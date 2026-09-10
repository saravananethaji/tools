"""Unit tests for POM structural relationships and used-by (P1.5).

The central invariant: resolved, structural, and declared relationships are
different kinds of fact and must never be flattened into one another. A
``<parent>`` edge is not a dependency, and a declared ``<dependency>`` is not
proof of usage.
"""

import json
import unittest

from graph_model import GraphModel, Module, SCAN_SCHEMA_VERSION
from maven_runner import parse_dot_to_tree
from pom_topology import (
    RELATION_AGGREGATES,
    RELATION_DECLARED,
    RELATION_DEPENDS_ON,
    RELATION_PARENT,
    RELATION_TRUTH,
    RELATION_USED_BY,
    TRUTH_DECLARED,
    TRUTH_RESOLVED,
    TRUTH_STRUCTURAL,
    build_topology,
    module_relationships,
    resolve_module_ref,
)


def dot_for(coord, *targets):
    """Build a DOT graph whose root matches ``coord`` exactly.

    The root must agree with the requested coordinate or ``parse_dot_to_tree``
    rejects it (and logs a mismatch), so tests build the root from the module
    coordinate rather than reusing a fixed graph.
    """
    group, artifact, version = coord.split(":")
    root = f"{group}:{artifact}:jar:{version}"
    lines = [f'digraph "{group}:{artifact}:jar:{version}" {{']
    for target in targets:
        lines.append(f'"{root}" -> "{target}"')
    lines.append("}")
    return "\n".join(lines) + "\n"


APP_DOT = (
    'digraph "com.acme:app:jar:1" {\n'
    '"com.acme:app:jar:1" -> "lib:shared:jar:1:compile"\n'
    '"com.acme:app:jar:1" -> "lib:mid:jar:1:compile"\n'
    '"lib:mid:jar:1:compile" -> "lib:shared:jar:1:compile"\n'
    '}\n'
)

OTHER_DOT = (
    'digraph "com.acme:other:jar:1" {\n'
    '"com.acme:other:jar:1" -> "lib:shared:jar:1:compile"\n'
    '}\n'
)

# A graph whose root is `com.acme:app:jar:1`, extended so that app also depends
# on an in-scan module. Used where a test needs both a real tree and a
# cross-module edge.
APP_WITH_MODULE_DOT = (
    'digraph "com.acme:app:jar:1" {\n'
    '"com.acme:app:jar:1" -> "lib:shared:jar:1:compile"\n'
    '"com.acme:app:jar:1" -> "com.acme:common:jar:1:compile"\n'
    '}\n'
)


def module(coord, dot=None, **kwargs):
    group, artifact, version = coord.split(":")
    fields = dict(
        pom_path=f"/repo/{artifact}/pom.xml",
        dir_path=f"/repo/{artifact}",
        coord_id=coord,
        groupId=group,
        artifactId=artifact,
        version=version,
        tree=parse_dot_to_tree(dot, coord) if dot else None,
        analysis_status="resolved" if dot else "empty",
        completeness="complete",
        source="maven-resolved",
    )
    fields.update(kwargs)
    return Module(**fields)


