#!/usr/bin/env python3
"""
Ancestral Tracing Script for Maven Artifact Location

Reads the JSON output from maven_extractor.py and traces the parent POM chain
for each module that contains an exact artifact as a resolved dependency.

Usage:
    python trace_ancestors.py -i analysis.json --artifact org:library:1.0.0

The script will output:
- Which modules contain the artifact as a transitive dependency
- The parent chain for each module as contextual evidence
- A warning that static evidence cannot determine a safe remediation
"""

import json
import os
import sys
from collections import defaultdict

from graph_model import SCAN_SCHEMA_VERSION, parse_maven_coordinate as parse_resolved_coordinate


def parse_maven_coord(coord_str):
    """Parse a Maven coordinate string: groupId:artifactId:version"""
    cleaned = coord_str.strip().strip('"').strip("'")
    parts = cleaned.split(":")
    if len(parts) >= 3:
        return {
            'groupId': parts[0],
            'artifactId': parts[1],
            'version': parts[-1]
        }
    return None


def _coord_matches(coord_str, target_ga, target_version):
    parsed = parse_resolved_coordinate(coord_str)
    if not parsed:
        return False
    ga = f"{parsed['groupId']}:{parsed['artifactId']}"
    return ga == target_ga and (
        not target_version
        or target_version == "unknown"
        or parsed["version"] == target_version
    )


def _get_project_coord(project_dict):
    if not project_dict:
        return ""
    if "coord_id" in project_dict:
        return project_dict["coord_id"]
    coords = project_dict.get("coordinates", {})
    return f"{coords.get('groupId', '')}:{coords.get('artifactId', '')}:{coords.get('version', '')}"


def trace_parent_chain(analyses, module_coord, max_depth=5):
    """
    Trace the parent POM chain for a module.

    Args:
        analyses: List of PomAnalysis dicts from maven_extractor JSON
        module_coord: The coord_id of the module to trace from
        max_depth: Maximum depth to trace (prevents infinite loops)

    Returns:
        List of dicts with 'pom_path', 'version', 'relative_path' from child to root
    """
    chain = []

    # Find the module in analyses
    target_module = None
    for a in analyses:
        if _get_project_coord(a) == module_coord:
            target_module = a
            break

    if target_module is None:
        return chain

    # Start tracing from this module
    current_coord = module_coord
    current_depth = 0
    visited_coords = set()

    while current_depth < max_depth:
        if current_coord in visited_coords:
            break
        visited_coords.add(current_coord)

        # Find the module in analyses to get its parent
        target_module = None
        for a in analyses:
            if _get_project_coord(a) == current_coord:
                target_module = a
                break

        if target_module is None or target_module.get('parent') is None:
            break

        parent = target_module.get('parent', {})
        parent_group = parent.get('groupId', '')
        parent_art = parent.get('artifactId', '')
        parent_ver = parent.get('version', '')
        parent_rel = parent.get('relativePath', '')

        if not parent_group or not parent_art:
            break

        parent_coord = f"{parent_group}:{parent_art}:{parent_ver}"

        # Find the parent module's actual POM path if in analyses
        parent_module = next((a for a in analyses if _get_project_coord(a) == parent_coord), None)
        parent_pom_path = parent_module.get('path', '') if parent_module else target_module.get('path', '')

        # Add to chain
        chain.append({
            'pom_path': parent_pom_path,
            'version': parent_ver,
            'relative_path': parent_rel,
            'coord': parent_coord
        })

        # Move to the parent for next iteration
        current_coord = parent_coord
        current_depth += 1

    return chain


