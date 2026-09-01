# projectgraph — Maven Dependency Graph Viewer

A Python (FastAPI) app that scans a folder of Java/Maven projects, runs
`mvn dependency:tree -DoutputType=dot` per pom, and presents an interactive
dependency graph with 4 capabilities:

1. **Dependency tree** — per-module, fully expandable, full transitive depth.
   Each node shows `groupId:artifactId:version` + scope.
2. **Conflicts** — every `groupId:artifactId` that resolved to more than one
   version across the combined graph, with where each version appears.
3. **Search** — a search box on the tree page filters/highlights matching
   nodes and dims the rest.
4. **Neo4j export** — the whole graph as a `.cypher` script of `MERGE`
   statements (nodes `:Artifact`, edges `:DEPENDS_ON` with `scope`).

## Layout

```
projectgraph/
  app.py            FastAPI app + routes
  maven_runner.py   pom discovery, mvn exec, DOT->tree, on-disk JSON cache
  graph_model.py    in-memory tree model + conflict detection
  neo4j_export.py   .cypher script generator
  templates/        Jinja2 HTML (base, tree, conflicts, export)
  static/           (reserved)
  cache/            on-disk JSON cache (auto-created)
  parser.py         (pre-existing DOT + Neo4j Bolt ingester, unchanged)
  requirements.txt
```

## Run

```bash
cd projectgraph
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
# open http://127.0.0.1:8000
```

By default it scans `../test` (the shipped Camel fixture). To point it at
your own projects, POST the root:

```bash
curl -d 'root=/path/to/your/java/projects' http://127.0.0.1:8000/api/load
```

or use **Reload** in the UI after editing the root in `app.py`.

## How it works

- `find_poms(root)` walks the tree (skipping `target/`) for every `pom.xml`.
- For each pom, `mvn dependency:tree -DoutputType=dot -q` runs in that pom's
  directory. On failure the module is skipped, marked `error`, and the stderr
  is surfaced in the tree view.
- The DOT edge list is parsed into a `TreeNode` rooted at the module's own
  coordinate (`groupId:artifactId:version`).
- Results are cached on disk as JSON keyed by pom path + mtime. **Reload**
  re-runs Maven and refreshes the cache; re-opening the app loads from cache.
- Conflicts: a `groupId:artifactId` with >1 distinct version anywhere in any
  module's tree.
- Export: every unique artifact is a `:Artifact` node; every parent->child
  edge is a `:DEPENDS_ON {scope}` relationship.

## Requirements

- `mvn` on `PATH` (Maven 3.6+)
- Python 3.9+
- Internet only on first `pip install`
