"""In-memory blast-radius and dependency-route queries (P1.3).

Answers two architect questions directly from the resolved scan model, with
**no graph database**:

1. **Blast radius** — given an exact coordinate, which modules depend on it,
   through which bounded paths, which dependency introduces it, and which
   source POMs are involved?
2. **Dependency route** — given two coordinates, which bounded routes lead
   from the first to the second?

Correctness rules (consistent with P0.6/P0.7, P1.1, P1.2):

* **Exact coordinate matching only.** A query must always include an explicit
  ``groupId``; artifactId-only matching is rejected. When a query matches more
  than one canonical artifact (for example ``g:a`` spanning two versions, or
  ``g:a:v`` spanning a classifier variant) the result says so via
  ``ambiguous`` and lists every match rather than silently picking one.
* **Resolved data only.** Modules without a resolved tree contribute nothing
  and are reported in ``excluded_modules``.
* **A module's own root is context, not a dependency**, so it is never
  reported as an affected artifact. It *may* appear as the origin of a route,
  because "how does this module reach that library?" is a legitimate question;
  such origins are flagged ``module_root: true``.
* **Nearest occurrence wins.** Once a target is reached on a path, that branch
  stops descending, matching Maven's nearest-wins resolution and avoiding
  redundant deeper duplicates.
* **Bounded.** Path collection is capped by ``max_paths`` and total traversal
  by a node budget; both caps are reported, never silently applied.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

from graph_model import GraphModel, Module, TreeNode

DEFAULT_MAX_PATHS = 16
MAX_ALLOWED_PATHS = 100
DEFAULT_NODE_BUDGET = 500_000


# ----------------------------------------------------------------------
# Coordinate queries and artifact index
# ----------------------------------------------------------------------

def parse_coordinate_query(text: str) -> dict:
    """Parse a user-supplied coordinate query.

    Accepted forms (a ``groupId`` and ``artifactId`` are always required):
        groupId:artifactId
        groupId:artifactId:version
        groupId:artifactId:packaging:version
        groupId:artifactId:packaging:classifier:version

    Raises ``ValueError`` for malformed or under-specified input. An
    artifactId-only query is deliberately rejected: this tool never guesses a
    groupId.
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("coordinate is required")
    parts = raw.split(":")
    if any(not p.strip() for p in parts):
        raise ValueError(f"coordinate has an empty segment: {raw!r}")
    if len(parts) < 2:
        raise ValueError(
            "coordinate must include an explicit groupId and artifactId "
            f"(got {raw!r}); artifactId-only matching is not supported"
        )
    spec: dict = {"groupId": parts[0], "artifactId": parts[1]}
    if len(parts) == 2:
        return spec
    if len(parts) == 3:
        spec["version"] = parts[2]
        return spec
    if len(parts) == 4:
        spec["packaging"] = parts[2]
        spec["version"] = parts[3]
        return spec
    if len(parts) == 5:
        spec["packaging"] = parts[2]
        spec["classifier"] = parts[3]
        spec["version"] = parts[4]
        return spec
    raise ValueError(
        f"coordinate has too many segments ({len(parts)}): {raw!r}; expected at "
        "most groupId:artifactId:packaging:classifier:version"
    )


def purl_for(group_id: str, artifact_id: str, version: str,
             classifier: Optional[str] = None) -> str:
    qualifier = f"?classifier={classifier}" if classifier else ""
    return f"pkg:maven/{group_id}/{artifact_id}@{version}{qualifier}"


def _artifact_meta(node: TreeNode) -> dict:
    return {
        "canonical_id": node.artifact_id,
        "groupId": node.groupId,
        "artifactId": node.artifactId,
        "version": node.version,
        "packaging": node.packaging,
        "classifier": node.classifier,
        "purl": purl_for(node.groupId, node.artifactId, node.version,
                         node.classifier),
    }


def index_artifacts(model: GraphModel) -> Dict[str, dict]:
    """Every canonical artifact reachable in any resolved tree, plus module
    coordinates (which are legitimate route origins and query subjects)."""
    index: Dict[str, dict] = {}
    for module in model.modules:
        if module.tree is not None:
            index.setdefault(module.tree.artifact_id, {
                **_artifact_meta(module.tree),
                "module_root": True,
                "modules": [],
            })["modules"].append(module.coord_id)
    for module in model.modules:
        if module.tree is None:
            continue
        stack = list(module.tree.children)
        while stack:
            node = stack.pop()
            if node.artifact_id not in index:
                index[node.artifact_id] = {
                    **_artifact_meta(node),
                    "module_root": False,
                    "modules": [],
                }
            index[node.artifact_id]["modules"].append(module.coord_id)
            stack.extend(node.children)
    for meta in index.values():
        meta["modules"] = sorted(set(meta["modules"]))
    return index