def trace_artifact_ancestors(json_data, target_ga, target_version):
    """
    Locate an exact artifact and trace ancestral chains.

    Args:
        json_data: The JSON dict from maven_extractor.py
        target_ga: groupId:artifactId to locate
        target_version: version to locate

    Returns:
        Dictionary with analysis results and ancestral chains
    """
    analyses = json_data.get('projects', [])

    # Find all modules that have this artifact as a dependency
    modules_with_artifact = []
    for a in analyses:
        has_transitive = False
        has_direct = False

        deps = a.get('dependencies', [])
        for dep in deps:
            dep_ga = dep.get('ga') or f"{dep.get('groupId', '')}:{dep.get('artifactId', '')}"
            dep_ver = dep.get('version', '')
            if dep_ga == target_ga and (not target_version or dep_ver == target_version):
                has_direct = True

        dot_deps = a.get('dot_dependencies') or []
        for d in dot_deps:
            to_coord = d.get('to', '')
            if _coord_matches(to_coord, target_ga, target_version):
                has_transitive = True

        # If transitive and not direct, record it
        if has_transitive and not has_direct:
            modules_with_artifact.append(a)

    # Trace parent chain for each module
    ancestral_info = []
    for module in modules_with_artifact:
        coord = _get_project_coord(module)
        chain = trace_parent_chain(analyses, coord, max_depth=5)

        if chain:
            ancestral_info.append({
                'module_coord': coord,
                'module_name': coord,
                'chain': chain,
                'pom_path': module.get('path', '')
            })

    return ancestral_info


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Trace ancestral POM chains for an exact Maven artifact"
    )
    parser.add_argument("-i", "--input", required=True, help="Path to JSON file from maven_extractor.py")
    parser.add_argument(
        "-a", "--artifact", "-v", "--vulnerable",
        dest="artifact",
        required=True,
        help="Artifact coordinate: groupId:artifactId:version",
    )
    parser.add_argument("-o", "--output", help="Output file for results (default: stdout)")

    args = parser.parse_args()

    # Parse exact artifact coordinate.
    if "--vulnerable" in sys.argv:
        print(
            "Warning: --vulnerable is deprecated; use --artifact. "
            "This command does not discover vulnerabilities.",
            file=sys.stderr,
        )
    parts = args.artifact.split(":")
    if len(parts) < 2:
        print("Error: Vulnerable artifact must be in format groupId:artifactId:version")
        sys.exit(1)

    target_ga = f"{parts[0]}:{parts[1]}"
    target_version = parts[2] if len(parts) >= 3 else "unknown"

    # Read JSON input
    try:
        with open(args.input, 'r') as f:
            json_data = json.load(f)
    except FileNotFoundError:
        print(f"Error: File {args.input} not found")
        sys.exit(1)
    except json.JSONDecodeError:
        print("Error: Invalid JSON file")
        sys.exit(1)
    if json_data.get("schema_version") != SCAN_SCHEMA_VERSION:
        print(f"Error: Unsupported JSON schema; expected {SCAN_SCHEMA_VERSION}")
        sys.exit(1)

    # Run ancestral tracing
    print("=== ARTIFACT ANCESTRAL TRACE (STATIC/PARTIAL) ===")
    print(f"Target: {target_ga}:{target_version}")
    print(f"Input file: {args.input}")
    print()

    ancestral_info = trace_artifact_ancestors(json_data, target_ga, target_version)

    if not ancestral_info:
        print("No modules found with the artifact as a transitive dependency.")
        print("The artifact may be a direct dependency or not present in the project.")
        return

    print(f"Found {len(ancestral_info)} module(s) with the artifact as a transitive dependency:")
    print()

    for info in ancestral_info:
        print(f"Module: {info['module_name']}")
        print(f"  Module POM: {info['pom_path']}")
        print(f"  Parent Chain ({len(info['chain'])} levels):")

        for i, step in enumerate(info['chain']):
            pom_info = f"pom_path: {step['pom_path']}" if step.get('pom_path') else "pom_path: not available"
            rel_info = f"relative_path: {step['relative_path']}" if step.get('relative_path') else ""
            print(f"  Level {i+1}: version={step['version']}, {pom_info} {rel_info}")

        print()

    # Report evidence only. A parent chain alone does not identify a safe fix.
    print("=" * 60)
    print("PARENT-CHAIN EVIDENCE:")
    print("=" * 60)

    for info in ancestral_info:
        module_coord = info['module_coord']
        chain = info['chain']

        if not chain:
            print(f"Module {info['module_coord']}: No parent chain found - this is likely a root project or has no parent POM.")
            continue

        print(f"Module: {info['module_name']}")
        print("  Parent chain is context only; it is not a remediation target.")
        print()

    # Also provide the original analysis summary
    # Count direct vs transitive occurrences
    total_occurrences = 0
    direct_occurrences = 0
    transitive_occurrences = 0

    for a in json_data.get('projects', []):
        deps = a.get('dependencies', [])
        for dep in deps:
            dep_ga = dep.get('ga') or f"{dep.get('groupId', '')}:{dep.get('artifactId', '')}"
            if dep_ga == target_ga and (not target_version or dep.get('version') == target_version):
                direct_occurrences += 1
                total_occurrences += 1

        dot_deps = a.get('dot_dependencies') or []
        for d in dot_deps:
            to_coord = d.get('to', '')
            if _coord_matches(to_coord, target_ga, target_version):
                transitive_occurrences += 1
                total_occurrences += 1

    print("=" * 60)
    print("ARTIFACT LOCATION SUMMARY (STATIC/PARTIAL):")
    print(f"Target: {target_ga}:{target_version}")
    print(f"Total occurrences: {total_occurrences}")
    print(f"  - Direct dependencies: {direct_occurrences}")
    print(f"  - Transitive dependencies: {transitive_occurrences}")

    print()
    if total_occurrences == 0:
        print("The artifact was not found in the project dependencies.")
    else:
        print(
            "No remediation is inferred from this static report. Confirm the "
            "resolved path and advisory/fixed-version evidence first."
        )


if __name__ == "__main__":
    main()
