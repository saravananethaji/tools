"""Maven runner: find poms, run `mvn dependency:tree -DoutputType=dot`,
parse the DOT output into a tree, and keep an on-disk JSON cache.

Cache is keyed by pom path + file mtime. On explicit reload, Maven is
re-run and the cache refreshed.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from graph_model import (
    GraphModel,
    Module,
    TreeNode,
    parse_maven_coordinate,
)


NS = {"m": "http://maven.apache.org/POM/4.0.0"}
NS_FALLBACK = {"m": ""}


# ----------------------------------------------------------------------
# Pom discovery
# ----------------------------------------------------------------------

def find_poms(root_dir: str) -> List[str]:
    """Find all pom.xml files under root_dir (excluding target/)."""
    poms: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        # skip build output dirs
        dirnames[:] = [d for d in dirnames if d != "target"]
        if "pom.xml" in filenames:
            poms.append(os.path.join(dirpath, "pom.xml"))
    return sorted(poms)


def _localname(tag: str) -> str:
    """Strip XML namespace from an ElementTree tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_local(root, tag):
    """Find first child of root whose local tag name matches, ignoring namespace."""
    for el in root:
        if _localname(el.tag) == tag:
            return el
    return None


def parse_pom_coords(pom_path: str) -> Tuple[str, str, str]:
    """Return (groupId, artifactId, version) from a pom.xml.
    Namespace-agnostic (handles both the standard maven namespace and
    custom/fake namespaces). Inherits parent groupId/version if not set.
    """
    tree = ET.parse(pom_path)
    root = tree.getroot()

    def _text(tag):
        el = _find_local(root, tag)
        return el.text.strip() if el is not None and el.text else None

    gid = _text("groupId")
    aid = _text("artifactId")
    ver = _text("version")

    # inherit from parent if missing
    if not gid or not ver:
        parent = _find_local(root, "parent")
        if parent is not None:
            if not gid:
                p = _find_local(parent, "groupId")
                if p is not None and p.text:
                    gid = p.text.strip()
            if not ver:
                p = _find_local(parent, "version")
                if p is not None and p.text:
                    ver = p.text.strip()

    gid = gid or "unknown"
    aid = aid or "unknown"
    ver = ver or "unknown"
    return gid, aid, ver


# ----------------------------------------------------------------------
# DOT parsing into a tree
# ----------------------------------------------------------------------

_EDGE_RE = re.compile(r'"([^"]+)"\s*->\s*"([^"]+)"')


def parse_dot_to_tree(dot_text: str, root_coord_id: str) -> Optional[TreeNode]:
    """Parse DOT edge list into a TreeNode rooted at root_coord_id.

    Maven DOT output is a flat edge list; we rebuild the tree by BFS from
    the root, preserving first-seen order. Cycles are broken by skipping
    already-visited nodes.
    """
    # build adjacency
    adj: Dict[str, List[str]] = {}
    node_meta: Dict[str, dict] = {}
    for line in dot_text.splitlines():
        m = _EDGE_RE.search(line)
        if not m:
            continue
        src_raw, dst_raw = m.group(1), m.group(2)
        src = parse_maven_coordinate(src_raw)
        dst = parse_maven_coordinate(dst_raw)
        node_meta[src["id"]] = src
        node_meta[dst["id"]] = dst
        adj.setdefault(src["id"], []).append(dst["id"])

    if root_coord_id not in node_meta:
        return None

    built: Dict[str, TreeNode] = {}

    def build(coord_id: str) -> TreeNode:
        if coord_id in built:
            return built[coord_id]
        meta = node_meta[coord_id]
        node = TreeNode(
            coord_id=coord_id,
            groupId=meta["groupId"],
            artifactId=meta["artifactId"],
            version=meta["version"],
            scope=meta.get("scope", "compile"),
            packaging=meta.get("packaging", "jar"),
        )
        built[coord_id] = node  # guard against cycles
        for child_id in adj.get(coord_id, []):
            node.children.append(build(child_id))
        return node

    return build(root_coord_id)


# ----------------------------------------------------------------------
# Maven execution
# ----------------------------------------------------------------------

def run_mvn_dependency_tree(pom_dir: str) -> Tuple[bool, str, str]:
    """Run `mvn dependency:tree -DoutputType=dot` in pom_dir, writing the
    DOT graph to a temp file to avoid logging noise on stdout.
    Returns (success, dot_text, stderr_or_error).
    """
    import tempfile
    dot_path = os.path.join(tempfile.gettempdir(), f"depgraph_{os.getpid()}_{abs(hash(pom_dir))}.dot")
    # remove any stale dot file so mvn doesn't append/merge
    if os.path.exists(dot_path):
        os.remove(dot_path)
    cmd = ["mvn", "dependency:tree", "-DoutputType=dot",
           f"-DoutputFile={dot_path}", "-q"]
    try:
        proc = subprocess.run(
            cmd, cwd=pom_dir, capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        return False, "", "`mvn` executable not found on PATH"
    except subprocess.TimeoutExpired:
        return False, "", "mvn dependency:tree timed out after 300s"
    if proc.returncode != 0:
        return False, "", proc.stderr or proc.stdout
    if not os.path.exists(dot_path):
        # fallback: some setups ignore -DoutputFile, parse stdout instead
        return False, "", "mvn produced no DOT output file"
    try:
        with open(dot_path) as f:
            dot = f.read()
    finally:
        try:
            os.remove(dot_path)
        except OSError:
            pass
    if not dot.strip():
        return False, "", "mvn produced empty DOT output"
    return True, dot, ""


# ----------------------------------------------------------------------
# Cache
# ----------------------------------------------------------------------

def _cache_key(pom_path: str) -> str:
    """Stable cache key derived from the pom absolute path."""
    h = abs(hash(os.path.abspath(pom_path)))
    return f"{h}.json"


def load_cache(cache_dir: str, pom_path: str) -> Optional[dict]:
    path = os.path.join(cache_dir, _cache_key(pom_path))
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def save_cache(cache_dir: str, pom_path: str, data: dict) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, _cache_key(pom_path))
    with open(path, "w") as f:
        json.dump(data, f)


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------

def build_model(root_dir: str, cache_dir: str,
                force_reload: bool = False) -> GraphModel:
    """Discover poms, run/parse Maven, cache, and return a GraphModel."""
    model = GraphModel()
    poms = find_poms(root_dir)

    for pom_path in poms:
        gid, aid, ver = parse_pom_coords(pom_path)
        coord_id = f"{gid}:{aid}:{ver}"
        pom_dir = os.path.dirname(pom_path)
        mtime = os.path.getmtime(pom_path)

        cached = None if force_reload else load_cache(cache_dir, pom_path)

        module = Module(
            pom_path=pom_path, dir_path=pom_dir,
            coord_id=coord_id, groupId=gid, artifactId=aid, version=ver,
        )

        if cached and cached.get("mtime") == mtime:
            # use cached tree
            tree_dict = cached.get("tree")
            if tree_dict:
                from graph_model import _tree_from_dict
                module.tree = _tree_from_dict(tree_dict)
            module.error = cached.get("error")
        else:
            ok, dot, err = run_mvn_dependency_tree(pom_dir)
            if ok:
                module.tree = parse_dot_to_tree(dot, coord_id)
                if module.tree is None:
                    module.error = "Root module not found in DOT output"
            else:
                module.error = err
            save_cache(cache_dir, pom_path, {
                "mtime": mtime,
                "tree": module.tree.to_dict() if module.tree else None,
                "error": module.error,
            })

        model.add_module(module)

    return model
