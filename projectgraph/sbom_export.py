#!/usr/bin/env python3
"""
SBOM Export & Open-Source Dependency Intelligence for Project Graph.

P0 items from DESIGN.md:
  R2 - Open-source dependency inventory + CycloneDX 1.5 SBOM export
  R1/R3 - Real vulnerability data via the free OSV.dev API (no auth needed)
  R6 (bonus) - Version drift report across modules

Consumes the JSON produced by maven_extractor.py (-f json). Stdlib only.

NOTE (P1.1): the canonical OSS inventory is the RESOLVED one —
`oss_inventory.py`, `GET /api/inventory`, and the /inventory page — which
describes what Maven actually resolved. This CLI operates on the offline
static-POM export and is therefore PARTIAL: `dependencyManagement` entries and
declared versions are not proof of resolved usage. Prefer the resolved
inventory for any claim about what a build contains.

Usage:
    # 1. Generate extractor JSON first:
    python maven_extractor.py /path/to/projects -o analysis.json -f json

    # 2. OSS inventory (internal vs open-source split):
    python sbom_export.py -i analysis.json --inventory

    # 3. CycloneDX SBOM for Dependency-Track / Trivy / Grype:
    python sbom_export.py -i analysis.json --sbom sbom.cdx.json

    # 4. Query OSV.dev for known CVEs/GHSAs on every external dependency:
    python sbom_export.py -i analysis.json --osv

    # 5. Version drift report:
    python sbom_export.py -i analysis.json --drift

    # Mark your own groupIds as internal (repeatable flag):
    python sbom_export.py -i analysis.json --inventory --internal-prefix com.company
"""

import argparse
import json
import logging
import sys
import urllib.error
import urllib.request
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from graph_model import SCAN_SCHEMA_VERSION

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("sbom_export")

OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch"
OSV_VULN_URL = "https://api.osv.dev/v1/vulns/"


# ----------------------------------------------------------------------
# Data collection
# ----------------------------------------------------------------------

