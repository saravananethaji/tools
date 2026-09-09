"""Shared POM parsing utilities for Maven projects.

Provides consistent POM parsing across the codebase for:
- maven_runner.py (online analysis with mvn dependency:tree)
- maven_extractor.py (offline static analysis)
"""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ----------------------------------------------------------------------
# Data Models
# ----------------------------------------------------------------------

@dataclass
class ParentInfo:
    """Parent POM information."""
    groupId: str
    artifactId: str
    version: str
    relativePath: Optional[str] = None

    @property
    def coord(self) -> str:
        return f"{self.groupId}:{self.artifactId}:{self.version}"

    @property
    def ga(self) -> str:
        return f"{self.groupId}:{self.artifactId}"


@dataclass
class Dependency:
    """Maven dependency (from <dependencies> or <dependencyManagement>)."""
    groupId: str
    artifactId: str
    version: Optional[str] = None
    scope: Optional[str] = None
    type: Optional[str] = None
    classifier: Optional[str] = None

    @property
    def coord(self) -> str:
        parts = [self.groupId, self.artifactId]
        if self.type:
            parts.append(self.type)
        if self.classifier:
            parts.append(self.classifier)
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
    """Maven build plugin."""
    groupId: str
    artifactId: str
    version: Optional[str] = None
    configuration: Optional[Dict] = None

    @property
    def coord(self) -> str:
        parts = [self.groupId, self.artifactId]
        if self.version:
            parts.append(self.version)
        return ":".join(parts)


@dataclass
class PomInfo:
    """Complete parsed POM information."""
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


# ----------------------------------------------------------------------
# XML Namespace Handling
# ----------------------------------------------------------------------

_MAVEN_NS = "http://maven.apache.org/POM/4.0.0"
_MAVEN_NS_PREFIX = f"{{{_MAVEN_NS}}}"


