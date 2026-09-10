# ProjectGraph Live Graph Integration — Redesigned Specification

> Status: deferred until the P0 and P1 exit gates in `TODO.md` pass. This file
> defines the graph-persistence design; it is not a competing prioritized
> backlog. `TODO.md` is the single source for P0/P1/P2 ordering.

## 1. Purpose

ProjectGraph already scans Maven projects, builds dependency trees, detects version conflicts, and exports Cypher. This design adds live graph-database ingestion and exploration without turning the application into an unrestricted database administration console.

Delivery is iterative. Every iteration must be usable, testable, and reversible before the next begins. Graph integration must consume the canonical versioned Scan model; it must not invent or repair missing Maven dependency provenance during import.

## 2. Decisions and Boundaries

### 2.1 Decisions

1. **Memgraph first.** Neo4j support is a later compatibility iteration.
2. **Server-configured connection.** Bolt URI and credentials come from environment variables. Browsers never submit or store database passwords.
3. **No arbitrary Cypher initially.** The browser executes only server-owned, parameterized presets.
4. **Dataset isolation is mandatory.** An import may replace only ProjectGraph data for its configured dataset. It must never clear the whole database.
5. **Queries are scan-aware.** Results must not combine edges from unrelated scans or Maven modules accidentally.
6. **Offline export remains available.** Live integration extends `/export`; it does not replace the existing workflow.
7. **The API bounds graph size and execution time.** Browser limits are only a second line of defense.

### 2.2 Explicitly Out of Initial Scope

- Browser-entered Bolt URI, username, or password.
- Credentials in browser storage, URLs, logs, or repository files.
- Arbitrary/custom Cypher execution.
- Database-wide delete operations.
- Automatic Neo4j compatibility claims.
- Vulnerability-provider integration or live CVE feeds.
- Multi-user authorization and hosted/public deployment.
- WebSocket progress in the first import implementation.

### 2.3 Deployment Assumption

The first release is a trusted, localhost-only developer tool. Exposing it to a network requires authentication, authorization, CSRF protection, TLS, and rate limiting before deployment.

## 3. Canonical Identity and Graph Schema

### 3.1 Canonical Artifact ID

```text
groupId:artifactId:packaging[:classifier]:version
```

Examples:

```text
org.apache.commons:commons-lang3:jar:3.12.0
com.example:native-library:jar:linux-x86_64:2.0.0
```

Display labels may be shorter, but API parameters and database lookups use the canonical ID.

### 3.2 Nodes

#### `Dataset`

One configured ProjectGraph workspace.

| Property | Purpose |
| --- | --- |
| `id` | Stable configured dataset identifier |
| `activeScanId` | Last fully completed import |
| `updatedAt` | Activation timestamp |

#### `Scan`

One import attempt. Partial imports remain invisible to normal queries.

| Property | Purpose |
| --- | --- |
| `id` | Unique scan identifier |
| `datasetId` | Owning dataset |
| `status` | `IMPORTING`, `ACTIVE`, `FAILED`, or `SUPERSEDED` |
| `startedAt`, `completedAt` | Import timing |
| `nodeCount`, `edgeCount` | Verification counts |

#### `Module`

A local Maven POM discovered in the scan.

| Property | Purpose |
| --- | --- |
| `key` | `scanId + module coordinate` internal key |
| `scanId`, `datasetId` | Ownership |
| `coordinate` | Maven GAV coordinate |
| `artifactIdRef` | Canonical root artifact ID |
| `projectType` | Classification such as Service Code or BOM |
| `pomPath` | Source POM path |
| `classificationReason` | Explainability |

#### `Artifact`

An artifact as observed in one scan.

| Property | Purpose |
| --- | --- |
| `key` | `scanId + canonicalId` internal uniqueness key |
| `canonicalId` | Canonical Maven artifact ID |
| `scanId`, `datasetId` | Ownership |
| `groupId`, `artifactId`, `packaging`, `classifier`, `version` | Maven identity |
| `isLocal` | Whether it maps to a scanned module |
| `hasConflict` | Derived conflict marker for the scan |

Scan-specific artifact nodes deliberately trade duplication for isolation and predictable cleanup.

