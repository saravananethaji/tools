"""Unit tests for in-memory blast-radius and dependency-route queries (P1.3).

The answers must be correct without a graph database, must use exact
coordinate matching, and must be explicit about bounds and unresolved modules.
"""

import unittest

from graph_model import GraphModel, Module
from impact import (
    affected_modules,
    blast_radius,
    dependency_routes,
    index_artifacts,
    match_artifacts,
    parse_coordinate_query,
)
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


APP_DOT = (
    'digraph "com.acme:app:jar:1" {\n'
    '"com.acme:app:jar:1" -> "mid.lib:mid:jar:1:compile"\n'
    '"com.acme:app:jar:1" -> "direct.lib:direct:jar:2:runtime"\n'
    '"mid.lib:mid:jar:1:compile" -> "vuln.lib:core:jar:1:compile"\n'
    '"mid.lib:mid:jar:1:compile" -> "shared.lib:common:jar:1:compile"\n'
    '"direct.lib:direct:jar:2:runtime" -> "shared.lib:common:jar:1:compile"\n'
    '}\n'
)

OTHER_DOT = (
    'digraph "com.acme:other:jar:3" {\n'
    '"com.acme:other:jar:3" -> "vuln.lib:core:jar:1:compile"\n'
    '}\n'
)


def model_with_app_and_other():
    model = GraphModel(root="/repo")
    model.add_module(module("com.acme:app:1", APP_DOT,
                            analysis_status="resolved",
                            completeness="complete"))
    model.add_module(module("com.acme:other:3", OTHER_DOT,
                            analysis_status="resolved",
                            completeness="complete"))
    return model


class CoordinateQueryTests(unittest.TestCase):
    def test_rejects_artifact_only_query(self):
        with self.assertRaises(ValueError) as caught:
            parse_coordinate_query("core")
        self.assertIn("explicit groupId", str(caught.exception))

    def test_rejects_empty_and_blank_segments(self):
        for bad in ("", "   ", "g:", ":a", "g::1"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_coordinate_query(bad)

    def test_rejects_too_many_segments(self):
        with self.assertRaises(ValueError):
            parse_coordinate_query("g:a:jar:cls:1:extra:more")

    def test_accepts_supported_forms(self):
        self.assertEqual({"groupId": "g", "artifactId": "a"},
                         parse_coordinate_query("g:a"))
        self.assertEqual({"groupId": "g", "artifactId": "a", "version": "1"},
                         parse_coordinate_query("g:a:1"))
        self.assertEqual(
            {"groupId": "g", "artifactId": "a", "packaging": "jar",
             "version": "1"},
            parse_coordinate_query("g:a:jar:1"))
        self.assertEqual(
            {"groupId": "g", "artifactId": "a", "packaging": "jar",
             "classifier": "tests", "version": "1"},
            parse_coordinate_query("g:a:jar:tests:1"))


class ArtifactIndexTests(unittest.TestCase):
    def test_index_marks_module_roots(self):
        index = index_artifacts(model_with_app_and_other())
        self.assertTrue(index["com.acme:app:jar:1"]["module_root"])
        self.assertFalse(index["vuln.lib:core:jar:1"]["module_root"])
        self.assertEqual(["com.acme:app:1", "com.acme:other:3"],
                         index["vuln.lib:core:jar:1"]["modules"])

    def test_exact_match_returns_all_variants(self):
        model = GraphModel(root="/repo")
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:lib:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:lib:jar:tests:1:compile"\n'
            '"g:app:jar:1" -> "x:lib:jar:2:compile"\n'
            '}\n'
        )
        model.add_module(module("g:app:1", dot))
        index = index_artifacts(model)

        # GA-only query matches every version and classifier variant.
        ga = match_artifacts(index, {"groupId": "x", "artifactId": "lib"})
        self.assertEqual(3, len(ga))
        # Version narrows it; classifier is still explicit.
        v1 = match_artifacts(index, {"groupId": "x", "artifactId": "lib",
                                     "version": "1"})
        self.assertEqual(2, len(v1))
        exact = match_artifacts(index, {"groupId": "x", "artifactId": "lib",
                                        "classifier": "tests", "version": "1"})
        self.assertEqual(1, len(exact))
        self.assertEqual("x:lib:jar:tests:1", exact[0]["canonical_id"])


