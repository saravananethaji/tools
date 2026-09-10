import os
import asyncio
import io
import json
import tempfile
import unittest
import shutil
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, UploadFile

import app
from graph_model import GraphModel, Module, SCAN_SCHEMA_VERSION, _tree_from_dict
from maven_runner import (
    CACHE_SCHEMA_VERSION,
    MAVEN_COMMAND_SIGNATURE,
    _cache_is_compatible,
    _scan_input_fingerprint,
    parse_dot_to_tree,
    build_model,
    run_mvn_dependency_tree,
)
from neo4j_export import export_cypher
from pom_parser import ParentInfo, PomInfo, ProjectClassifier, parse_pom


DIAMOND_DOT = '''digraph "g:root:jar:1" {
"g:root:jar:1" -> "g:left:jar:1:compile"
"g:root:jar:1" -> "g:right:jar:1:compile"
"g:left:jar:1:compile" -> "g:shared:jar:tests:1:compile"
"g:right:jar:1:compile" -> "g:shared:jar:tests:1:compile"
"g:right:jar:1:compile" -> "g:shared:jar:1:compile"
}'''


class CoreBehaviorTests(unittest.TestCase):
    @patch("maven_runner.subprocess.run")
    @patch("shutil.which", return_value="mvn")
    def test_maven_analysis_is_non_recursive(self, _which, run):
        def complete(command, **_kwargs):
            output_arg = next(arg for arg in command if arg.startswith("-DoutputFile="))
            Path(output_arg.split("=", 1)[1]).write_text('digraph "g:root:jar:1" {\n}\n')
            return type("Result", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        run.side_effect = complete
        ok, _dot, error = run_mvn_dependency_tree(".")

        self.assertTrue(ok, error)
        self.assertIn("--non-recursive", run.call_args.args[0])

    @unittest.skipUnless(shutil.which("mvn.cmd" if os.name == "nt" else "mvn"), "Maven not installed")
    def test_controlled_maven_fixture_has_direct_and_transitive_dependencies(self):
        fixture = Path(__file__).parent / "fixtures" / "maven" / "resolved-app"
        pom = parse_pom(str(fixture / "pom.xml"))
        ok, dot, error = run_mvn_dependency_tree(str(fixture))
        self.assertTrue(ok, error)
        tree = parse_dot_to_tree(dot, pom.coord)
        self.assertIsNotNone(tree)
        self.assertEqual(
            ["httpclient", "commons-codec"],
            [child.artifactId for child in tree.children],
        )
        httpclient = tree.children[0]
        self.assertIn("httpcore", [child.artifactId for child in httpclient.children])

    def test_preserves_diamond_paths_and_classifier_variants(self):
        tree = parse_dot_to_tree(DIAMOND_DOT, "g:root:1")

        self.assertEqual(["left", "right"], [c.artifactId for c in tree.children])
        self.assertEqual("tests", tree.children[0].children[0].classifier)
        self.assertEqual(2, len(tree.children[1].children))

        restored = _tree_from_dict(tree.to_dict())
        self.assertEqual("tests", restored.children[0].children[0].classifier)

    def test_rejects_dot_output_for_a_different_reactor_module(self):
        wrong = 'digraph "g:other:jar:1" {\n}\n'
        self.assertIsNone(parse_dot_to_tree(wrong, "g:requested:1"))

    def test_accepts_effective_maven_version_for_revision_placeholder(self):
        dot = 'digraph "g:app:jar:2.4.0" {\n}\n'
        tree = parse_dot_to_tree(dot, "g:app:${revision}")
        self.assertEqual("2.4.0", tree.version)

    def test_scan_round_trip_preserves_edge_provenance(self):
        tree = parse_dot_to_tree(DIAMOND_DOT, "g:root:1")
        model = GraphModel(root="/repo", scan_id="scan-1")
        model.add_module(Module(
            pom_path="/repo/pom.xml",
            dir_path="/repo",
            coord_id="g:root:1",
            groupId="g",
            artifactId="root",
            version="1",
            tree=tree,
            analysis_status="resolved",
            completeness="complete",
            dependency_count=5,
        ))

        payload = model.to_dict()
        self.assertEqual(SCAN_SCHEMA_VERSION, payload["schema_version"])
        self.assertTrue(all(e["module_id"] == "g:root:1" for e in payload["edges"]))
        self.assertEqual(2, sum(1 for e in payload["edges"] if e["direct"]))

        restored = GraphModel.from_dict(payload)
        self.assertEqual(payload, restored.to_dict())

    def test_cache_contract_rejects_changed_inputs(self):
        with tempfile.TemporaryDirectory() as root:
            pom = Path(root, "pom.xml")
            pom.write_text("<project/>")
            first = _scan_input_fingerprint(root, [str(pom)])
            cache = {
                "cache_schema_version": CACHE_SCHEMA_VERSION,
                "command_signature": MAVEN_COMMAND_SIGNATURE,
                "input_fingerprint": first,
                "maven_version": "Apache Maven test",
                "analysis_status": "resolved",
                "created_at": __import__("time").time(),
            }
            self.assertTrue(_cache_is_compatible(cache, first, "Apache Maven test"))

            pom.write_text("<project><version>2</version></project>")
            second = _scan_input_fingerprint(root, [str(pom)])
            self.assertNotEqual(first, second)
            self.assertFalse(_cache_is_compatible(cache, second, "Apache Maven test"))

    def test_classifier_terminates_parent_cycle(self):
        first = PomInfo(
            path="/a/pom.xml", directory="/a", groupId="g", artifactId="a",
            version="1", packaging="jar", parent=ParentInfo("g", "b", "1"),
        )
        second = PomInfo(
            path="/b/pom.xml", directory="/b", groupId="g", artifactId="b",
            version="1", packaging="jar", parent=ParentInfo("g", "a", "1"),
        )
        result = ProjectClassifier.classify(first, [first, second])
        self.assertIn(result[0], {"Library", "Other Module"})

    def test_static_import_ignores_derived_dependency_fields(self):
        payload = {
            "schema_version": SCAN_SCHEMA_VERSION,
            "metadata": {
                "root": "/repo",
                "source": "pom-static",
                "completeness": "partial",
            },
            "projects": [{
                "coordinates": {
                    "groupId": "g", "artifactId": "app",
                    "version": "1", "packaging": "jar",
                },
                "dependencies": [{
                    "groupId": "x", "artifactId": "lib", "version": "2",
                    "coord_id": "x:lib:2", "ga": "x:lib", "is_direct": True,
                }],
            }],
        }
        upload = UploadFile(
            filename="static.json",
            file=io.BytesIO(json.dumps(payload).encode("utf-8")),
        )
        response = asyncio.run(app.api_load_json(upload))
        body = json.loads(response.body)
        self.assertEqual(1, body["modules"])
        self.assertEqual("partial", body["completeness"])

    @patch("maven_runner._maven_version", return_value="Apache Maven test")
    def test_build_model_distinguishes_resolved_empty_and_failure(self, _version):
        cases = [
            (
                "resolved",
                (True, 'digraph "g:app:jar:1" {\n'
                       '"g:app:jar:1" -> "x:lib:jar:2:compile"\n}\n', ""),
                1,
            ),
            ("empty", (True, 'digraph "g:app:jar:1" {\n}\n', ""), 0),
            ("maven_error", (False, "", "resolution failed"), 0),
        ]
        for expected_status, result, expected_count in cases:
            with self.subTest(expected_status), tempfile.TemporaryDirectory() as root:
                Path(root, "pom.xml").write_text(
                    "<project><modelVersion>4.0.0</modelVersion>"
                    "<groupId>g</groupId><artifactId>app</artifactId>"
                    "<version>1</version></project>"
                )
                with patch("maven_runner.run_mvn_dependency_tree", return_value=result):
                    model = build_model(root, str(Path(root, "cache")), force_reload=True)
                module = model.modules[0]
                self.assertEqual(expected_status, module.analysis_status)
                self.assertEqual(expected_count, module.dependency_count)
                self.assertEqual(
                    "complete" if expected_status != "maven_error" else "partial",
                    module.completeness,
                )

    @patch("maven_runner._maven_version", return_value="Apache Maven test")
    def test_fresh_and_cached_scans_preserve_the_same_tree(self, _version):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "pom.xml").write_text(
                "<project><modelVersion>4.0.0</modelVersion>"
                "<groupId>g</groupId><artifactId>app</artifactId>"
                "<version>1</version></project>"
            )
            cache = str(Path(root, "cache"))
            result = (
                True,
                'digraph "g:app:jar:1" {\n'
                '"g:app:jar:1" -> "x:lib:jar:2:compile"\n}\n',
                "",
            )
            with patch("maven_runner.run_mvn_dependency_tree", return_value=result):
                fresh = build_model(root, cache, force_reload=True)
            with patch("maven_runner.run_mvn_dependency_tree") as runner:
                cached = build_model(root, cache)

            runner.assert_not_called()
            self.assertEqual(
                fresh.modules[0].tree.to_dict(),
                cached.modules[0].tree.to_dict(),
            )
            self.assertEqual("fresh", fresh.modules[0].cache_state)
            self.assertEqual("cached", cached.modules[0].cache_state)

    def test_conflicts_exclude_unrelated_module_roots(self):
        model = GraphModel(root="/repo")
        for version in ("1", "2"):
            tree = parse_dot_to_tree(
                f'digraph "g:app:jar:{version}" {{\n}}\n',
                f"g:app:{version}",
            )
            model.add_module(Module(
                pom_path=f"/repo/{version}/pom.xml",
                dir_path=f"/repo/{version}",
                coord_id=f"g:app:{version}",
                groupId="g",
                artifactId="app",
                version=version,
                tree=tree,
            ))
        self.assertEqual([], model.conflicts())

    def test_conflicts_use_resolved_dependency_versions(self):
        model = GraphModel(root="/repo")
        for module_name, library_version in (("one", "1"), ("two", "2")):
            dot = (
                f'digraph "g:{module_name}:jar:1" {{\n'
                f'"g:{module_name}:jar:1" -> '
                f'"x:shared:jar:{library_version}:compile"\n}}\n'
            )
            model.add_module(Module(
                pom_path=f"/repo/{module_name}/pom.xml",
                dir_path=f"/repo/{module_name}",
                coord_id=f"g:{module_name}:1",
                groupId="g",
                artifactId=module_name,
                version="1",
                tree=parse_dot_to_tree(dot, f"g:{module_name}:1"),
            ))

        conflicts = model.conflicts()
        self.assertEqual(["x:shared"], [conflict.artifact_key for conflict in conflicts])
        self.assertEqual(["1", "2"], conflicts[0].versions)

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
        cypher = export_cypher(model)
        self.assertIn("IF NOT EXISTS", cypher)
        self.assertIn("moduleId: 'g:root:1'", cypher)
        self.assertIn("direct: true", cypher)

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
