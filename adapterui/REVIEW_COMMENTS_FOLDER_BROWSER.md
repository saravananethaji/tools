# Review comments — folder browser implementation, pass 3 (fixes applied)

**Status:** the three critical bugs and the cleanup items from this pass are **implemented and verified**.
**Method:** every claim carries a reproduction command or a captured test/execution output in §4.

Repo root: `/Users/saravanakumar/01_Coding/Active-Projects/tools/adapterui`

---

## 0. Summary

| Item | Before | After | Evidence |
|---|---|---|---|
| `pnpm test` | 26 passed | **34 passed** (15 folder + 16 parser + 3 app shell) | §4.1 |
| `pnpm run build` | clean | clean | §4.1 |
| `tsc --noEmit` | clean, but `folder.test.ts` was `@ts-nocheck` | clean with **no suppressions** | §4.1 |
| **C1** catalog findings leaked onto every card | ❌ false alarm on healthy adapters | ✅ **fixed** | §1 |
| **C2** `FILE_NOT_UTF8` / `TEMPLATE_FILE_UNREADABLE` unreachable | ❌ dead code; a present file reported "missing" | ✅ **fixed** | §2 |
| **C3** `dupFindings` never reached `catalog.findings` | ❌ empty catalog finding list | ✅ **fixed** | §3 |
| Feature reachable by a user | ❌ `Catalog` imported, never rendered | ✅ **fixed** — catalog is the default mode | §5 |
| N3 canonical duplicate selection | ✅ already correct | ✅ kept, now covered by a test | §4.2 |
| Model types declared twice | ❌ | ✅ single definition in `model.ts` | §5 |
| `readFolder` entry ordering | ❌ FileList order | ✅ sorted by `relativePath` | §5 |
| Repo hygiene | `main.tsx.backup` + 42 patch scripts | ✅ removed | §5 |

---

## 1. C1 — finding ownership (the critical false-alarm bug)

**Cause.** `relevantFindings` treated "no `registrationPath`" as "belongs to every card", so a duplicate or
undecodable file elsewhere in the folder appeared on unrelated use cases.

**Fix.** `Finding` gained an explicit `scope?: 'catalog' | 'registration'` (`src/model.ts`), and ownership is now
decided at creation time rather than inferred:

- **registration-scoped** — the registration's own parse findings, its standing `RUNTIME_UNVERIFIED` notice, its
  `TEMPLATE_SET_MISMATCH`, and a `FILE_NOT_UTF8`/`TEMPLATE_FILE_UNREADABLE` for a file that *is* one of its declared
  templates (because that blocks the entry).
- **catalog-scoped** — duplicate groups, orphan templates, shared templates, ambiguous `(id, type)`, reading-cap
  findings, and undecodable files that no entry declares.

A card now shows only what it owns:

```ts
const relevantFindings = allFindings.filter(f =>
  f.scope !== 'catalog' && f.registrationPath !== undefined && f.registrationPath === regPath
);
```

The chip also excludes the standing `RUNTIME_UNVERIFIED` notice — it is on every card by construction, so counting it
would make every card read "Not verified" and the chip would carry no information. This mirrors the reviewer's
Validation tab, whose count is invalid + warning only. A card reads `Not verified` only when the sole problem is an
unreadable file.

**Verified:** a clean registration plus an unrelated duplicate pair → the card is `Healthy` with only the standing
notice, while `catalog.findings` still contains `DUPLICATE_FILE`.

---

## 2. C2 — present-but-unreadable files

**Cause.** The candidate filter required `e.parsed !== undefined` while trying to classify files that failed to parse,
so both `FILE_NOT_UTF8` and `TEMPLATE_FILE_UNREADABLE` were unreachable — and an unreadable declared template fell
through to `TEMPLATE_SET_MISMATCH`, i.e. "missing".

**Fix.** A declared entry's file is now resolved to one of three states — *matched* (canonical), *present but
unreadable*, or *absent* — by entry name rather than by `parsed`:

- `TEMPLATE_FILE_UNREADABLE` (Invalid, registration-scoped) when the file is the declared template of an entry but
  cannot be parsed;
- `FILE_NOT_UTF8` (Warning) when a file that should have been a template will not decode;
- `TEMPLATE_SET_MISMATCH` is emitted **only** for genuinely absent files.

**Verified:** a declared `t1.json` containing invalid UTF-8 yields `[RUNTIME_UNVERIFIED, FILE_NOT_UTF8]` and
**no** `TEMPLATE_SET_MISMATCH`.

---

## 3. C3 — duplicate findings in the catalog list

**Cause.** `dupFindings` were merged into each card's group counts but never into `allFindings`.

