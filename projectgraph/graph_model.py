"""In-memory graph + tree model built from parsed Maven DOT output.

Each loaded module produces a DependencyTree (rooted at the module itself),
plus a flat set of artifact nodes and edges. The GraphModel aggregates
trees from all modules and exposes conflict detection.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple


# ----------------------------------------------------------------------
# Coordinate parsing
# ----------------------------------------------------------------------

def parse_maven_coordinate(coord_str: str) -> Dict[str, str]:
    """Parse a Maven coordinate string from a DOT node label.

    Handles:
      groupId:artifactId:type:version:scope
      groupId:artifactId:type:classifier:version:scope
      groupId:artifactId:type:version            (root / no scope)
    """
    cleaned = coord_str.strip().strip('"').strip("'")
    parts = cleaned.split(":")

    def _id(g, a, v):
        return f"{g}:{a}:{v}"

    if len(parts) == 5:
        g, a, _t, v, s = parts
        return {"id": _id(g, a, v), "groupId": g, "artifactId": a,
                "packaging": _t, "version": v, "scope": s}
    if len(parts) == 6:
        g, a, _t, c, v, s = parts
        return {"id": _id(g, a, v), "groupId": g, "artifactId": a,
                "packaging": _t, "classifier": c, "version": v, "scope": s}
    if len(parts) == 4:
        g, a, _t, v = parts
        return {"id": _id(g, a, v), "groupId": g, "artifactId": a,
                "packaging": _t, "version": v, "scope": "compile"}

    # Fallback
    g = parts[0] if len(parts) > 0 else "unknown"
    a = parts[1] if len(parts) > 1 else cleaned
    v = parts[-1] if len(parts) > 2 else "unknown"
    return {"id": _id(g, a, v), "groupId": g, "artifactId": a,
            "packaging": "jar", "version": v, "scope": "compile"}


# ----------------------------------------------------------------------
# Dataclasses
# ----------------------------------------------------------------------

@dataclass
class TreeNode:
    coord_id: str            # groupId:artifactId:version
    groupId: str
    artifactId: str
    version: str
    scope: str
    packaging: str
    children: List["TreeNode"] = field(default_factory=list)

    @property
    def display(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"

    def to_dict(self) -> dict:
        return {
            "coord_id": self.coord_id,
            "groupId": self.groupId,
            "artifactId": self.artifactId,
            "version": self.version,
            "scope": self.scope,
            "packaging": self.packaging,
            "display": self.display,
            "children": [c.to_dict() for c in self.children],
        }


@dataclass
class Module:
    pom_path: str
    dir_path: str
    coord_id: str           # groupId:artifactId:version (from pom)
    groupId: str
    artifactId: str
    version: str
    tree: Optional[TreeNode] = None
    error: Optional[str] = None   # set if mvn failed for this module

    @property
    def display(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"

    def to_dict(self) -> dict:
        return {
            "pom_path": self.pom_path,
            "dir_path": self.dir_path,
            "coord_id": self.coord_id,
            "groupId": self.groupId,
            "artifactId": self.artifactId,
            "version": self.version,
            "display": self.display,
            "tree": self.tree.to_dict() if self.tree else None,
            "error": self.error,
        }


@dataclass
class Conflict:
    artifact_key: str          # groupId:artifactId
    versions: List[str]
    # where each version appears: list of (module coord, version, scope)
    occurrences: List[dict]


# ----------------------------------------------------------------------
# Graph model
# ----------------------------------------------------------------------

class GraphModel:
    """Aggregates modules + their trees; provides conflict detection."""

    def __init__(self):
        self.modules: List[Module] = []

    # --- population ---

    def add_module(self, module: Module) -> None:
        self.modules.append(module)

    # --- queries ---

    def conflicts(self) -> List[Conflict]:
        """Find groupId:artifactId pairs that have >1 distinct version
        across the combined graph (all modules, all transitive deps)."""
        # artifact_key -> { version -> [ {module, scope} ] }
        seen: Dict[str, Dict[str, List[dict]]] = defaultdict(lambda: defaultdict(list))

        def walk(node: TreeNode, module: Module):
            key = f"{node.groupId}:{node.artifactId}"
            seen[key][node.version].append({
                "module": module.display,
                "scope": node.scope,
                "coord_id": node.coord_id,
            })
            for c in node.children:
                walk(c, module)

        for m in self.modules:
            if m.tree:
                walk(m.tree, m)

        conflicts = []
        for key, versions in sorted(seen.items()):
            if len(versions) > 1:
                occ = []
                for v, locs in sorted(versions.items()):
                    for loc in locs:
                        occ.append({"version": v, **loc})
                conflicts.append(Conflict(
                    artifact_key=key,
                    versions=sorted(versions.keys()),
                    occurrences=occ,
                ))
        return conflicts

    def all_artifacts(self) -> List[dict]:
        """Flat unique list of all artifact coords across all trees."""
        out: Dict[str, dict] = {}
        def walk(node: TreeNode):
            out[node.coord_id] = {
                "id": node.coord_id,
                "groupId": node.groupId,
                "artifactId": node.artifactId,
                "version": node.version,
                "scope": node.scope,
                "packaging": node.packaging,
            }
            for c in node.children:
                walk(c)
        for m in self.modules:
            if m.tree:
                walk(m.tree)
        return list(out.values())

    def all_edges(self) -> List[dict]:
        """All dependency edges (from_id -> to_id, scope)."""
        edges: List[dict] = []
        def walk(node: TreeNode):
            for c in node.children:
                edges.append({
                    "from_id": node.coord_id,
                    "to_id": c.coord_id,
                    "scope": c.scope,
                })
                walk(c)
        for m in self.modules:
            if m.tree:
                walk(m.tree)
        return edges

    # --- serialization (for on-disk cache) ---

    def to_dict(self) -> dict:
        return {"modules": [m.to_dict() for m in self.modules]}

    @classmethod
    def from_dict(cls, data: dict) -> "GraphModel":
        model = cls()
        for md in data.get("modules", []):
            tree = None
            if md.get("tree"):
                tree = _tree_from_dict(md["tree"])
            model.add_module(Module(
                pom_path=md["pom_path"],
                dir_path=md["dir_path"],
                coord_id=md["coord_id"],
                groupId=md["groupId"],
                artifactId=md["artifactId"],
                version=md["version"],
                tree=tree,
                error=md.get("error"),
            ))
        return model


def _tree_from_dict(d: dict) -> TreeNode:
    return TreeNode(
        coord_id=d["coord_id"],
        groupId=d["groupId"],
        artifactId=d["artifactId"],
        version=d["version"],
        scope=d["scope"],
        packaging=d.get("packaging", "jar"),
        children=[_tree_from_dict(c) for c in d.get("children", [])],
    )
