"""Portable, user-facing dependency snapshots.

This format deliberately wraps the canonical GraphModel JSON. The cache uses
the model JSON too, but is private, replaceable implementation state; a
snapshot is an explicit interchange file with a stable format identifier.
"""

from __future__ import annotations

from datetime import datetime, timezone

from graph_model import GraphModel, SCAN_SCHEMA_VERSION


SNAPSHOT_FORMAT = "projectgraph.dependency-snapshot.v1"


def export_snapshot(model: GraphModel) -> dict:
    """Build a portable, versioned snapshot without exposing cache metadata."""
    scan = model.to_dict()
    for module in scan["modules"]:
        module.pop("cache_state", None)
    return {
        "snapshot_format": SNAPSHOT_FORMAT,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "scan": scan,
    }


def import_snapshot(payload: dict) -> GraphModel:
    """Validate and restore a model from an exported dependency snapshot."""
    if payload.get("snapshot_format") != SNAPSHOT_FORMAT:
        raise ValueError("Unsupported dependency snapshot format")
    scan = payload.get("scan")
    if not isinstance(scan, dict) or scan.get("schema_version") != SCAN_SCHEMA_VERSION:
        raise ValueError("Snapshot has an unsupported or missing scan schema")
    return GraphModel.from_dict(scan)