### 3.3 Relationships

```text
(Dataset)-[:HAS_SCAN]->(Scan)
(Scan)-[:CONTAINS_MODULE]->(Module)
(Module)-[:ROOT_ARTIFACT]->(Artifact)
(Artifact)-[:DEPENDS_ON {scanId, moduleKey, scope, direct}]->(Artifact)
```

`moduleKey` records which Maven module produced an edge. Presets must constrain it when answering questions about a specific module. Cross-module aggregation must be explicit.

### 3.4 Required GraphModel Changes Before Ingestion

The current flattened edge representation lacks sufficient provenance. Before live import, it must expose:

- owning module for every edge;
- direct versus transitive status;
- canonical source and destination IDs;
- project type for local module roots;
- scan-level conflict annotations;
- deterministic node and edge ordering.

The database service must not guess missing provenance.

## 4. Import Lifecycle and Stale Data

### 4.1 State Machine

```text
REQUESTED → IMPORTING → ACTIVE
                     ↘ FAILED

previous ACTIVE → SUPERSEDED after new scan activation
```

### 4.2 Safe Replacement

1. Create a new `Scan` with `IMPORTING` status.
2. Import scan-owned artifacts, modules, and relationships in bounded batches.
3. Verify expected node, module, and relationship counts.
4. In one final transaction, activate the new scan, update `Dataset.activeScanId`, and supersede the previous scan.
5. Delete superseded data only through a separate dataset-scoped cleanup operation.

On failure, mark the new scan `FAILED`. Queries continue using the previous active scan.

### 4.3 Idempotency Rules

- An import cannot mutate another dataset.
- Nodes use `MERGE` on their scan-specific `key`.
- Relationships use source, destination, `scanId`, `moduleKey`, and scope as identity.
- Cleanup requires both `datasetId` and a non-active `scanId`.
- No endpoint performs a database-wide clear.

## 5. Security Model

### 5.1 Configuration

```text
PROJECTGRAPH_GRAPH_ENABLED=false
PROJECTGRAPH_GRAPH_DIALECT=memgraph
PROJECTGRAPH_GRAPH_URI=bolt://127.0.0.1:7687
PROJECTGRAPH_GRAPH_USER=
PROJECTGRAPH_GRAPH_PASSWORD=
PROJECTGRAPH_GRAPH_DATASET=local-projectgraph
PROJECTGRAPH_GRAPH_QUERY_TIMEOUT_SECONDS=10
PROJECTGRAPH_GRAPH_MAX_NODES=200
PROJECTGRAPH_GRAPH_MAX_EDGES=400
PROJECTGRAPH_GRAPH_BATCH_SIZE=500
```

Secrets are read at startup, redacted from errors, and never returned through an API.

### 5.2 Database Account

Use a dedicated ProjectGraph account with only the permissions needed for ProjectGraph labels and approved read queries. Do not reuse an administrator account.

### 5.3 Query Controls

- Clients submit a preset ID and validated parameters, never Cypher.
- Every preset has a server-side timeout and hard result limit.
- Values are Bolt parameters, not string-interpolated.
- Errors remove credentials and raw driver configuration.
- Import and cleanup routes are disabled unless integration is explicitly enabled.

## 6. Backend Architecture

### 6.1 Components

```text
app.py
  └── graph API routes
        ├── GraphConnectionService
        ├── GraphImportService
        ├── GraphQueryService
        ├── PresetCatalog
        └── GraphResultMapper
```

These services remain separate from `neo4j_export.py`. File export and live ingestion consume the same model but have different transaction, security, and lifecycle requirements.

### 6.2 Driver Lifecycle

- Create one driver from server configuration during application startup.
- Verify connectivity without logging credentials.
- Close the driver during shutdown.
- Use the asynchronous driver, or put synchronous calls in a threadpool.
- Apply connection-acquisition and query timeouts.
- Do not maintain a browser-selected global “current URI.”

### 6.3 API Contracts

#### `GET /api/graph/health`

```json
{
  "ok": true,
  "enabled": true,
  "dialect": "memgraph",
  "database": "reachable",
  "latency_ms": 12.4
}
```

#### `POST /api/graph/import`