def load_extractor_json(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != SCAN_SCHEMA_VERSION:
        raise ValueError(
            f"unsupported or missing schema_version; expected {SCAN_SCHEMA_VERSION}"
        )
    if data.get("metadata", {}).get("source") != "pom-static":
        raise ValueError("this transitional exporter accepts pom-static exports only")
    if "projects" not in data:
        raise ValueError("Not a maven_extractor JSON export: missing 'projects' key")
    return data


def internal_prefixes_from(data, extra_prefixes):
    """Internal groupIds = explicit --internal-prefix flags + every groupId
    that owns a project module in the scan (self-built artifacts)."""
    prefixes = set(extra_prefixes or [])
    for p in data.get("projects", []):
        gid = p.get("groupId")
        if gid:
            prefixes.add(gid)
    return prefixes


def is_internal(group_id, prefixes):
    return any(group_id == p or group_id.startswith(p + ".") for p in prefixes)


def collect_dependencies(data, prefixes):
    """
    Returns inventory dict:
      ga -> {
        'groupId', 'artifactId', 'internal': bool,
        'versions': {version -> {'modules': set, 'scopes': set, 'direct': bool}}
      }
    Pulls from dependencies and dependency_management of every project.
    """
    inv = {}
    for proj in data.get("projects", []):
        module = proj.get("coord_id") or proj.get("artifactId", "?")
        sections = (
            (proj.get("dependencies", []), True),
            (proj.get("dependency_management", []), False),
        )
        for deps, is_dep_section in sections:
            for d in deps:
                ga = d.get("ga") or f"{d.get('groupId','?')}:{d.get('artifactId','?')}"
                gid = d.get("groupId", ga.split(":")[0])
                aid = d.get("artifactId", ga.split(":")[-1])
                version = d.get("version") or "unresolved"
                entry = inv.setdefault(ga, {
                    "groupId": gid,
                    "artifactId": aid,
                    "internal": is_internal(gid, prefixes),
                    "versions": {},
                })
                v = entry["versions"].setdefault(version, {
                    "modules": set(),
                    "scopes": set(),
                    "direct": False,
                    "managed_only": True,
                })
                v["modules"].add(module)
                if d.get("scope"):
                    v["scopes"].add(d["scope"])
                if is_dep_section:
                    v["managed_only"] = False
                    if d.get("is_direct", True):
                        v["direct"] = True
    return inv


# ----------------------------------------------------------------------
# R2: OSS inventory report
# ----------------------------------------------------------------------

def print_inventory(inv, show_internal=False):
    external = {ga: e for ga, e in inv.items() if not e["internal"]}
    internal = {ga: e for ga, e in inv.items() if e["internal"]}

    print("=" * 72)
    print("OPEN-SOURCE DECLARATION INVENTORY (STATIC/PARTIAL)")
    print("=" * 72)
    print(f"External coordinates: {len(external)}   Internal coordinates: {len(internal)}")
    print("Managed entries are declarations, not proof of resolved usage.")
    print()

    for ga in sorted(external):
        e = external[ga]
        print(f"  {ga}")
        for ver in sorted(e["versions"]):
            v = e["versions"][ver]
            kind = "direct" if v["direct"] else ("managed" if v["managed_only"] else "transitive/declared")
            scopes = ",".join(sorted(v["scopes"])) or "compile"
            mods = ", ".join(sorted(v["modules"]))
            relation = "managed by" if v["managed_only"] else "declared by"
            print(f"    - {ver:<15} [{kind}; scope={scopes}] {relation}: {mods}")
        print()

    if show_internal:
        print("-" * 72)
        print("INTERNAL ARTIFACTS (own groupIds)")
        print("-" * 72)
        for ga in sorted(internal):
            vers = ", ".join(sorted(internal[ga]["versions"]))
            print(f"  {ga}  ({vers})")

    return external


# ----------------------------------------------------------------------
# R6: Version drift report
# ----------------------------------------------------------------------

def print_drift(inv):
    print("=" * 72)
    print("DECLARED VERSION DRIFT REPORT (STATIC/PARTIAL)")
    print("=" * 72)
    drifted = 0
    for ga in sorted(inv):
        e = inv[ga]
        real_versions = [v for v in e["versions"] if v != "unresolved"]
        if len(real_versions) > 1:
            drifted += 1
            tag = "internal" if e["internal"] else "OPEN-SOURCE"
            print(f"  ⚠ {ga}  [{tag}]")
            for ver in sorted(real_versions):
                mods = ", ".join(sorted(e["versions"][ver]["modules"]))
                print(f"      {ver:<15} <- {mods}")
    if drifted == 0:
        print("  No drift detected: every library resolves to a single version.")
    else:
        print(f"\n  {drifted} librarie(s) with version drift. Align these before a"
              " CVE forces a rushed multi-version upgrade.")
    print()


# ----------------------------------------------------------------------
# R2: CycloneDX 1.5 SBOM export
# ----------------------------------------------------------------------

def to_purl(group_id, artifact_id, version):
    return f"pkg:maven/{group_id}/{artifact_id}@{version}"


def build_cyclonedx(data, inv):
    """Build a CycloneDX 1.5 JSON BOM covering external + internal components."""
    components = []
    for ga in sorted(inv):
        e = inv[ga]
        for ver in sorted(e["versions"]):
            if ver == "unresolved":
                continue
            v = e["versions"][ver]
            # dependencyManagement constrains versions but does not establish
            # component usage, so it must not become an SBOM component.
            if v["managed_only"]:
                continue
            components.append({
                "type": "library",
                "bom-ref": to_purl(e["groupId"], e["artifactId"], ver),
                "group": e["groupId"],
                "name": e["artifactId"],
                "version": ver,
                "purl": to_purl(e["groupId"], e["artifactId"], ver),
                "scope": "required",
                "properties": [
                    {"name": "projectgraph:origin",
                     "value": "internal" if e["internal"] else "external"},
                    {"name": "projectgraph:relationship",
                     "value": "direct" if v["direct"] else "managed-or-transitive"},
                    {"name": "projectgraph:used-by",
                     "value": ";".join(sorted(v["modules"]))},
                ],
            })

    root_dir = data.get("metadata", {}).get("root_directory", "unknown")
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tools": [{"vendor": "projectgraph", "name": "sbom_export", "version": "1.0"}],
            "component": {
                "type": "application",
                "name": root_dir,
                "version": "scan",
            },
            "properties": [
                {"name": "projectgraph:source", "value": "pom-static"},
                {"name": "projectgraph:completeness", "value": "partial"},
            ],
        },
        "components": components,
    }


