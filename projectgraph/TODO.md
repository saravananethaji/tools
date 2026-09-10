# ProjectGraph — Consolidated TODO

> This is the only prioritized backlog. Do not maintain competing P0/P1/P2
> lists in other documents. Priority means dependency order, not enthusiasm.

## P0 — Make the dependency data truthful

- [x] **P0.1 Add representative resolved-dependency fixtures.** Include a
  direct library, a transitive library, a diamond, a classifier variant, a
  version conflict, an empty module, a failing module, and a multi-module
  aggregator. The current fixtures mostly contain parents, modules, and
  dependency management, so they cannot prove the library tree works.
- [x] **P0.2 Lock down per-POM Maven execution.** Keep non-recursive execution,
  verify that the DOT root matches the requested POM, capture Maven/tool
  versions, and add Windows plus POSIX integration coverage.
- [x] **P0.3 Replace the weak cache contract.** Include command options, parser
  version, schema version, relevant Maven files/settings, and tool version in
  cache validity. Never silently reuse an older root-only or incompatible
  graph. Surface `fresh`, `cached`, and `stale` states.
- [x] **P0.4 Define one versioned `Scan` JSON schema.** Unify web scans,
  extractor export, `/api/load-json`, impact analysis, SBOM, and future graph
  ingestion. Record source and completeness explicitly.
- [x] **P0.5 Preserve module provenance on every edge.** Store canonical source
  and destination IDs, owning module, scope, depth, and direct/transitive
  status. Preserve duplicate paths in diamonds while stopping actual cycles.
- [x] **P0.6 Make failure states honest.** Distinguish no dependencies from
  Maven failure, timeout, parse failure, cache incompatibility, and partial
  static data in the API and UI. Stop calling the root node a dependency.
- [x] **P0.7 Correct misleading product language.** Rename
  `--analyze-vulnerability` to an artifact-location/impact command until OSV
  evidence is attached. Mark the current static-POM inventory and SBOM path as
  partial; `dependencyManagement` must not be reported as resolved usage.
- [x] **P0.8 Add regression gates.** Unit tests, Maven integration tests, and
  deterministic Playwright tests must run from one documented command. Add an
  explicit render-complete marker and eliminate fixed timing sleeps.
- [x] **P0.9 Protect classification stability.** Add cycle fixtures and tests
  for memoization/self-skip behavior; refactor new contextual classification
  rules into two-pass analysis.

### P0 exit gate

A clean scan of the controlled fixtures produces attributable, repeatable
direct/transitive trees; fresh and cached results match; errors are not shown
as empty trees; and the same versioned model round-trips through JSON.

Completed on 2026-09-10. Verified locally with `npm test`. The portable test
runner is implemented for native Windows and POSIX Python, but the Windows run
must still be executed on the Windows checkout because this machine cannot
verify another operating system.

## P1 — Deliver useful dependency intelligence

- [x] **P1.1 Build resolved OSS inventory.** Configure internal group prefixes
  and list external canonical coordinates by consuming module, scope, and
  direct/transitive path. Implemented in `oss_inventory.py` (only resolved
  module trees contribute; unresolved modules are reported, not dropped;
  root nodes are never dependencies; paths are bounded with truncation
  flagged). Exposed via `GET /api/inventory`, `GET /inventory`, and the
  `PROJECTGRAPH_INTERNAL_PREFIXES` env var. Covered by
  `tests/test_inventory.py` and the Playwright inventory test.
  Excel export of the same inventory was added later: `GET /inventory/download`
  produces a two-sheet workbook (Summary with total distinct external libraries
  and groupId distribution, Inventory with the same columns as the web table),
  built in `inventory_export.py` and covered by
  `tests/test_inventory_export.py` plus a Playwright download test. It exports
  the resolved inventory only, never the partial static POM view.
- [x] **P1.2 Correct conflicts and version drift.** Compute them only from
  resolved, module-owned dependency data and show the paths responsible.
  `GraphModel.conflicts()` groups by Maven conflict identity
  (`groupId:artifactId:type[:classifier]`) and distinguishes `conflict` (one module resolves
  two versions itself) from `drift` (different modules resolve different
  versions); every occurrence carries the module-owned dependency path,
  scope, depth, and direct flag; paths are bounded per (module, version) with
  truncation flagged. Unresolved modules contribute nothing and are listed
  explicitly in the view. Covered by `tests/test_conflicts.py` and the
  Playwright conflicts test.
- [x] **P1.3 Add in-memory blast-radius and dependency-route APIs.** Query an
  exact canonical coordinate; return bounded module-specific paths without a
  graph database. Implemented in `impact.py`: `blast_radius()` (affected
  modules, POM paths, direct/transitive relationship, introducing artifact,
  scopes, min depth, bounded paths) and `dependency_routes()` (bounded routes
  between two exact coordinates). Exact matching only — artifactId-only
  queries are rejected with 400, and ambiguity (several versions or classifier
  variants) is reported rather than silently resolved. Nearest occurrence wins
  per branch; cycles terminate; unresolved modules are excluded and listed.
  Exposed as `GET /api/impact` and `GET /api/routes`. Covered by
  `tests/test_impact.py` and three Playwright API tests.
