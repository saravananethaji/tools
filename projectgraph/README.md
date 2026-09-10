# projectgraph — Maven Dependency Graph Viewer

A Python (FastAPI) app that scans a folder of Java/Maven projects, runs
`mvn --non-recursive dependency:tree -DoutputType=dot` per pom, and presents an interactive
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
  maven_extractor.py offline POM extractor + coordinate-location analysis
  trace_ancestors.py parent-POM chain tracing for remediation guidance
  sbom_export.py    OSS inventory, CycloneDX 1.5, OSV.dev, version drift
  DESIGN.md         architecture, limitations, PO review, and roadmap
  TODO.md           single prioritized P0/P1/P2 implementation backlog
  requirements.txt
```

## Run

```bash
cd projectgraph
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PROJECTGRAPH_ALLOWED_ROOTS="/path/to/your/java/projects"
python app.py
# open http://127.0.0.1:8000
```

By default it scans the local `test_projects` fixtures. `/api/load` accepts only
absolute directories under `PROJECTGRAPH_ALLOWED_ROOTS` (the application
directory is the default). To point it at your own projects, set that variable
before starting the server and POST the root:

```bash
curl -d 'root=/path/to/your/java/projects' http://127.0.0.1:8000/api/load
```

or use **Reload** in the UI after editing the root in `app.py`.

## How it works

- `find_poms(root)` walks the tree (skipping `target/`) for every `pom.xml`.
- For each pom, `mvn --non-recursive dependency:tree -DoutputType=dot -q` runs in that pom's
  directory. On failure the module is skipped, marked `error`, and the stderr
  is surfaced in the tree view.
- The DOT edge list is parsed into a `TreeNode` rooted at the module's own
  coordinate (`groupId:artifactId:version`).
- Results are cached on disk by POM path. A cache entry is reused only when its
  schema, Maven command/version, age, POM/configuration fingerprint, and local
  Maven settings fingerprint remain compatible. **Reload** always re-runs
  Maven and refreshes the cache.
- Conflicts: a `groupId:artifactId` with >1 distinct version anywhere in any
  module's tree.
- Export: every unique artifact is a `:Artifact` node; every parent->child
  edge is a `:DEPENDS_ON {scope}` relationship.

## OSS inventory, SBOM, and advisory scan

Generate the extractor JSON once, then use the standalone product-owner
reports. The inventory treats discovered project groupIds as internal by
default; add more prefixes with repeated `--internal-prefix` flags.

```bash
python maven_extractor.py test_projects -o analysis.json -f json

# Which open-source libraries, versions, scopes, and consuming modules?
python sbom_export.py -i analysis.json --inventory

# CycloneDX 1.5 for Dependency-Track, Trivy, Grype, or other tooling
python sbom_export.py -i analysis.json --sbom projectgraph.cdx.json

# Known CVEs/GHSAs from OSV.dev (requires network access)
python sbom_export.py -i analysis.json --osv

# Same library present at multiple versions
python sbom_export.py -i analysis.json --drift
```

This command currently consumes static POM declarations and dependency
management, not the web application's Maven-resolved graph. Its inventory and
CycloneDX output are therefore **partial** and must not be treated as proof of
runtime composition. Connecting it to the versioned resolved Scan model is a
P0/P1 item in `TODO.md`.

`--osv` is advisory enrichment, not a replacement for organizational risk
acceptance, exploitability review, license review, or a full build-resolved
SBOM. A result with no advisories is not proof that a component is safe.

## Requirements

- `mvn` on `PATH` (Maven 3.6+)
- Python 3.9+
- Internet only on first `pip install`; additionally required for `--osv`

## Verification

Run the complete unit and browser regression suite through one command:

```bash
npm test
```

The runner starts ProjectGraph on an available local port, waits for the tree
to render, runs Playwright, and shuts the test server down. It works with
native Python on Windows and POSIX systems.
