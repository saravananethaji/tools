"""POM structural relationships: parent, aggregation, and used-by (P1.5).

A Maven reactor contains four structurally different relationships, and
conflating them produces misleading answers:

======================  ========================  ==========================
Relationship            Evidence                  Truth status
======================  ========================  ==========================
``dependsOn``           ``mvn dependency:tree``   authoritative (resolved)
``usedBy``              reverse of the above      authoritative (resolved)
``parent``              ``<parent>`` in the POM   structural, not a dep
``aggregates``          ``<modules>`` in the POM  build structure, not a dep
``declaredDependency``  ``<dependencies>``        **unverified declaration**
======================  ========================  ==========================

This module keeps those classes apart and labels each one. In particular a
declared dependency is *not* proof that the dependency resolves or is used:
only ``mvn dependency:tree`` establishes that. Declared edges are therefore
reported as their own class with their own truth status and never feed the
resolved-only answers produced by ``impact.py`` or ``oss_inventory.py``.

The same reasoning applies to structural edges: a parent POM that manages a
version has not thereby made any module depend on anything.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from graph_model import GraphModel, Module, has_maven_resolved_tree

# Truth statuses. Consumers must render these, not flatten them into a single
# undifferentiated notion of "related".
TRUTH_RESOLVED = "resolved"
TRUTH_STRUCTURAL = "structural"
TRUTH_DECLARED = "declared-unverified"

RELATION_PARENT = "parent"
RELATION_AGGREGATES = "aggregates"
RELATION_DEPENDS_ON = "dependsOn"
RELATION_USED_BY = "usedBy"
RELATION_DECLARED = "declaredDependency"

RELATION_TRUTH = {
    RELATION_PARENT: TRUTH_STRUCTURAL,
    RELATION_AGGREGATES: TRUTH_STRUCTURAL,
    RELATION_DEPENDS_ON: TRUTH_RESOLVED,
    RELATION_USED_BY: TRUTH_RESOLVED,
    RELATION_DECLARED: TRUTH_DECLARED,
}

RELATION_LABEL = {
    RELATION_PARENT: "parent (POM inheritance)",
    RELATION_AGGREGATES: "aggregates (build structure)",
    RELATION_DEPENDS_ON: "depends on (resolved)",
    RELATION_USED_BY: "used by (resolved)",
    RELATION_DECLARED: "declared dependency (unverified)",
}

RELATION_NOTE = {
    RELATION_PARENT: "POM inheritance only. A parent manages versions; it does "
                     "not make this module depend on anything.",
    RELATION_AGGREGATES: "Build aggregation only. Listing a module in <modules> "
                         "is not a dependency edge.",
    RELATION_DEPENDS_ON: "From mvn dependency:tree. This is the resolved truth.",
    RELATION_USED_BY: "Reverse of resolved dependency edges.",
    RELATION_DECLARED: "Present in the POM's <dependencies> but NOT proven by a "
                       "resolved scan. Treat as intent, not fact.",
}


def _module_index(model: GraphModel) -> Dict[str, Module]:
    """Index modules by canonical coordinate and by groupId:artifactId."""
    index: Dict[str, Module] = {}
    for module in model.modules:
        index[module.coord_id] = module
    return index


def _module_coordinate(artifact_id: str) -> Optional[str]:
    """Reduce a resolved artifact id to its POM coordinate form.

    Resolved edges carry packaging (``g:a:jar:1.0.0``), while a module is
    addressed as ``g:a:1.0.0``. Mapping between the two is what lets a module's
    own used-by set be found; without it the lookup is silently empty.

    Returns ``None`` when the id does not look like a coordinate, so callers
    skip rather than invent a key.
    """
    parts = artifact_id.split(":")
    if len(parts) == 3:
        return artifact_id
    if len(parts) == 4:
        return f"{parts[0]}:{parts[1]}:{parts[3]}"
    if len(parts) == 5:
        return f"{parts[0]}:{parts[1]}:{parts[4]}"
    return None


def _ga_index(model: GraphModel) -> Dict[str, List[Module]]:
    """Index modules by groupId:artifactId.

    A GA can appear more than once (for example the same artifact at two
    versions), so values are lists and callers must handle ambiguity rather
    than assume a single owner.
    """
    index: Dict[str, List[Module]] = {}
    for module in model.modules:
        index.setdefault(f"{module.groupId}:{module.artifactId}", []).append(module)
    return index


def resolve_module_ref(model: GraphModel, group_id: str, artifact_id: str,
                       version: Optional[str] = None) -> Optional[str]:
    """Resolve a POM coordinate to an in-scan module coordinate.

    Returns ``None`` when the reference points outside the scanned reactor
    (a genuine external parent such as an OSS BOM), which callers must report
    as external rather than silently omitting.
    """
    if version:
        exact = f"{group_id}:{artifact_id}:{version}"
        if any(m.coord_id == exact for m in model.modules):
            return exact
    candidates = _ga_index(model).get(f"{group_id}:{artifact_id}", [])
    if len(candidates) == 1:
        return candidates[0].coord_id
    return None


def build_topology(model: GraphModel) -> dict:
    """Typed relationship index over the whole reactor.

    Each relationship class is reported separately with its truth status, so a
    consumer cannot accidentally present a structural or declared edge as a
    resolved fact. Modules whose structural references could not be resolved
    are reported in ``unresolved_links`` instead of being dropped.
    """
    by_coord = _module_index(model)
    edges: Dict[str, List[dict]] = {r: [] for r in RELATION_TRUTH}
    unresolved_links: List[dict] = []

    for module in model.modules:
        # --- parent (structural) ---
        if module.parent_coord:
            target = module.parent_module
            edge = {
                "from": module.coord_id,
                "to_coord": module.parent_coord,
                "to": target,
                "relative_path": module.parent_relative_path,
                "in_scan": target is not None,
            }
            edges[RELATION_PARENT].append(edge)
            if target is None:
                unresolved_links.append({
                    "module": module.coord_id,
                    "relationship": RELATION_PARENT,
                    "reference": module.parent_coord,
                    "reason": "parent POM is outside the scanned reactor",
                })

        # --- aggregation (structural) ---
        for child in module.child_modules:
            edges[RELATION_AGGREGATES].append({
                "from": module.coord_id,
                "to_coord": child,
                "to": child,
                "in_scan": True,
            })
        for missing in module.unresolved_module_paths:
            unresolved_links.append({
                "module": module.coord_id,
                "relationship": RELATION_AGGREGATES,
                "reference": missing,
                "reason": "declared <module> path does not match a scanned POM",
            })

        # --- declared dependencies (unverified) ---
        for dep in module.declared_dependencies:
            edges[RELATION_DECLARED].append({
                "from": module.coord_id,
                "to_coord": dep.get("coord_id"),
                "to": resolve_module_ref(model, dep.get("groupId", ""),
                                         dep.get("artifactId", ""),
                                         dep.get("version")),
                "scope": dep.get("scope"),
                "optional": dep.get("optional", False),
            })

        # --- resolved dependencies (authoritative) ---
        # A parsed tree alone is not proof of Maven resolution: static imports
        # can contain DOT-shaped edges. Keep the same resolved-only boundary
        # used by inventory, conflicts, and impact.
        if has_maven_resolved_tree(module):
            def walk(node, ancestry: List[str]):
                for child in node.children:
                    if child.artifact_id in ancestry:
                        continue
                    edges[RELATION_DEPENDS_ON].append({
                        "from": node.artifact_id,
                        "to": child.artifact_id,
                        "scope": child.scope,
                        "module": module.coord_id,
                        "direct": len(ancestry) == 0,
                    })
                    walk(child, ancestry + [child.artifact_id])
            walk(module.tree, [])

    # --- used by (authoritative reverse index) ---
    # Derived strictly from resolved edges: a module that declares a library it
    # never actually resolves does not appear here.
    #
    # Two indexes are maintained because two different questions are asked:
    #   * `used_by`        artifact-level dependents (lossless; a library can be
    #                      reached by several artifacts, directly and
    #                      transitively, and each is a genuine fact)
    #   * `used_by_module` module-level rollup keyed by the packaging-stripped
    #                      POM coordinate, because a module is addressed as
    #                      `g:a:v` while resolved edges carry `g:a:packaging:v`
    used_by: Dict[str, List[dict]] = {}
    used_by_module: Dict[str, Dict[str, dict]] = {}
    seen_pairs = set()

    for edge in edges[RELATION_DEPENDS_ON]:
        target = edge["to"]
        dependent = {
            "artifact": edge["from"],
            "module": edge["module"],
            "scope": edge["scope"],
            "direct": edge["direct"],
        }
        pair = (edge["from"], edge["module"], target)
        if pair not in seen_pairs:
            seen_pairs.add(pair)
            used_by.setdefault(target, []).append(dependent)

        module_key = _module_coordinate(target)
        if module_key:
            existing = used_by_module.setdefault(module_key, {}).get(edge["module"])
            # Nearest occurrence wins: a module that reaches the target both
            # directly and through an intermediate is a direct user.
            if existing is None or (edge["direct"] and not existing["direct"]):
                used_by_module[module_key][edge["module"]] = {
                    "module": edge["module"],
                    "via": edge["from"],
                    "scope": edge["scope"],
                    "direct": edge["direct"],
                }

    for target, users in used_by.items():
        for user in users:
            edges[RELATION_USED_BY].append({
                # Reverse the resolved edge: this artifact is used by the
                # artifact that introduces it. The previous representation
                # duplicated dependsOn and made the UI direction misleading.
                "from": target,
                "to_coord": user["artifact"],
                "to": user["artifact"],
                "module": user["module"],
                "scope": user["scope"],
                "direct": user["direct"],
            })

    resolved_modules = [m for m in model.modules if has_maven_resolved_tree(m)]
    return {
        "relations": {
            relation: {
                "label": RELATION_LABEL[relation],
                "truth": RELATION_TRUTH[relation],
                "note": RELATION_NOTE[relation],
                "count": len(edges[relation]),
                "edges": edges[relation],
            }
            for relation in RELATION_TRUTH
        },
        "used_by": used_by,
        "used_by_module": used_by_module,
        "unresolved_links": unresolved_links,
        "module_count": len(model.modules),
        "resolved_module_count": len(resolved_modules),
        "completeness": "complete" if len(resolved_modules) == len(model.modules)
                        and model.modules else "partial",
    }


def module_relationships(model: GraphModel, coordinate: str) -> Optional[dict]:
    """All relationships for one module, split by class and labelled."""
    module = next((m for m in model.modules if m.coord_id == coordinate), None)
    if module is None:
        return None

    topology = build_topology(model)
    rel = topology["relations"]

    agg_children = [e for e in rel[RELATION_AGGREGATES]["edges"]
                    if e["from"] == module.coord_id]
    declared = [e for e in rel[RELATION_DECLARED]["edges"]
                if e["from"] == module.coord_id]
    resolved_edges = [e for e in rel[RELATION_DEPENDS_ON]["edges"]
                      if e["module"] == module.coord_id and e["direct"]]

    # Two distinct questions, two answer sets:
    #   * `used_by`            — who depends on THIS module (module rollup)
    #   * `depends_on_modules` — which in-scan modules this one resolves to
    used_by = list(topology["used_by_module"].get(module.coord_id, {}).values())

    module_coords = {m.coord_id for m in model.modules}
    depends_on_modules = set()
    for edge in rel[RELATION_DEPENDS_ON]["edges"]:
        if edge["module"] != module.coord_id:
            continue
        target = _module_coordinate(edge["to"])
        # Only genuine cross-module links are reported. External libraries are
        # not modules, and self-references are not a relationship.
        if target in module_coords and target != module.coord_id:
            depends_on_modules.add(target)

    return {
        "module": module.coord_id,
        "pom_path": module.pom_path,
        "project_type": module.project_type,
        "analysis_status": module.analysis_status,
        "parent": {
            "coord": module.parent_coord,
            "relative_path": module.parent_relative_path,
            "module": module.parent_module,
            "in_scan": module.parent_module is not None,
        } if module.parent_coord else None,
        "child_modules": agg_children,
        "unresolved_module_paths": module.unresolved_module_paths,
        "declared_dependencies": declared,
        "direct_dependencies": resolved_edges,
        "used_by": used_by,
        "depends_on_modules": sorted(depends_on_modules),
        "completeness": "complete" if has_maven_resolved_tree(module) else "partial",
    }