def _localname(tag: str) -> str:
    """Strip XML namespace from an ElementTree tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_local(root, tag: str):
    """Find first child of root whose local tag name matches, ignoring namespace."""
    for el in root:
        if _localname(el.tag) == tag:
            return el
    return None


def _find_all_local(root, tag: str):
    """Find all children of root whose local tag name matches, ignoring namespace."""
    return [el for el in root if _localname(el.tag) == tag]


def _text(el, default: Optional[str] = None) -> Optional[str]:
    """Get stripped text content or default."""
    if el is None or el.text is None:
        return default
    return el.text.strip()


# ----------------------------------------------------------------------
# POM Parser
# ----------------------------------------------------------------------

def parse_pom(pom_path: str) -> Optional[PomInfo]:
    """Parse a pom.xml file and extract all relevant information.
    
    Args:
        pom_path: Absolute path to pom.xml file
        
    Returns:
        PomInfo object with all parsed data, or None if parsing fails
    """
    try:
        tree = ET.parse(pom_path)
        root = tree.getroot()
    except (ET.ParseError, OSError, UnicodeDecodeError) as e:
        # Could log warning here if logger passed
        return None

    def get_text(tag: str, default: Optional[str] = None) -> Optional[str]:
        el = _find_local(root, tag)
        return _text(el, default)

    # Basic coordinates (with parent inheritance)
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
                classifier=_text(_find_local(dep_el, "classifier")),
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
# Project Classification
# ----------------------------------------------------------------------

PACKAGE_GEN_PATTERNS = {
    "maven-plugin", "plugin", "packaging", "distribution",
    "assembly", "shade", "spring-boot", "quarkus"
}


class ProjectClassifier:
    """Classify Maven projects into types based on POM structure."""

    @classmethod
    def classify(cls, pom: PomInfo, all_poms: List[PomInfo],
                 _memo: Optional[Dict[str, Tuple[str, str]]] = None,
                 _visiting: Optional[Set[str]] = None) -> Tuple[str, str]:
        """
        Classify a POM into a project type.
        Returns (type, reason).
        """
        if _memo is None:
            _memo = {}
        if _visiting is None:
            _visiting = set()

        if pom.path in _memo:
            return _memo[pom.path]
        if pom.path in _visiting:
            return "Other Module", "cycle detected"

        _visiting.add(pom.path)

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
        parent_type = cls._get_parent_type(pom, all_poms, _memo, _visiting)

        result: Tuple[str, str]

        # Classification logic
        if packaging == "pom" and has_dm and not has_modules:
            if is_bom_imported:
                result = ("Service BOM", "packaging=pom + dependencyManagement + imported by others")
            else:
                result = ("Internal Parent BOM", "packaging=pom + dependencyManagement + no modules")

        elif packaging == "pom" and has_modules and has_import_scope:
            result = ("Service Framework", "packaging=pom + modules + imports BOM")

        elif packaging == "pom" and has_modules and parent_type == "Service Framework":
            result = ("Service Project", "packaging=pom + parent=framework + modules")

        elif packaging in ("jar", "war") and parent_type == "Service Project":
            result = ("Service Code", "packaging=jar/war + parent=service-project")

        elif packaging == "pom" and has_modules and uses_package_gen:
            result = ("Service Packaging", "packaging=pom + modules + uses Package Gen plugin")

        elif packaging in ("pom", "jar") and parent_type == "Service Packaging":
            if uses_package_gen:
                result = ("Service Package", "parent=service-packaging + uses Package Gen")
            else:
                result = ("Service Package", "parent=service-packaging")

        elif packaging == "maven-plugin":
            result = ("Package Gen", "packaging=maven-plugin")

        elif packaging == "jar" and parent_type in ("Internal Parent BOM", "Service BOM"):
            # Count usage across services
            usage_count = cls._count_usage(pom, all_poms, _memo, _visiting)
            if usage_count >= 3:
                result = ("Common Component", f"parent=internal-bom + used by {usage_count} services")
            else:
                result = ("Other Module", f"parent=internal-bom + used by {usage_count} services")

        # Fallbacks
        elif packaging == "pom":
            if has_modules:
                result = ("Aggregator POM", "packaging=pom + modules")
            elif has_dm:
                result = ("BOM", "packaging=pom + dependencyManagement")
            else:
                result = ("Parent POM", "packaging=pom")
        else:
            result = ("Library", f"packaging={packaging}")

        _visiting.remove(pom.path)
        _memo[pom.path] = result
        return result

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
            if any(pattern in artifact_lower for pattern in PACKAGE_GEN_PATTERNS):
                return True
        return False

    @classmethod
    def _get_parent_type(cls, pom: PomInfo, all_poms: List[PomInfo],
                         _memo: Optional[Dict[str, Tuple[str, str]]] = None,
                         _visiting: Optional[Set[str]] = None) -> Optional[str]:
        """Get the classified type of the parent POM."""
        if not pom.parent:
            return None
        for other in all_poms:
            if other.ga == pom.parent.ga and other.version == pom.parent.version:
                parent_type, _ = cls.classify(other, all_poms, _memo, _visiting)
                return parent_type
        return None

    @classmethod
    def _count_usage(cls, pom: PomInfo, all_poms: List[PomInfo],
                     _memo: Optional[Dict[str, Tuple[str, str]]] = None,
                     _visiting: Optional[Set[str]] = None) -> int:
        """Count how many Service Code modules depend on this artifact."""
        count = 0
        for other in all_poms:
            if other.path == pom.path:
                continue
            other_type, _ = cls.classify(other, all_poms, _memo, _visiting)
            if other_type == "Service Code":
                for dep in other.dependencies:
                    if dep.ga == pom.ga:
                        count += 1
                        break
        return count


# ----------------------------------------------------------------------
# Maven Coordinate Parsing (for DOT output)
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
# DOT File Parsing
# ----------------------------------------------------------------------

import re
_EDGE_RE = re.compile(r'"([^"]+)"\s*->\s*"([^"]+)"')


@dataclass
class DotDependency:
    from_coord: str
    to_coord: str
    scope: str


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
        # Could log warning
        pass
    return dependencies


# ----------------------------------------------------------------------
# Convenience Functions
# ----------------------------------------------------------------------

def find_poms(root_dir: str) -> List[str]:
    """Find all pom.xml files under root_dir (excluding target/ and other common non-source directories)."""
    SKIP_DIRS = {
        "target", "node_modules", ".git", ".idea", ".vscode",
        "dist", "build", "out", "__pycache__",
    }
    MAVEN_PROJECT_SKIP_DIRS = {"src", "target", "test"}
    
    poms: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        is_maven_project = "pom.xml" in filenames
        
        skip_dirs = set(SKIP_DIRS)
        if is_maven_project:
            skip_dirs.update(MAVEN_PROJECT_SKIP_DIRS)
        
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        
        if is_maven_project:
            pom_path = os.path.join(dirpath, "pom.xml")
            poms.append(pom_path)
    
    return sorted(poms)


def scan_projects(root_dir: str) -> List[PomInfo]:
    """Scan directory and parse all POMs, returning list of PomInfo."""
    poms = find_poms(root_dir)
    results = []
    for pom_path in poms:
        pom = parse_pom(pom_path)
        if pom:
            results.append(pom)
    return results