def match_artifacts(index: Dict[str, dict], spec: dict) -> List[dict]:
    """Artifacts in the index matching every field present in ``spec``."""
    matches = []
    for canonical_id in sorted(index):
        meta = index[canonical_id]
        if all(meta.get(field) == value for field, value in spec.items()):
            matches.append(meta)
    return matches


# ----------------------------------------------------------------------
# Traversal
# ----------------------------------------------------------------------

class _Budget:
    """Shared traversal budget so a pathological graph cannot hang a query."""

    def __init__(self, node_budget: int) -> None:
        self.remaining = node_budget
        self.exhausted = False

    def spend(self) -> bool:
        if self.remaining <= 0:
            self.exhausted = True
            return False
        self.remaining -= 1
        return True


def _paths_to_targets(module: Module, targets: Set[str], max_paths: int,
                      budget: _Budget) -> Tuple[List[List[TreeNode]], bool]:
    """Bounded, cycle-safe paths from a module's root to any target.

    Paths are returned root-first and include the module root. Once a target is
    reached on a branch, that branch stops (nearest occurrence wins).
    """
    assert module.tree is not None
    paths: List[List[TreeNode]] = []
    truncated = False

    def walk(node: TreeNode, path: List[TreeNode], on_path: Set[str]) -> None:
        nonlocal truncated
        if not budget.spend():
            truncated = True
            return
        if node.artifact_id in on_path:
            return
        on_path = on_path | {node.artifact_id}
        current = path + [node]
        if node.artifact_id in targets:
            if len(paths) < max_paths:
                paths.append(current)
            else:
                truncated = True
            return  # nearest occurrence wins
        for child in node.children:
            walk(child, current, on_path)

    for child in module.tree.children:
        walk(child, [module.tree], {module.tree.artifact_id})
    if budget.exhausted:
        truncated = True
    return paths, truncated


def _routes_between(module: Module, from_ids: Set[str], to_ids: Set[str],
                    max_paths: int, budget: _Budget
                    ) -> Tuple[List[List[TreeNode]], bool]:
    """Bounded routes where a ``from`` artifact precedes a ``to`` artifact."""
    assert module.tree is not None
    routes: List[List[TreeNode]] = []
    truncated = False

    def descend(node: TreeNode, path: List[TreeNode], on_path: Set[str]) -> None:
        nonlocal truncated
        if not budget.spend():
            truncated = True
            return
        if node.artifact_id in on_path:
            return
        on_path = on_path | {node.artifact_id}
        current = path + [node]
        if node.artifact_id in to_ids:
            if len(routes) < max_paths:
                routes.append(current)
            else:
                truncated = True
            return
        for child in node.children:
            descend(child, current, on_path)

    def start(node: TreeNode, on_path: Set[str]) -> None:
        """Find origin artifacts; the reported route starts AT the origin.

        Ancestry (``on_path``) is tracked separately from the reported route
        so a cycle cannot recurse forever while the route itself stays honest
        about where it begins.
        """
        if not budget.spend():
            truncated = True
            return
        if node.artifact_id in on_path:
            return
        next_on_path = on_path | {node.artifact_id}
        if node.artifact_id in from_ids:
            for child in node.children:
                descend(child, [node], next_on_path)
            return
        for child in node.children:
            start(child, next_on_path)

    root = module.tree
    # The module root may legitimately be a route origin.
    if root.artifact_id in from_ids:
        for child in root.children:
            descend(child, [root], {root.artifact_id})
    else:
        for child in root.children:
            start(child, {root.artifact_id})
    if budget.exhausted:
        truncated = True
    return routes, truncated


def _module_errors(model: GraphModel) -> List[dict]:
    return [
        {"coord_id": m.coord_id, "reason": m.error or m.analysis_status}
        for m in model.modules if m.tree is None
    ]


def _clamp(max_paths: int) -> int:
    if max_paths < 1:
        return 1
    return min(max_paths, MAX_ALLOWED_PATHS)


# ----------------------------------------------------------------------
# Blast radius
# ----------------------------------------------------------------------

