"""Resolved open-source (OSS) inventory for a ProjectGraph scan.

P1.1 — Build resolved OSS inventory.

Rules that keep this truthful (per P0.6 / P0.7):
  * Only modules with a resolved dependency tree contribute. Modules that
    failed to resolve are listed in ``excluded_modules`` with a reason —
    they are never silently treated as having no dependencies.
  * The module's own root node is context, not a dependency.
  * A dependency that appears in a module's tree under several different
    paths (diamonds) contributes one entry per path, up to ``max_paths``
    (truncation is flagged). Actual cycles terminate the branch.
  * ``dependencyManagement`` and other static POM data are not used here;
    this inventory describes what Maven actually resolved.

Internal vs external:
  * A groupId is internal if it matches a configured prefix
    (``PROJECTGRAPH_INTERNAL_PREFIXES``, comma-separated, or the
    ``extra_prefixes`` argument) or belongs to a module scanned in this
    run (the projects under analysis are self-built).
  * The default inventory lists external (open-source) coordinates only.
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Set

from graph_model import (
    GraphModel,
    Module,
    TreeNode,
    has_maven_resolved_tree,
    resolved_tree_exclusion_reason,
)

DEFAULT_MAX_PATHS = 8


def internal_group_prefixes(model: GraphModel,
                            extra_prefixes: Optional[List[str]] = None) -> List[str]:
    """Return the configured internal groupId prefixes plus every groupId
    owned by a module in this scan (those projects are self-built)."""
    env = os.environ.get("PROJECTGRAPH_INTERNAL_PREFIXES", "")
    prefixes: Set[str] = set()
    for raw in env.split(","):
        if raw.strip():
            prefixes.add(raw.strip().rstrip("."))
    for raw in extra_prefixes or []:
        if raw.strip():
            prefixes.add(raw.strip().rstrip("."))
    for module in model.modules:
        if module.groupId:
            prefixes.add(module.groupId.rstrip("."))
    return sorted(prefixes)


def _matches_prefix(group_id: str, prefixes: List[str]) -> bool:
    return any(group_id == p or group_id.startswith(p + ".") for p in prefixes)


def _purl(node: TreeNode) -> str:
    qualifier = f"?classifier={node.classifier}" if node.classifier else ""
    return f"pkg:maven/{node.groupId}/{node.artifactId}@{node.version}{qualifier}"


class _Consumer:
    __slots__ = ("scopes", "paths", "seen_paths", "direct")

    def __init__(self) -> None:
        self.scopes: Set[str] = set()
        self.paths: List[List[str]] = []
        self.seen_paths = 0
        self.direct = False

    @property
    def truncated(self) -> bool:
        return self.seen_paths > len(self.paths)


def build_inventory(model: GraphModel,
                    extra_prefixes: Optional[List[str]] = None,
                    max_paths: int = DEFAULT_MAX_PATHS,
                    include_internal: bool = False) -> dict:
    """Build the resolved OSS inventory for a scan model.

    Returns a JSON-serializable dict:
      {
        "internal_prefixes": [...],
        "sources": [...],                # scan source(s) present
        "completeness": "complete"|"partial",
        "included_modules": [...],       # coord ids that contributed
        "excluded_modules": [{"coord_id", "reason"}],
        "entries": [
          {
            "canonical_id": "g:a:jar:1",  # lossless artifact identity
            "groupId", "artifactId", "version", "packaging", "classifier",
            "purl": "pkg:maven/...",
            "kind": "external"|"internal",
            "consumers": [
              {"module": "g:app:1", "scopes": [...],
               "relationship": "direct"|"transitive",
               "paths": [["g:app:jar:1", "x:lib:jar:2", ...], ...],
               "paths_truncated": bool}
            ]
          }
        ]
      }
    """
    prefixes = internal_group_prefixes(model, extra_prefixes)

    included: List[str] = []
    excluded: List[dict] = []
    for module in model.modules:
        reason = resolved_tree_exclusion_reason(module)
        if reason:
            excluded.append({"coord_id": module.coord_id, "reason": reason})
            continue
        included.append(module.coord_id)

    # canonical_id -> entry dict with meta + consumers {module_id: _Consumer}
    entries: Dict[str, dict] = {}

    def entry_for(node: TreeNode) -> dict:
        entry = entries.get(node.artifact_id)
        if entry is None:
            entry = {
                "canonical_id": node.artifact_id,
                "groupId": node.groupId,
                "artifactId": node.artifactId,
                "version": node.version,
                "packaging": node.packaging,
                "classifier": node.classifier,
                "purl": _purl(node),
                "kind": ("internal"
                         if _matches_prefix(node.groupId, prefixes)
                         else "external"),
                "consumers": {},
            }
            entries[node.artifact_id] = entry
        return entry

    def record(node: TreeNode, module: Module, path: List[str],
               on_path: Set[str]) -> None:
        if node.artifact_id in on_path:
            return  # real cycle: stop this branch
        on_path = on_path | {node.artifact_id}
        consumer = entry_for(node)["consumers"].setdefault(
            module.coord_id, _Consumer())
        consumer.scopes.add(node.scope)
        full_path = path + [node.artifact_id]
        if len(full_path) == 2:
            consumer.direct = True
        consumer.seen_paths += 1
        if len(consumer.paths) < max_paths:
            consumer.paths.append(full_path)
        for child in node.children:
            record(child, module, full_path, on_path)

    for module in model.modules:
        if not has_maven_resolved_tree(module):
            continue
        # The module's own root is context, not a resolved dependency.
        for child in module.tree.children:
            record(child, module, [module.tree.artifact_id],
                   {module.tree.artifact_id})

    out_entries: List[dict] = []
    for canonical_id in sorted(entries):
        entry = entries[canonical_id]
        if entry["kind"] == "internal" and not include_internal:
            continue
        consumers = []
        for module_id in sorted(entry["consumers"]):
            c = entry["consumers"][module_id]
            consumers.append({
                "module": module_id,
                "scopes": sorted(c.scopes),
                "relationship": "direct" if c.direct else "transitive",
                "paths": c.paths,
                "paths_truncated": c.truncated,
            })
        out_entries.append({
            **{k: entry[k] for k in (
                "canonical_id", "groupId", "artifactId", "version",
                "packaging", "classifier", "purl", "kind")},
            "consumers": consumers,
        })

    return {
        "internal_prefixes": prefixes,
        "sources": sorted({m.source for m in model.modules}) or ["unknown"],
        "completeness": "complete" if not excluded else "partial",
        "included_modules": included,
        "excluded_modules": excluded,
        "entries": out_entries,
        "status_note": ("All modules resolved."
                        if not excluded else
                        "Some modules could not be resolved; their "
                        "dependencies are NOT represented."),
    }


def external_entries(inventory: dict) -> List[dict]:
    """Entries that are open-source (non-internal) coordinates."""
    return [e for e in inventory["entries"] if e["kind"] == "external"]
