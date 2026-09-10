# projectgraph — Maven Dependency Graph Viewer

A Python (FastAPI) app that scans a folder of Java/Maven projects, runs
`mvn --non-recursive dependency:tree -DoutputType=dot` per pom, and presents an interactive
dependency graph with 7 capabilities:

1. **Dependency tree** — per-module, fully expandable, full transitive depth.
   Each node shows `groupId:artifactId:version` + scope.
2. **Conflicts/drift** — every Maven conflict identity
   (`groupId:artifactId:type[:classifier]`) that resolved to more than one
   version across resolved modules, classified as `conflict` (one module, two
   versions) or `drift` (different modules, different versions), with the
   responsible dependency path shown for each occurrence.
3. **OSS Inventory** — resolved external (open-source) coordinates by
   consuming module, scope, and direct/transitive path, with **Excel export**.
4. **Impact** — enter a coordinate (from `groupId:artifactId` up to a fully
   qualified variant) to see affected modules, the dependency that introduces
   it, the paths responsible, and the source POMs.
5. **Search** — a search box on the tree page filters/highlights matching
   nodes and dims the rest.
6. **Neo4j export** — the whole graph as a `.cypher` script of `MERGE`
   statements (nodes `:Artifact`, edges `:DEPENDS_ON` with `scope`).
7. **Dependency Snapshot** — export and reopen a portable, versioned copy of
   the resolved graph on another machine.

The web navigation uses the same order as the list above, minus Search, which
lives inside the Dependency Tree page: `1 · Dependency Tree`, `2 · Conflicts`,
`3 · OSS Inventory`, `4 · Impact`, `5 · Neo4j Export`, `6 · Snapshot`.

## Layout

```
projectgraph/
  app.py            FastAPI app + routes
  maven_runner.py   pom discovery, mvn exec, DOT->tree, on-disk JSON cache
  graph_model.py    in-memory tree model + conflict detection
  neo4j_export.py   .cypher script generator
  templates/        Jinja2 HTML (base, tree, conflicts, inventory, impact,
                    snapshot, export)
  cache/            on-disk JSON cache (auto-created)
  parser.py         (pre-existing DOT + Neo4j Bolt ingester, unchanged)
  oss_inventory.py  resolved OSS inventory (external coords, paths, prefixes)
  inventory_export.py Excel workbook export of the resolved inventory
  impact.py         in-memory blast-radius and dependency-route queries
  scan_state.py     persist/restore the last successful resolved scan
  dependency_snapshot.py portable, versioned snapshot export/import
  maven_extractor.py offline POM extractor + coordinate-location analysis
  trace_ancestors.py parent-POM chain tracing for remediation guidance
  sbom_export.py    (offline/partial) static SBOM, OSV, version drift
  DESIGN.md         architecture, limitations, PO review, and roadmap
  TODO.md           single prioritized P0/P1/P2 implementation backlog
  requirements.txt
```

## Web UI quick start

The UI scans Maven projects only after you choose a folder. The server will
reject folders outside `PROJECTGRAPH_ALLOWED_ROOTS`; that is intentional.

1. Start the server with an allowed **parent** folder configured.
2. Open `http://127.0.0.1:8000`.
3. In the header, paste the absolute folder that contains your Maven projects.
4. Click **Load folder** and wait for the module count to appear.
5. Use **Dependency Tree**, **Conflicts**, **OSS Inventory**, and **Impact**.

**Load folder** scans a different folder. **Reload** re-runs Maven for the
currently loaded folder and refreshes its cache. The app retains exactly one
last successful Maven-resolved scan in its local cache; after a server restart
all tabs reopen against that saved report. A new successful load replaces it.
Reload still requires that source folder to exist and be allowed.

### Move a dependency graph to another machine

Use **6 · Snapshot** → **Download Dependency Snapshot**. This downloads a
portable `dependency-snapshot.json`, not the internal cache. On the other
machine, open **6 · Snapshot**, choose the file, and select **Open snapshot**.
The imported graph is historical and read-only: it keeps the original scan's
paths and resolved dependencies, but cannot be refreshed until you load a
local source folder and scan it with Maven.

### macOS / Linux

```bash
cd projectgraph
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PROJECTGRAPH_ALLOWED_ROOTS="/path/to/parent/of/your/java/projects"
python -m uvicorn app:app --reload
```

### Windows 11 — Git Bash

```bash
cd /c/Users/you/path/to/projectgraph
python -m venv .venv
source .venv/Scripts/activate
python -m pip install -r requirements.txt

# Use C:/ form in both the environment variable and browser input.
export PROJECTGRAPH_ALLOWED_ROOTS='C:/Users/you/Projects'
python -m uvicorn app:app --reload
```