class TruthClassTests(unittest.TestCase):
    """Relationship classes must carry distinguishable truth statuses."""

    def test_every_relationship_declares_a_truth_status(self):
        for relation in (RELATION_PARENT, RELATION_AGGREGATES,
                         RELATION_DEPENDS_ON, RELATION_USED_BY,
                         RELATION_DECLARED):
            self.assertIn(relation, RELATION_TRUTH)
            self.assertIn(RELATION_TRUTH[relation],
                          (TRUTH_RESOLVED, TRUTH_STRUCTURAL, TRUTH_DECLARED))

    def test_structural_and_declared_are_not_resolved(self):
        self.assertEqual(TRUTH_STRUCTURAL, RELATION_TRUTH[RELATION_PARENT])
        self.assertEqual(TRUTH_STRUCTURAL, RELATION_TRUTH[RELATION_AGGREGATES])
        self.assertEqual(TRUTH_DECLARED, RELATION_TRUTH[RELATION_DECLARED])
        self.assertEqual(TRUTH_RESOLVED, RELATION_TRUTH[RELATION_DEPENDS_ON])
        self.assertEqual(TRUTH_RESOLVED, RELATION_TRUTH[RELATION_USED_BY])

    def test_report_labels_each_relation(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        relations = build_topology(model)["relations"]
        for relation, payload in relations.items():
            self.assertTrue(payload["label"], relation)
            self.assertTrue(payload["note"], relation)


class ParentRelationTests(unittest.TestCase):
    def test_parent_is_reported_and_is_not_a_dependency(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:parent:1", declared_modules=["child"]))
        model.add_module(module("com.acme:child:1", dot_for("com.acme:child:1", "lib:shared:jar:1:compile"),
                                parent_coord="com.acme:parent:1",
                                parent_module="com.acme:parent:1"))
        topology = build_topology(model)
        parents = topology["relations"][RELATION_PARENT]["edges"]
        self.assertEqual(1, len(parents))
        self.assertEqual("com.acme:child:1", parents[0]["from"])
        self.assertEqual("com.acme:parent:1", parents[0]["to_coord"])
        # The parent must never appear as a resolved dependency edge.
        self.assertNotIn(
            "com.acme:parent:1",
            [e["to"] for e in topology["relations"][RELATION_DEPENDS_ON]["edges"]],
        )

    def test_external_parent_is_reported_not_dropped(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:child:1", dot_for("com.acme:child:1", "lib:shared:jar:1:compile"),
                                parent_coord="org.springframework.boot:spring-boot-starter-parent:3.2.0"))
        topology = build_topology(model)
        edge = topology["relations"][RELATION_PARENT]["edges"][0]
        self.assertFalse(edge["in_scan"])
        self.assertIsNone(edge["to"])
        reasons = [u["reason"] for u in topology["unresolved_links"]]
        self.assertTrue(any("outside the scanned reactor" in r for r in reasons))

    def test_unresolved_module_path_is_reported(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:agg:1",
                                declared_modules=["missing"],
                                unresolved_module_paths=["missing"]))
        topology = build_topology(model)
        references = [u["reference"] for u in topology["unresolved_links"]]
        self.assertIn("missing", references)
        self.assertIn("scanned POM", topology["unresolved_links"][0]["reason"])

    def test_module_relationships_reports_parent(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:parent:1"))
        model.add_module(module("com.acme:child:1", dot_for("com.acme:child:1", "lib:shared:jar:1:compile"),
                                parent_coord="com.acme:parent:1",
                                parent_relative_path="../parent",
                                parent_module="com.acme:parent:1"))
        result = module_relationships(model, "com.acme:child:1")
        self.assertEqual("com.acme:parent:1", result["parent"]["coord"])
        self.assertTrue(result["parent"]["in_scan"])

    def test_module_without_parent_reports_none(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        self.assertIsNone(module_relationships(model, "com.acme:app:1")["parent"])

    def test_unknown_module_returns_none(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        self.assertIsNone(module_relationships(model, "com.acme:ghost:9"))


class UsedByTests(unittest.TestCase):
    def test_used_by_is_the_reverse_of_resolved_edges(self):
        """Artifact-level dependents are lossless: direct and via both count."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        model.add_module(module("com.acme:other:1", OTHER_DOT))
        topology = build_topology(model)
        users = topology["used_by"]["lib:shared:jar:1"]
        # `shared` is reached directly by app/other and transitively via mid.
        self.assertEqual(
            {"com.acme:app:jar:1", "com.acme:other:jar:1", "lib:mid:jar:1"},
            {u["artifact"] for u in users},
        )
        # Every dependent is attributed to the module whose scan produced it.
        self.assertEqual({"com.acme:app:1", "com.acme:other:1"},
                         {u["module"] for u in users})
        # The reactor-wide relationship class must be visually/API-wise
        # reversed too: library -> consuming artifact, never a duplicate of
        # dependsOn.
        used_by_edges = topology["relations"][RELATION_USED_BY]["edges"]
        shared_edge = next(e for e in used_by_edges
                           if e["from"] == "lib:shared:jar:1"
                           and e["to"] == "com.acme:app:jar:1")
        self.assertEqual("com.acme:app:1", shared_edge["module"])

    def test_module_rollup_prefers_the_nearest_occurrence(self):
        """A module reaching a target directly is a direct user, not via mid."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        topology = build_topology(model)
        rollup = topology["used_by_module"]["lib:shared:1"]
        self.assertEqual(["com.acme:app:1"], list(rollup))
        self.assertTrue(rollup["com.acme:app:1"]["direct"])
        self.assertEqual("compile", rollup["com.acme:app:1"]["scope"])

    def test_module_rollup_records_the_intermediate_when_transitive(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        topology = build_topology(model)
        # `mid` is reached directly by app; `shared` is also reachable through
        # mid, so the direct occurrence must win.
        self.assertEqual("com.acme:app:jar:1",
                         topology["used_by_module"]["lib:mid:1"]["com.acme:app:1"]["via"])

    def test_declared_only_dependency_is_not_used_by(self):
        """A declared dependency with no resolved tree must not create usage."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", None, declared_dependencies=[{
            "groupId": "lib", "artifactId": "shared", "version": "1",
            "coord_id": "lib:shared:1", "scope": "compile",
        }]))
        topology = build_topology(model)
        self.assertEqual({}, topology["used_by"])
        self.assertEqual({}, topology["used_by_module"])
        self.assertEqual(1, topology["relations"][RELATION_DECLARED]["count"])

    def test_static_dot_shaped_tree_is_not_presented_as_resolved(self):
        """Static imports may carry a tree, but it is not Maven evidence."""
        model = GraphModel(root="/repo", source="pom-static", completeness="partial")
        model.add_module(module(
            "com.acme:app:1", APP_DOT,
            source="pom-static", analysis_status="partial_static",
            completeness="partial",
        ))
        topology = build_topology(model)
        self.assertEqual(0, topology["resolved_module_count"])
        self.assertEqual(0, topology["relations"][RELATION_DEPENDS_ON]["count"])
        self.assertEqual(0, topology["relations"][RELATION_USED_BY]["count"])
        self.assertEqual({}, topology["used_by"])

    def test_module_lookup_is_not_silently_empty(self):
        """Module lookup must bridge coord_id and packaging-bearing ids."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:lib:1"))
        model.add_module(module(
            "com.acme:app:1",
            'digraph "com.acme:app:jar:1" {\n'
            '"com.acme:app:jar:1" -> "com.acme:lib:jar:1:compile"\n}\n',
        ))
        # The module's tree root carries packaging; its coord_id does not.
        app = next(m for m in model.modules if m.artifactId == "app")
        self.assertEqual("com.acme:app:jar:1", app.tree.artifact_id)
        self.assertEqual("com.acme:app:1", app.coord_id)

        result = module_relationships(model, "com.acme:lib:1")
        self.assertEqual(1, len(result["used_by"]),
                         "used_by must be found despite the id form difference")
        self.assertEqual("com.acme:app:1", result["used_by"][0]["module"])

    def test_external_libraries_are_not_reported_as_modules(self):
        """depends_on_modules means in-scan modules, not external libraries."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        result = module_relationships(model, "com.acme:app:1")
        # app resolves lib:mid and lib:shared, which are external libraries.
        self.assertEqual([], result["depends_on_modules"])
        self.assertEqual(["lib:mid:jar:1", "lib:shared:jar:1"],
                         sorted({e["to"] for e in result["direct_dependencies"]}))

    def test_internal_module_dependency_is_reported(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:common:1"))
        model.add_module(module(
            "com.acme:app:1",
            'digraph "com.acme:app:jar:1" {\n'
            '"com.acme:app:jar:1" -> "com.acme:common:jar:1:compile"\n}\n',
        ))
        result = module_relationships(model, "com.acme:app:1")
        self.assertEqual(["com.acme:common:1"], result["depends_on_modules"])

    def test_depends_on_modules_is_a_distinct_question_from_used_by(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:common:1"))
        model.add_module(module(
            "com.acme:app:1",
            'digraph "com.acme:app:jar:1" {\n'
            '"com.acme:app:jar:1" -> "com.acme:common:jar:1:compile"\n}\n',
        ))
        common = module_relationships(model, "com.acme:common:1")
        app = module_relationships(model, "com.acme:app:1")
        # Opposite directions: app depends on common; common is used by app.
        self.assertEqual(["com.acme:app:1"], [u["module"] for u in common["used_by"]])
        self.assertEqual([], common["depends_on_modules"])
        self.assertEqual(["com.acme:common:1"], app["depends_on_modules"])
        self.assertEqual([], app["used_by"])


class DeclaredDependencyTests(unittest.TestCase):
    def test_declared_dependency_is_separate_from_resolved(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT, declared_dependencies=[{
            "groupId": "lib", "artifactId": "shared", "version": "1",
            "coord_id": "lib:shared:1", "scope": "compile",
        }]))
        result = module_relationships(model, "com.acme:app:1")
        self.assertEqual(1, len(result["declared_dependencies"]))
        self.assertEqual(TRUTH_DECLARED,
                         build_topology(model)["relations"][RELATION_DECLARED]["truth"])
        # Declared coordinate form differs from the resolved artifact id.
        self.assertEqual("lib:shared:1",
                         result["declared_dependencies"][0]["to_coord"])
        self.assertEqual("lib:shared:jar:1",
                         result["direct_dependencies"][0]["to"])

    def test_declared_internal_dependency_resolves_to_module(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:common:1"))
        model.add_module(module("com.acme:app:1", APP_DOT, declared_dependencies=[{
            "groupId": "com.acme", "artifactId": "common", "version": "1",
            "coord_id": "com.acme:common:1", "scope": "compile",
        }]))
        edges = build_topology(model)["relations"][RELATION_DECLARED]["edges"]
        self.assertEqual("com.acme:common:1", edges[0]["to"])


class AggregationTests(unittest.TestCase):
    def test_child_modules_are_aggregation_not_dependency(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:agg:1", declared_modules=["a"],
                                child_modules=["com.acme:a:1"]))
        model.add_module(module("com.acme:a:1", dot_for("com.acme:a:1", "lib:shared:jar:1:compile")))
        topology = build_topology(model)
        self.assertEqual(1, topology["relations"][RELATION_AGGREGATES]["count"])
        self.assertEqual(
            [],
            [e for e in topology["relations"][RELATION_DEPENDS_ON]["edges"]
             if e["to"] == "com.acme:agg:1"],
        )

    def test_module_relationships_lists_child_modules(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:agg:1", child_modules=["com.acme:a:1"]))
        model.add_module(module("com.acme:a:1", dot_for("com.acme:a:1", "lib:shared:jar:1:compile")))
        result = module_relationships(model, "com.acme:agg:1")
        self.assertEqual(["com.acme:a:1"],
                         [c["to"] for c in result["child_modules"]])


class ResolveModuleRefTests(unittest.TestCase):
    def test_exact_version_match_wins(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:lib:1"))
        model.add_module(module("com.acme:lib:2"))
        self.assertEqual("com.acme:lib:2",
                         resolve_module_ref(model, "com.acme", "lib", "2"))

    def test_ambiguous_ga_without_version_is_not_guessed(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:lib:1"))
        model.add_module(module("com.acme:lib:2"))
        self.assertIsNone(resolve_module_ref(model, "com.acme", "lib"))

    def test_unknown_ga_resolves_to_none(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:lib:1"))
        self.assertIsNone(resolve_module_ref(model, "other", "thing"))


class CompletenessTests(unittest.TestCase):
    def test_unresolved_module_makes_topology_partial(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        model.add_module(module("com.acme:broken:1", None,
                                analysis_status="maven_error",
                                error="resolution failed", completeness="partial"))
        topology = build_topology(model)
        self.assertEqual("partial", topology["completeness"])
        self.assertEqual(1, topology["resolved_module_count"])
        self.assertEqual(2, topology["module_count"])

    def test_all_resolved_is_complete(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:app:1", APP_DOT))
        self.assertEqual("complete", build_topology(model)["completeness"])

    def test_empty_model_is_not_claimed_complete(self):
        self.assertEqual("partial", build_topology(GraphModel(root="/repo"))["completeness"])


class BackwardCompatibilityTests(unittest.TestCase):
    """Scans written before topology capture must still load (additive fields)."""

    def test_scan_without_topology_fields_loads(self):
        legacy = {
            "schema_version": SCAN_SCHEMA_VERSION,
            "metadata": {"root": "/repo", "scan_id": "s", "source": "maven-resolved"},
            "modules": [{
                "pom_path": "/repo/a/pom.xml",
                "dir_path": "/repo/a",
                "coord_id": "com.acme:a:1",
                "groupId": "com.acme",
                "artifactId": "a",
                "version": "1",
                "analysis_status": "resolved",
                "completeness": "complete",
                "source": "maven-resolved",
            }],
            "edges": [],
        }
        model = GraphModel.from_dict(legacy)
        self.assertEqual(1, len(model.modules))
        loaded = model.modules[0]
        self.assertIsNone(loaded.parent_coord)
        self.assertEqual([], loaded.child_modules)
        self.assertEqual([], loaded.declared_dependencies)
        # Absence means "not captured", and topology still reports cleanly.
        topology = build_topology(model)
        self.assertEqual(0, topology["relations"][RELATION_PARENT]["count"])
        self.assertEqual([], topology["unresolved_links"])

    def test_topology_round_trips_through_scan_json(self):
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:parent:1"))
        model.add_module(module("com.acme:child:1", dot_for("com.acme:child:1", "lib:shared:jar:1:compile"),
                                parent_coord="com.acme:parent:1",
                                parent_relative_path="../parent",
                                parent_module="com.acme:parent:1",
                                declared_modules=["a"],
                                child_modules=["com.acme:grand:1"],
                                unresolved_module_paths=["gone"],
                                declared_dependencies=[{
                                    "groupId": "lib", "artifactId": "shared",
                                    "version": "1", "coord_id": "lib:shared:1",
                                }]))
        restored = GraphModel.from_dict(json.loads(json.dumps(model.to_dict())))
        child = next(m for m in restored.modules if m.artifactId == "child")
        self.assertEqual("com.acme:parent:1", child.parent_coord)
        self.assertEqual("../parent", child.parent_relative_path)
        self.assertEqual("com.acme:parent:1", child.parent_module)
        self.assertEqual(["a"], child.declared_modules)
        self.assertEqual(["com.acme:grand:1"], child.child_modules)
        self.assertEqual(["gone"], child.unresolved_module_paths)
        self.assertEqual("lib:shared:1", child.declared_dependencies[0]["coord_id"])


if __name__ == "__main__":
    unittest.main()