def blast_radius(model: GraphModel, coordinate: str,
                 max_paths: int = DEFAULT_MAX_PATHS,
                 node_budget: int = DEFAULT_NODE_BUDGET) -> dict:
    """Which modules depend on an exact coordinate, and through which paths."""
    spec = parse_coordinate_query(coordinate)
    limit = _clamp(max_paths)
    index = index_artifacts(model)
    matches = match_artifacts(index, spec)

    result: dict = {
        "query": {"coordinate": coordinate.strip(), "parsed": spec},
        "matches": matches,
        "ambiguous": len(matches) > 1,
        "max_paths": limit,
        "affected_module_count": 0,
        "path_count": 0,
        "truncated": False,
        "modules": [],
        "excluded_modules": _module_errors(model),
        "completeness": "partial" if _module_errors(model) else "complete",
    }
    if not matches:
        result["note"] = (
            "No resolved artifact matches this coordinate. Verify the "
            "groupId/artifactId/version, or check excluded_modules for "
            "modules that could not be resolved."
        )
        return result

    target_ids = {m["canonical_id"] for m in matches}
    root_ids = {m["canonical_id"] for m in matches if m.get("module_root")}
    dependency_targets = target_ids - root_ids

    if not dependency_targets:
        result["note"] = (
            "The coordinate matches only scanned module roots, which are "
            "project context rather than dependencies; no module is affected."
        )
        return result

    budget = _Budget(node_budget)
    for module in model.modules:
        if module.tree is None:
            continue
        paths, truncated = _paths_to_targets(module, dependency_targets,
                                             limit, budget)
        if not paths:
            continue
        direct = any(len(p) == 2 for p in paths)
        introducers = sorted({p[-2].artifact_id for p in paths
                              if len(p) > 2})
        scopes = sorted({p[-1].scope for p in paths})
        result["modules"].append({
            "module": module.coord_id,
            "pom_path": module.pom_path,
            "dir_path": module.dir_path,
            "project_type": module.project_type,
            "source": module.source,
            "completeness": module.completeness,
            "relationship": "direct" if direct else "transitive",
            "direct": direct,
            "introduced_by": introducers,
            "scopes": scopes,
            "min_depth": min(len(p) - 1 for p in paths),
            "artifact": {
                **_artifact_meta(paths[0][-1]),
            },
            "paths": [[n.artifact_id for n in p] for p in paths],
            "paths_truncated": truncated,
        })
        result["truncated"] = result["truncated"] or truncated

    result["affected_module_count"] = len(result["modules"])
    result["path_count"] = sum(len(m["paths"]) for m in result["modules"])
    if result["truncated"] or budget.exhausted:
        result["truncated"] = True
        result["note"] = (
            "Path collection hit a configured bound; the listed paths are a "
            "complete subset of the routes that were explored, and some "
            "routes may be omitted."
        )
    elif not result["modules"]:
        result["note"] = "No resolved module depends on this coordinate."
    return result


# ----------------------------------------------------------------------
# Dependency routes
# ----------------------------------------------------------------------

def dependency_routes(model: GraphModel, from_coordinate: str,
                      to_coordinate: str,
                      max_paths: int = DEFAULT_MAX_PATHS,
                      node_budget: int = DEFAULT_NODE_BUDGET) -> dict:
    """Bounded routes leading from one exact coordinate to another."""
    from_spec = parse_coordinate_query(from_coordinate)
    to_spec = parse_coordinate_query(to_coordinate)
    limit = _clamp(max_paths)
    index = index_artifacts(model)
    from_matches = match_artifacts(index, from_spec)
    to_matches = match_artifacts(index, to_spec)

    result: dict = {
        "from": {"coordinate": from_coordinate.strip(), "parsed": from_spec,
                 "matches": from_matches},
        "to": {"coordinate": to_coordinate.strip(), "parsed": to_spec,
               "matches": to_matches},
        "ambiguous": len(from_matches) > 1 or len(to_matches) > 1,
        "max_paths": limit,
        "route_count": 0,
        "truncated": False,
        "routes": [],
        "excluded_modules": _module_errors(model),
        "completeness": "partial" if _module_errors(model) else "complete",
    }
    if not from_matches or not to_matches:
        missing = "from" if not from_matches else "to"
        result["note"] = (
            f"No resolved artifact matches the '{missing}' coordinate."
        )
        return result

    from_ids = {m["canonical_id"] for m in from_matches}
    to_ids = {m["canonical_id"] for m in to_matches}

    budget = _Budget(node_budget)
    for module in model.modules:
        if module.tree is None:
            continue
        routes, truncated = _routes_between(module, from_ids, to_ids, limit,
                                            budget)
        for route in routes:
            result["routes"].append({
                "module": module.coord_id,
                "pom_path": module.pom_path,
                "project_type": module.project_type,
                "depth": len(route) - 1,
                "origin_is_module_root": route[0].artifact_id
                == module.tree.artifact_id,
                "scopes": sorted({n.scope for n in route[1:]}),
                "path": [n.artifact_id for n in route],
            })
        result["truncated"] = result["truncated"] or truncated

    result["route_count"] = len(result["routes"])
    if result["truncated"] or budget.exhausted:
        result["truncated"] = True
        result["note"] = (
            "Route collection hit a configured bound; some routes may be "
            "omitted."
        )
    elif not result["routes"]:
        result["note"] = "No resolved route connects these coordinates."
    return result


# ----------------------------------------------------------------------
# Convenience: affected modules only (cheap summary view)
# ----------------------------------------------------------------------

def affected_modules(model: GraphModel, coordinate: str) -> List[dict]:
    """Compact blast-radius summary: one entry per affected module."""
    report = blast_radius(model, coordinate, max_paths=1)
    return [
        {
            "module": m["module"],
            "pom_path": m["pom_path"],
            "relationship": m["relationship"],
            "min_depth": m["min_depth"],
            "scopes": m["scopes"],
            "introduced_by": m["introduced_by"],
        }
        for m in report["modules"]
    ]
