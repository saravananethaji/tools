"""Maven runner: find poms, run `mvn dependency:tree -DoutputType=dot`,
parse the DOT output into a tree, and keep an on-disk JSON cache.

Cache files are keyed by POM path. Compatibility additionally requires the
cache schema, Maven command/version, age, and local Maven-input fingerprint to
match. On explicit reload, Maven is re-run and the cache refreshed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import hashlib
import time
import uuid
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
CACHE_SCHEMA_VERSION = 2
MAVEN_COMMAND_SIGNATURE = "mvn --non-recursive dependency:tree -DoutputType=dot -q"
DEFAULT_CACHE_MAX_AGE_SECONDS = 86400


def _same_gav(left: dict, root_coord_id: str) -> bool:
    parts = root_coord_id.split(":")
    if (
        len(parts) < 3
        or left.get("groupId") != parts[0]
        or left.get("artifactId") != parts[1]
    ):
        return False
    # CI-friendly Maven versions commonly use ${revision}. Maven's DOT root is
    # the effective value and should replace that placeholder after parsing.
    expected_version = parts[2]
    return "${" in expected_version or left.get("version") == expected_version


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
        if not _same_gav(root_parsed, root_coord_id):
            logger.error(
                "  DOT root mismatch: requested %s but Maven produced %s",
                root_coord_id, root_parsed["id"],
            )
            return None
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
    # Each discovered POM is analysed independently.  Without --non-recursive,
    # an aggregator POM builds its entire reactor and every module writes to the
    # same output file; the last module then overwrites the graph we requested.
    cmd = ["mvn", "--non-recursive", "dependency:tree", "-DoutputType=dot",
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


def _maven_version() -> str:
    import shutil

    executable = shutil.which("mvn.cmd" if os.name == "nt" else "mvn")
    if not executable:
        return "unavailable"
    try:
        proc = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    first_line = (proc.stdout or proc.stderr or "").splitlines()
    return first_line[0].strip() if first_line else "unknown"


def _scan_input_fingerprint(root_dir: str, pom_paths: List[str]) -> str:
    """Conservative cache input hash for Maven model-affecting local files."""
    digest = hashlib.sha256()
    candidates = {Path(path).resolve() for path in pom_paths}
    root = Path(root_dir).resolve()
    for relative in (".mvn/maven.config", ".mvn/jvm.config", ".mvn/extensions.xml"):
        path = root / relative
        if path.is_file():
            candidates.add(path)
    settings = Path.home() / ".m2" / "settings.xml"
    if settings.is_file():
        candidates.add(settings)
    for path in sorted(candidates, key=str):
        digest.update(str(path).encode("utf-8"))
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"<unreadable>")
    digest.update(os.environ.get("MAVEN_OPTS", "").encode("utf-8"))
    digest.update(MAVEN_COMMAND_SIGNATURE.encode("utf-8"))
    return digest.hexdigest()


def _cache_is_compatible(cache: dict, fingerprint: str, maven_version: str) -> bool:
    try:
        max_age = int(os.environ.get(
            "PROJECTGRAPH_CACHE_MAX_AGE_SECONDS",
            str(DEFAULT_CACHE_MAX_AGE_SECONDS),
        ))
    except ValueError:
        max_age = DEFAULT_CACHE_MAX_AGE_SECONDS
    age = time.time() - float(cache.get("created_at", 0))
    return (
        cache.get("cache_schema_version") == CACHE_SCHEMA_VERSION
        and cache.get("command_signature") == MAVEN_COMMAND_SIGNATURE
        and cache.get("input_fingerprint") == fingerprint
        and cache.get("maven_version") == maven_version
        and cache.get("analysis_status") in {"resolved", "empty"}
        and 0 <= age <= max_age
    )


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------

def build_model(root_dir: str, cache_dir: str,
                force_reload: bool = False) -> GraphModel:
    """Discover poms, run/parse Maven, cache, and return a GraphModel."""
    logger.info(f"Building dependency model from: {root_dir}")
    if force_reload:
        logger.info("Force reload enabled - bypassing cache")

    model = GraphModel(root=str(Path(root_dir).resolve()), scan_id=str(uuid.uuid4()))
    
    # Use shared parser to find and parse all POMs
    pom_infos = []
    pom_paths = list(find_poms(root_dir))
    for pom_path in pom_paths:
        pom = parse_pom(pom_path)
        if pom:
            pom_infos.append(pom)

    if not pom_infos:
        logger.warning("No pom.xml files found!")
        return model

    maven_version = _maven_version()
    input_fingerprint = _scan_input_fingerprint(root_dir, [p.path for p in pom_infos])

    # Classify all projects first (needed for dependency analysis)
    classifier = ProjectClassifier()
    project_types = {}
    classification_memo = {}
    for pom in pom_infos:
        ptype, reason = classifier.classify(
            pom, pom_infos, _memo=classification_memo, _visiting=set()
        )
        project_types[pom.path] = (ptype, reason)
        logger.info(f"  Classified {pom.coord} as: {ptype} ({reason})")

    total = len(pom_infos)
    for i, pom in enumerate(pom_infos, 1):
        logger.info(f"[{i}/{total}] Processing: {pom.path}")
        logger.info(f"  Coordinates: {pom.coord}")
        pom_dir = pom.directory
        cached = None if force_reload else load_cache(cache_dir, pom.path)

        project_type, classification_reason = project_types[pom.path]
        module = Module(
            pom_path=pom.path, dir_path=pom_dir,
            coord_id=pom.coord, groupId=pom.groupId, artifactId=pom.artifactId, version=pom.version,
            project_type=project_type, classification_reason=classification_reason,
            maven_version=maven_version,
        )

        if cached and _cache_is_compatible(cached, input_fingerprint, maven_version):
            # use cached tree
            logger.info("  Using cached dependency tree")
            tree_dict = cached.get("tree")
            if tree_dict:
                from graph_model import _tree_from_dict
                module.tree = _tree_from_dict(tree_dict)
            module.error = cached.get("error")
            module.analysis_status = cached.get("analysis_status", "error" if module.error else "resolved")
            module.completeness = cached.get("completeness", "partial" if module.error else "complete")
            module.dependency_count = cached.get(
                "dependency_count",
                max(0, _count_tree_nodes(module.tree) - 1) if module.tree else 0,
            )
            module.cache_state = "cached"
        else:
            if cached:
                logger.info("  Ignoring stale or incompatible cache entry")
            logger.info("  Running Maven dependency analysis...")
            ok, dot, err = run_mvn_dependency_tree(pom_dir)
            if ok:
                module.tree = parse_dot_to_tree(dot, module.coord_id)
                if module.tree is None:
                    module.error = "Maven DOT root does not match requested POM"
                    module.analysis_status = "parse_error"
                    module.completeness = "partial"
                    logger.error(f"  {module.error}")
                else:
                    # Do not report the project root itself as a dependency.
                    module.dependency_count = _count_tree_nodes(module.tree) - 1
                    module.analysis_status = "empty" if module.dependency_count == 0 else "resolved"
                    module.completeness = "complete"
                    logger.info(f"  Parsed {module.dependency_count} dependencies")
            else:
                module.error = err
                module.analysis_status = "timeout" if "timed out" in err.lower() else "maven_error"
                module.completeness = "partial"
                logger.error(f"  Maven error: {err}")
            module.cache_state = "stale-refreshed" if cached else "fresh"
            save_cache(cache_dir, pom.path, {
                "cache_schema_version": CACHE_SCHEMA_VERSION,
                "command_signature": MAVEN_COMMAND_SIGNATURE,
                "input_fingerprint": input_fingerprint,
                "maven_version": maven_version,
                "created_at": time.time(),
                "tree": module.tree.to_dict() if module.tree else None,
                "error": module.error,
                "analysis_status": module.analysis_status,
                "completeness": module.completeness,
                "dependency_count": module.dependency_count,
            })

        if module.tree:
            # Maven's graph contains the effective project version; prefer it
            # over an unresolved static-POM placeholder for fresh and cached
            # results alike.
            module.groupId = module.tree.groupId
            module.artifactId = module.tree.artifactId
            module.version = module.tree.version
            module.coord_id = f"{module.groupId}:{module.artifactId}:{module.version}"

        model.add_module(module)

    logger.info(f"Model complete: {len(model.modules)} module(s) loaded")
    return model


def _count_tree_nodes(node: TreeNode) -> int:
    """Recursively count nodes in a dependency tree."""
    count = 1
    for child in node.children:
        count += _count_tree_nodes(child)
    return count