**Fix.** They are pushed once as catalog-scoped findings, and the now-redundant per-card merge was deleted.

**Verified:** the real `debulking/` folder yields `catalog.findings = [RUNTIME_UNVERIFIED, DUPLICATE_TEMPLATE_FILE]`.

---

## 4. Reproduction and captured results

### 4.1 Pipeline

```bash
npx tsc --noEmit && pnpm test && pnpm run build
# tsc: clean (no @ts-nocheck, no @ts-ignore)
# Tests  34 passed (34)  — folder.test.ts 15, parser.test.ts 16, app.test.tsx 3
# build: ✓ built
```

### 4.2 Behaviour (captured)

```
C1  clean card + unrelated duplicate pair
    card groups=[RUNTIME_UNVERIFIED]  health=Healthy
    catalog.findings=[RUNTIME_UNVERIFIED, DUPLICATE_FILE]

C2  declared template present but not UTF-8
    findings=[RUNTIME_UNVERIFIED, FILE_NOT_UTF8]   (no TEMPLATE_SET_MISMATCH)

C3  debulking/ duplicate pair
    canonical = debulking/debulking.xml.preprocess.json
    duplicate = debulking/debulking.xml.preprocess (1).json
    catalog.findings contains DUPLICATE_TEMPLATE_FILE

ordering
    entries sorted by relativePath (deterministic across runs)

debulking/            fileCount=6  bytes=58644  card health=Healthy  3/3 stages matched
                      sideItems=[(1).json:template, payment.xml:raw-xml]
eventToApi Registration/  fileCount=3  card health=Healthy  1/1 stage matched
                      sideItems=[eventtoapieventpayload.json:sample]
```

Note the deliberate consequence of §1: tier-1 health is now `Healthy` for both real folders because duplicate/orphan
facts are catalog-scoped, not card-scoped. The tier-2 findings (`PARAM_MISSING`, `PARAM_UNUSED ×5`,
`XML_REF_UNDECLARED ×4`, `ROUTE_ID_MISMATCH`) still require `buildReview` and therefore still appear only when a use
case is opened — which is exactly what D4 specifies.

---

## 5. Also completed in this pass

1. **The feature is reachable.** `src/main.tsx` is now a 7-line bootstrap; the reviewer moved to `src/App.tsx`; the
   shared presentation primitives moved to `src/ui.tsx`, which breaks the `main.tsx ↔ Catalog.tsx` circular import.
   `App` renders the folder browser by default with a `role="tablist"` mode switch, and `Catalog`'s **Open full review**
   builds the tier-2 reviews via `buildReview` and hands them to the existing 5-tab reviewer (single source of truth).
2. **The hard-coded 3-file cap is gone** — the single-review picker is disabled only above
   `Math.max(requiredCount, FOLDER_MAX_TEMPLATES)`.
3. **Model types are defined once** in `src/model.ts` and re-exported from `folder.ts`.
4. **`readFolder` sorts entries by `relativePath`** (D4/D8 determinism).
5. **`@ts-nocheck` and both `@ts-ignore`s removed**; the `FolderEntry.relativePath` fallback now handles the empty
   string that a plain multi-file selection produces (`webkitRelativePath` exists but is `''`), which the previous
   `?? file.name` never caught.
6. **Tests added (8):** UTF-8 decode failure, entry ordering, duplicate resolution, and three ownership regressions —
   the assertions that would have caught C1/C2/C3. Plus `src/app.test.tsx`: both modes render, the switch works, and
   the folder picker exists only in catalog mode.
7. **Hygiene:** `src/main.tsx.backup` and all `fix_*.py` / `insert_*.py` / `update_main.py` scripts deleted.

---

## 6. What is still not verified

- **The live folder picker has not been exercised in a real browser.** jsdom cannot set `input.files` from a folder
  selection, so the end-to-end path (`webkitdirectory` → `readFolder` → card → **Open full review** → 5-tab reviewer)
  is covered by unit tests at both ends but not joined by an automated click-through. Worth one manual pass:
  `pnpm dev`, select `debulking/`, confirm one card, the duplicate side item, `payment.xml` as raw XML, and that
  **Open full review** lands on the Adapter Configuration tab.
- **F4 remains partial:** the card shows name/type/status, the stage rows, and the grouped summary, but the
  transformation engine (JOLT/XSLT) is not yet shown on the card, and `stage.processReference` is computed but not
  rendered.
- **`isSample`** still matches only `eventId`/`eventType`, not the `payload` marker named in the proposal.
- **`Catalog.tsx` styling** is still functional rather than the proposal's card design (no health chip component, no
  `.template-ref` stage styling). Behaviourally correct; cosmetically unfinished.
