# ProjectGraph — Product and Technical Design

> Status: living design. `TODO.md` is the only prioritized backlog.

## 1. Product boundary

ProjectGraph is a local Maven **resolved-library dependency** tool. Its first
job is to answer, from Maven's effective dependency graph:

1. Which libraries does each module actually resolve?
2. Which direct dependency introduces a transitive library?
3. Where do versions conflict or drift across modules?
4. Which local modules are affected by an exact library coordinate?

The dependency-tree page is not a project-structure browser. Maven parents,
reactor modules, BOM declarations, and build plugins may provide provenance or
explanation, but they are not library-tree children unless Maven resolves them
as dependencies.

Project classification is supporting metadata. Memgraph, Neo4j, SBOM, OSV,
and visualization are consumers of the dependency model; none is the source
of truth.

## 2. Truth hierarchy

ProjectGraph currently has two acquisition paths. They must not be presented
as equivalent:

| Source | Truth available | Valid use |
| --- | --- | --- |
| `mvn dependency:tree` DOT | Effective direct and transitive library graph | Tree, conflicts, impact, used-by, resolved SBOM |
| Static `pom.xml` parsing | Declared dependencies, dependency management, parents, modules, properties | Classification, provenance hints, POM topology (as labelled structure), offline partial report |

`dependencyManagement` is not proof that a component is used. A static-POM
export therefore cannot be called a complete SBOM or resolved dependency tree.
Every API and report must identify its source and completeness.

Static structure is not resolved structure. A `<parent>` edge means inherited
configuration and a `<modules>` edge means build aggregation; neither one makes
any module depend on anything. Accordingly the topology view labels each
relationship with its own truth status (resolved, structural, or
declared-unverified) and derives `usedBy` from resolved edges alone, so a
library that is declared but never resolved cannot appear as used.

## 3. Target architecture

```text
Folder selected under PROJECTGRAPH_ALLOWED_ROOTS
        |
        v
POM discovery + static metadata -------------------+
        |                                           |
        v                                           v
per-POM non-recursive Maven resolution       classification/provenance
        |                                           |
        +-------------------+-----------------------+
                            v
                 Canonical versioned Scan model
                 - modules
                 - canonical artifacts
                 - module-owned edges
                 - direct/transitive depth
                 - source/completeness/errors
                            |
          +-----------------+------------------+
          v                 v                  v
     Web tree/conflicts  JSON + SBOM       optional graph DB
```

### 3.1 Scan model

A scan is immutable after completion and contains:

- a scan ID, schema version, normalized root, start/end time, and tool version;
- one record per discovered Maven module;
- a lossless artifact ID:
  `groupId:artifactId:packaging[:classifier]:version`;
- dependency edges owned by a module, with `scope`, `depth`, and `direct`;
- per-module Maven success, failure, timeout, or empty-result status;
- acquisition source (`maven-resolved` or `pom-static`) and completeness;
- deterministic ordering for repeatable JSON and tests.

An empty Maven result is valid and must be visually distinct from a failed or
stale result. The project root is not counted as a dependency.

### 3.2 Maven execution

- Discover POMs once, then analyze each POM independently with
  `mvn --non-recursive dependency:tree`.
- Never let reactor modules share and overwrite one DOT output file.
- Keep `shell=False`, bounded timeouts, and temporary output files.
- Cache keys must include the POM identity, relevant file state, command/tool
  version, and parser/schema version—not only `pom.xml` mtime.
- A forced reload bypasses cache. Normal startup may use only a compatible,
  attributable cache record.

### 3.3 Static metadata and classification

Static parsing remains useful for parent/BOM/module context and project-type
labels. Classification must retain cycle detection and memoization. New
cross-project metrics should use a two-pass analysis instead of recursively
classifying peers.

Static metadata may explain a resolved edge, but it must never fabricate one.

### 3.4 Consumers

- **Tree:** one card per Maven module; the body shows its resolved library
  hierarchy and explicit empty/error/stale states.
- **Conflicts/drift:** computed from module-owned resolved edges only,
  excluding module roots and managed-but-unused declarations. A `conflict` is
  one module resolving two versions of the same GA; `drift` is different
  modules resolving different versions. Each occurrence carries the
  dependency path, scope, and depth responsible for it, so the route is
  visible rather than asserted. Paths are bounded per (module, version) and
  truncation is flagged. Unresolved modules contribute nothing and are listed
  explicitly.
- **Topology:** POM relationships shown as separate classes with explicit truth
  status, because a Maven reactor contains structurally different edges that
  must never be flattened together:

  | Relationship | Evidence | Truth status |
  |---|---|---|
  | `dependsOn` | `mvn dependency:tree` | resolved (authoritative) |
  | `usedBy` | reverse of resolved edges | resolved (authoritative) |
  | `parent` | `<parent>` in the POM | structural — not a dependency |
  | `aggregates` | `<modules>` in the POM | build structure — not a dependency |
  | `declaredDependency` | `<dependencies>` in the POM | declared-unverified |

  `parent` and `aggregates` are attached from static POMs; they explain
  structure but prove nothing about resolution. `declaredDependency` records
  intent and is deliberately weaker than a resolved edge: a library declared
  but never resolved never appears in `usedBy`. Unresolvable `<module>` paths
  and external parents are reported in `unresolved_links` rather than dropped.
  Topology fields are additive and optional in the scan schema, so scans
  written before they existed still load and simply report no structural links.
