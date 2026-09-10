"""Tests for the scan-health diagnostic summary."""

import unittest

from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree
from scan_diagnostics import build_scan_diagnostics


def resolved_module() -> Module:
    tree = parse_dot_to_tree(
        'digraph "g:app:jar:1" {\n"g:app:jar:1" -> "x:lib:jar:2:compile"\n}',
        "g:app:1",
    )
    return Module(
        pom_path="/repo/app/pom.xml", dir_path="/repo/app", coord_id="g:app:1",
        groupId="g", artifactId="app", version="1", tree=tree,
        analysis_status="resolved", completeness="complete", dependency_count=1,
        cache_state="fresh", maven_version="Apache Maven 3.9.9",
    )


class ScanDiagnosticsTests(unittest.TestCase):
    def test_complete_resolved_scan_has_counts_and_metadata(self):
        model = GraphModel(root="/repo", scan_id="scan-1")
        model.add_module(resolved_module())

        report = build_scan_diagnostics(model)
        self.assertEqual("complete", report["completeness"])
        self.assertEqual(1, report["module_count"])
        self.assertEqual(1, report["resolved_module_count"])
        self.assertEqual(1, report["dependency_count"])
        self.assertEqual({"fresh": 1}, report["cache_state_counts"])
        self.assertEqual(["Apache Maven 3.9.9"], report["maven_versions"])
        self.assertEqual([], report["excluded_modules"])

    def test_failure_is_visible_not_counted_as_an_empty_tree(self):
        model = GraphModel(root="/repo")
        model.add_module(resolved_module())
        model.add_module(Module(
            pom_path="/repo/broken/pom.xml", dir_path="/repo/broken",
            coord_id="g:broken:1", groupId="g", artifactId="broken", version="1",
            analysis_status="maven_error", completeness="partial", cache_state="fresh",
            error="Could not resolve dependencies",
        ))

        report = build_scan_diagnostics(model)
        self.assertEqual("partial", report["completeness"])
        self.assertEqual(1, report["resolved_module_count"])
        self.assertEqual(1, report["excluded_module_count"])
        self.assertEqual("Could not resolve dependencies", report["excluded_modules"][0]["reason"])

    def test_static_data_is_explicitly_partial(self):
        model = GraphModel(root="/repo", source="pom-static", completeness="partial")
        static = resolved_module()
        static.source = "pom-static"
        static.completeness = "partial"
        model.add_module(static)

        report = build_scan_diagnostics(model)
        self.assertEqual("partial", report["completeness"])
        self.assertEqual(0, report["resolved_module_count"])
        self.assertEqual(1, report["excluded_module_count"])
