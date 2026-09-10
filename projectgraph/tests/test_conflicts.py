"""Unit tests for corrected conflict and version-drift detection (P1.2).

Conflicts/drift must be computed only from resolved, module-owned data, and
must show the dependency path responsible for each occurrence.
"""

import unittest

from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree


def module(coord, dot, **kwargs):
    group, artifact, version = coord.split(":")
    return Module(
        pom_path=f"/repo/{artifact}/pom.xml",
        dir_path=f"/repo/{artifact}",
        coord_id=coord,
        groupId=group,
        artifactId=artifact,
        version=version,
        tree=parse_dot_to_tree(dot, coord) if dot else None,
        **kwargs,
    )


def one_module_model(coord, dot, **kwargs):
    model = GraphModel(root="/repo")
    model.add_module(module(coord, dot, **kwargs))
    return model


class ConflictAndDriftTests(unittest.TestCase):
    def test_intra_module_two_versions_is_a_conflict(self):
        """One module's own tree containing two versions cannot be satisfied."""
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:left:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:right:jar:1:compile"\n'
            '"x:left:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '"x:right:jar:1:compile" -> "shared.lib:lib:jar:2:compile"\n'
            '}\n'
        )
        conflicts = one_module_model("g:app:1", dot).conflicts()
        self.assertEqual(1, len(conflicts))
        c = conflicts[0]
        self.assertEqual("shared.lib:lib", c.artifact_key)
        self.assertEqual("conflict", c.kind)
        self.assertEqual(["1", "2"], c.versions)
        self.assertEqual(["g:app:1"], c.modules)
        self.assertFalse(c.truncated)

    def test_cross_module_different_versions_is_drift(self):
        model = GraphModel(root="/repo")
        for name, lib_version in (("one", "1"), ("two", "2")):
            dot = (
                f'digraph "g:{name}:jar:1" {{\n'
                f'"g:{name}:jar:1" -> "shared.lib:lib:jar:{lib_version}:compile"\n'
                f'}}\n'
            )
            model.add_module(module(f"g:{name}:1", dot))
        conflicts = model.conflicts()
        self.assertEqual(1, len(conflicts))
        c = conflicts[0]
        self.assertEqual("drift", c.kind)
        self.assertEqual(["g:one:1", "g:two:1"], c.modules)

    def test_occurrence_carries_the_responsible_path(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:mid:jar:1:compile"\n'
            '"x:mid:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '"g:app:jar:1" -> "shared.lib:lib:jar:2:runtime"\n'
            '}\n'
        )
        c = one_module_model("g:app:1", dot).conflicts()[0]
        by_version = {o["version"]: o for o in c.occurrences}

        # Direct occurrence: depth 1, flagged direct, 2-element path.
        direct = by_version["2"]
        self.assertEqual(1, direct["depth"])
        self.assertTrue(direct["direct"])
        self.assertEqual("runtime", direct["scope"])
        self.assertEqual(["g:app:jar:1", "shared.lib:lib:jar:2"], direct["path"])

        # Transitive occurrence: depth 2, full route visible.
        transitive = by_version["1"]
        self.assertEqual(2, transitive["depth"])
        self.assertFalse(transitive["direct"])
        self.assertEqual(
            ["g:app:jar:1", "x:mid:jar:1", "shared.lib:lib:jar:1"],
            transitive["path"])
        self.assertEqual("g:app:1", transitive["module_id"])

    def test_unresolved_modules_do_not_produce_conflicts(self):
        """A failed module must not fabricate nor hide a conflict."""
        model = GraphModel(root="/repo")
        model.add_module(module(
            "g:app:1",
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "shared.lib:lib:jar:1:compile"\n}\n',
            analysis_status="resolved", completeness="complete"))
        model.add_module(module("g:broken:1", None,
                                analysis_status="maven_error",
                                completeness="partial",
                                error="resolution failed"))
        self.assertEqual([], model.conflicts())

    def test_module_roots_are_not_conflicts(self):
        """Two modules that ARE the same GA at different versions are not a
        dependency conflict — their own root nodes are context, not deps."""
        model = GraphModel(root="/repo")
        for version in ("1", "2"):
            model.add_module(module(
                f"g:app:{version}",
                f'digraph "g:app:jar:{version}" {{\n}}\n'))
        self.assertEqual([], model.conflicts())

    def test_diamond_same_version_is_not_a_conflict(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:left:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:right:jar:1:compile"\n'
            '"x:left:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '"x:right:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '}\n'
        )
        self.assertEqual([], one_module_model("g:app:1", dot).conflicts())

    def test_paths_are_bounded_and_truncation_flagged(self):
        # lib:1 is reached twice (diamond) while lib:2 is direct.
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:left:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:right:jar:1:compile"\n'
            '"g:app:jar:1" -> "shared.lib:lib:jar:2:compile"\n'
            '"x:left:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '"x:right:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '}\n'
        )
        model = one_module_model("g:app:1", dot)
        c = model.conflicts(max_paths=1)[0]
        self.assertTrue(c.truncated)
        # Every stored occurrence still carries a complete path that starts
        # at the owning module and ends at the artifact.
        for occ in c.occurrences:
            self.assertEqual("g:app:jar:1", occ["path"][0])
            self.assertEqual(occ["canonical_id"], occ["path"][-1])
            self.assertEqual(len(occ["path"]) - 1, occ["depth"])

    def test_diamond_paths_are_all_reported_when_bounded_generously(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:left:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:right:jar:1:compile"\n'
            '"x:left:jar:1:compile" -> "shared.lib:lib:jar:1:compile"\n'
            '"x:right:jar:1:compile" -> "shared.lib:lib:jar:2:compile"\n'
            '}\n'
        )
        c = one_module_model("g:app:1", dot).conflicts()[0]
        versions = sorted({o["version"] for o in c.occurrences})
        self.assertEqual(["1", "2"], versions)
        self.assertEqual(2, len(c.occurrences))

    def test_scope_is_reported_per_occurrence(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "shared.lib:lib:jar:1:test"\n'
            '"g:app:jar:1" -> "x:mid:jar:1:compile"\n'
            '"x:mid:jar:1:compile" -> "shared.lib:lib:jar:2:compile"\n'
            '}\n'
        )
        c = one_module_model("g:app:1", dot).conflicts()[0]
        scopes = {o["version"]: o["scope"] for o in c.occurrences}
        self.assertEqual("test", scopes["1"])
        self.assertEqual("compile", scopes["2"])


if __name__ == "__main__":
    unittest.main()