- [x] **P1.4 Add an Impact UI.** Search an exact library and show affected
  modules, direct bringers, paths, and source POMs. Do not generate speculative
  "minimal fix" XML. Implemented as `GET /impact` (`templates/impact.html`,
  nav item "4 · Impact"): coordinate form with inline guidance, matched-artifact
  table, ambiguity warning, unresolved-module warning, and per-module evidence
  (source POM, directory, introducing artifact, scopes, min depth, all bounded
  paths with truncation). ArtifactId-only queries show a visible error instead
  of guessing. The view states explicitly that it reports evidence only and
  generates no POM edits. Covered by three Playwright UI tests.
- [x] **P1.5 Show POM relationships: parent, aggregation, depends-on, used-by.**
  A Maven reactor holds four structurally different relationships, and
  conflating them produces misleading answers. They are now modelled and shown
  as separate, labelled classes with explicit truth status: `parent` and
  `aggregates` are **structural** (POM inheritance and build structure — neither
  is a dependency), `dependsOn` and `usedBy` are **resolved** (from
  `mvn dependency:tree`), and `declaredDependency` is **declared-unverified**
  (intent, not proof of use). Implemented in `pom_topology.py`
  (`build_topology`, `module_relationships`), with `graph_model.Module`
  extended by additive optional fields (`parent_coord`, `parent_module`,
  `declared_modules`, `child_modules`, `unresolved_module_paths`,
  `declared_dependencies`) populated by `maven_runner._attach_topology` from the
  POMs it already parses. Surfaces as `GET /api/topology`,
  `GET /api/topology?module=`, `GET /topology` (nav "2 · Topology"), plus
  `GET /api/topology` for machines. Unresolvable `<module>` paths and external
  parents are reported in `unresolved_links`, never dropped. Used-by is derived
  from resolved edges only, so a library that is declared but never resolved
  never appears as used. Covered by `tests/test_topology.py` (29 tests,
  including backward-compatible loading of scans written before these fields
  existed) and five Playwright tests, one of which proves cross-module used-by
  end to end against `tests/fixtures/maven/shared-lib`.
- [ ] **P1.6 Produce a validated CycloneDX SBOM.** Generate it from a completed
  resolved scan, validate against the pinned CycloneDX schema, and label any
  partial export visibly.
- [ ] **P1.7 Add optional OSV enrichment.** Batch exact Maven coordinates,
  cache responses with timestamps, expose unknown/offline states, and link
  advisories to impact paths. No advisory result is not proof of safety.
- [ ] **P1.8 Improve tree usability.** Visually distinguish internal and OSS
  libraries, preserve accessible text/table behavior, and make large-tree
  search and expansion bounded and responsive.
- [ ] **P1.9 Add scan metadata and diagnostics.** Show scan time, source,
  completeness, Maven version, cache state, module counts, dependency counts,
  and actionable per-module errors.
- [x] **P1.10 Add scan persistence and portable Dependency Snapshots.** Retained
  across restarts: `scan_state.py` atomically saves the last *successful
  resolved* scan and restores it on boot; a failed, empty, or partial static
  scan deliberately leaves the previous good report intact (`can_persist`),
  and corrupt or unsuitable snapshots are ignored. Portability:
  `dependency_snapshot.py` exports `projectgraph.dependency-snapshot.v1`, which
  wraps the canonical scan model with a stable format identifier while
  stripping private cache metadata, so a graph can be moved to another machine
  (`GET /snapshot/download`, `POST /api/snapshot/load`, `GET /snapshot`, nav
  "7 · Snapshot"). Imported snapshots are marked read-only — they are another
  scan's evidence, not a local Maven result — and `/api/reload` returns 409
  rather than silently re-running Maven against them; loading a local folder
  clears the flag. Unknown formats and schema mismatches are rejected. Covered
  by `tests/test_scan_state.py`, `tests/test_dependency_snapshot.py`, and a
  Playwright download/upload/read-only test.
  Retained-scan cleanup and multi-scan comparison remain in P2.4.

### P1 exit gate

An architect can select a resolved library and see where it occurs, why it is
present, whether versions drift, and export a schema-valid SBOM without
Memgraph or Neo4j.

## P2 — Persist and explore proven data

- [ ] **P2.1 Implement Memgraph connection health and safe scan import.** Use
  server-side credentials, dataset/scan isolation, bounded batches, stale-safe
  activation, and disposable-container integration tests.
- [ ] **P2.2 Implement read-only graph presets.** Port blast radius and directed
  dependency route only after matching the P1 in-memory answers exactly.
- [ ] **P2.3 Add a minimal graph explorer.** Start with accessible tabular
  results and import status; add a bounded, locally bundled visualization only
  after correctness and performance gates pass.
- [ ] **P2.4 Add scan comparison and retention.** Dataset-scoped cleanup must
  reject active and foreign scans. Never clear the database globally.
- [ ] **P2.5 Evaluate Neo4j compatibility.** Add a dialect capability matrix
  and real integration tests before claiming support.
- [ ] **P2.6 Evaluate deeper analysis.** Conflict paths, unused local modules,
  deepest chains, licenses, and remediation suggestions require demonstrated
  workflows and explicit semantics before implementation.

### P2 exit gate

Persisted preset answers match the in-memory model, failed imports leave the
previous scan active, unrelated datasets survive replacement and cleanup, and
the core application still works with the database disabled.

## Parked — not scheduled

- Arbitrary/custom Cypher in the browser.
- Browser-entered or browser-stored graph credentials.
- Hosted multi-user deployment.
- Database-wide delete/reset operations.
- Automatic remediation or generated POM edits.
- Neo4j compatibility by assumption.
