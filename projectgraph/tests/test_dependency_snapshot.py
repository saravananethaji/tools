"""Tests for portable Dependency Snapshot export/import."""

import asyncio
import io
import json
import unittest

from fastapi import UploadFile

import app
from dependency_snapshot import SNAPSHOT_FORMAT, export_snapshot, import_snapshot
from graph_model import GraphModel, Module, TreeNode


class DependencySnapshotTests(unittest.TestCase):
    def _model(self):
        model = GraphModel(root="C:/projects/example", scan_id="scan-1")
        model.add_module(Module(
            pom_path="C:/projects/example/pom.xml",
            dir_path="C:/projects/example",
            coord_id="com.example:app:1.0.0",
            groupId="com.example",
            artifactId="app",
            version="1.0.0",
            tree=TreeNode("com.example:app:1.0.0", "com.example", "app", "1.0.0", "compile", "jar"),
            analysis_status="resolved",
            completeness="complete",
        ))
        return model

    def test_export_round_trips_the_canonical_model(self):
        model = self._model()
        snapshot = export_snapshot(model)

        self.assertEqual(SNAPSHOT_FORMAT, snapshot["snapshot_format"])
        self.assertIn("exported_at", snapshot)
        self.assertNotIn("cache_state", snapshot)
        self.assertEqual(model.to_dict(), import_snapshot(snapshot).to_dict())

    def test_rejects_cache_or_unknown_format(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            import_snapshot({"snapshot_format": "wrong", "scan": {}})

    def test_api_import_marks_snapshot_read_only(self):
        original_state = app._state.copy()
        try:
            upload = UploadFile(
                filename="dependency-snapshot.json",
                file=io.BytesIO(json.dumps(export_snapshot(self._model())).encode("utf-8")),
            )
            response = asyncio.run(app.api_load_snapshot(upload))
            body = json.loads(response.body)
            self.assertTrue(body["read_only"])
            self.assertTrue(app._state["read_only_snapshot"])
        finally:
            app._state.clear()
            app._state.update(original_state)
