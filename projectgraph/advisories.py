"""User-triggered OSV advisory refresh with a local, atomic SQLite cache."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from graph_model import GraphModel
from oss_inventory import build_inventory, external_entries

OSV_BATCH = "https://api.osv.dev/v1/querybatch"
OSV_VULN = "https://api.osv.dev/v1/vulns/"
DB_NAME = "osv-current-scan.sqlite3"
TIMEOUT_SECONDS = 30
BATCH_SIZE = 100


def _db_path(cache_dir: str) -> Path:
    return Path(cache_dir) / "advisories" / DB_NAME


def _coordinates(inventory: dict) -> list[dict]:
    return sorted(external_entries(inventory), key=lambda e: e["canonical_id"])


def _post_json(url: str, payload: dict) -> dict:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "ProjectGraph/1.0"}, method="POST")
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode())


def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "ProjectGraph/1.0"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode())


def _query(entries: list[dict]) -> dict[str, list[str]]:
    matched = {entry["canonical_id"]: [] for entry in entries}
    for offset in range(0, len(entries), BATCH_SIZE):
        batch = entries[offset:offset + BATCH_SIZE]
        data = _post_json(OSV_BATCH, {"queries": [{
            "package": {"name": f"{entry['groupId']}:{entry['artifactId']}", "ecosystem": "Maven"},
            "version": entry["version"],
        } for entry in batch]})
        for entry, result in zip(batch, data.get("results", [])):
            matched[entry["canonical_id"]] = [v["id"] for v in result.get("vulns", []) if v.get("id")]
    return matched


def _aliases(record: dict) -> tuple[list[str], list[str]]:
    values = [item.get("id") for item in record.get("aliases", []) if item.get("id")]
    return sorted(v for v in values if v.startswith("GHSA-")), sorted(v for v in values if v.startswith("CVE-"))


def refresh(model: GraphModel, cache_dir: str) -> dict:
    """Refresh exact current-version matches, leaving old data untouched on failure."""
    inventory = build_inventory(model)
    entries = _coordinates(inventory)
    records: dict[str, dict] = {}
    try:
        matches = _query(entries)
        for advisory_id in sorted({item for ids in matches.values() for item in ids}):
            records[advisory_id] = _get_json(OSV_VULN + urllib.parse.quote(advisory_id, safe=""))
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        raise RuntimeError(f"OSV refresh failed; the last local data was kept: {exc}") from exc

    target = _db_path(cache_dir); target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix="osv-", suffix=".sqlite3", dir=target.parent)
    os.close(handle)
    try:
        with sqlite3.connect(temporary_name) as db:
            db.executescript("""
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE advisory (id TEXT PRIMARY KEY, raw_json TEXT NOT NULL);
                CREATE TABLE match (canonical_id TEXT NOT NULL, advisory_id TEXT NOT NULL,
                    PRIMARY KEY (canonical_id, advisory_id));
            """)
            now = datetime.now(timezone.utc).isoformat()
            db.executemany("INSERT INTO metadata VALUES (?, ?)", [
                ("refreshed_at", now), ("source", "OSV querybatch Maven"),
                ("evaluated_count", str(len(entries))), ("advisory_count", str(len(records))),
            ])
            db.executemany("INSERT INTO advisory VALUES (?, ?)",
                [(key, json.dumps(value, sort_keys=True)) for key, value in records.items()])
            db.executemany("INSERT INTO match VALUES (?, ?)",
                [(coordinate, advisory_id) for coordinate, ids in matches.items() for advisory_id in ids])
        os.replace(temporary_name, target)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return report(model, cache_dir)


def report(model: GraphModel, cache_dir: str) -> dict:
    inventory = build_inventory(model)
    entries = {item["canonical_id"]: item for item in _coordinates(inventory)}
    path = _db_path(cache_dir)
    base = {"completeness": inventory["completeness"], "excluded_modules": inventory["excluded_modules"],
            "evaluated_count": 0, "findings": [], "status": "not_downloaded", "metadata": {}}
    if not path.exists():
        return base
    try:
        with sqlite3.connect(path) as db:
            metadata = dict(db.execute("SELECT key, value FROM metadata"))
            rows = db.execute("SELECT match.canonical_id, advisory.raw_json FROM match JOIN advisory ON advisory.id=match.advisory_id").fetchall()
    except (sqlite3.Error, OSError):
        base["status"] = "unavailable"; return base
    findings = []
    for canonical_id, raw in rows:
        entry = entries.get(canonical_id)
        if not entry:
            continue
        record = json.loads(raw); ghsas, cves = _aliases(record)
        findings.append({"library": entry, "id": record.get("id"), "summary": record.get("summary", ""),
            "severity": (record.get("database_specific") or {}).get("severity", "unknown"),
            "ghsas": ghsas, "cves": cves, "references": record.get("references", []),
            "withdrawn": record.get("withdrawn"), "modified": record.get("modified")})
    base.update({"status": "ready", "metadata": metadata, "evaluated_count": int(metadata.get("evaluated_count", 0)),
                 "findings": sorted(findings, key=lambda item: (item["severity"], item["library"]["canonical_id"]))})
    return base