Starts an import of the current `GraphModel`.

```json
{"replace_active": true}
```

```json
{
  "ok": true,
  "job_id": "import-uuid",
  "scan_id": "scan-uuid",
  "status": "IMPORTING"
}
```

#### `GET /api/graph/import/{job_id}`

Polling endpoint for bounded progress reporting.

```json
{
  "ok": true,
  "status": "IMPORTING",
  "nodes_completed": 500,
  "nodes_total": 1200,
  "edges_completed": 0,
  "edges_total": 4600,
  "elapsed_seconds": 1.8
}
```

#### `GET /api/graph/presets`

Returns preset metadata and parameter schemas, not executable Cypher.

#### `POST /api/graph/query`

```json
{
  "preset_id": "blast_radius",
  "params": {
    "target_id": "org.apache.commons:commons-lang3:jar:3.12.0"
  }
}
```

The server resolves the active scan and returns bounded data:

```json
{
  "ok": true,
  "scan_id": "scan-uuid",
  "nodes": [],
  "edges": [],
  "truncated": false,
  "stats": {
    "node_count": 0,
    "edge_count": 0,
    "execution_time_ms": 14
  }
}
```

#### `DELETE /api/graph/scans/{scan_id}`

Deferred cleanup route. It must reject the active scan and scans belonging to another dataset. It is not part of the first user-facing iteration.

## 7. Initial Read-Only Presets

### 7.1 Blast Radius

Answers which local modules depend directly or transitively on one exact artifact.

- Required `target_id`: canonical artifact ID.
- Optional `max_depth`: server-bounded, default 8.
- Searches the active scan only.
- Returns module-specific paths.
- Never falls back to `artifactId` alone.

### 7.2 Directed Dependency Route

Answers why one selected local module includes one exact target artifact.

- Required `module_key` and canonical `target_id`.
- Traverses forward `DEPENDS_ON` relationships only.
- Constrains every relationship to the selected module.
- Returns one shortest directed path with bounded depth.

### 7.3 Deferred Presets

- **Conflict Paths:** deferred until provenance and conflict annotations are verified. It must match group plus artifact, not artifact alone.
- **Unused Local Modules:** requires `Module` semantics; it is not equivalent to isolated artifacts.
- **Deepest Chains:** deferred until representative performance testing.
- **Custom Cypher:** excluded from the current roadmap.

## 8. Frontend Design

### 8.1 `/export` Sections

1. Existing offline copy and download actions.
2. Integration status: enabled, dialect, health, and active scan—never credentials.
3. Import control with polled progress.
4. Preset selector with schema-driven inputs.
5. Bounded result table/list. The canvas arrives later.

### 8.2 Visualization Rules

- Bundle and pin `vis-network` locally; do not load runtime JavaScript from a CDN.
- Apply a Content Security Policy before enabling it.
- Enforce node and edge limits in the API.
- Show an explicit truncation warning.
- Derive node colors from stored schema fields, not browser guesses.
- Keep an accessible table fallback.

## 9. Execution Iterations

Each acceptance gate must pass before the next iteration starts.

### Iteration 0 — Model and Contract Foundation

**Goal:** make the in-memory model capable of producing truthful graph data.

**In scope**

- Finalize canonical IDs and database schema.
- Add module provenance and `direct` metadata to edges.
- Define deterministic graph serialization.
- Define configuration and secret-redaction behavior.
- Add fixtures for shared dependencies, classifiers, conflicts, and cycles.

**Out of scope:** Bolt, database container, APIs, and UI.

**Deliverables:** typed schema/export contracts and unit tests.

**Acceptance gate**

- A diamond dependency retains both paths.
- Two modules using the same artifact have distinguishable provenance.
- Classifier variants remain separate.
- Serialization is stable across repeated runs.

### Iteration 1 — Memgraph Connection and Safe Import

**Goal:** import one scan safely into locally configured Memgraph.

**In scope**

- Pin a compatible Neo4j Python driver.
- Application-lifespan driver management.
- Environment-only configuration and health route.
- Dataset, scan, module, artifact, and relationship ingestion.
- Safe activation, failure handling, and status polling.
- Integration tests using a disposable Memgraph container.