class BlastRadiusTests(unittest.TestCase):
    def test_reports_affected_modules_with_paths(self):
        report = blast_radius(model_with_app_and_other(),
                              "vuln.lib:core:1")
        self.assertEqual(2, report["affected_module_count"])
        self.assertFalse(report["ambiguous"])

        by_module = {m["module"]: m for m in report["modules"]}

        app = by_module["com.acme:app:1"]
        self.assertEqual("transitive", app["relationship"])
        self.assertFalse(app["direct"])
        self.assertEqual(["mid.lib:mid:jar:1"], app["introduced_by"])
        self.assertEqual(2, app["min_depth"])
        self.assertEqual(
            ["com.acme:app:jar:1", "mid.lib:mid:jar:1", "vuln.lib:core:jar:1"],
            app["paths"][0])
        self.assertEqual("/repo/app/pom.xml", app["pom_path"])

        # In the other module it is direct.
        other = by_module["com.acme:other:3"]
        self.assertEqual("direct", other["relationship"])
        self.assertTrue(other["direct"])
        self.assertEqual(1, other["min_depth"])

    def test_no_match_is_explicit_and_not_an_error(self):
        report = blast_radius(model_with_app_and_other(), "nope:missing:9")
        self.assertEqual([], report["matches"])
        self.assertEqual(0, report["affected_module_count"])
        self.assertIn("No resolved artifact matches", report["note"])

    def test_module_root_query_is_context_not_a_dependency(self):
        report = blast_radius(model_with_app_and_other(), "com.acme:app:1")
        self.assertEqual(0, report["affected_module_count"])
        self.assertIn("module roots", report["note"])

    def test_internal_module_root_is_still_a_dependency_in_other_module(self):
        """A coordinate can be a root in one module and a dependency in another."""
        model = GraphModel(root="/repo")
        model.add_module(module("com.acme:common:1",
                                'digraph "com.acme:common:jar:1" {\n}\n',
                                analysis_status="empty", completeness="complete"))
        model.add_module(module(
            "com.acme:app:1",
            'digraph "com.acme:app:jar:1" {\n'
            '"com.acme:app:jar:1" -> "com.acme:common:jar:1:compile"\n'
            '}\n',
            analysis_status="resolved", completeness="complete"))
        report = blast_radius(model, "com.acme:common:1")
        self.assertEqual(1, report["affected_module_count"])
        self.assertEqual("com.acme:app:1", report["modules"][0]["module"])
        self.assertTrue(report["matches"][0]["module_root"])
        self.assertTrue(report["matches"][0]["dependency"])

    def test_ambiguous_query_lists_every_match(self):
        model = GraphModel(root="/repo")
        for name, version in (("one", "1"), ("two", "2")):
            dot = (f'digraph "g:{name}:jar:1" {{\n'
                   f'"g:{name}:jar:1" -> "x:lib:jar:{version}:compile"\n}}\n')
            model.add_module(module(f"g:{name}:1", dot))
        report = blast_radius(model, "x:lib")
        self.assertTrue(report["ambiguous"])
        self.assertEqual(2, len(report["matches"]))
        # Both affected modules are still reported.
        self.assertEqual(2, report["affected_module_count"])

    def test_resolved_scope_and_directness(self):
        report = blast_radius(model_with_app_and_other(), "direct.lib:direct:2")
        app = report["modules"][0]
        self.assertEqual("direct", app["relationship"])
        self.assertEqual(["runtime"], app["scopes"])

    def test_packaging_and_version_form_matches_exactly(self):
        report = blast_radius(model_with_app_and_other(), "vuln.lib:core:jar:1")
        self.assertEqual(1, len(report["matches"]))
        self.assertEqual("vuln.lib:core:jar:1",
                         report["matches"][0]["canonical_id"])

    def test_mismatched_packaging_does_not_match(self):
        report = blast_radius(model_with_app_and_other(), "vuln.lib:core:pom:1")
        self.assertEqual([], report["matches"])

    def test_nearest_occurrence_wins_within_a_branch(self):
        """A branch stops at the first target, so a deeper duplicate on the
        SAME branch is not reported; distinct branches are still both real."""
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:mid:jar:1:compile"\n'
            '"x:mid:jar:1:compile" -> "x:lib:jar:1:compile"\n'
            '"x:lib:jar:1:compile" -> "x:lib:jar:1:compile"\n'
            '}\n'
        )
        report = blast_radius(one_module(dot), "x:lib:1")
        paths = report["modules"][0]["paths"]
        self.assertEqual(1, len(paths))
        self.assertEqual(
            ["g:app:jar:1", "x:mid:jar:1", "x:lib:jar:1"], paths[0])
        self.assertEqual(2, report["modules"][0]["min_depth"])

    def test_two_distinct_routes_are_both_reported(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:lib:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:mid:jar:1:compile"\n'
            '"x:mid:jar:1:compile" -> "x:lib:jar:1:compile"\n'
            '}\n'
        )
        report = blast_radius(one_module(dot), "x:lib:1")
        paths = report["modules"][0]["paths"]
        self.assertEqual(2, len(paths))
        # The direct route explains the shallowest depth.
        self.assertEqual(1, report["modules"][0]["min_depth"])
        self.assertEqual("direct", report["modules"][0]["relationship"])

    def test_paths_are_bounded_and_truncation_reported(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:a:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:b:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:c:jar:1:compile"\n'
            '"x:a:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '"x:b:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '"x:c:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '}\n'
        )
        report = blast_radius(one_module(dot), "t:target:1", max_paths=2)
        self.assertEqual(2, len(report["modules"][0]["paths"]))
        self.assertTrue(report["truncated"])
        self.assertIn("configured bound", report["note"])

    def test_directness_survives_path_truncation(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:first:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:second:jar:1:compile"\n'
            '"g:app:jar:1" -> "t:target:jar:1:compile"\n'
            '"x:first:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '"x:second:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '}\n'
        )
        report = blast_radius(one_module(dot), "t:target:1", max_paths=2)
        self.assertEqual("direct", report["modules"][0]["relationship"])
        self.assertTrue(report["modules"][0]["paths_truncated"])

    def test_cycle_terminates(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:one:jar:1:compile"\n'
            '"x:one:jar:1:compile" -> "x:two:jar:1:compile"\n'
            '"x:two:jar:1:compile" -> "x:one:jar:1:compile"\n'
            '"x:two:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '}\n'
        )
        report = blast_radius(one_module(dot), "t:target:1")
        self.assertEqual(1, report["affected_module_count"])
        self.assertEqual(
            ["g:app:jar:1", "x:one:jar:1", "x:two:jar:1", "t:target:jar:1"],
            report["modules"][0]["paths"][0])

    def test_unresolved_modules_are_excluded_and_reported(self):
        model = model_with_app_and_other()
        model.add_module(module("com.acme:broken:1", None,
                                analysis_status="maven_error",
                                completeness="partial",
                                error="resolution failed"))
        report = blast_radius(model, "vuln.lib:core:1")
        self.assertEqual("partial", report["completeness"])
        self.assertEqual(
            {"com.acme:broken:1": "resolution failed"},
            {m["coord_id"]: m["reason"] for m in report["excluded_modules"]})
        # The resolved modules are still fully reported.
        self.assertEqual(2, report["affected_module_count"])

    def test_static_tree_is_excluded_from_resolved_impact(self):
        model = GraphModel(root="/repo", source="pom-static",
                           completeness="partial")
        model.add_module(module("com.acme:app:1", APP_DOT,
                                source="pom-static",
                                analysis_status="partial_static",
                                completeness="partial"))
        report = blast_radius(model, "vuln.lib:core:1")
        self.assertEqual([], report["matches"])
        self.assertEqual(0, report["affected_module_count"])
        self.assertEqual("partial", report["completeness"])
        self.assertIn("not Maven-resolved", report["excluded_modules"][0]["reason"])

    def test_affected_modules_helper_is_compact(self):
        rows = affected_modules(model_with_app_and_other(), "vuln.lib:core:1")
        self.assertEqual(2, len(rows))
        self.assertEqual(
            {"module", "pom_path", "relationship", "min_depth", "scopes",
             "introduced_by"},
            set(rows[0]))


