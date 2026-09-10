"""Isolated Maven version-resolution previews.

This deliberately patches only an explicit existing version token in a
temporary POM-only mirror. It never writes the selected workspace.
"""
from __future__ import annotations

import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from graph_model import GraphModel, has_maven_resolved_tree
from maven_runner import parse_dot_to_tree, run_mvn_dependency_tree

MAX_MODULES = 25
MODES = {"direct", "dependency-management", "bom", "property"}


def _local(element, name):
    return next((x for x in element if x.tag.rsplit("}", 1)[-1] == name), None)


def _text(element, name):
    child = _local(element, name)
    return child.text.strip() if child is not None and child.text else None


def _version_element(root, target_ga, mode, property_name=None):
    if mode == "property":
        props = _local(root, "properties")
        if props is None or not property_name:
            raise ValueError("Select an existing version property")
        result = next((x for x in props if x.tag.rsplit("}", 1)[-1] == property_name), None)
        if result is None or not result.text:
            raise ValueError("Selected version property does not exist")
        reference = "${" + property_name + "}"
        feeds_target = False
        for parent in (_local(root, "dependencies"),
                       _local(_local(root, "dependencyManagement"), "dependencies")
                       if _local(root, "dependencyManagement") is not None else None):
            for dep in parent or []:
                if (dep.tag.rsplit("}", 1)[-1] == "dependency"
                        and f"{_text(dep, 'groupId')}:{_text(dep, 'artifactId')}" == target_ga
                        and _text(dep, "version") == reference):
                    feeds_target = True
        if not feeds_target:
            raise ValueError("Selected property does not feed the requested dependency in this POM")
        return result
    deps_parent = _local(root, "dependencies")
    if mode in {"dependency-management", "bom"}:
        management = _local(root, "dependencyManagement")
        deps_parent = _local(management, "dependencies") if management is not None else None
    if deps_parent is None:
        raise ValueError("Selected control point has no dependencies section")
    for dep in deps_parent:
        if dep.tag.rsplit("}", 1)[-1] != "dependency":
            continue
        if f"{_text(dep, 'groupId')}:{_text(dep, 'artifactId')}" != target_ga:
            continue
        if mode == "bom" and not (_text(dep, "type") == "pom" and _text(dep, "scope") == "import"):
            continue
        version = _local(dep, "version")
        if version is None or not version.text:
            raise ValueError("Selected dependency has no literal version to preview")
        if "${" in version.text:
            raise ValueError("Version is property-backed; select property mode and the exact property")
        return version
    raise ValueError("Selected control point does not contain the requested dependency")


def _paths(node, prefix=None, ancestors=None):
    """Return root-to-node artifact paths without following a cyclic branch."""
    prefix = (prefix or []) + [node.artifact_id]
    ancestors = (ancestors or set()) | {node.artifact_id}
    out = [prefix]
    for child in node.children:
        if child.artifact_id not in ancestors:
            out.extend(_paths(child, prefix, ancestors))
    return out


def _changed_paths(before, after):
    left, right = {tuple(p) for p in _paths(before)}, {tuple(p) for p in _paths(after)}
    return {"removed": [list(p) for p in sorted(left - right)], "added": [list(p) for p in sorted(right - left)]}


def run_preview(model: GraphModel, cache_dir: str, *, target_ga: str,
                requested_version: str, control_module: str, mode: str,
                property_name: str | None = None, allow_network: bool = False) -> dict:
    """Patch one explicit version token in an isolated mirror and resolve it."""
    if model.source != "maven-resolved" or not model.modules or not all(has_maven_resolved_tree(m) for m in model.modules):
        raise ValueError("A complete local Maven-resolved scan is required")
    if mode not in MODES or not requested_version.strip() or target_ga.count(":") != 1:
        raise ValueError("Invalid target, requested version, or preview mode")
    control = next((m for m in model.modules if m.coord_id == control_module), None)
    if control is None:
        raise ValueError("Select a module from the current scan as the control point")
    root = Path(model.root).resolve()
    if not Path(control.pom_path).resolve().is_relative_to(root):
        raise ValueError("Control POM is outside the selected workspace")
    affected = [
        module for module in model.modules
        if target_ga in {
            ":".join(artifact.split(":")[:2])
            for path in _paths(module.tree) for artifact in path
        }
    ]
    if not affected:
        affected = [control]
    if len(affected) > MAX_MODULES:
        raise ValueError(f"Preview affects {len(affected)} modules; select a narrower control point")
    preview_base = Path(cache_dir) / "previews"
    preview_base.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="resolution-", dir=preview_base))
    source_poms = {Path(m.pom_path).resolve(): Path(m.pom_path).read_bytes()
                   for m in model.modules}
    try:
        # POM-only mirror preserves all relative parent/module paths needed by Maven.
        for source in source_poms:
            relative = source.relative_to(root)
            destination = workspace / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        if (root / ".mvn").is_dir():
            shutil.copytree(root / ".mvn", workspace / ".mvn", dirs_exist_ok=True)
        patched = workspace / Path(control.pom_path).resolve().relative_to(root)
        tree = ET.parse(patched); version = _version_element(tree.getroot(), target_ga, mode, property_name)
        version.text = requested_version.strip(); tree.write(patched, encoding="utf-8", xml_declaration=True)
        preview_repo = workspace / ".projectgraph-m2"
        extra = [f"-Dmaven.repo.local={preview_repo}"] + ([] if allow_network else ["--offline"])
        modules = []
        verdict = "resolved"
        for baseline in affected:
            mirrored = workspace / Path(baseline.pom_path).resolve().relative_to(root)
            ok, dot, error = run_mvn_dependency_tree(str(mirrored.parent), extra_args=extra)
            if not ok:
                modules.append({"module": baseline.coord_id, "status": "blocked", "error": error})
                verdict = "blocked"; continue
            preview_tree = parse_dot_to_tree(dot, baseline.coord_id)
            if preview_tree is None:
                modules.append({"module": baseline.coord_id, "status": "blocked", "error": "Preview DOT root mismatch"})
                verdict = "blocked"; continue
            changes = _changed_paths(baseline.tree, preview_tree)
            resolved_versions = {
                node.rsplit(":", 1)[-1]
                for path in _paths(preview_tree) for node in path
                if target_ga == ":".join(node.split(":")[:2])
            }
            # "Old version disappeared" is not sufficient: Maven might have
            # selected a third version. A resolved result means the requested
            # version is the only selected version for this GA.
            status = ("resolved" if resolved_versions == {requested_version}
                      else "partially-resolved")
            if status != "resolved" and verdict == "resolved": verdict = status
            modules.append({"module": baseline.coord_id, "status": status,
                            "resolved_versions": sorted(resolved_versions),
                            "changed_subtrees": changes})
        return {"verdict": verdict, "target": target_ga, "requested_version": requested_version,
                "control_module": control_module, "mode": mode, "network_mode": "allowed" if allow_network else "offline",
                "modules": modules, "workspace_mutated": False}
    finally:
        changed = [str(path) for path, original in source_poms.items()
                   if path.read_bytes() != original]
        if changed:
            raise RuntimeError("Preview safety violation: source POM changed")
        shutil.rmtree(workspace, ignore_errors=True)
