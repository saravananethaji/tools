"""Maven runner: find poms, run `mvn dependency:tree -DoutputType=dot`,
parse the DOT output into a tree, and keep an on-disk JSON cache.

Cache is keyed by pom path + file mtime. On explicit reload, Maven is
re-run and the cache refreshed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from graph_model import (
    GraphModel,
    Module,
    TreeNode,
    parse_maven_coordinate,
)

from pom_parser import (
    parse_pom,
    parse_dot_file,
    find_poms,
    parse_maven_coordinate as pom_parse_maven_coordinate,
    ProjectClassifier,
)

# Configure logging to console
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("projectgraph")


# ----------------------------------------------------------------------
# DOT parsing into a tree
# ----------------------------------------------------------------------

_EDGE_RE = re.compile(r'"([^"]+)"\s*->\s*"([^"]+)"')
_DIGRAPH_RE = re.compile(r'digraph\s*"([^"]+)"')


def parse_dot_to_tree(dot_text: str, root_coord_id: str) -> Optional[TreeNode]:
    """Parse DOT edge list into a TreeNode rooted at root_coord_id.

    Maven DOT output is a flat edge list; we rebuild the tree by BFS from
    the root, preserving first-seen order. Cycles are broken by skipping
    already-visited nodes.
    """
    # build adjacency
    adj: Dict[str, List[str]] = {}
    node_meta: Dict[str, dict] = {}
    root_graph_id = root_coord_id

    dm = _DIGRAPH_RE.search(dot_text)
    if dm:
        root_parsed = parse_maven_coordinate(dm.group(1))
        node_meta[root_parsed["id"]] = root_parsed
        root_graph_id = root_parsed["id"]

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

    if root_graph_id not in node_meta:
        parts = root_coord_id.split(":")
        if len(parts) >= 3:
            node_meta[root_graph_id] = {
                "id": root_graph_id,
                "groupId": parts[0],
                "artifactId": parts[1],
                "version": parts[2],
                "scope": "compile",
                "packaging": "jar",
            }
        else:
            return None

    def build(coord_id: str) -> TreeNode:
        meta = node_meta[coord_id]
        node = TreeNode(
            coord_id=coord_id,
            groupId=meta["groupId"],
            artifactId=meta["artifactId"],
            version=meta["version"],
            scope=meta.get("scope", "compile"),
            packaging=meta.get("packaging", "jar"),
            classifier=meta.get("classifier"),
        )
        return node

    def build_path(coord_id: str, ancestors: set[str]) -> TreeNode:
        node = build(coord_id)
        identity = node.artifact_id
        if identity in ancestors:
            return node
        next_ancestors = ancestors | {identity}
        for child_id in adj.get(coord_id, []):
            child_meta = node_meta[child_id]
            child_identity_parts = [child_meta["groupId"], child_meta["artifactId"], child_meta.get("packaging", "jar")]
            if child_meta.get("classifier"):
                child_identity_parts.append(child_meta["classifier"])
            child_identity_parts.append(child_meta["version"])
            if ":".join(child_identity_parts) in next_ancestors:
                continue
            node.children.append(build_path(child_id, next_ancestors))
        return node

    return build_path(root_graph_id, set())


# ----------------------------------------------------------------------
# Maven execution
# ----------------------------------------------------------------------

def run_mvn_dependency_tree(pom_dir: str) -> Tuple[bool, str, str]:
    """Run `mvn dependency:tree -DoutputType=dot` in pom_dir, writing the
    DOT graph to a temp file to avoid logging noise on stdout.
    Returns (success, dot_text, stderr_or_error).
    """
    import tempfile
    import shutil
    
    logger.info(f"  Running: mvn dependency:tree (in {pom_dir})")
    with tempfile.NamedTemporaryFile(prefix="depgraph_", suffix=".dot", delete=False) as tmp:
        dot_path = tmp.name
    # remove any stale file so mvn creates it fresh
    try:
        os.remove(dot_path)
    except OSError:
        pass
    cmd = ["mvn", "dependency:tree", "-DoutputType=dot",
           f"-DoutputFile={dot_path}", "-q"]
    
    # Resolve mvn executable path (avoids shell=True)
    mvn_cmd = shutil.which("mvn.cmd" if os.name == "nt" else "mvn")
    if not mvn_cmd:
        logger.error("  `mvn` executable not found on PATH")
        return False, "", "`mvn` executable not found on PATH"
    cmd[0] = mvn_cmd
    
    try:
        proc = subprocess.run(
            cmd, cwd=pom_dir, capture_output=True, text=True, timeout=300,
            shell=False,   # SECURITY: No shell injection risk
        )
    except FileNotFoundError:
        logger.error("  `mvn` executable not found on PATH")
        return False, "", "`mvn` executable not found on PATH"
    except subprocess.TimeoutExpired:
        logger.error("  mvn dependency:tree timed out after 300s")
        return False, "", "mvn dependency:tree timed out after 300s"
    if proc.returncode != 0:
        logger.error(f"  mvn failed with exit code {proc.returncode}")
        return False, "", proc.stderr or proc.stdout
    if not os.path.exists(dot_path):
        # fallback: some setups ignore -DoutputFile, parse stdout instead
        logger.error("  mvn produced no DOT output file")
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
        logger.error("  mvn produced empty DOT output")
        return False, "", "mvn produced empty DOT output"
    logger.info(f"  Maven analysis complete ({len(dot)} bytes of DOT output)")
    return True, dot, ""


# ----------------------------------------------------------------------
# Cache
# ----------------------------------------------------------------------

def _cache_key(pom_path: str) -> str:
    """Stable cache key derived from the pom absolute path.
    Uses SHA256 for consistent cross-process caching (unlike Python's randomized hash()).
    """
    import hashlib
    abs_path = os.path.abspath(pom_path)
    h = hashlib.sha256(abs_path.encode()).hexdigest()[:16]
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
    logger.info(f"Building dependency model from: {root_dir}")
    if force_reload:
        logger.info("Force reload enabled - bypassing cache")

    model = GraphModel()
    
    # Use shared parser to find and parse all POMs
    pom_infos = []
    for pom_path in find_poms(root_dir):
        pom = parse_pom(pom_path)
        if pom:
            pom_infos.append(pom)

    if not pom_infos:
        logger.warning("No pom.xml files found!")
        return model

    # Classify all projects first (needed for dependency analysis)
    classifier = ProjectClassifier()
    project_types = {}
    for pom in pom_infos:
        ptype, reason = classifier.classify(pom, pom_infos)
        project_types[pom.path] = (ptype, reason)
        logger.info(f"  Classified {pom.coord} as: {ptype} ({reason})")

    total = len(pom_infos)
    for i, pom in enumerate(pom_infos, 1):
        logger.info(f"[{i}/{total}] Processing: {pom.path}")
        logger.info(f"  Coordinates: {pom.coord}")
        pom_dir = pom.directory
        mtime = os.path.getmtime(pom.path)

        cached = None if force_reload else load_cache(cache_dir, pom.path)

        project_type, classification_reason = project_types[pom.path]
        module = Module(
            pom_path=pom.path, dir_path=pom_dir,
            coord_id=pom.coord, groupId=pom.groupId, artifactId=pom.artifactId, version=pom.version,
            project_type=project_type, classification_reason=classification_reason,
        )

        if cached and cached.get("mtime") == mtime:
            # use cached tree
            logger.info("  Using cached dependency tree")
            tree_dict = cached.get("tree")
            if tree_dict:
                from graph_model import _tree_from_dict
                module.tree = _tree_from_dict(tree_dict)
            module.error = cached.get("error")
        else:
            logger.info("  Running Maven dependency analysis...")
            ok, dot, err = run_mvn_dependency_tree(pom_dir)
            if ok:
                module.tree = parse_dot_to_tree(dot, module.coord_id)
                if module.tree is None:
                    module.error = "Root module not found in DOT output"
                    logger.error(f"  {module.error}")
                else:
                    dep_count = _count_tree_nodes(module.tree)
                    logger.info(f"  Parsed {dep_count} dependencies")
            else:
                module.error = err
                logger.error(f"  Maven error: {err}")
            save_cache(cache_dir, pom.path, {
                "mtime": mtime,
                "tree": module.tree.to_dict() if module.tree else None,
                "error": module.error,
            })

        model.add_module(module)

    logger.info(f"Model complete: {len(model.modules)} module(s) loaded")
    return model


def _count_tree_nodes(node: TreeNode) -> int:
    """Recursively count nodes in a dependency tree."""
    count = 1
    for child in node.children:
        count += _count_tree_nodes(child)
    return count
