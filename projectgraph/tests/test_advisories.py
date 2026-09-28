import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from advisories import refresh, report
from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree


DOT = '''digraph "g:app:jar:1" {
"g:app:jar:1" -> "org.example:library:jar:1.0:compile"
}'''


def model() -> GraphModel:
    graph = GraphModel(root="/repo")
    graph.add_module(Module(pom_path="/repo/pom.xml", dir_path="/repo", coord_id="g:app:1",
        groupId="g", artifactId="app", version="1", tree=parse_dot_to_tree(DOT, "g:app:1"),
        analysis_status="resolved", source="maven-resolved", completeness="complete"))
    return graph


class AdvisoryCacheTests(unittest.TestCase):
    def test_refresh_stores_exact_osv_result_with_ghsa_and_cve(self):
        record = {"id": "GHSA-test-0000-0000", "summary": "Example issue", "aliases":
                  [{"id": "GHSA-test-0000-0000"}, {"id": "CVE-2026-12345"}],
                  "database_specific": {"severity": "HIGH"}, "references": ["https://example.test/advisory"]}
        with tempfile.TemporaryDirectory() as cache:
            with patch("advisories._query", return_value={"org.example:library:jar:1.0": [record["id"]]}), \
                 patch("advisories._get_json", return_value=record):
                result = refresh(model(), cache)
            self.assertEqual("ready", result["status"])
            self.assertEqual(1, len(result["findings"]))
            finding = result["findings"][0]
            self.assertEqual(["GHSA-test-0000-0000"], finding["ghsas"])
            self.assertEqual(["CVE-2026-12345"], finding["cves"])
            self.assertEqual("direct", finding["library"]["consumers"][0]["relationship"])

    def test_failed_refresh_keeps_the_previous_local_database(self):
        record = {"id": "GHSA-test-0000-0000", "aliases": []}
        with tempfile.TemporaryDirectory() as cache:
            with patch("advisories._query", return_value={"org.example:library:jar:1.0": [record["id"]]}), \
                 patch("advisories._get_json", return_value=record):
                refresh(model(), cache)
            with patch("advisories._query", side_effect=OSError("offline")):
                with self.assertRaisesRegex(RuntimeError, "last local data was kept"):
                    refresh(model(), cache)
            self.assertEqual("ready", report(model(), cache)["status"])

    def test_no_database_is_not_reported_as_safe(self):
        with tempfile.TemporaryDirectory() as cache:
            self.assertEqual("not_downloaded", report(model(), cache)["status"])