- **Impact:** exact canonical coordinate to affected modules and dependency
  paths. No artifactId-only matching. Answers are computed in memory and are
  bounded (path count and traversal budget), with any truncation reported
  rather than hidden.
- **SBOM:** generated from a completed resolved scan. Partial static exports
  must be labeled as such. CycloneDX output requires schema validation.
- **OSV:** optional enrichment of exact resolved Maven versions. Advisory data
  is cached with timestamps and never turns “not queried” into “safe.”
- **Graph database:** optional persistence/query acceleration after the scan
  contract is stable. It must not become required for the core workflow.

## 4. API direction

The current endpoints remain during consolidation:

- `POST /api/load` selects and scans an allowed root.
- `POST /api/reload` performs a forced rescan.
- `GET /api/state` returns the current model.
- `GET /api/inventory` returns the resolved OSS inventory (P1.1): external
  canonical coordinates by consuming module, scope, direct/transitive
  relationship, and bounded dependency paths; unresolved modules are reported
  in `excluded_modules`, never dropped.
- `GET /api/topology` returns POM relationship classes with truth status per
  class (P1.5); `?module=<coordinate>` returns one module's parent,
  aggregation, declared, resolved, and used-by detail. An unknown module is a
  404, not an empty answer.
- `GET /api/impact?coordinate=…` returns the blast radius for an exact
  coordinate (P1.3): affected modules with POM paths, direct/transitive
  relationship, introducing artifact, scopes, minimum depth, and bounded
  paths. ArtifactId-only queries are rejected; ambiguity is reported.
- `GET /api/routes?from_coordinate=…&to_coordinate=…` returns bounded routes
  between two exact coordinates (P1.3) in memory, with no graph database.
- `/tree`, `/topology`, `/conflicts`, `/inventory`, `/impact`, `/snapshot`, and
  `/export` render consumers. `/impact` reports evidence only (occurrence,
  relationship, introducing artifact, paths, source POMs) and deliberately
  generates no remediation POM XML. `/topology` labels every relationship class
  with its truth status.

The versioned scan contract should eventually be shared by live Maven scans,
JSON import/export, SBOM generation, impact analysis, and graph ingestion.
`/api/load-json` must reject unsupported schema versions and state whether an
import is resolved or static/partial.

## 5. Security and operational boundaries

- Only normalized absolute paths within `PROJECTGRAPH_ALLOWED_ROOTS` may be
  scanned; resolve symlinks before checking the boundary.
- Maven is code execution supplied by the selected project. The localhost UI
  does not make an untrusted repository safe. Document this plainly.
- Keep subprocess arguments structured and never use `shell=True`.
- Do not expose browser-entered database credentials or arbitrary Cypher.
- A network-exposed deployment requires authentication, authorization, CSRF
  protection, TLS, rate limiting, and a stricter Maven execution sandbox.
- Logs and API errors must redact secrets and clearly identify module failures.

## 6. Review decisions

The additional proposals contained useful ideas, but their ordering was wrong.

- **Accepted:** resolved OSS inventory, CycloneDX export, OSV enrichment,
  blast-radius queries, internal/OSS distinction, version drift, deterministic
  E2E tests, canonical identity, edge provenance, and scan isolation.
- **Corrected:** OSV and SBOM are not P0 while resolved graph provenance and
  cache validity are unfinished. A static `dependencyManagement` entry is not
  an installed or resolved component.
- **Deferred:** Memgraph explorer and visualization until the same questions
  work correctly in memory and through the API.
- **Rejected for now:** arbitrary browser Cypher, browser-stored database
  credentials, database-wide cleanup, automatic Neo4j compatibility claims,
  and vulnerability wording without advisory evidence.

## 7. Verification strategy

The fixtures must include at least one real direct dependency, one transitive
dependency, a diamond, two versions of the same GA, classifier variants, an
empty module, a Maven failure, and a multi-module aggregator. Tests must prove:

- Maven output belongs to the POM being displayed;
- dependency paths and module provenance survive serialization;
- cached and fresh scans produce the same model;
- empty, failed, stale, and populated states are distinguishable;
- Windows and POSIX path/cache behavior is deterministic;
- SBOM and advisory claims match the scan's declared completeness;
- E2E tests wait for an explicit render-complete signal, not timing sleeps.

See `TODO.md` for the single ordered implementation backlog and
`MEMGRAPH_INTEGRATION_DESIGN.md` for the deferred graph-persistence design.