# ----------------------------------------------------------------------
# R1/R3: OSV.dev advisory lookup (free, no API key)
# ----------------------------------------------------------------------

def osv_query_batch(coords, timeout=30):
    """
    coords: list of (groupId, artifactId, version).
    Returns {(g,a,v): [vuln ids]} using the OSV batch endpoint.
    """
    queries = [{
        "package": {"name": f"{g}:{a}", "ecosystem": "Maven"},
        "version": v,
    } for (g, a, v) in coords]

    body = json.dumps({"queries": queries}).encode("utf-8")
    req = urllib.request.Request(
        OSV_BATCH_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError) as exc:
        log.error("OSV.dev unreachable: %s", exc)
        return None

    results = {}
    for coord, res in zip(coords, payload.get("results", [])):
        vulns = res.get("vulns") or []
        results[coord] = [v.get("id", "?") for v in vulns]
    return results


def run_osv(inv, batch_size=100):
    external = {ga: e for ga, e in inv.items() if not e["internal"]}
    coords = []
    for ga, e in sorted(external.items()):
        for ver in e["versions"]:
            if ver != "unresolved" and not e["versions"][ver]["managed_only"]:
                coords.append((e["groupId"], e["artifactId"], ver))

    print("=" * 72)
    print(f"OSV.dev ADVISORY SCAN ({len(coords)} external coordinate(s))")
    print("=" * 72)
    if not coords:
        print("  No external coordinates with resolved versions to scan.")
        return {}

    findings = {}
    for i in range(0, len(coords), batch_size):
        chunk = coords[i:i + batch_size]
        res = osv_query_batch(chunk)
        if res is None:
            print("  ✗ OSV.dev not reachable (offline?). Re-run with network access.")
            return None
        findings.update(res)

    vulnerable = {c: ids for c, ids in findings.items() if ids}
    if not vulnerable:
        print("  ✓ No known advisories for any external dependency version.")
        return {}

    for (g, a, v), ids in sorted(vulnerable.items()):
        ga = f"{g}:{a}"
        mods = sorted(inv[ga]["versions"][v]["modules"]) if ga in inv and v in inv[ga]["versions"] else []
        print(f"  ✗ {g}:{a}:{v}")
        print(f"      advisories: {', '.join(ids)}")
        print(f"      used by:    {', '.join(mods)}")
        print(f"      next step:  python trace_ancestors.py -i <analysis.json> -v {g}:{a}:{v}")
    print(f"\n  {len(vulnerable)} vulnerable coordinate(s) found.")
    return vulnerable


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-i", "--input", required=True,
                    help="JSON file produced by maven_extractor.py -f json")
    ap.add_argument("--inventory", action="store_true",
                    help="Print the open-source dependency inventory")
    ap.add_argument("--show-internal", action="store_true",
                    help="Also list internal artifacts in the inventory")
    ap.add_argument("--sbom", metavar="OUT.cdx.json",
                    help="Write a CycloneDX 1.5 SBOM to this path")
    ap.add_argument("--osv", action="store_true",
                    help="Query OSV.dev for known advisories on external deps")
    ap.add_argument("--drift", action="store_true",
                    help="Print the version drift report")
    ap.add_argument("--internal-prefix", action="append", default=[],
                    help="groupId prefix to treat as internal (repeatable)")
    args = ap.parse_args()

    if not (args.inventory or args.sbom or args.osv or args.drift):
        ap.error("choose at least one action: --inventory, --sbom, --osv, --drift")

    try:
        data = load_extractor_json(args.input)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.error("Cannot load %s: %s", args.input, exc)
        sys.exit(1)

    prefixes = internal_prefixes_from(data, args.internal_prefix)
    log.info("Internal groupId prefixes: %s", ", ".join(sorted(prefixes)) or "(none)")
    inv = collect_dependencies(data, prefixes)

    if args.inventory:
        print_inventory(inv, show_internal=args.show_internal)
    if args.drift:
        print_drift(inv)
    if args.sbom:
        bom = build_cyclonedx(data, inv)
        with open(args.sbom, "w", encoding="utf-8") as f:
            json.dump(bom, f, indent=2)
        print(f"CycloneDX SBOM written: {args.sbom} "
              f"({len(bom['components'])} components)")
    if args.osv:
        result = run_osv(inv)
        if result is None:
            sys.exit(2)


if __name__ == "__main__":
    main()
