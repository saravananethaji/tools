"""Durable state for the single last successful resolved ProjectGraph scan."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from graph_model import GraphModel, has_maven_resolved_tree


def can_persist(model: GraphModel) -> bool:
    """Only retain a useful Maven-resolved report, never partial static data."""
    return (
        model.source == "maven-resolved"
        and any(has_maven_resolved_tree(module) for module in model.modules)
    )


def save_last_scan(path: Path, model: GraphModel) -> bool:
    """Atomically replace the one retained resolved scan.

    A failed/empty scan deliberately leaves the previously successful report
    intact. The caller can still show the failed current attempt in memory.
    """
    if not can_persist(model):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(model.to_dict(), output, indent=2, sort_keys=True)
        output.write("\n")
    os.replace(temporary, path)
    return True


def load_last_scan(path: Path) -> Optional[GraphModel]:
    """Load the one retained scan, ignoring corrupt or unsuitable snapshots."""
    try:
        with path.open(encoding="utf-8") as source:
            model = GraphModel.from_dict(json.load(source))
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return None
    return model if can_persist(model) else None
