"""Safety and evidence tests for isolated Maven resolution previews."""

import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

from graph_model import GraphModel, Module
from maven_runner import parse_dot_to_tree
from resolution_preview import _changed_paths, _version_element, run_preview


BASE_DOT = '''digraph "g:app:jar:1" {
"g:app:jar:1" -> "x:lib:jar:1:compile"
}'''
PREVIEW_DOT = '''digraph "g:app:jar:1" {
"g:app:jar:1" -> "x:lib:jar:2:compile"
}'''
THIRD_VERSION_DOT = '''digraph "g:app:jar:1" {
"g:app:jar:1" -> "x:lib:jar:3:compile"
}'''


def module(root: Path) -> Module:
    pom = root / "app" / "pom.xml"
    return Module(
        pom_path=str(pom), dir_path=str(pom.parent), coord_id="g:app:1",
        groupId="g", artifactId="app", version="1",
        tree=parse_dot_to_tree(BASE_DOT, "g:app:1"),
        analysis_status="resolved", source="maven-resolved", completeness="complete",
    )


class ResolutionPreviewTests(unittest.TestCase):
    def test_property_control_must_exist(self):
        root = ET.fromstring(
            "<project><properties><lib.version>1</lib.version></properties><dependencies>"
            "<dependency><groupId>x</groupId><artifactId>lib</artifactId>"
            "<version>${lib.version}</version></dependency></dependencies></project>"
        )
        self.assertEqual("1", _version_element(root, "x:lib", "property", "lib.version").text)
        with self.assertRaisesRegex(ValueError, "does not exist"):
            _version_element(root, "x:lib", "property", "missing")
        with self.assertRaisesRegex(ValueError, "does not feed"):
            _version_element(root, "x:other", "property", "lib.version")

    def test_changed_paths_preserve_the_actual_branch(self):
        before = parse_dot_to_tree(BASE_DOT, "g:app:1")
        after = parse_dot_to_tree(PREVIEW_DOT, "g:app:1")
        changes = _changed_paths(before, after)
        self.assertEqual([["g:app:jar:1", "x:lib:jar:1"]], changes["removed"])
        self.assertEqual([["g:app:jar:1", "x:lib:jar:2"]], changes["added"])

    def test_preview_patches_only_a_temporary_pom_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"; pom = root / "app" / "pom.xml"
            pom.parent.mkdir(parents=True)
            original = ("<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId>"
                        "<artifactId>app</artifactId><version>1</version><dependencies>"
                        "<dependency><groupId>x</groupId><artifactId>lib</artifactId>"
                        "<version>1</version></dependency></dependencies></project>")
            pom.write_text(original)
            model = GraphModel(root=str(root)); model.add_module(module(root))
            cache = Path(directory) / "cache"

            def resolve(pom_dir, **_kwargs):
                self.assertIn("<version>2</version>", (Path(pom_dir) / "pom.xml").read_text())
                self.assertNotEqual(str(Path(pom_dir).resolve()), str(pom.parent.resolve()))
                return True, PREVIEW_DOT, ""

            with patch("resolution_preview.run_mvn_dependency_tree", side_effect=resolve):
                report = run_preview(model, str(cache), target_ga="x:lib", requested_version="2",
                                     control_module="g:app:1", mode="direct")
            self.assertEqual("resolved", report["verdict"])
            self.assertEqual(original, pom.read_text())
            self.assertEqual([], list((cache / "previews").iterdir()))

    def test_partial_or_static_baseline_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "pom.xml").write_text("<project/>")
            model = GraphModel(root=str(root), source="pom-static")
            candidate = module(root)
            candidate.source = "pom-static"
            model.add_module(candidate)
            with self.assertRaisesRegex(ValueError, "complete local Maven-resolved"):
                run_preview(model, str(root / "cache"), target_ga="x:lib", requested_version="2",
                            control_module="g:app:1", mode="direct")

    def test_a_third_resolved_version_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"; pom = root / "app" / "pom.xml"
            pom.parent.mkdir(parents=True)
            pom.write_text("<project><dependencies><dependency><groupId>x</groupId>"
                           "<artifactId>lib</artifactId><version>1</version>"
                           "</dependency></dependencies></project>")
            model = GraphModel(root=str(root)); model.add_module(module(root))
            with patch("resolution_preview.run_mvn_dependency_tree",
                       return_value=(True, THIRD_VERSION_DOT, "")):
                report = run_preview(model, str(Path(directory) / "cache"), target_ga="x:lib",
                                     requested_version="2", control_module="g:app:1", mode="direct")
            self.assertEqual("partially-resolved", report["verdict"])
            self.assertEqual(["3"], report["modules"][0]["resolved_versions"])