For multiple allowed roots on Windows, use a quoted semicolon-separated list:

```bash
export PROJECTGRAPH_ALLOWED_ROOTS='C:/Users/you/Projects;D:/shared/maven-projects'
```

Open `http://127.0.0.1:8000`, enter a folder such as
`C:/Users/you/Projects/my-maven-repos` in the header, then click **Load
folder**. Set the variable in the same Git Bash session that starts Uvicorn.
It does not require a Git commit or a remote push.

By default the app scans local `test_projects` fixtures. `/api/load` accepts
only absolute directories under `PROJECTGRAPH_ALLOWED_ROOTS` (the application
directory is the default). The browser is the normal way to load a folder; for
automation, use the API:

```bash
curl -d 'root=/path/to/your/java/projects' http://127.0.0.1:8000/api/load
```

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
- Conflicts/drift: a Maven conflict identity
  (`groupId:artifactId:type[:classifier]`) resolved to >1 distinct version
  across **resolved** module trees. `conflict` means one module resolves two
  versions itself; `drift` means different modules resolve different versions.
  Every row shows the responsible dependency path, scope, and depth.
  Unresolved modules contribute nothing and are listed explicitly at the top.
- Export: every unique artifact is a `:Artifact` node; every parent->child
  edge is a `:DEPENDS_ON {scope}` relationship.

## Resolved OSS inventory (canonical)

The inventory view lists every **external** (non-internal) artifact from the
*Maven-resolved* dependency trees, with each consuming module, its scope, its
relationship (`direct`/`transitive`), and the actual dependency path(s) by
which it is reached.

```
GET  /inventory         -> table view (also linked as "3 · OSS Inventory")
GET  /api/inventory     -> the same data as JSON
GET  /inventory/download -> Excel workbook for the current resolved inventory
```

Use **Download Excel** on the Inventory page to export two sheets:

- **Summary**: total distinct external libraries, scan completeness, excluded
  module count, and distribution by exact Maven `groupId`.
- **Inventory**: the same consumer-level columns shown in the web table
  (coordinate, version, consumer, relationship, scopes, dependency path) plus
  PURL. A library reached through several paths keeps those bounded paths in
  one Excel cell.

Internal group IDs are detected from the scanned projects' own groupIds plus
any configured prefixes:

```bash
export PROJECTGRAPH_INTERNAL_PREFIXES="com.acme,org.mycompany"
```

The inventory is honest about what it covers: only Maven-resolved module trees
contribute; excluded modules are listed under `excluded_modules` with a reason
(they are never silently treated as empty), and the module's own root node is
never reported as a dependency. Path lists are bounded per consumer, with
truncation flagged.

## Impact queries (no graph database)

Ask which modules a library affects, and how one library reaches another —
either in the UI at **`/impact`** (nav item "4 · Impact") or via the API.
Queries always require `groupId` and `artifactId`; artifactId-only matching is
rejected so the tool never guesses a library. You may narrow with version,
type, and classifier. A broader query can match several variants and is shown
as ambiguous rather than silently picking one.

```bash
# Blast radius: who depends on this, through which paths?
curl "http://127.0.0.1:8000/api/impact?coordinate=org.apache.httpcomponents:httpcore"

# Route: how does one artifact reach another?
curl "http://127.0.0.1:8000/api/routes?from_coordinate=org.apache.httpcomponents:httpclient&to_coordinate=org.apache.httpcomponents:httpcore"
```

Accepted coordinate forms: `groupId:artifactId`,
`groupId:artifactId:version`, `groupId:artifactId:packaging:version`, and
`groupId:artifactId:packaging:classifier:version`. A query matching several
versions or classifier variants is reported as `ambiguous` with every match
listed, rather than silently picking one.

Each answer is bounded (path count and traversal budget) and says so when a
bound was hit; modules that could not be resolved are listed under
`excluded_modules` and are never silently treated as unaffected.

## Offline static reports (partial)

`sbom_export.py` works on the offline extractor JSON **without running
Maven**. It is useful for quick, static triage, but because it only sees
declared dependencies and `dependencyManagement`, its inventory and SBOM are
**partial** and must not be treated as proof of resolved usage.

```bash
python maven_extractor.py test_projects -o analysis.json -f json

python sbom_export.py -i analysis.json --inventory   # static (partial)
python sbom_export.py -i analysis.json --sbom out.cdx.json
python sbom_export.py -i analysis.json --osv         # needs network
python sbom_export.py -i analysis.json --drift
```

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
