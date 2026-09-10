"""In-memory graph + tree model built from parsed Maven DOT output.

Each loaded module produces a DependencyTree (rooted at the module itself),
plus a flat set of artifact nodes and edges. The GraphModel aggregates
trees from all modules and exposes conflict detection.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional


SCAN_SCHEMA_VERSION = "projectgraph.scan.v1"


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

    def _id(g, a, packaging, v, classifier=None):
        parts = [g, a, packaging]
        if classifier:
            parts.append(classifier)
        parts.append(v)
        return ":".join(parts)

    if len(parts) == 5:
        g, a, _t, v, s = parts
        return {"id": _id(g, a, _t, v), "groupId": g, "artifactId": a,
                "packaging": _t, "version": v, "scope": s}
    if len(parts) == 6:
        g, a, _t, c, v, s = parts
        return {"id": _id(g, a, _t, v, c), "groupId": g, "artifactId": a,
                "packaging": _t, "classifier": c, "version": v, "scope": s}
    if len(parts) == 4:
        g, a, _t, v = parts
        return {"id": _id(g, a, _t, v), "groupId": g, "artifactId": a,
                "packaging": _t, "version": v, "scope": "compile"}

    # Fallback
    g = parts[0] if len(parts) > 0 else "unknown"
    a = parts[1] if len(parts) > 1 else cleaned
    v = parts[-1] if len(parts) > 2 else "unknown"
    return {"id": _id(g, a, "jar", v), "groupId": g, "artifactId": a,
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
    classifier: Optional[str] = None
    children: List["TreeNode"] = field(default_factory=list)
    # Version metadata (populated during analysis)
    versionOverride: bool = False      # Direct POM override of BOM/parent
    versionExtended: bool = False      # Version range explicitly widened
    bomImported: bool = False          # Version from BOM dependencyManagement
    usesPackageGen: bool = False       # Uses Package Gen Maven plugin
    versionConflict: bool = False      # Version conflict detected in tree
    displayOverride: str = ""          # Visual override indicator text

    @property
    def display(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"

    @property
    def artifact_id(self) -> str:
        """Lossless artifact identity used by graph exports and traversal."""
        parts = [self.groupId, self.artifactId, self.packaging]
        if self.classifier:
            parts.append(self.classifier)
        parts.append(self.version)
        return ":".join(parts)

    def to_dict(self, _visited: Optional[set] = None) -> dict:
        if _visited is None:
            _visited = set()
        # guard against cycles (shouldn't happen now, but belt-and-suspenders)
        if self.artifact_id in _visited:
            return {
                "coord_id": self.coord_id,
                "groupId": self.groupId,
                "artifactId": self.artifactId,
                "version": self.version,
                "scope": self.scope,
                "packaging": self.packaging,
                "classifier": self.classifier,
                "display": self.display,
                "cycle": True,
                "children": [],
            }
        _visited = _visited | {self.artifact_id}
        return {
            "coord_id": self.coord_id,
            "groupId": self.groupId,
            "artifactId": self.artifactId,
            "version": self.version,
            "scope": self.scope,
            "packaging": self.packaging,
            "classifier": self.classifier,
            "display": self.display,
            # Version metadata fields
            "versionOverride": self.versionOverride,
            "versionExtended": self.versionExtended,
            "bomImported": self.bomImported,
            "usesPackageGen": self.usesPackageGen,
            "versionConflict": self.versionConflict,
            "displayOverride": self.displayOverride,
            "children": [c.to_dict(_visited) for c in self.children],
        }


@dataclass
class Module:
    pom_path: str
    dir_path: str
    coord_id: str           # groupId:artifactId:version (from pom)
    groupId: str
    artifactId: str
    version: str
    project_type: str = "Other Module"
    classification_reason: str = "not classified"
    tree: Optional[TreeNode] = None
    error: Optional[str] = None   # set if mvn failed for this module
    analysis_status: str = "pending"
    source: str = "maven-resolved"
    completeness: str = "unknown"
    cache_state: str = "none"
    dependency_count: int = 0
    maven_version: Optional[str] = None

    # --- POM structural relationships (static POM evidence, NOT resolved) ---
    # These are deliberately kept apart from `tree`: a <parent> edge is POM
    # inheritance and a <module> edge is build aggregation. Neither is a
    # dependency, and neither may feed resolved-only answers.
    parent_coord: Optional[str] = None
    parent_relative_path: Optional[str] = None
    parent_module: Optional[str] = None      # in-scan coord, if resolvable
    declared_modules: List[str] = field(default_factory=list)   # raw <module>
    child_modules: List[str] = field(default_factory=list)      # in-scan coords
    unresolved_module_paths: List[str] = field(default_factory=list)
    declared_dependencies: List[dict] = field(default_factory=list)

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
            "project_type": self.project_type,
            "classification_reason": self.classification_reason,
            "display": self.display,
            "tree": self.tree.to_dict() if self.tree else None,
            "error": self.error,
            "analysis_status": self.analysis_status,
            "source": self.source,
            "completeness": self.completeness,
            "cache_state": self.cache_state,
            "dependency_count": self.dependency_count,
            "maven_version": self.maven_version,
            # Structural POM relationships. Optional and additive: older scans
            # simply lack them, and absence means "not captured", never "none".
            "parent_coord": self.parent_coord,
            "parent_relative_path": self.parent_relative_path,
            "parent_module": self.parent_module,
            "declared_modules": self.declared_modules,
            "child_modules": self.child_modules,
            "unresolved_module_paths": self.unresolved_module_paths,
            "declared_dependencies": self.declared_dependencies,
        }


def resolved_tree_exclusion_reason(module: Module) -> Optional[str]:
    """Why a module cannot support a resolved-data query.

    A parsed tree alone is not proof of Maven resolution: imported static POM
    exports can contain DOT-shaped edges too. Consumers that promise resolved
    answers must require the Maven source marker. Completeness remains scan
    metadata: older valid resolved-cache records do not always store it.
    """
    if module.tree is None:
        return module.error or module.analysis_status
    if module.source != "maven-resolved":
        return f"source={module.source} is not Maven-resolved"
    return None


def has_maven_resolved_tree(module: Module) -> bool:
    """Whether ``module`` may contribute to a resolved-only result."""
    return resolved_tree_exclusion_reason(module) is None


@dataclass
class Conflict:
    artifact_key: str          # groupId:artifactId:packaging[:classifier]
    versions: List[str]
    # "conflict" = one module's resolved tree contains >1 version of this GA;
    # "drift"    = different modules resolve different versions.
    kind: str = "drift"
    # Every occurrence, each with the module-owned path that produced it:
    #   {module, version, canonical_id, scope, direct, depth, path}
    occurrences: List[dict] = field(default_factory=list)
    modules: List[str] = field(default_factory=list)
    # True when some (module, version) had more paths than were stored.
    truncated: bool = False


# ----------------------------------------------------------------------
# Graph model
# ----------------------------------------------------------------------

class GraphModel:
    """Aggregates modules + their trees; provides conflict detection."""

    def __init__(self, *, root: Optional[str] = None, scan_id: Optional[str] = None,
                 generated_at: Optional[str] = None,
                 source: str = "maven-resolved",
                 completeness: Optional[str] = None):
        self.modules: List[Module] = []
        self.root = root
        self.scan_id = scan_id
        self.generated_at = generated_at or datetime.now(timezone.utc).isoformat()
        self.source = source
        self.completeness = completeness

    # --- population ---

    def add_module(self, module: Module) -> None:
        self.modules.append(module)

    # --- queries ---

    def conflicts(self, max_paths: int = 8) -> List[Conflict]:
        """Find Maven conflict identities resolved to >1 distinct version.

        Computed only from resolved, module-owned dependency data:
          * modules without a resolved tree contribute nothing (they are
            reported through the scan's error status instead of silently
            shrinking the result);
          * a module's own root node is context, not a resolved dependency;
          * every occurrence carries the module-owned dependency path that
            produced it, so the responsible route is visible;
          * paths per (module, version) are bounded by ``max_paths`` and the
            truncation is flagged rather than hidden.

        ``kind`` distinguishes:
          * ``conflict`` — one module's own tree contains two versions of the
            same Maven conflict identity (its classpath cannot satisfy both);
          * ``drift``    — different modules resolved different versions.
        """
        # artifact_key (G:A:type[:classifier]) -> version -> canonical_id ->
        # module_id -> accumulator. Version is intentionally excluded from
        # the key because it is the value being compared.
        seen: Dict[str, Dict[str, Dict[str, Dict[str, dict]]]] = defaultdict(
            lambda: defaultdict(lambda: defaultdict(dict)))

        def walk(node: TreeNode, module: Module, path: List[str],
                 on_path: set, depth: int) -> None:
            if node.artifact_id in on_path:
                return  # real cycle: stop this branch
            on_path = on_path | {node.artifact_id}
            key_parts = [node.groupId, node.artifactId, node.packaging]
            if node.classifier:
                key_parts.append(node.classifier)
            key = ":".join(key_parts)
            per_module = seen[key][node.version][node.artifact_id]
            acc = per_module.setdefault(module.coord_id, {
                "module": module.display,
                "paths": [],
                "seen_paths": 0,
            })
            acc["seen_paths"] += 1
            full_path = path + [node.artifact_id]
            if len(acc["paths"]) < max_paths:
                acc["paths"].append({
                    "path": full_path,
                    "scope": node.scope,
                    "direct": depth == 1,
                })
            for c in node.children:
                walk(c, module, full_path, on_path, depth + 1)

        for m in self.modules:
            if not has_maven_resolved_tree(m):
                continue  # unresolved modules are surfaced via their status
            for child in m.tree.children:
                walk(child, m, [m.tree.artifact_id],
                     {m.tree.artifact_id}, 1)

        conflicts = []
        for key, versions in sorted(seen.items()):
            if len(versions) < 2:
                continue
            occurrences: List[dict] = []
            truncated = False
            module_ids: set = set()
            for version in sorted(versions):
                for canonical_id in sorted(versions[version]):
                    for module_id in sorted(versions[version][canonical_id]):
                        acc = versions[version][canonical_id][module_id]
                        module_ids.add(module_id)
                        if acc["seen_paths"] > len(acc["paths"]):
                            truncated = True
                        for path_data in acc["paths"]:
                            path = path_data["path"]
                            occurrences.append({
                                "module": acc["module"],
                                "module_id": module_id,
                                "version": version,
                                "canonical_id": canonical_id,
                                "scope": path_data["scope"],
                                "direct": path_data["direct"],
                                "depth": len(path) - 1,
                                "path": path,
                            })
            # A conflict is intra-module when one module resolved two
            # versions itself; otherwise it is cross-module drift.
            per_module_versions: Dict[str, set] = defaultdict(set)
            for occ in occurrences:
                per_module_versions[occ["module_id"]].add(occ["version"])
            intra = any(len(v) > 1 for v in per_module_versions.values())
            conflicts.append(Conflict(
                artifact_key=key,
                versions=sorted(versions.keys()),
                kind="conflict" if intra else "drift",
                occurrences=occurrences,
                modules=sorted(module_ids),
                truncated=truncated,
            ))
        return conflicts

    def all_artifacts(self) -> List[dict]:
        """Flat unique list of all artifact coords across all trees."""
        out: Dict[str, dict] = {}
        def walk(node: TreeNode, _visited: set):
            if node.artifact_id in _visited:
                return
            _visited = _visited | {node.artifact_id}
            out[node.artifact_id] = {
                "id": node.artifact_id,
                "groupId": node.groupId,
                "artifactId": node.artifactId,
                "version": node.version,
                "scope": node.scope,
                "packaging": node.packaging,
                "classifier": node.classifier,
            }
            for c in node.children:
                walk(c, _visited)
        for m in self.modules:
            if m.tree:
                walk(m.tree, set())
        return list(out.values())

    def all_edges(self) -> List[dict]:
        """All dependency edges with owning-module provenance."""
        edges: List[dict] = []
        def walk(node: TreeNode, module: Module, depth: int, _visited: set):
            if node.artifact_id in _visited:
                return
            _visited = _visited | {node.artifact_id}
            for c in node.children:
                edges.append({
                    "from_id": node.artifact_id,
                    "to_id": c.artifact_id,
                    "scope": c.scope,
                    "module_id": module.coord_id,
                    "depth": depth + 1,
                    "direct": depth == 0,
                })
                walk(c, module, depth + 1, _visited)
        for m in self.modules:
            if m.tree:
                walk(m.tree, m, 0, set())
        return edges

    # --- serialization (for on-disk cache) ---

    def to_dict(self) -> dict:
        statuses = defaultdict(int)
        for module in self.modules:
            statuses[module.analysis_status] += 1
        return {
            "schema_version": SCAN_SCHEMA_VERSION,
            "metadata": {
                "scan_id": self.scan_id,
                "generated_at": self.generated_at,
                "root": self.root,
                "source": self.source,
                "completeness": self.completeness or (
                    "complete"
                    if self.modules and all(m.completeness == "complete" for m in self.modules)
                    else "partial"
                ),
                "module_count": len(self.modules),
                "status_counts": dict(sorted(statuses.items())),
            },
            "modules": [m.to_dict() for m in self.modules],
            "edges": self.all_edges(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GraphModel":
        if data.get("schema_version") != SCAN_SCHEMA_VERSION:
            raise ValueError(
                f"Unsupported scan schema: {data.get('schema_version')!r}; "
                f"expected {SCAN_SCHEMA_VERSION!r}"
            )
        metadata = data.get("metadata", {})
        model = cls(
            root=metadata.get("root"),
            scan_id=metadata.get("scan_id"),
            generated_at=metadata.get("generated_at"),
            source=metadata.get("source", "maven-resolved"),
            completeness=metadata.get("completeness"),
        )
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
                project_type=md.get("project_type", "Other Module"),
                classification_reason=md.get("classification_reason", "not classified"),
                tree=tree,
                error=md.get("error"),
                analysis_status=md.get("analysis_status", "pending"),
                source=md.get("source", "maven-resolved"),
                completeness=md.get("completeness", "unknown"),
                cache_state=md.get("cache_state", "none"),
                dependency_count=md.get("dependency_count", 0),
                maven_version=md.get("maven_version"),
                # Backward compatible: scans written before topology capture
                # load with these absent rather than failing.
                parent_coord=md.get("parent_coord"),
                parent_relative_path=md.get("parent_relative_path"),
                parent_module=md.get("parent_module"),
                declared_modules=md.get("declared_modules") or [],
                child_modules=md.get("child_modules") or [],
                unresolved_module_paths=md.get("unresolved_module_paths") or [],
                declared_dependencies=md.get("declared_dependencies") or [],
            ))
        return model


def _tree_from_dict(d: dict) -> TreeNode:
    parts = d.get("coord_id", "").split(":")
    return TreeNode(
        coord_id=d.get("coord_id", ""),
        groupId=d.get("groupId", parts[0] if len(parts) > 0 else ""),
        artifactId=d.get("artifactId", parts[1] if len(parts) > 1 else ""),
        version=d.get("version", parts[2] if len(parts) > 2 else ""),
        scope=d.get("scope", "compile"),
        packaging=d.get("packaging", "jar"),
        classifier=d.get("classifier"),
        # Version metadata fields (with defaults for backward compatibility)
        versionOverride=d.get("versionOverride", False),
        versionExtended=d.get("versionExtended", False),
        bomImported=d.get("bomImported", False),
        usesPackageGen=d.get("usesPackageGen", False),
        versionConflict=d.get("versionConflict", False),
        displayOverride=d.get("displayOverride", ""),
        children=[_tree_from_dict(c) for c in d.get("children", [])],
    )
