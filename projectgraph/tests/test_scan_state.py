"""Tests for restoring exactly one last successful resolved scan."""

import tempfile
import unittest
from pathlib import Path

from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree
from scan_state import load_last_scan, save_last_scan


def resolved_model() -> GraphModel:
    model = GraphModel(root="/repo/projects", scan_id="scan-1")
    tree = parse_dot_to_tree(
        'digraph "g:app:jar:1" {\n'
        '"g:app:jar:1" -> "x:lib:jar:2:compile"\n'
        '}\n',
        "g:app:1",
    )
    model.add_module(Module(
        pom_path="/repo/projects/app/pom.xml",
        dir_path="/repo/projects/app",
        coord_id="g:app:1",
        groupId="g",
        artifactId="app",
        version="1",
        tree=tree,
        analysis_status="resolved",
        completeness="complete",
    ))
    return model


class LastScanTests(unittest.TestCase):
    def test_saved_resolved_scan_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "last-resolved-scan.json"
            self.assertTrue(save_last_scan(path, resolved_model()))
            restored = load_last_scan(path)
        self.assertIsNotNone(restored)
        self.assertEqual("/repo/projects", restored.root)
        self.assertEqual("g:app:1", restored.modules[0].coord_id)
        self.assertEqual("x:lib:jar:2", restored.modules[0].tree.children[0].artifact_id)

    def test_partial_static_scan_does_not_replace_last_resolved_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "last-resolved-scan.json"
            self.assertTrue(save_last_scan(path, resolved_model()))
            static = resolved_model()
            static.source = "pom-static"
            static.modules[0].source = "pom-static"
            static.modules[0].completeness = "partial"
            self.assertFalse(save_last_scan(path, static))
            restored = load_last_scan(path)
        self.assertEqual("maven-resolved", restored.source)

    def test_corrupt_snapshot_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "last-resolved-scan.json"
            path.write_text("not JSON", encoding="utf-8")
            self.assertIsNone(load_last_scan(path))


if __name__ == "__main__":
    unittest.main()