**Out of scope:** Neo4j, presets, visualization, browser connection forms, and custom Cypher.

**Acceptance gate**

- Successful import becomes active.
- Failed import leaves the prior scan active.
- Re-import removes no unrelated data.
- Imported counts match `GraphModel`.
- Logs and API errors contain no credentials.

### Iteration 2 — Read-Only Query Presets

**Goal:** answer two useful questions without exposing arbitrary Cypher.

**In scope:** preset catalog, autocomplete, Blast Radius, Directed Dependency Route, timeouts, limits, result mapping, and integration tests.

**Out of scope:** conflict/deepest-chain presets, custom Cypher, and canvas.

**Acceptance gate**

- Queries use only the active dataset scan.
- Paths never mix edges from different modules.
- Invalid inputs return clear 4xx responses.
- Expensive queries stop at configured limits and timeout.

### Iteration 3 — Minimal Explorer UI

**Goal:** expose health, import, and presets without visualization complexity.

**In scope:** status panel, import progress, preset forms, accessible tabular results, and existing export regression coverage.

**Out of scope:** `vis-network`, force layouts, custom editor, and fullscreen mode.

**Acceptance gate**

- `/export` works when integration is disabled or Memgraph is offline.
- Import failure is recoverable.
- Results are understandable without a canvas.
- Existing copy/download behavior still passes E2E tests.

### Iteration 4 — Interactive Visualization

**Goal:** visualize already-correct, bounded preset results.

**In scope:** locally bundled `vis-network`, force/hierarchical layouts, selection, adjacency highlighting, inspector, truncation messages, and table fallback.

**Out of scope:** browser credentials, arbitrary Cypher, and unlimited graphs.

**Acceptance gate**

- Maximum permitted payload remains responsive.
- Colors match stored role/conflict data.
- Node degree is module-specific and truthful.
- Keyboard users retain the table fallback.

### Iteration 5 — Additional Analysis Presets

Candidate scope: Conflict Paths, Unused Local Modules, Deepest Module-Specific Chains, and scan comparison. Each requires defined semantics, bounded queries, fixtures, and performance evidence. Candidate status is not an implementation commitment.

### Iteration 6 — Neo4j Compatibility

**In scope:** explicit dialect adapter, capability matrix, Neo4j integration container, and every supported preset tested against both databases.

**Acceptance gate:** switching requires configuration only, and unsupported capabilities fail clearly rather than changing semantics silently.

### Optional Future — Restricted Query Workspace

Consider arbitrary Cypher only if presets cannot serve a demonstrated analyst workflow. It requires a dedicated read-only account, application authentication, query auditing, enforced timeouts, result limits, and explicit unsafe-mode configuration.

## 10. Test Strategy

### Unit

- Canonical IDs and classifiers.
- Module provenance and direct/transitive metadata.
- Preset validation, mapping, and truncation.
- Secret redaction and scan state transitions.

### Integration

- Disposable Memgraph container.
- Constraints, batches, activation, failure recovery, and cleanup.
- Every preset against controlled Maven fixtures.
- Dataset isolation.

Mocks alone are insufficient for dialect and transaction behavior.

### End to End

- Integration disabled and database unavailable.
- Health, import progress, preset validation, and results.
- Existing copy/download workflow.
- Visualization only after Iteration 4.

## 11. Verification Outline

Exact container image and dependency versions will be pinned in Iteration 1.

1. Start isolated Memgraph.
2. Start ProjectGraph with environment configuration.
3. Verify health.
4. Import controlled fixtures.
5. Verify counts and active-scan ownership.
6. Execute supported presets and compare fixture expectations.
7. Force an import failure and prove the old scan remains active.
8. Remove the disposable container.

## 12. Definition of Done

Live integration is complete only when:

- credentials never pass through or persist in the browser;
- imports are dataset-scoped and stale-safe;
- failed imports cannot replace the active scan;
- queries preserve Maven module provenance;
- only allow-listed parameterized presets are exposed;
- server timeouts and response limits are enforced;
- behavior is tested against a real supported database version;
- ProjectGraph remains useful when the database is unavailable;
- offline Cypher export continues to work.
