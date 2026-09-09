import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import app
from graph_model import GraphModel, Module, _tree_from_dict
from maven_runner import parse_dot_to_tree
from neo4j_export import export_cypher


DIAMOND_DOT = '''digraph "g:root:jar:1" {
"g:root:jar:1" -> "g:left:jar:1:compile"
"g:root:jar:1" -> "g:right:jar:1:compile"
"g:left:jar:1:compile" -> "g:shared:jar:tests:1:compile"
"g:right:jar:1:compile" -> "g:shared:jar:tests:1:compile"
"g:right:jar:1:compile" -> "g:shared:jar:1:compile"
}'''


class CoreBehaviorTests(unittest.TestCase):
    def test_preserves_diamond_paths_and_classifier_variants(self):
        tree = parse_dot_to_tree(DIAMOND_DOT, "g:root:1")

        self.assertEqual(["left", "right"], [c.artifactId for c in tree.children])
        self.assertEqual("tests", tree.children[0].children[0].classifier)
        self.assertEqual(2, len(tree.children[1].children))

        restored = _tree_from_dict(tree.to_dict())
        self.assertEqual("tests", restored.children[0].children[0].classifier)

    def test_export_has_lossless_ids_and_idempotent_constraint(self):
        tree = parse_dot_to_tree(DIAMOND_DOT, "g:root:1")
        model = GraphModel()
        model.add_module(Module(
            pom_path="pom.xml", dir_path=".", coord_id="g:root:1",
            groupId="g", artifactId="root", version="1", tree=tree,
        ))

        artifact_ids = {artifact["id"] for artifact in model.all_artifacts()}
        self.assertIn("g:shared:jar:1", artifact_ids)
        self.assertIn("g:shared:jar:tests:1", artifact_ids)
        self.assertIn("IF NOT EXISTS", export_cypher(model))

    def test_root_validation_enforces_configured_boundary(self):
        with tempfile.TemporaryDirectory() as allowed, tempfile.TemporaryDirectory() as denied:
            child = Path(allowed, "child")
            child.mkdir()
            with patch.dict(os.environ, {"PROJECTGRAPH_ALLOWED_ROOTS": allowed}):
                self.assertEqual(str(child.resolve()), app._validate_root_path(str(child)))
                with self.assertRaises(HTTPException) as caught:
                    app._validate_root_path(denied)
                self.assertEqual(403, caught.exception.status_code)


if __name__ == "__main__":
    unittest.main()
