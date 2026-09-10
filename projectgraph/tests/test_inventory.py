"""Unit tests for the resolved OSS inventory (P1.1).

Fixture graph (module com.acme:app:1, resolved). Every external artifact has
its own groupId so prefix-targeting is unambiguous:

    com.acme:app:jar:1           (root — context, never a dependency)
    ├── direct.lib:jar:2         (external, direct)
    │   └── shared.core:jar:9    (external, transitive)
    ├── com.acme:core:jar:1      (internal, direct — own group of the scan)
    ├── path.left:jar:1          (external, direct)
    │   └── shared.core:jar:9
    └── path.right:jar:1         (external, direct)
        └── shared.core:jar:9

So shared.core:jar:9 is reached by THREE distinct paths (a diamond).
"""

import os
import unittest
from unittest import mock

from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree
from oss_inventory import (
    build_inventory,
    external_entries,
    internal_group_prefixes,
)

APP_DOT = (
    'digraph "com.acme:app:jar:1" {\n'
    '"com.acme:app:jar:1" -> "direct.lib:lib:jar:2:compile"\n'
    '"com.acme:app:jar:1" -> "com.acme:core:jar:1:compile"\n'
    '"com.acme:app:jar:1" -> "path.left:left:jar:1:compile"\n'
    '"com.acme:app:jar:1" -> "path.right:right:jar:1:compile"\n'
    '"direct.lib:lib:jar:2:compile" -> "shared.core:core:jar:9:compile"\n'
    '"path.left:left:jar:1:compile" -> "shared.core:core:jar:9:compile"\n'
    '"path.right:right:jar:1:compile" -> "shared.core:core:jar:9:compile"\n'
    '}\n'
)


def module(coord, dot, **kwargs):
    group, artifact, version = coord.split(":")
    return Module(
        pom_path=f"/repo/{artifact}/pom.xml",
        dir_path=f"/repo/{artifact}",
        coord_id=coord,
        groupId=group,
        artifactId=artifact,
        version=version,
        # DOT roots use the 4-part g:a:packaging:version label; the requested
        # coordinate is the 3-part POM coord (P0.2 contract).
        tree=parse_dot_to_tree(dot, coord) if dot else None,
        **kwargs,
    )


