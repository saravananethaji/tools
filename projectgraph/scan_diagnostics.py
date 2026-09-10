"""Truthful scan-health summary for the web UI and API."""

from __future__ import annotations

from collections import Counter

from graph_model import GraphModel, has_maven_resolved_tree, resolved_tree_exclusion_reason


def build_scan_diagnostics(model: GraphModel) -> dict:
    """Summarize scan evidence without treating failures as empty modules."""
    statuses = Counter(module.analysis_status for module in model.modules)
    cache_states = Counter(module.cache_state for module in model.modules)
    resolved = [module for module in model.modules if has_maven_resolved_tree(module)]
    excluded = []
    for module in model.modules:
        reason = resolved_tree_exclusion_reason(module)
        if reason:
            excluded.append({
                "module": module.coord_id,
                "status": module.analysis_status,
                "reason": reason,
                "pom_path": module.pom_path,
            })

    source_is_resolved = model.source == "maven-resolved"
    complete = bool(model.modules) and source_is_resolved and not excluded
    maven_versions = sorted({module.maven_version for module in model.modules if module.maven_version})
    return {
        "generated_at": model.generated_at,
        "scan_id": model.scan_id,
        "root": model.root,
        "source": model.source,
        "completeness": "complete" if complete else "partial",
        "module_count": len(model.modules),
        "resolved_module_count": len(resolved),
        "excluded_module_count": len(excluded),
        "dependency_count": sum(module.dependency_count for module in resolved),
        "status_counts": dict(sorted(statuses.items())),
        "cache_state_counts": dict(sorted(cache_states.items())),
        "maven_versions": maven_versions,
        "excluded_modules": excluded,
        "note": (
            "Every module has a Maven-resolved tree."
            if complete else
            "Only Maven-resolved modules contribute dependency evidence; excluded modules are listed below."
        ),
    }
