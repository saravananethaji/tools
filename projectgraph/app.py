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

import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, Request, Form, HTTPException, status
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from maven_runner import build_model
from neo4j_export import export_cypher

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
    
    # Normalize path (resolve .. and symlinks)
    try:
        abs_path = os.path.abspath(os.path.normpath(root.strip()))
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
    
    # Prevent directory traversal - ensure path is within allowed boundaries
    if not os.path.isabs(abs_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path must be absolute"
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


def _get_model():
    if _state["model"] is None:
        root = _state["root"] or _default_root()
        _state["model"] = build_model(root, CACHE_DIR)
    return _state["model"]


def _default_root() -> str:
    # default: the ../test fixture shipped with the project
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "test"))


@app.get("/")
async def index():
    return RedirectResponse(url="/tree")


@app.get("/api/state")
async def api_state():
    model = _get_model()
    return JSONResponse(model.to_dict())


@app.get("/tree", response_class=HTMLResponse)
async def tree_view(request: Request, q: str = ""):
    model = _get_model()
    return templates.TemplateResponse(request, "tree.html", {
        "modules": [m.to_dict() for m in model.modules],
        "query": q,
        "root": _state["root"] or _default_root(),
    })


@app.get("/conflicts", response_class=HTMLResponse)
async def conflicts_view(request: Request):
    model = _get_model()
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
    model = _get_model()
    cypher = export_cypher(model)
    return templates.TemplateResponse(request, "export.html", {
        "cypher": cypher,
        "root": _state["root"] or _default_root(),
    })


@app.get("/export/download", response_class=PlainTextResponse)
async def export_download():
    model = _get_model()
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
