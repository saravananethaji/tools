#!/usr/bin/env python3
"""
Maven Project Structure Extractor

Scans a root directory for Maven projects, extracts POM structure,
dependencies, and generates a Markdown report for analysis.

Usage:
    python maven_extractor.py <root_directory> [output_file.md]

Example:
    python maven_extractor.py C:/product/tools/githubrepo output.md
"""

from __future__ import annotations

import os
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


# ----------------------------------------------------------------------
# Data Models
# ----------------------------------------------------------------------

@dataclass
class ParentInfo:
    groupId: str
    artifactId: str
    version: str
    relativePath: Optional[str] = None

    @property
    def coord(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"


@dataclass
class Dependency:
    groupId: str
    artifactId: str
    version: Optional[str] = None
    scope: Optional[str] = None
    type: Optional[str] = None

    @property
    def coord(self) -> str:
        parts = [self.groupId, self.artifactId]
        if self.type:
            parts.append(self.type)
        if self.version:
            parts.append(self.version)
        if self.scope:
            parts.append(self.scope)
        return ":".join(parts)

    @property
    def ga(self) -> str:
        return f"{self.groupId}:{self.artifactId}"


@dataclass
class Plugin:
    groupId: str
    artifactId: str
    version: Optional[str] = None

    @property
    def coord(self) -> str:
        parts = [self.groupId, self.artifactId]
        if self.version:
            parts.append(self.version)
        return ":".join(parts)


@dataclass
class PomInfo:
    path: str
    directory: str
    groupId: str
    artifactId: str
    version: str
    packaging: str
    name: Optional[str] = None
    description: Optional[str] = None
    parent: Optional[ParentInfo] = None
    modules: List[str] = field(default_factory=list)
    dependencies: List[Dependency] = field(default_factory=list)
    dependency_management: List[Dependency] = field(default_factory=list)
    plugins: List[Plugin] = field(default_factory=list)
    properties: Dict[str, str] = field(default_factory=dict)

    @property
    def coord(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"

    @property
    def ga(self) -> str:
        return f"{self.groupId}:{self.artifactId}"


@dataclass
class DotDependency:
    from_coord: str
    to_coord: str
    scope: str


@dataclass
class ProjectAnalysis:
    pom: PomInfo
    dot_file: Optional[str] = None
    dot_dependencies: List[DotDependency] = field(default_factory=list)
    project_type: str = "UNKNOWN"
    classification_reason: str = ""


# ----------------------------------------------------------------------
# POM Parser
# ----------------------------------------------------------------------

def _localname(tag: str) -> str:
    """Strip XML namespace from an ElementTree tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_local(root, tag: str):
    """Find first child of root whose local tag name matches."""
    for el in root:
        if _localname(el.tag) == tag:
            return el
    return None


def _find_all_local(root, tag: str):
    """Find all children of root whose local tag name matches."""
    return [el for el in root if _localname(el.tag) == tag]


def _text(el, default: Optional[str] = None) -> Optional[str]:
    """Get stripped text content or default."""
    if el is None or el.text is None:
        return default
    return el.text.strip()


def parse_pom(pom_path: str) -> Optional[PomInfo]:
    """Parse a pom.xml file and extract all relevant information."""
    try:
        tree = ET.parse(pom_path)
        root = tree.getroot()
    except (ET.ParseError, OSError, UnicodeDecodeError) as e:
        print(f"  [WARN] Cannot parse {pom_path}: {e}")
        return None

    def get_text(tag: str, default: Optional[str] = None) -> Optional[str]:
        el = _find_local(root, tag)
        return _text(el, default)

    # Basic coordinates
    groupId = get_text("groupId")
    artifactId = get_text("artifactId", "unknown")
    version = get_text("version")
    packaging = get_text("packaging", "jar")

    # Parent
    parent = None
    parent_el = _find_local(root, "parent")
    if parent_el is not None:
        p_groupId = _text(_find_local(parent_el, "groupId"))
        p_artifactId = _text(_find_local(parent_el, "artifactId"), "unknown")
        p_version = _text(_find_local(parent_el, "version"))
        p_relative = _text(_find_local(parent_el, "relativePath"))
        parent = ParentInfo(p_groupId, p_artifactId, p_version, p_relative)

        # Inherit from parent if not set
        if not groupId:
            groupId = p_groupId
        if not version:
            version = p_version

    groupId = groupId or "unknown"
    version = version or "unknown"

    # Modules
    modules = []
    modules_el = _find_local(root, "modules")
    if modules_el is not None:
        for module_el in _find_all_local(modules_el, "module"):
            module_path = _text(module_el)
            if module_path:
                modules.append(module_path)

    # Dependencies
    dependencies = []
    deps_el = _find_local(root, "dependencies")
    if deps_el is not None:
        for dep_el in _find_all_local(deps_el, "dependency"):
            dep = Dependency(
                groupId=_text(_find_local(dep_el, "groupId"), "unknown"),
                artifactId=_text(_find_local(dep_el, "artifactId"), "unknown"),
                version=_text(_find_local(dep_el, "version")),
                scope=_text(_find_local(dep_el, "scope")),
                type=_text(_find_local(dep_el, "type")),
            )
            dependencies.append(dep)

    # Dependency Management (BOM imports)
    dependency_management = []
    dm_el = _find_local(root, "dependencyManagement")
    if dm_el is not None:
        dm_deps_el = _find_local(dm_el, "dependencies")
        if dm_deps_el is not None:
            for dep_el in _find_all_local(dm_deps_el, "dependency"):
                dep = Dependency(
                    groupId=_text(_find_local(dep_el, "groupId"), "unknown"),
                    artifactId=_text(_find_local(dep_el, "artifactId"), "unknown"),
                    version=_text(_find_local(dep_el, "version")),
                    scope=_text(_find_local(dep_el, "scope")),
                    type=_text(_find_local(dep_el, "type")),
                )
                dependency_management.append(dep)

    # Plugins
    plugins = []
    build_el = _find_local(root, "build")
    if build_el is not None:
        plugins_el = _find_local(build_el, "plugins")
        if plugins_el is not None:
            for plugin_el in _find_all_local(plugins_el, "plugin"):
                plugin = Plugin(
                    groupId=_text(_find_local(plugin_el, "groupId"), "unknown"),
                    artifactId=_text(_find_local(plugin_el, "artifactId"), "unknown"),
                    version=_text(_find_local(plugin_el, "version")),
                )
                plugins.append(plugin)

    # Properties
    properties = {}
    props_el = _find_local(root, "properties")
    if props_el is not None:
        for prop in props_el:
            tag = _localname(prop.tag)
            value = _text(prop)
            if tag and value:
                properties[tag] = value

    return PomInfo(
        path=pom_path,
        directory=os.path.dirname(pom_path),
        groupId=groupId,
        artifactId=artifactId,
        version=version,
        packaging=packaging,
        name=get_text("name"),
        description=get_text("description"),
        parent=parent,
        modules=modules,
        dependencies=dependencies,
        dependency_management=dependency_management,
        plugins=plugins,
        properties=properties,
    )


# ----------------------------------------------------------------------
# DOT File Parser
# ----------------------------------------------------------------------

_EDGE_RE = re.compile(r'"([^"]+)"\s*->\s*"([^"]+)"')


def parse_dot_file(dot_path: str) -> List[DotDependency]:
    """Parse Maven dependency:tree DOT output."""
    dependencies = []
    try:
        with open(dot_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                match = _EDGE_RE.search(line)
                if match:
                    src, dst = match.group(1), match.group(2)
                    # Extract scope from destination coordinate
                    scope = "compile"
                    if ":" in dst:
                        parts = dst.split(":")
                        if len(parts) >= 5:
                            scope = parts[-1]
                    dependencies.append(DotDependency(src, dst, scope))
    except OSError as e:
        print(f"  [WARN] Cannot read {dot_path}: {e}")
    return dependencies


# ----------------------------------------------------------------------
# Project Classifier
# ----------------------------------------------------------------------

class ProjectClassifier:
    """Classify Maven projects into types based on POM structure."""

    # Known plugin patterns for Package Gen detection
    PACKAGE_GEN_PATTERNS = {
        "maven-plugin", "plugin", "packaging", "distribution",
        "assembly", "shade", "spring-boot", "quarkus"
    }

    @classmethod
    def classify(cls, pom: PomInfo, all_poms: List[PomInfo]) -> Tuple[str, str]:
        """
        Classify a POM into a project type.
        Returns (type, reason).
        """
        packaging = pom.packaging.lower()
        has_parent = pom.parent is not None
        has_modules = len(pom.modules) > 0
        has_dm = len(pom.dependency_management) > 0
        has_import_scope = any(
            d.scope == "import" for d in pom.dependency_management
        )

        # Check if this is a BOM (imported by others)
        is_bom_imported = cls._is_bom_imported(pom, all_poms)

        # Check for Package Gen plugin usage
        uses_package_gen = cls._uses_package_gen_plugin(pom)

        # Check parent type
        parent_type = cls._get_parent_type(pom, all_poms)

        # Classification logic
        if packaging == "pom" and has_dm and not has_modules:
            if is_bom_imported:
                return "Service BOM", "packaging=pom + dependencyManagement + imported by others"
            return "Internal Parent BOM", "packaging=pom + dependencyManagement + no modules"

        if packaging == "pom" and has_modules and has_import_scope:
            return "Service Framework", "packaging=pom + modules + imports BOM"

        if packaging == "pom" and has_modules and parent_type == "Service Framework":
            return "Service Project", "packaging=pom + parent=framework + modules"

        if packaging in ("jar", "war") and parent_type == "Service Project":
            return "Service Code", "packaging=jar/war + parent=service-project"

        if packaging == "pom" and has_modules and uses_package_gen:
            return "Service Packaging", "packaging=pom + modules + uses Package Gen plugin"

        if packaging in ("pom", "jar") and parent_type == "Service Packaging":
            if uses_package_gen:
                return "Service Package", "parent=service-packaging + uses Package Gen"
            return "Service Package", "parent=service-packaging"

        if packaging == "maven-plugin":
            return "Package Gen", "packaging=maven-plugin"

        if packaging == "jar" and parent_type in ("Internal Parent BOM", "Service BOM"):
            # Count usage across services
            usage_count = cls._count_usage(pom, all_poms)
            if usage_count >= 3:
                return "Common Component", f"parent=internal-bom + used by {usage_count} services"
            return "Other Module", f"parent=internal-bom + used by {usage_count} services"

        # Fallbacks
        if packaging == "pom":
            if has_modules:
                return "Aggregator POM", "packaging=pom + modules"
            if has_dm:
                return "BOM", "packaging=pom + dependencyManagement"
            return "Parent POM", "packaging=pom"

        return "Library", f"packaging={packaging}"

    @classmethod
    def _is_bom_imported(cls, pom: PomInfo, all_poms: List[PomInfo]) -> bool:
        """Check if this POM is imported as a BOM by other projects."""
        for other in all_poms:
            if other.path == pom.path:
                continue
            for dep in other.dependency_management:
                if dep.scope == "import" and dep.ga == pom.ga:
                    return True
        return False

    @classmethod
    def _uses_package_gen_plugin(cls, pom: PomInfo) -> bool:
        """Check if POM uses any package generation plugin."""
        for plugin in pom.plugins:
            artifact_lower = plugin.artifactId.lower()
            if any(pattern in artifact_lower for pattern in cls.PACKAGE_GEN_PATTERNS):
                return True
        return False

    @classmethod
    def _get_parent_type(cls, pom: PomInfo, all_poms: List[PomInfo]) -> Optional[str]:
        """Get the classified type of the parent POM."""
        if not pom.parent:
            return None
        for other in all_poms:
            if other.ga == pom.parent.ga and other.version == pom.parent.version:
                parent_type, _ = cls.classify(other, all_poms)
                return parent_type
        return None

    @classmethod
    def _count_usage(cls, pom: PomInfo, all_poms: List[PomInfo]) -> int:
        """Count how many Service Code modules depend on this artifact."""
        count = 0
        for other in all_poms:
            other_type, _ = cls.classify(other, all_poms)
            if other_type == "Service Code":
                for dep in other.dependencies:
                    if dep.ga == pom.ga:
                        count += 1
                        break
        return count


# ----------------------------------------------------------------------
# Scanner
# ----------------------------------------------------------------------

class MavenScanner:
    """Scan directories for Maven projects and extract information."""

    SKIP_DIRS = {
        "node_modules", ".git", ".idea", ".vscode",
        "dist", "build", "out", "__pycache__",
    }

    MAVEN_SKIP_DIRS = {"src", "target", "test"}

    def __init__(self, root_dir: str):
        self.root_dir = os.path.abspath(root_dir)
        self.poms: List[PomInfo] = []
        self.dot_files: Dict[str, str] = {}  # pom_dir -> dot_file_path

    def scan(self) -> List[ProjectAnalysis]:
        """Scan for all POMs and DOT files, return analysis."""
        print(f"Scanning: {self.root_dir}")
        self._find_poms_and_dots()
        print(f"Found {len(self.poms)} pom.xml files")

        # Validate nested project discovery
        self._validate_nested_discovery()

        # Build analysis
        analyses = []
        classifier = ProjectClassifier()

        for pom in self.poms:
            # Find matching DOT file
            dot_file = self.dot_files.get(pom.directory)
            dot_deps = parse_dot_file(dot_file) if dot_file else []

            # Classify
            project_type, reason = classifier.classify(pom, self.poms)

            analysis = ProjectAnalysis(
                pom=pom,
                dot_file=dot_file,
                dot_dependencies=dot_deps,
                project_type=project_type,
                classification_reason=reason,
            )
            analyses.append(analysis)

        return analyses

    def _validate_nested_discovery(self):
        """Validate that nested Maven projects were discovered correctly."""
        # Check for POMs that declare modules but we didn't find all of them
        for pom in self.poms:
            if not pom.modules:
                continue

            pom_dir = pom.directory
            for module_path in pom.modules:
                # Resolve module path (handle relative paths like ../other-module)
                if module_path.startswith(".."):
                    expected_dir = os.path.normpath(os.path.join(pom_dir, module_path))
                else:
                    expected_dir = os.path.normpath(os.path.join(pom_dir, module_path))

                expected_pom = os.path.join(expected_dir, "pom.xml")

                # Check if we found this nested module
                found = any(p.path == expected_pom for p in self.poms)
                if not found:
                    if os.path.exists(expected_pom):
                        print(f"  [WARN] Nested module not discovered: {expected_pom}")
                        print(f"         (declared in {pom.coord})")
                    else:
                        print(f"  [INFO] Module path does not exist: {expected_pom}")

    def _find_poms_and_dots(self):
        """Walk directory tree, find pom.xml and .dot files.
        
        For Maven projects (directories containing pom.xml), skip their
        src/, target/, and test/ subdirectories during traversal. Also skip
        common non-source directories globally.
        
        IMPORTANT: This handles NESTED Maven projects correctly:
        - A directory with pom.xml will have its src/target/test skipped
        - But subdirectories WITH their own pom.xml are still traversed
        - Example:
            root/pom.xml          → found, skips root/src, root/target
            root/module/pom.xml   → found, skips root/module/src, root/module/target
        """
        for dirpath, dirnames, filenames in os.walk(self.root_dir):
            # Check if current directory is a Maven project (has pom.xml)
            is_maven_project = "pom.xml" in filenames

            # Filter directories to skip during traversal
            skip_dirs = set(self.SKIP_DIRS)
            if is_maven_project:
                # Only skip src/target/test inside actual Maven projects
                skip_dirs.update(self.MAVEN_SKIP_DIRS)
                # Log what we're skipping for visibility
                skipped = [d for d in dirnames if d in self.MAVEN_SKIP_DIRS]
                if skipped:
                    print(f"  [SKIP] {dirpath}: {', '.join(skipped)}")

            # IMPORTANT: dirnames[:] modifies the list in-place, which affects
            # os.walk's traversal. We skip src/target/test, but we do NOT skip
            # subdirectories that might contain their own pom.xml (nested modules).
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]

            # Parse pom.xml in current directory
            if is_maven_project:
                pom_path = os.path.join(dirpath, "pom.xml")
                pom = parse_pom(pom_path)
                if pom:
                    self.poms.append(pom)
                    # Log nested modules for visibility
                    if pom.modules:
                        print(f"  [MODULES] {pom.coord}: {', '.join(pom.modules)}")

            # Look for .dot files in current directory
            for filename in filenames:
                if filename.endswith(".dot"):
                    dot_path = os.path.join(dirpath, filename)
                    self.dot_files[dirpath] = dot_path


# ----------------------------------------------------------------------
# Markdown Report Generator
# ----------------------------------------------------------------------

class MarkdownReportGenerator:
    """Generate a structured Markdown report from project analysis."""

    def __init__(self, analyses: List[ProjectAnalysis]):
        self.analyses = analyses
        self.by_type: Dict[str, List[ProjectAnalysis]] = {}
        for a in analyses:
            self.by_type.setdefault(a.project_type, []).append(a)

    def generate(self) -> str:
        """Generate the complete Markdown report."""
        lines = [
            "# Maven Project Analysis Report",
            "",
            f"**Generated:** {self._timestamp()}",
            f"**Root Directory:** `{self._root_dir()}`",
            f"**Total Projects:** {len(self.analyses)}",
            "",
            "---",
            "",
            "## Executive Summary",
            "",
            self._summary_table(),
            "",
            "---",
            "",
            "## Projects by Type",
            "",
        ]

        # Add section for each project type
        for project_type in sorted(self.by_type.keys()):
            projects = self.by_type[project_type]
            lines.extend(self._type_section(project_type, projects))
            lines.append("")

        # Detailed listings
        lines.extend([
            "---",
            "",
            "## Detailed Project Information",
            "",
        ])

        for a in self.analyses:
            lines.extend(self._project_detail(a))
            lines.append("")

        # Dependency matrix
        lines.extend([
            "---",
            "",
            "## Dependency Matrix",
            "",
            self._dependency_matrix(),
            "",
        ])

        # Version conflicts
        lines.extend([
            "---",
            "",
            "## Version Conflicts",
            "",
            self._version_conflicts(),
            "",
        ])

        return "\n".join(lines)

    def _timestamp(self) -> str:
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _root_dir(self) -> str:
        if self.analyses:
            # Find common root
            paths = [a.pom.directory for a in self.analyses]
            return os.path.commonpath(paths) if paths else "unknown"
        return "unknown"

    def _summary_table(self) -> str:
        lines = [
            "| Project Type | Count |",
            "|--------------|-------|",
        ]
        for project_type in sorted(self.by_type.keys()):
            count = len(self.by_type[project_type])
            lines.append(f"| {project_type} | {count} |")
        return "\n".join(lines)

    def _type_section(self, project_type: str, projects: List[ProjectAnalysis]) -> List[str]:
        lines = [
            f"### {project_type} ({len(projects)})",
            "",
            "| GroupId | ArtifactId | Version | Packaging | Location |",
            "|---------|------------|---------|-----------|----------|",
        ]
        for a in sorted(projects, key=lambda x: x.pom.coord):
            p = a.pom
            rel_path = os.path.relpath(p.directory, self._root_dir())
            lines.append(
                f"| `{p.groupId}` | `{p.artifactId}` | `{p.version}` | "
                f"`{p.packaging}` | `{rel_path}` |"
            )
        return lines

    def _project_detail(self, a: ProjectAnalysis) -> List[str]:
        p = a.pom
        lines = [
            f"### {p.coord}",
            "",
            f"**Type:** {a.project_type}",
            f"**Classification:** {a.classification_reason}",
            f"**Path:** `{p.path}`",
            "",
            "#### Basic Info",
            "",
            f"- **GroupId:** `{p.groupId}`",
            f"- **ArtifactId:** `{p.artifactId}`",
            f"- **Version:** `{p.version}`",
            f"- **Packaging:** `{p.packaging}`",
        ]

        if p.name:
            lines.append(f"- **Name:** {p.name}")
        if p.description:
            lines.append(f"- **Description:** {p.description}")

        # Parent
        if p.parent:
            lines.extend([
                "",
                "#### Parent",
                "",
                f"- **Coordinates:** `{p.parent.coord}`",
            ])
            if p.parent.relativePath:
                lines.append(f"- **Relative Path:** `{p.parent.relativePath}`")

        # Modules
        if p.modules:
            lines.extend([
                "",
                "#### Modules",
                "",
            ])
            for m in p.modules:
                lines.append(f"- `{m}`")

        # Dependency Management (BOM)
        if p.dependency_management:
            lines.extend([
                "",
                f"#### Dependency Management ({len(p.dependency_management)} entries)",
                "",
                "| GroupId | ArtifactId | Version | Scope | Type |",
                "|---------|------------|---------|-------|------|",
            ])
            for d in p.dependency_management[:20]:  # Limit to first 20
                lines.append(
                    f"| `{d.groupId}` | `{d.artifactId}` | `{d.version or '?'}` | "
                    f"`{d.scope or '?'}` | `{d.type or 'jar'}` |"
                )
            if len(p.dependency_management) > 20:
                lines.append(f"| ... | ... | ... | ... | ... | ({len(p.dependency_management) - 20} more)")

        # Dependencies
        if p.dependencies:
            lines.extend([
                "",
                f"#### Dependencies ({len(p.dependencies)})",
                "",
                "| GroupId | ArtifactId | Version | Scope |",
                "|---------|------------|---------|-------|",
            ])
            for d in p.dependencies[:20]:
                lines.append(
                    f"| `{d.groupId}` | `{d.artifactId}` | `{d.version or '?'}` | `{d.scope or 'compile'}` |"
                )
            if len(p.dependencies) > 20:
                lines.append(f"| ... | ... | ... | ... | ({len(p.dependencies) - 20} more)")

        # Plugins
        if p.plugins:
            lines.extend([
                "",
                f"#### Build Plugins ({len(p.plugins)})",
                "",
                "| GroupId | ArtifactId | Version |",
                "|---------|------------|---------|",
            ])
            for pl in p.plugins:
                lines.append(f"| `{pl.groupId}` | `{pl.artifactId}` | `{pl.version or '?'}` |")

        # DOT dependencies
        if a.dot_dependencies:
            lines.extend([
                "",
                f"#### Resolved Dependencies from DOT ({len(a.dot_dependencies)} edges)",
                "",
                "| From | To | Scope |",
                "|------|-----|-------|",
            ])
            for d in a.dot_dependencies[:30]:
                lines.append(f"| `{d.from_coord}` | `{d.to_coord}` | `{d.scope}` |")
            if len(a.dot_dependencies) > 30:
                lines.append(f"| ... | ... | ... | ({len(a.dot_dependencies) - 30} more edges)")

        # Properties
        if p.properties:
            lines.extend([
                "",
                f"#### Properties ({len(p.properties)})",
                "",
                "| Property | Value |",
                "|----------|-------|",
            ])
            for k, v in list(p.properties.items())[:10]:
                lines.append(f"| `{k}` | `{v}` |")
            if len(p.properties) > 10:
                lines.append(f"| ... | ... | ({len(p.properties) - 10} more)")

        return lines

    def _dependency_matrix(self) -> str:
        """Show which projects depend on which artifacts."""
        # Collect all dependencies
        all_deps: Dict[str, Set[str]] = {}  # artifact_ga -> set of project_coords

        for a in self.analyses:
            project_coord = a.pom.coord
            for dep in a.pom.dependencies:
                ga = dep.ga
                if ga not in all_deps:
                    all_deps[ga] = set()
                all_deps[ga].add(project_coord)

        lines = [
            "| Dependency | Used By (count) | Projects |",
            "|------------|-----------------|----------|",
        ]

        # Sort by usage count (most used first)
        sorted_deps = sorted(all_deps.items(), key=lambda x: len(x[1]), reverse=True)

        for ga, projects in sorted_deps[:50]:  # Top 50
            count = len(projects)
            project_list = ", ".join(sorted(projects)[:5])
            if count > 5:
                project_list += f", ... ({count - 5} more)"
            lines.append(f"| `{ga}` | {count} | {project_list} |")

        return "\n".join(lines)

    def _version_conflicts(self) -> str:
        """Detect version conflicts across all dependencies."""
        # Collect all versions per artifact
        versions: Dict[str, Set[str]] = {}  # ga -> set of versions

        for a in self.analyses:
            for dep in a.pom.dependencies:
                if dep.version:
                    if dep.ga not in versions:
                        versions[dep.ga] = set()
                    versions[dep.ga].add(dep.version)

        # Also check dependencyManagement
        for a in self.analyses:
            for dep in a.pom.dependency_management:
                if dep.version:
                    if dep.ga not in versions:
                        versions[dep.ga] = set()
                    versions[dep.ga].add(dep.version)

        # Find conflicts
        conflicts = {ga: v for ga, v in versions.items() if len(v) > 1}

        if not conflicts:
            return "No version conflicts detected."

        lines = [
            "| Dependency | Versions | Count |",
            "|------------|----------|-------|",
        ]

        for ga, v in sorted(conflicts.items(), key=lambda x: len(x[1]), reverse=True):
            version_list = ", ".join(sorted(v))
            lines.append(f"| `{ga}` | {version_list} | {len(v)} |")

        return "\n".join(lines)


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: python maven_extractor.py <root_directory> [output_file.md]")
        print("Example: python maven_extractor.py C:/product/tools/githubrepo output.md")
        sys.exit(1)

    root_dir = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else "maven_analysis.md"

    if not os.path.isdir(root_dir):
        print(f"Error: {root_dir} is not a directory")
        sys.exit(1)

    # Scan
    scanner = MavenScanner(root_dir)
    analyses = scanner.scan()

    # Generate report
    print(f"Generating report: {output_file}")
    generator = MarkdownReportGenerator(analyses)
    report = generator.generate()

    # Write output
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"Done! Report written to: {output_file}")
    print(f"  - {len(analyses)} projects analyzed")
    print(f"  - {len(generator.by_type)} project types identified")


if __name__ == "__main__":
    main()