class DependencyRouteTests(unittest.TestCase):
    def test_route_from_module_root_to_library(self):
        report = dependency_routes(model_with_app_and_other(),
                                   "com.acme:app:1", "vuln.lib:core:1")
        self.assertEqual(1, report["route_count"])
        route = report["routes"][0]
        self.assertEqual("com.acme:app:1", route["module"])
        self.assertTrue(route["origin_is_module_root"])
        self.assertEqual(2, route["depth"])
        self.assertEqual(
            ["com.acme:app:jar:1", "mid.lib:mid:jar:1", "vuln.lib:core:jar:1"],
            route["path"])

    def test_route_between_two_libraries(self):
        report = dependency_routes(model_with_app_and_other(),
                                   "mid.lib:mid:1", "shared.lib:common:1")
        self.assertEqual(1, report["route_count"])
        self.assertFalse(report["routes"][0]["origin_is_module_root"])
        self.assertEqual(
            ["mid.lib:mid:jar:1", "shared.lib:common:jar:1"],
            report["routes"][0]["path"])

    def test_no_route_is_explicit(self):
        report = dependency_routes(model_with_app_and_other(),
                                   "vuln.lib:core:1", "com.acme:app:1")
        self.assertEqual(0, report["route_count"])
        self.assertIn("No resolved route", report["note"])

    def test_missing_coordinate_is_explicit(self):
        report = dependency_routes(model_with_app_and_other(),
                                   "nope:missing:1", "vuln.lib:core:1")
        self.assertEqual(0, report["route_count"])
        self.assertIn("'from' coordinate", report["note"])

    def test_routes_are_bounded_and_reported(self):
        dot = (
            'digraph "g:app:jar:1" {\n'
            '"g:app:jar:1" -> "x:a:jar:1:compile"\n'
            '"g:app:jar:1" -> "x:b:jar:1:compile"\n'
            '"x:a:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '"x:b:jar:1:compile" -> "t:target:jar:1:compile"\n'
            '}\n'
        )
        model = one_module(dot)
        report = dependency_routes(model, "g:app:1", "t:target:1", max_paths=1)
        self.assertEqual(1, report["route_count"])
        self.assertTrue(report["truncated"])

    def test_invalid_coordinate_raises_value_error(self):
        with self.assertRaises(ValueError):
            dependency_routes(model_with_app_and_other(), "core",
                              "vuln.lib:core:1")

    def test_routes_include_scopes(self):
        report = dependency_routes(model_with_app_and_other(),
                                   "com.acme:app:1", "direct.lib:direct:2")
        self.assertEqual(["runtime"], report["routes"][0]["scopes"])


def one_module(dot):
    model = GraphModel(root="/repo")
    model.add_module(module("g:app:1", dot))
    return model


if __name__ == "__main__":
    unittest.main()
