# Key Gap Findings

Audit date: 2026-09-10
Baseline commit: `d6b32a5` (feat: add isolated Maven resolution preview)
Test baseline at audit time: **114 unit + 24 Playwright tests, all passing**

Scope: implementation review of the P1 feature set (P1.1–P1.11) — resolved OSS
inventory, conflicts/drift, impact queries, Impact UI, POM topology, scan
persistence/snapshots, tree usability, diagnostics, and the Maven resolution
preview.

**Nothing in this document has been fixed.** It is a triage record. Each finding
was reproduced by an independent probe; the commands and observed output are
included so any finding can be re-verified or dismissed on the evidence.

---

## How these were found

Two delegated read-only audits (impact/inventory/graph_model, and
snapshot/scan_state/inventory_export) were run, then **every CRITICAL and HIGH
claim was re-verified independently** before being recorded here. Findings that
did not reproduce were dropped or downgraded — see
[Corrections to reported findings](#corrections-to-reported-findings).

Severity reflects user-visible impact on a truthful-reporting tool:

| Severity | Meaning |
|---|---|
| CRITICAL | Hangs the process, or crashes a core query path |
| HIGH | Produces a wrong or dishonest answer, or breaks a documented invariant |
| MEDIUM | Wrong answer in reachable but narrower conditions; contract violation |
| LOW | Weakens diagnostics, robustness, or input validation |

---

## CRITICAL

### C1 — `index_artifacts` has no visited set, so a cyclic tree hangs forever

`impact.py:134-147`

```python
stack = list(module.tree.children)
while stack:
    node = stack.pop()
    ...
    stack.extend(node.children)      # line 147 — a cycle re-pushes forever
```

Every other traversal in the codebase tracks `on_path`/`_visited`; this one does
not. `blast_radius`, `dependency_routes` and `affected_modules` all call
`index_artifacts` first, so **every impact query hangs** on a cyclic tree.

Maven DOT output does contain self/back edges, and the repo already carries cycle
fixtures (`test_impact.py`, plus the DOT parser's own regression suite), so a
reachable cycle is not hypothetical. Note the *query layer* does handle cycles
correctly — only this index builder does not.

Evidence (5 s alarm, self-edge `x:lib:1 -> x:lib:1`):

```
$ python3 -c "...index_artifacts(model) with a self-cycle..."
calling index_artifacts ...
>>> CONFIRMED HANG
```

### C2 — `has_maven_resolved_tree()` returns True for a module with no tree

`graph_model.py:209-210`

```python
if module.tree is None:
    return module.error or module.analysis_status   # can be None or ""
```

`has_maven_resolved_tree()` is implemented as `reason is None`, so when both
`error` and `analysis_status` are falsy the helper reports **True for a module
that has no tree at all**. This is reachable from persisted JSON because
`GraphModel.from_dict` applies `.get("analysis_status", "pending")`, which does
*not* substitute the default when the key is present with JSON `null` (and
`"error"` has no default).

Evidence:

```
tree=None, error=None, status=None ->
   reason: None
   has_maven_resolved_tree: True          <-- should be False

from persisted JSON with null fields ->
   error: None   status: None
   has_maven_resolved_tree: True          <-- should be False
   blast_radius -> AttributeError: 'NoneType' object has no attribute 'artifact_id'
```

Consequences: `AttributeError` in all five consumers (`blast_radius`,
`dependency_routes`, `build_inventory`, `conflicts`, `index_artifacts`) when both
fields are `None`; and the **weaker, more likely** variant — when the status is a
non-empty string the reason is still falsy, so the module is silently absent from
the index and the user gets a clean lie: *"No resolved module depends on this
coordinate."*

---

## HIGH

### H1 — A non-object retained scan crashes application boot

`scan_state.py:43` (called unguarded from `app.py:85` at import)

```python
except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
```

The handler cannot catch `AttributeError` from `GraphModel.from_dict(data).get(...)`
or `RecursionError` from `json.load`, so uvicorn cannot start. This violates the
documented invariant that corrupt retained scans are *ignored*, not fatal.

Evidence:

```
JSON list    -> CRASH AttributeError: 'list' object has no attribute 'get'
JSON string  -> CRASH AttributeError: 'str' object has no attribute 'get'
JSON number  -> CRASH AttributeError: 'int' object has no attribute 'get'
JSON true    -> CRASH AttributeError: 'bool' object has no attribute 'get'
```

Correctly handled already: not-JSON, empty file, wrong `schema_version`,
`modules=null` (these are ignored). The common truncation case
(`JSONDecodeError`) is fine; only structurally-valid-but-wrong-shape content
crashes.

### H2 — Imported evidence is written to the retained cache and read-only is lost on restart

`app.py:555-558`, `graph_model.py:148`, `app.py:90`

`/api/load-json` calls `save_last_scan(LAST_SCAN_PATH, model)` for a model built
from user-supplied JSON. Because `Module.source` defaults to `"maven-resolved"`
and nothing records that the data was *imported*, `can_persist` passes. On the
next boot, `read_only_snapshot` is initialised to `False` unconditionally — so the
409 guard on `/api/reload` is gone and Maven is run against the imported
snapshot's root.

Evidence:

```
restored module source : 'maven-resolved'
restored has tree      : True
can_persist(restored)  : True
save_last_scan         : True
=> imported evidence DOES get written to the retained resolved cache
```

Within a single process the guard is correct: `/api/reload` and `/api/preview`
both return 409 after `/api/snapshot/load` and after `/api/load-json`, and
`/api/load` clears the flag. **Persistence across restart is the only hole.**

### H3 — Inventory and impact disagree about whether a module was excluded

`oss_inventory.py:115-118` vs `impact.py:280`

`build_inventory` filters on the *truthiness of the reason string*
(`if reason:`), while `impact.py` filters on `not has_maven_resolved_tree(m)`.
With an empty reason the two disagree and the inventory contradicts itself.

Evidence:

```
INVENTORY:
  included_modules: ['g:x:1']
  excluded_modules: []
  completeness    : complete
  status_note     : All modules resolved.
  entries         : []
IMPACT:
  excluded_modules: [{'coord_id': 'g:x:1', 'reason': ''}]
  completeness    : partial
```

This directly violates the never-silently-dropped invariant and contradicts the
promise made in `README.md`. The same empty reason also renders as a blank reason
in the inventory UI.

### H4 — `min_depth` is inferred from the bounded path sample, contradicting `direct` in the same payload

`impact.py:351`, `impact.py:456`

Lines 335-336 explicitly refuse to infer directness from a bounded sample
("Do not infer directness from a bounded path sample"), but line 351 does exactly
that for depth. So a single payload can assert both `relationship: "direct"` and
`min_depth: 2`.

Evidence (`g:app -> x:first -> t:target` plus a direct `g:app -> t:target`):

```
  max_paths=1: relationship=direct  direct=True  min_depth=2  truncated=True
  max_paths=2: relationship=direct  direct=True  min_depth=1  truncated=False
  => truth: target IS direct (depth 1). min_depth=2 is WRONG when bounded.

  affected_modules() (hard-codes max_paths=1):
    {'relationship': 'direct', 'min_depth': 2}
```

`affected_modules()` hard-codes `max_paths=1`, so its `min_depth` is wrong for
essentially every module with more than one route to the target. The default
`max_paths=16` does not protect this. `scopes` (line 339) carries the same
sample-bounded defect.

### H5 — A genuine intra-module conflict is relabelled `drift` when the path bound is 0

`graph_model.py:346-353`

`kind` is computed from *post-truncation* occurrences. When nothing is retained,
`per_module_versions` is empty, `intra` is `False`, and an intra-module version
conflict is mislabelled as drift.

Evidence (one module resolving `lib` v1 **and** v2 — must be `conflict`):

```
  max_paths=  0: kind=drift     versions=['1','2'] modules=['g:app:1'] occurrences=0 truncated=True
  max_paths= -1: kind=drift     versions=['1','2'] modules=['g:app:1'] occurrences=0 truncated=True
  max_paths=  1: kind=conflict  versions=['1','2'] modules=['g:app:1'] occurrences=2 truncated=False
  max_paths=  8: kind=conflict  versions=['1','2'] modules=['g:app:1'] occurrences=2 truncated=False
```

`kind` and `truncated` are contract values, so deriving one from a truncated list
makes the answer depend on the bound rather than the data.

### H6 — Parent POM version mismatch is silently "corrected" and reported as in-scan

`maven_runner.py:468` (`resolve_ga`), same fallback in `pom_topology.resolve_module_ref`

When the exact `g:a:version` is absent, the resolver falls back to GA-only
matching, so a *different* version is presented as the resolved parent while
`in_scan` stays `True` and `unresolved_links` stays empty.

Evidence:

```
child declares parent : com.acme:lib:1.0.0
workspace contains    : com.acme:lib:2.0.0   (only)
parent_module resolved: com.acme:lib:2.0.0
in_scan               : True
unresolved_links      : []
```

The UI renders `com.acme:lib:1.0.0 [in this scan]` linking to **2.0.0**: a false
badge and a link that silently jumps versions. This is the "nearest guess
presented as fact" class of bug the truth hierarchy exists to prevent.

**Latent, not currently triggered** — all fixtures are internally consistent and
**no test covers a parent version absent from the scan**, which is why it
survived. Introduced in P1.5.

### H7 — Sketchy snapshot payloads return HTTP 500 instead of a clear rejection

`dependency_snapshot.py:32,35`, `app.py:317`

`AttributeError` is absent from the handler's except tuple, and
`GraphModel.from_dict` is not shape-checked.

Evidence:

```
top-level list         -> AttributeError (uncaught by route): 'list' object has no attribute 'get'
top-level string       -> AttributeError (uncaught by route)
top-level null         -> AttributeError (uncaught by route)
scan.modules=['a']     -> AttributeError (uncaught by route)
module tree='yes'      -> AttributeError (uncaught by route)
groupId=99             -> ACCEPTED GraphModel      <-- wrong types accepted
```

The specifically-named case (wrong `schema_version`) correctly returns 400; the
surrounding shape validation does not.

### H8 — No provenance validation, so a payload with zero metadata claims to be authoritative resolved evidence

`dependency_snapshot.py:35`, `graph_model.py:418-422`

Only `scan.schema_version` is checked; `GraphModel` then defaults
`source="maven-resolved"` and `completeness` to `"complete"`, so an imported
payload with no metadata at all is reported as authoritative resolved data.

Combined with H7 (`groupId=99` accepted), a wrong-typed field then makes
`/api/inventory`, `/inventory/download` and `/tree` return 500
(`'int' object has no attribute 'rstrip'`).

---

## MEDIUM

### M1 — Consumers are keyed by `coord_id`, merging two distinct POMs that share a GAV

`oss_inventory.py:148-149, 174`

Evidence (two distinct POMs, same `g:app:1`, both reaching `t:target`):

```
included_modules: ['g:app:1', 'g:app:1']
consumer count for t:target: 1
  consumer module: g:app:1  paths: 2      <-- two POMs merged
```

Paths from two different POMs are merged under one consumer identity with no
`pom_path`, so the reported dependency path cannot be attributed to a project.
`blast_radius` handles the same case correctly (lists both, with distinct
`pom_path`), which shows the intended behaviour.

### M2 — An "empty" resolved scan replaces a richer retained scan, contradicting the code's own contract

`scan_state.py:13-18, 25-26`

A module whose Maven run succeeds with an empty DOT gets
`analysis_status="empty"` but a real `TreeNode`, so `has_maven_resolved_tree` is
`True` and `can_persist` returns `True`.

Evidence:

```
tree is not None : True
analysis_status  : empty
has_maven_resolved_tree -> True
can_persist      : True          <-- replaces a richer retained scan
```

`save_last_scan`'s docstring says *"A failed/empty scan deliberately leaves the
previously successful report intact."* Invariant 2 is otherwise honoured: all
four call sites go through `save_last_scan`, and `can_persist` correctly rejects
`pom-static`, zero-module, and all-modules-failed models.

### M3 — Unbounded recursion; thresholds below what the producer accepts

All traversals are recursive closures (`impact.py:193/226/244`,
`oss_inventory.py:143`, `graph_model.py:97/285/479`) and nothing raises the
recursion limit. Binary-searched maxima on the default limit of 1000:

```
  parse_dot_to_tree (producer)          max depth = 992
  blast_radius                          max depth = 992
  build_inventory                       max depth = 990
  to_dict/_tree_from_dict round-trip    max depth = 497
```

The cache/snapshot path is the weakest link: a tree the parser accepts (992) and
the query layer can traverse (992) **cannot round-trip through the cache**
(497). Whether real Maven reactor trees reach depth ~500 needs cache fixtures to
confirm, so this is recorded as a measured threshold rather than a live failure.

### M4 — `introduced_by` is sample-bounded, so the "which dependency brings this in" answer is incomplete

`impact.py:337-339, 364-368`

`introduced_by` is derived from the retained (≤ `max_paths`) paths, so the answer
promised by `DESIGN.md` is incomplete, and the flag raised is the generic
path-bound note — it does not say that *attribution* is incomplete.

Evidence:

```
  max_paths=1: introduced_by=['x:i1:jar:1']  truncated=True
  max_paths=2: introduced_by=['x:i1:jar:1','x:i2:jar:1']
  max_paths=3: introduced_by=['x:i1:jar:1','x:i2:jar:1']  truncated=False
```

### M5 — `inventory_export` crashes on an entry without a usable `groupId`

`inventory_export.py:38` (and the sort key near `:60`)

```
  missing groupId -> KeyError: 'groupId'
  groupId=None    -> KeyError: 'consumers'   (via sort/detail path)
```

Requires a hand-crafted inventory shape (`build_inventory` always emits
`groupId`), hence MEDIUM. It is reachable through H8's wrong-typed payload.

### M6 — `usedBy` arrows point backwards relative to their label

`templates/topology.html:170` vs `pom_topology.py:255`

A later change deliberately reversed the edge (comment: *"the previous
representation duplicated dependsOn and made the UI direction misleading"*), but
the template was never updated and renders every relationship class with the same
`A → B` arrow. Rendered output:

```
used by (resolved):
   commons-codec:commons-codec:jar:1.15  →  consumer-a:jar:1.0.0
depends on (resolved):
   consumer-a:jar:1.0.0  →  commons-codec:commons-codec:jar:1.15
```

Under the label "used by", the arrow reads left-to-right as *"commons-codec
depends on consumer-a"* — the opposite — in a visual style identical to
`dependsOn`. The fix for one misleading direction introduced another; only the
label now carries the meaning, and the arrow contradicts it. Introduced in P1.5.

### M7 — Two key forms for the same `used_by` concept

`pom_topology.py` (`used_by` vs `used_by_module`)

```
used_by keys       : ['c:lib:jar:1']    <-- packaging-bearing
used_by_module keys: ['c:lib:1']        <-- POM coordinate
```

Both appear in the `/api/topology` payload. A client querying
`used_by["c:lib:1"]` for an internal module gets **nothing** — the same trap that
previously made module-level `used_by` silently empty. `module_relationships`
reads the coord-keyed index while `build_topology["used_by"]` stays
packaging-keyed, so the two API surfaces disagree. Introduced in P1.5.

---

## LOW

### L1 — `/api/load-json` also 500s on a top-level non-object

`app.py:530` — `data.get(...)` raises `AttributeError`; `json.loads` succeeds for
`[1,2]`, `"x"`, `null`.

### L2 — `export_snapshot` is a shallow copy and leaks into the live model

`dependency_snapshot.py:20-22` — module dicts are copied but nested lists are
shared with the running model.

Evidence:

```
live model declared_dependencies: [{'groupId': 'x'}, {'groupId': 'INJECTED'}]
=> mutation of snapshot leaked into live model: True
```

Masked today only because `api_load_snapshot` discards the payload's nested
objects at `from_dict`. Related: `cache_state` is stripped on export, so a
genuine export→import changes `"fresh"` → `"none"`.

### L3 — `max_paths` clamping is applied but never surfaced

`impact.py:284-287` — a requested `-5` or `0` settles to `1`, and `10**9` to
`100`, with no `clamped` field or note explaining the override (compare the
explicit truncation note). Also, a result that retained exactly `max_paths` paths
cannot be distinguished from "the cap was hit".

Evidence:

```
  requested=          -5 -> reported max_paths=1
  requested=           0 -> reported max_paths=1
  requested=  1000000000 -> reported max_paths=100
```

### L4 — The inventory never echoes `max_paths`

`oss_inventory.py:83, 155` — truncation is flagged per consumer (invariant 4
satisfied), but the result contains no `max_paths` field, so a consumer of
`/api/inventory` cannot tell which bound produced the truncation.
`max_paths=0` also yields `paths=[]` for every consumer — an entry with a
consumer and zero paths, visibly odd in the Excel export.

### L5 — `optional` is a phantom field, and real `<optional>` is ignored

`pom_topology.py:188` emits `dep.get("optional", False)`, but
`pom_parser.Dependency` fields are exactly
`[groupId, artifactId, version, scope, type, classifier]` — there is no
`optional`, and `_attach_topology` never copies one. The field is therefore
permanently `false`: it asserts a fact never captured. `<optional>` is
semantically meaningful (optional dependencies do not propagate transitively) and
is silently dropped. Introduced in P1.5.

### L6 — Display caps live in the template; the API has no truncation flag

`templates/topology.html:172, 181` — the view honestly prints "N more not shown",
but the bound is not part of the model, so machine consumers cannot detect it and
any new consumer must re-implement the cap. Introduced in P1.5.

### L7 — Dead code in `build_topology`

`pom_topology.py:139` — `by_coord = _module_index(model)` is assigned and never
read. Introduced in P1.5.

### L8 — Whole-reactor topology computed twice per module-detail request

`app.py:425-428` — `/topology?module=` calls `build_topology`, then
`module_relationships`, which calls `build_topology` again. Measured small
(0.6 ms per 300 modules) but it scales with tree size, not module count, so it
grows with real reactors. Introduced in P1.5.

### L9 — One malformed project discards the whole static import with a misleading message

`app.py:697-701` — with 2 projects where the second lacks `coordinates`, the
response is `400 "Static import rejected; no projects were loaded"` and project 0
— which parsed fine — is dropped.

### L10 — Zero-entry Excel export sets `auto_filter.ref` to `A1:G1`

`inventory_export.py:115` — over a sheet whose only row is the header.
Cosmetic; the workbook is valid.

---

## Verified correct (suspect areas that hold up)

Recorded so these are not re-audited, and so this document is not read as
uniformly negative.

**Provenance marker.** Items tagged **[re-verified]** were re-run by the author
of this document and reproduced. Items tagged **[reported]** come from a
delegated audit and were *not* independently re-run here — they are recorded as
credible but should be treated as second-hand until re-checked.

- **Module root is context, not a dependency.** **[re-verified]** `blast_radius` never reports a
  module's own root as affected; `dependency_routes` uses the root only as a
  flagged `origin_is_module_root` origin, and traversals start from
  `module.tree.children`.
- **Cycle termination in the query layer.** **[re-verified]** `_paths_to_targets`,
  `_routes_between`, `conflicts.walk` and inventory `record` all carry
  `on_path` and terminate repeated identities — verified on cycles of length 1
  and 2 and on back-edges into the module root. (Only `index_artifacts` lacks
  this — see C1.)
- **Resolved-only gating.** **[re-verified]** A module with `source="pom-static"` and a fully
  populated tree is excluded from `blast_radius`, `dependency_routes` and
  `build_inventory` with the reason `source=pom-static is not Maven-resolved`.
  Static POM-shaped trees are excluded from topology `dependsOn`/`usedBy`.
- **Node budget is genuinely surfaced** **[re-verified]** — `truncated=True` plus a "hit a
  configured bound" note whenever the budget bites; `0` and negative budgets
  return an empty result with `truncated=True`, never a silent empty answer.
- **Nearest-occurrence-wins holds.** **[re-verified]** A branch stops at the first target; the same
  target on two distinct branches is correctly kept twice.
- **Exact matching / no guessing.** **[re-verified]** `parse_coordinate_query` rejects
  artifactId-only, empty and blank segments, and more than 5 segments;
  classifier/packaging mismatches return no match; a `g:a` query spanning two
  versions and a classifier variant returns all matches with `ambiguous=True`.
- **No-match is explicit and non-error** **[re-verified]**, with distinct notes for "no resolved
  artifact matches", "no resolved module depends on this coordinate", and
  "matches only scanned module roots".
- **`conflicts` respects resolved-only and root-is-context** **[re-verified]** — no conflict is
  fabricated from a failed or static module.
- **`declared_dependencies` uses `pom.dependencies`, not
  `dependency_management`** **[re-verified]**, honouring P0.7 (verified:
  `internal-parent-bom` has 2 managed entries, 0 declared).
- **POM topology structure is accurate** **[re-verified]** — 7 parent + 6 aggregate edges on the
  real fixture set with **0** false "unresolved"; parent cycles terminate;
  relative vs absolute `<module>` path normalization is correct.
- **Topology fields are additive** **[re-verified]**; scans written before them load and report no
  structural links.
- **Snapshot invariant 6 (no private cache state) is clean** **[reported]** — harvested files
  contain no `cache_state`/`cache_schema_version`/`input_fingerprint`/
  `command_signature`; top-level keys are exactly
  `exported_at`, `scan`, `snapshot_format`.
- **Snapshot invariant 5 is clean** **[reported]** — a static-only model exports 0 data rows; a
  mixed scan exports only resolved entries and reports `partial` with an excluded
  count; truncation is labelled including the 0-stored-paths case.
- **Full-fidelity round trip** **[reported]** through the real HTTP route: `/api/state`
  identical apart from `cache_state`.
- **P1.11 Maven Resolution Preview is sound** **[re-verified]** — `shell=False` with list args (no
  injection), version written via ElementTree (escaped), `MAX_MODULES=25`,
  temp mirror only, a runtime check that raises `Preview safety violation` if a
  source POM changed, temp dir cleaned up (0 leftovers), read-only snapshot
  rejected with 409.
- **P1.8** meets its spec **[re-verified]** (lazy expansion, 25-root cap, 100-item paging,
  internal/OSS labels); **P1.9** diagnostics exist and report the documented
  fields.

---

## Corrections to reported findings

Recorded for accuracy, so a reader does not chase claims that did not hold up.

1. **"Imported evidence persists to the retained cache"** — the first probe
   returned `can_persist = False`, because the test payload had no tree. With a
   realistic snapshot (a module that *does* carry a tree, which is what
   `import_snapshot` produces) it returns `True` and does persist. The finding
   stands as **H2**; the initial probe was under-specified.

2. **"A module with `tree is None` and a non-empty status is dropped from the
   index"** — the audit attached this to the `graph_model` helper. Re-verified:
   the crash variant requires *both* fields falsy (**C2**); with a non-empty
   status the module is correctly excluded by the *reason string*, and the
   inventory/impact disagreement is the separate **H3**.

3. **Audit claim that `test_core.py` cannot run** — partly environmental.
   `openpyxl` and `fastapi` are missing from `.venv` **but present in the system
   `python3`**, and `requirements.txt` does declare `openpyxl>=3.1`. Under
   `python3` all **114** tests pass. This is a real environment defect (the venv
   does not match `requirements.txt`) but not a code defect.

4. **`all_artifacts` / `all_edges` gate on `if m.tree:` rather than
   `has_maven_resolved_tree`** — noted but **not** recorded as a finding: their
   consumers (`neo4j_export.py`, the scan JSON `edges` key) sit outside the
   resolved-only query contract. It is a trap for any future caller that assumes
   graph-model-level "all" means resolved.

---

## Coverage gaps

No test covers any of the following, which is why these findings survived:

1. A cyclic tree reaching `index_artifacts` (**C1**) — other suites have cycle
   fixtures; the index builder does not.
2. A scanned module whose `error` and `analysis_status` are both null (**C2**).
3. A retained scan file containing valid JSON of the wrong **shape** (**H1**).
4. An imported payload round-tripped through a **process restart** (**H2**) —
   tests assert the in-process flag only.
5. An empty reason string from the exclusion helper (**H3**).
6. `min_depth` / `scopes` under a **bounded** path sample (**H4**) — the existing
   test uses the default bound and passes.
7. `conflicts.kind` at `max_paths <= 0` (**H5**) — `kind` is asserted, but never
   alongside a zero bound.
8. A parent POM version **absent from the scan** (**H6**).
9. A snapshot payload with the wrong **shape** or wrong **field types** (**H7**,
   **H8**) — only `schema_version` is tested.
10. `usedBy` **arrow direction** in the rendered view (**M6**) — API-shape tests
    pass, so the regression is invisible.
11. `used_by` **key form** for internal modules (**M7**).
12. Distinct POMs sharing one `coord_id` (**M1**).

---

## Environment note

`.venv` is missing `openpyxl` (and lacks `fastapi` for some invocations) although
`requirements.txt` declares both. Tests and probes in this document were run with
the system `python3` (`/Users/saravanakumar/.pyenv/versions/3.11.8/bin/python3`),
which has the dependencies installed. Rebuilding `.venv` from `requirements.txt`
would remove this discrepancy.

## Runtime artifact note

A probing session overwrote `projectgraph/cache/last-resolved-scan.json`, a
**gitignored runtime file**, and restored it from a Playwright artifact. It now
holds a valid 11-module `maven-resolved` scan of `test_projects` (19,503 bytes).
If the last scan before the audit was something else (for example a
single-module `shared-lib` scan), re-running a scan restores the desired state.
No tracked source file was modified by the audits — `git status` is clean.
