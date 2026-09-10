"""FastAPI app for the Maven dependency graph viewer.

Routes:
  GET  /                 -> redirect to /tree
  GET  /api/state         -> full model as JSON (modules + trees)
  GET  /tree              -> tree view (option 1) with search (option 3)
  GET  /conflicts         -> conflicts view (option 2)
  GET  /export            -> download .cypher script (option 4)
  POST  /api/reload        -> re-run Maven and refresh cache
  POST  /api/load          -> load/scan a root folder (body: {"root": "..."})
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, Request, Form, HTTPException, status, UploadFile, File
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from maven_runner import build_model
from graph_model import GraphModel, Module, TreeNode, SCAN_SCHEMA_VERSION
from neo4j_export import export_cypher
from pom_parser import parse_pom, PomInfo, Dependency, Plugin, ParentInfo

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("projectgraph")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "cache")
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

# Ensure runtime dirs exist (git skips empty directories).
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app = FastAPI(title="Maven Dependency Graph")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# In-memory current model + the root it was built from
_state: dict = {"root": None, "model": None}


def _validate_root_path(root: str) -> str:
    """Validate and sanitize root directory path.
    
    Args:
        root: User-provided directory path
        
    Returns:
        Normalized absolute path
        
    Raises:
        HTTPException: If path is invalid, doesn't exist, or traversal attempt
    """
    if not root or not root.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Root directory path is required"
        )
    
    raw_path = root.strip()
    if not os.path.isabs(raw_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path must be absolute"
        )

    # Normalize path and resolve symlinks.
    try:
        abs_path = str(Path(raw_path).resolve(strict=True))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid path: {e}"
        )
    
    # Check if path exists and is a directory
    if not os.path.exists(abs_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Directory does not exist: {abs_path}"
        )
    
    if not os.path.isdir(abs_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a directory: {abs_path}"
        )
    
    configured_roots = os.environ.get("PROJECTGRAPH_ALLOWED_ROOTS")
    allowed_roots = [
        Path(p.strip()).resolve()
        for p in (configured_roots.split(os.pathsep) if configured_roots else [BASE_DIR])
        if p.strip()
    ]
    resolved = Path(abs_path)
    if not any(resolved == allowed or resolved.is_relative_to(allowed) for allowed in allowed_roots):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path is outside PROJECTGRAPH_ALLOWED_ROOTS"
        )
    
    return abs_path


# Global exception handlers
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    logger.error(f"HTTP error {exc.status_code}: {exc.detail}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "error": exc.detail}
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Unhandled error: {exc}")
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"ok": False, "error": "Internal server error"}
    )


async def _get_model():
    if _state["model"] is None:
        root = _state["root"] or _default_root()
        _state["model"] = await run_in_threadpool(build_model, root, CACHE_DIR)
    return _state["model"]


def _default_root() -> str:
    # default: local test_projects directory or ../test fixture
    here = os.path.dirname(os.path.abspath(__file__))
    local_test = os.path.join(here, "test_projects")
    if os.path.isdir(local_test):
        return local_test
    return os.path.normpath(os.path.join(here, "..", "test"))


@app.get("/")
async def index():
    return RedirectResponse(url="/tree")


@app.get("/api/state")
async def api_state():
    model = await _get_model()
    return JSONResponse(model.to_dict())


@app.get("/tree", response_class=HTMLResponse)
async def tree_view(request: Request, q: str = ""):
    model = await _get_model()
    return templates.TemplateResponse(request, "tree.html", {
        "modules": [m.to_dict() for m in model.modules],
        "query": q,
        "root": _state["root"] or _default_root(),
    })


@app.get("/conflicts", response_class=HTMLResponse)
async def conflicts_view(request: Request):
    model = await _get_model()
    conflicts = model.conflicts()
    return templates.TemplateResponse(request, "conflicts.html", {
        "conflicts": [
            {
                "artifact_key": c.artifact_key,
                "versions": c.versions,
                "occurrences": c.occurrences,
            }
            for c in conflicts
        ],
        "root": _state["root"] or _default_root(),
    })


@app.get("/export", response_class=HTMLResponse)
async def export_view(request: Request):
    model = await _get_model()
    cypher = export_cypher(model)
    return templates.TemplateResponse(request, "export.html", {
        "cypher": cypher,
        "root": _state["root"] or _default_root(),
    })


@app.get("/export/download", response_class=PlainTextResponse)
async def export_download():
    model = await _get_model()
    cypher = export_cypher(model)
    return PlainTextResponse(
        cypher, media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename=dependency-graph.cypher"},
    )


@app.post("/api/reload")
async def api_reload():
    root = _state["root"] or _default_root()
    logger.info(f"Reload requested for: {root}")
    # Run blocking build_model in thread pool to avoid blocking event loop
    _state["model"] = await run_in_threadpool(build_model, root, CACHE_DIR, True)
    count = len(_state["model"].modules)
    logger.info(f"Reload complete: {count} module(s)")
    return JSONResponse({"ok": True, "modules": count})


@app.post("/api/load")
async def api_load(root: str = Form(...)):
    logger.info(f"Load requested for: {root}")
    # Validate and sanitize the input path
    abs_root = _validate_root_path(root)
    _state["root"] = abs_root
    logger.info(f"Scanning directory: {_state['root']}")
    # Run blocking build_model in thread pool to avoid blocking event loop
    _state["model"] = await run_in_threadpool(build_model, _state["root"], CACHE_DIR)
    count = len(_state["model"].modules)
    logger.info(f"Load complete: {count} module(s)")
    return JSONResponse({"ok": True, "modules": count})


@app.post("/api/load-json")
async def api_load_json(file: UploadFile = File(...)):
    """Load a versioned ProjectGraph scan or static-analysis export."""
    logger.info(f"Loading JSON file: {file.filename}")
    
    if not file.filename or not file.filename.endswith('.json'):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be a .json file"
        )
    
    try:
        content = await file.read()
        data = json.loads(content.decode('utf-8'))
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid JSON: {e}"
        )
    
    if data.get("schema_version") != SCAN_SCHEMA_VERSION:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported or missing schema_version; expected "
                f"{SCAN_SCHEMA_VERSION}"
            )
        )

    # A resolved scan round-trips directly through the canonical model.
    if "modules" in data:
        try:
            model = GraphModel.from_dict(data)
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid scan JSON: {e}",
            )
        _state["model"] = model
        _state["root"] = model.root or "loaded-from-json"
        return JSONResponse({
            "ok": True,
            "modules": len(model.modules),
            "source": model.source,
            "completeness": model.to_dict()["metadata"]["completeness"],
        })

    # Static extractor exports use the same versioned envelope but remain
    # explicitly partial; managed declarations are never fabricated as edges.
    if "projects" not in data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Scan JSON must contain 'modules' or 'projects'",
        )
    
    # Convert JSON projects to GraphModel
    metadata = data.get("metadata", {})
    model = GraphModel(
        root=metadata.get("root") or metadata.get("root_directory"),
        scan_id=metadata.get("scan_id"),
        generated_at=metadata.get("generated_at"),
        source="pom-static",
        completeness="partial",
    )

    def dependency_from_dict(item: dict) -> Dependency:
        return Dependency(
            groupId=item.get("groupId", "unknown"),
            artifactId=item.get("artifactId", "unknown"),
            version=item.get("version"),
            scope=item.get("scope"),
            type=item.get("type"),
            classifier=item.get("classifier"),
        )
    
    import_errors = []
    for index, p in enumerate(data["projects"]):
        try:
            coord = p["coordinates"]
            pom = PomInfo(
                path=p.get("path", ""),
                directory=p.get("directory", ""),
                groupId=coord["groupId"],
                artifactId=coord["artifactId"],
                version=coord["version"],
                packaging=coord.get("packaging", "jar"),
                name=p.get("name"),
                description=p.get("description"),
                parent=ParentInfo(**p["parent"]) if p.get("parent") else None,
                modules=p.get("modules", []),
                dependencies=[dependency_from_dict(d) for d in p.get("dependencies", [])],
                dependency_management=[
                    dependency_from_dict(d)
                    for d in p.get("dependency_management", [])
                ],
                plugins=[Plugin(**pl) for pl in p.get("plugins", [])],
                properties=p.get("properties", {}),
            )
            
            # Build module
            module = Module(
                pom_path=pom.path or f"{pom.groupId}/{pom.artifactId}/pom.xml",
                dir_path=pom.directory,
                coord_id=pom.coord,
                groupId=pom.groupId,
                artifactId=pom.artifactId,
                version=pom.version,
                project_type=p.get("project_type", "Other Module"),
                classification_reason=p.get("classification_reason", "not classified"),
                source="pom-static",
                completeness="partial",
                cache_state="imported",
                analysis_status="partial_static",
            )
            
            # If DOT dependencies exist, build tree from them
            dot_deps = p.get("dot_dependencies", [])
            if dot_deps:
                # Build adjacency from DOT edges
                from pom_parser import parse_maven_coordinate as pom_parse_coord
                adj = {}
                node_meta = {}
                for d in dot_deps:
                    src = pom_parse_coord(d["from"])
                    dst = pom_parse_coord(d["to"])
                    node_meta[src["id"]] = src
                    node_meta[dst["id"]] = dst
                    adj.setdefault(src["id"], []).append(dst["id"])
                
                root_id = next((
                    node_id for node_id, meta in node_meta.items()
                    if meta["groupId"] == module.groupId
                    and meta["artifactId"] == module.artifactId
                    and meta["version"] == module.version
                ), None)
                if root_id:
                    def build(coord_id):
                        meta = node_meta[coord_id]
                        node = TreeNode(
                            coord_id=coord_id,
                            groupId=meta["groupId"],
                            artifactId=meta["artifactId"],
                            version=meta["version"],
                            scope=meta.get("scope", "compile"),
                            packaging=meta.get("packaging", "jar"),
                            classifier=meta.get("classifier"),
                        )
                        return node

                    def build_path(coord_id, ancestors):
                        node = build(coord_id)
                        if node.artifact_id in ancestors:
                            return node
                        next_ancestors = ancestors | {node.artifact_id}
                        for child_id in adj.get(coord_id, []):
                            child = build(child_id)
                            if child.artifact_id not in next_ancestors:
                                node.children.append(build_path(child_id, next_ancestors))
                        return node
                    
                    module.tree = build_path(root_id, set())
                    def count_nodes(node):
                        return 1 + sum(count_nodes(child) for child in node.children)

                    module.dependency_count = count_nodes(module.tree) - 1
            
            model.add_module(module)
            
        except Exception as e:
            project_name = p.get("coord_id") or p.get("coordinates", {}).get("artifactId", "unknown")
            logger.warning(f"Invalid project {project_name}: {e}")
            import_errors.append({
                "index": index,
                "project": project_name,
                "error": str(e),
            })
            continue

    if import_errors:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Static import rejected; no projects were loaded", "errors": import_errors},
        )
    
    _state["model"] = model
    _state["root"] = model.root or "loaded-from-json"
    logger.info(f"Loaded {len(model.modules)} modules from JSON")
    return JSONResponse({
        "ok": True,
        "modules": len(model.modules),
        "source": "pom-static",
        "completeness": "partial",
    })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