class OssInventoryTests(unittest.TestCase):
    def _model(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT,
                                analysis_status="resolved",
                                completeness="complete"))
        # A second, broken module must be reported, not silently dropped.
        model.add_module(module("com.acme:broken:1", None,
                                analysis_status="maven_error",
                                completeness="partial",
                                error="resolution failed"))
        return model

    def _kinds(self, inventory):
        return {e["canonical_id"]: e["kind"] for e in inventory["entries"]}

    def test_scan_group_is_internal_by_default(self):
        inventory = build_inventory(self._model(), include_internal=True)
        self.assertIn("com.acme", internal_group_prefixes(self._model()))
        # The app's own group and its sibling are internal.
        self.assertEqual("internal", self._kinds(inventory)["com.acme:core:jar:1"])
        # The scanned root itself is never a listed dependency.
        self.assertNotIn("com.acme:app:jar:1", self._kinds(inventory))
        # Default (no include_internal) lists only external entries.
        default = build_inventory(self._model())
        self.assertNotIn("com.acme:core:jar:1",
                         [e["canonical_id"] for e in default["entries"]])
        self.assertNotIn("com.acme:core:jar:1",
                         [e["canonical_id"] for e in external_entries(default)])

    def test_external_classification(self):
        kinds = self._kinds(build_inventory(self._model(),
                                            include_internal=True))
        self.assertEqual("external", kinds["direct.lib:lib:jar:2"])
        self.assertEqual("external", kinds["shared.core:core:jar:9"])
        self.assertEqual("external", kinds["path.left:left:jar:1"])

    def test_env_prefix_is_respected(self):
        model = self._model()
        with mock.patch.dict(os.environ,
                             {"PROJECTGRAPH_INTERNAL_PREFIXES": "path.left, path.right"}):
            inventory = build_inventory(model, include_internal=True)
        kinds = self._kinds(inventory)
        self.assertEqual("internal", kinds["path.left:left:jar:1"])
        self.assertEqual("internal", kinds["path.right:right:jar:1"])
        self.assertEqual("external", kinds["shared.core:core:jar:9"])

    def test_extra_prefix_argument_reclassifies(self):
        inventory = build_inventory(self._model(),
                                    extra_prefixes=["direct.lib"],
                                    include_internal=True)
        self.assertEqual("internal", self._kinds(inventory)["direct.lib:lib:jar:2"])

    def test_direct_relationship(self):
        by_id = {e["canonical_id"]: e for e in build_inventory(self._model())["entries"]}
        lib = by_id["direct.lib:lib:jar:2"]["consumers"][0]
        self.assertEqual("direct", lib["relationship"])
        self.assertEqual(
            ["com.acme:app:jar:1", "direct.lib:lib:jar:2"], lib["paths"][0])

    def test_transitive_diamond_preserves_all_paths(self):
        by_id = {e["canonical_id"]: e for e in build_inventory(self._model())["entries"]}
        shared = by_id["shared.core:core:jar:9"]["consumers"][0]
        self.assertEqual("transitive", shared["relationship"])
        self.assertEqual(3, len(shared["paths"]))
        middles = {p[1] for p in shared["paths"]}
        self.assertEqual(
            {"direct.lib:lib:jar:2", "path.left:left:jar:1", "path.right:right:jar:1"},
            middles)
        self.assertFalse(shared["paths_truncated"])

    def test_paths_are_bounded_and_flagged(self):
        inventory = build_inventory(self._model(), max_paths=2)
        shared = next(e for e in inventory["entries"]
                      if e["canonical_id"] == "shared.core:core:jar:9")
        consumer = shared["consumers"][0]
        self.assertEqual(2, len(consumer["paths"]))
        self.assertTrue(consumer["paths_truncated"])

    def test_directness_survives_path_truncation(self):
        """A later direct edge must not be hidden by retained indirect paths."""
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:first:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:second:jar:1:compile"\n'
            '"g:app:jar:1" -> "t:target:jar:1:compile"\n'
            '"x:first:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '"x:second:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '}\n'
        )
        model = GraphModel(root="/repo")
        model.add_module(module("g:app:1", dot,
                                analysis_status="resolved",
                                completeness="complete"))
        entry = next(e for e in build_inventory(model, max_paths=2)["entries"]
                     if e["canonical_id"] == "t:target:jar:1")
        consumer = entry["consumers"][0]
        self.assertEqual("direct", consumer["relationship"])
        self.assertTrue(consumer["paths_truncated"])

    def test_static_tree_is_excluded_from_resolved_inventory(self):
        model = GraphModel(root="/repo", source="pom-static",
                           completeness="partial")
        model.add_module(module("com.acme:app:1", APP_DOT,
                                source="pom-static",
                                analysis_status="partial_static",
                                completeness="partial"))
        inventory = build_inventory(model)
        self.assertEqual([], inventory["entries"])
        self.assertEqual([], inventory["included_modules"])
        self.assertEqual("partial", inventory["completeness"])
        self.assertIn("not Maven-resolved", inventory["excluded_modules"][0]["reason"])

    def test_unresolved_module_is_reported_not_dropped(self):
        inventory = build_inventory(self._model())
        self.assertEqual("partial", inventory["completeness"])
        excluded = {m["coord_id"]: m["reason"]
                    for m in inventory["excluded_modules"]}
        self.assertEqual({"com.acme:broken:1": "resolution failed"}, excluded)
        self.assertIn("com.acme:app:1", inventory["included_modules"])
        self.assertIn("NOT represented", inventory["status_note"])

    def test_complete_model_reports_complete(self):
        model = GraphModel(root="/repo")
        model.add_module(module(
            "g:app:1",
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:lib:jar:1:compile"\n}\n',
            analysis_status="resolved", completeness="complete",
        ))
        inventory = build_inventory(model)
        self.assertEqual("complete", inventory["completeness"])
        self.assertEqual([], inventory["excluded_modules"])
        self.assertEqual("All modules resolved.", inventory["status_note"])

    def test_entry_metadata_is_lossless(self):
        inventory = build_inventory(self._model())
        lib = next(e for e in inventory["entries"]
                   if e["canonical_id"] == "direct.lib:lib:jar:2")
        self.assertEqual("pkg:maven/direct.lib/lib@2", lib["purl"])
        self.assertEqual("jar", lib["packaging"])
        self.assertIsNone(lib["classifier"])


if __name__ == "__main__":
    unittest.main()
