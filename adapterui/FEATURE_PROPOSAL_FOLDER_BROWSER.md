# Feature proposal — Use-case folder browser

**Status:** Approved for implementation.
**Companion to:** [`DESIGN.md`](DESIGN.md) (current as-built design), [`README.md`](README.md) (usage).
**Review history:** Two senior-architect passes are recorded in [`REVIEW_COMMENTS_FOLDER_BROWSER.md`](REVIEW_COMMENTS_FOLDER_BROWSER.md) (self-contained — its section numbers no longer mirror this file, so references here point at the document, not its § numbers). Pass 1 ("request changes") produced the approved decisions D1–D10, now recorded in §3. Pass 2 ("approved for implementation") produced comments R1–R6, all applied in this revision. The §5/§6/§7 sections of this file were rewritten to match the decisions rather than carrying a review appendix.

## 1. Problem (as observed in the folders)

AdapterMS configuration is organized into **one folder per business use-case**. Each folder holds an adapter registration plus the template-definition files it references, and often extra artifacts:

| Folder | Registration | Templates | Other artifacts |
|---|---|---|---|
| `eventToApi Registration/` | `eventtoapiadapterconfigpayload.json` (EVENTTOAPI) | 1 × PROCESS | `eventtoapieventpayload.json` — an **event sample** (has `eventId`/`eventType`/`payload`, no `id`/`xmlRoute`) |
| `debulking/` | `paymentxmlupload.json` (DEBULKING) | 3 × PREPROCESS/PROCESS/POSTPROCESS | `payment.xml` — **raw input XML**; `debulking.xml.preprocess (1).json` — **byte-identical duplicate** of `debulking.xml.preprocess.json` |

The three relevant artifact shapes are detectable from their top-level keys:

- **Registration** — `{ type, name, status, templates[] }`
- **Template** — `{ id, name, type, xmlRoute, inputParameters, defaultParameters }`
- **Sample / other** — anything else (`eventId`/`eventType`, raw `<?xml`, …)

**Today's friction:** the reviewer requires the developer to (a) know which file is the registration, (b) pick it, and (c) hand-pick every matching template file one at a time. For every new use-case folder the developer must redo this and mentally hold the mapping. The tool does not discover the structure.

## 2. Goal

**When a developer selects a use-case folder, the app automatically identifies the registration and its templates, matches them, and renders a catalog where each use-case shows a meaningful summary and its integrity health — with one-click drill-down into the existing per-use-case reviewer.** The developer should be able to answer, at a glance, *what this adapter does and whether it is complete and consistent* without knowing which file is which.

## 3. Review history and approved decisions

**Two senior-architect passes** (full detail in `REVIEW_COMMENTS_FOLDER_BROWSER.md`):

- **Pass 1 — "request changes."** The direction was affirmed (signature-based F1, "classify and surface, never block", no second source of truth, reuse of the `TemplateReference` shape for the stage row), but three blocking defects (B1: import aborts before duplicate/missing logic and hard-codes a 3-file cap; B2: `buildReview` lives in `main.tsx`, not `parser.ts`; B3: `file.text()` destroys lossy-read evidence) plus four behavioural surprises (S1–S4: wrong-file resolution, real finding counts, unreachable `payment.xml`, 6 not 4 files) forced a rewrite. They resolved into the approved decisions **D1–D10** below; this file's §5–§7 were rewritten to match them.
- **Pass 2 — "approved for implementation"** after comments **R1–R6**: R1 (fix the misleading ASCII mock), R2 (add the missing `TEMPLATE_FILE_UNREADABLE` id), R3 (define `isSample`), R4 (named `FOLDER_MAX_TEMPLATES` cap, no undefined reference), R5 (fix DoD cross-references), R6 (status block + stale "existing 5-tab" framing + this collapse). All are applied in this revision.

### Approved decisions (D1–D10)

These are decisions, not options; the proposal text matches them.

- **D1 — New module `src/review.ts`.** Move `buildReview` and the `TemplateReference` assembly out of `main.tsx` into a pure module (no React import; imports `./parser` and `./model` only). Both `main.tsx` and the folder browser import it. *(Fixes B2.)*
- **D2 — Read raw bytes for every folder file.** `await file.arrayBuffer()` + `new TextDecoder('utf-8', { fatal: true })`. On `TypeError`, the entry is `unrecognised` with note `Not verified — the file could not be decoded as UTF-8`. Do **not** detect lossiness from the decoded string. *(Fixes B3.)*
- **D3 — Duplicate resolution precedes matching, deterministically.** Group by decoded text; within a group the **lexicographically smallest `relativePath`** is canonical (so `debulking.xml.preprocess.json` wins over `(1)`); others become `duplicate` side items. Raise `DUPLICATE_TEMPLATE_FILE` for templates, `DUPLICATE_FILE` otherwise. Matching uses **canonical entries only**. *Accepted limitation:* content equality is a synchronous non-cryptographic FNV-1a 32-bit hash over decoded text, no crypto dependency. *(Fixes S1.)*
- **D4 — Two-tier health.** **Tier 1 `folder`** (catalog chip) is computed from the registration + file classification only — **no Base64 decode, no `DOMParser`, no `buildReview`**. **Tier 2 `review`** is the existing `buildReview` pipeline, run only when a use-case is opened. Both use the same finding objects/ids (N4); only the *timing* differs. Card stage rows come from the registration (free). **Do not** run `buildReview` for every card on import.
- **D5 — Folder-level caps.** `FOLDER_MAX_FILES = 200`, `FOLDER_MAX_BYTES = 20 * 1024 * 1024` (sum of read byte lengths). Exceeding either stops further reads, keeps what was read, and raises an **Invalid** `FOLDER_LIMIT` naming the cap hit. Read files **sequentially** (never `Promise.all`); `await yieldToBrowser()` after every 25 files or 2 MB. *(Makes N2 real.)*
- **D6 — Mode switch is the catalog/default entry point.** "Folder browser" is default; the 5-tab reviewer is reached by **Open full review** on a card or via "Single review". Single review keeps its current gates (`REG_NOT_READ`, `FILE_COUNT`, `FILE_ROLES`, `TEMPLATE_COUNT`, `TEMPLATE_SET_MISMATCH`) and `accept="application/json,.json"` — **do not loosen it**. The "never block" policy applies to the **folder browser only**. The magic `3` becomes a named constant `FOLDER_MAX_TEMPLATES = 3`, and the single-review load-button guard is written against the already-narrowed required count — `selected.length > Math.max(requiredCount, FOLDER_MAX_TEMPLATES)` where `requiredCount` is the registration's declared template count (never `undefined`, because the button is disabled until a registration is read) — so it can never contradict the declared count or throw.
- **D7 — Health chip vocabulary (4 states) + grouped summaries.** `Errors` (≥1 Invalid), `Warnings` (≥1 Warning, no Invalid), `Not verified` (no Invalid/Warning, ≥1 Not verified), `Healthy` (otherwise); reuse the `Badge` accent system. Cards **group findings by `finding.id` with counts** (e.g. `PARAM_UNUSED ×5`), show at most **4 groups**, then `+N more`. Never render a raw finding list on a card.
- **D8 — Classification is an ordered, exclusive definition.** Each file gets exactly one kind, in this order: `registration` → `template` → `sample` → `raw-xml` → `unrecognised`. A `.json` that fails to decode is `unrecognised` (D2); a `.json` that parses but matches no shape is `unrecognised` and **must** appear as a side item. Non-JSON: `.xml` → `raw-xml` (never XML-parsed); `.pdf` and others → `unrecognised` with the extension in the label.
- **D9 — A template file may be claimed by more than one registration** (F8). It is shared, not duplicated: emit `TEMPLATE_SHARED` (**Warning**) once per occurrence and list it under every claiming card.
- **D10 — `SourceArtifact` is not modified.** Folder entries carry `relativePath: string`; `SourceArtifact.name` keeps receiving a single path segment. Card labels use `relativePath`.

## 4. Confirmed decisions (product direction)

| Decision | Chosen |
|---|---|
| Data source | **Select a folder** (`webkitdirectory`-style multi-file input). No `.zip` in this increment. |
| View depth | **Two-tier health (D4):** tier-1 summary + integrity chip on the card (from registration + classification only); tier-2 full `buildReview` findings on click, in the existing reviewer. |
| Non-adapter files | **Classify and surface, never block** — folder browser only (D6). Samples, duplicates, raw XML, and unrecognised files are labeled side-items; they never fail the catalog. The single-review flow keeps its strict gates. |
| Deliverable now | **This spec + design proposal**, then implementation per `REVIEW_COMMENTS_FOLDER_BROWSER.md` §4. |

## 5. Refined requirements

### 5.1 Functional

- **F1 — Discovery.** From a folder selection, classify every file into exactly one kind, in this order (D8): `registration` → `template` → `sample` → `raw-xml` → `unrecognised`, using the existing top-level-key predicates `isRegistration` / `isTemplate` (moved to `src/folder.ts`) plus a new `isSample`:

  ```ts
  export function isSample(value: unknown): boolean {
    const v = value as Record<string, unknown>;
    return !!v && (typeof v.eventId === 'string' || typeof v.eventType === 'string');
  }
  ```

  The order matters: a registration also carries a string `status`, and a registration that happens to carry `id`/`xmlRoute` must still be read as a **registration**, so `isRegistration`/`isTemplate` are evaluated before `isSample`. Do not use filename heuristics for role.
- **F2 — Use-case grouping.** A *use-case* is a registration plus the template files that match it.
- **F3 — Auto-matching.** Match registration entries to **canonical** template files (duplicates removed per D3) on exact `id` + `type` (same rule as R2 in `DESIGN.md`). Tier-1 (catalog) is classification-only; tier-2 reuses the `buildReview` / `validateCrossArtifact` pipeline so catalog and review findings share the same objects and ids (N4).
- **F4 — Meaningful summary (tier 1, from the registration).** For each use-case card show: adapter `name`, registration `type`, `status`, and the stage rows built from the registration's declared entries in declaration order — per entry: entry `type`, entry `id`, the canonical template file path (or a broken/missing row), and the declared route state. Where the registration supplies a transformation parameter, show the engine (JOLT/XSLT).
- **F5 — Integrity health (two tiers, D4/D7).** **Tier 1 (catalog chip)** is computed from registration + classification only: file/byte caps, unreadable declared templates (an entry whose candidate file exists but failed the UTF-8 decode raises **`TEMPLATE_FILE_UNREADABLE` (Invalid)** — distinct from `TEMPLATE_SET_MISMATCH`, which means the file is simply absent from the folder; tier 1 can tell them apart for free because it holds the file's `relativePath` and its `FILE_NOT_UTF8` note), duplicate groups, orphan templates, missing/extra declared entries, shared templates, and the registration's own parse findings — **no `buildReview`**. **Tier 2 (per use-case, on open)** adds the full `buildReview` verdicts (undeclared-supplied parameters, missing-mandatory parameters, process-id→route mismatches, and any `Invalid` findings). The chip uses the 4-state vocabulary `Errors` / `Warnings` / `Not verified` / `Healthy`; findings are shown **grouped by `finding.id` with counts**, at most 4 groups then `+N more` — never a raw list.
- **F6 — Side items.** Present non-adapter files as labeled items by kind: `sample`, `raw-xml` (never XML-parsed), `unrecognised` (including failed-JSON with a `JSON_SYNTAX` note, shown inspectable in a `<details>`), and `duplicate` (identical-content siblings). These are informational and never gate the catalog. An `unrecognised` JSON must remain visible, never silently dropped (D8).
- **F7 — Drill-down.** Clicking a use-case card runs the **tier-2** `buildReview` over the canonical files, sets the existing `reviews`/`findings` state, and opens the 5-tab reviewer. No second source of truth; the reviewer keeps its single-source-of-truth findings.
- **F8 — Multi-registration folder.** One card per valid registration (each with its own matched/unmatched template set); a template claimed by more than one registration is **shared** (D9, `TEMPLATE_SHARED`), listed under every claiming card.
- **F9 — Degraded mode (B1).** The catalog renders even when the file set is incomplete: a declared entry with no canonical file renders as a broken row (`matched: false`) with a `TEMPLATE_SET_MISMATCH` finding, rather than aborting the whole catalog.

### 5.2 Non-functional

- **N1 — Static + read-only.** Continue to require only the built static app; the folder's bytes are read in-browser and never uploaded.
- **N2 — Bounded input (D5).** Keep the existing per-file `MAX_FILE_BYTES` cap and add folder-level caps `FOLDER_MAX_FILES = 200` and `FOLDER_MAX_BYTES = 20 * 1024 * 1024` (sum of read byte lengths). Hitting either stops further reads, keeps what was read, and raises an Invalid `FOLDER_LIMIT` finding naming the cap hit; the reader yields to the browser every 25 files or 2 MB.
- **N3 — Read primitive (D2, fixes B3).** Read each folder file with `file.arrayBuffer()` + `new TextDecoder('utf-8', { fatal: true })` — **never `file.text()`** (which decodes leniently and destroys the evidence of a lossy read). On a decode `TypeError` the entry is `unrecognised` with a `FILE_NOT_UTF8` finding and a `Not verified — could not be decoded as UTF-8` note.
- **N4 — Consistent verdicts.** Tier-1 and tier-2 use the same `Finding` objects/ids as the single-review pipeline; the extraction into `src/review.ts` (D1) is what makes this hold.
- **N5 — No new dependency.** No zip/hash/UI library and no `crypto.subtle`; duplicate equality is a synchronous FNV-1a 32-bit hash (D3). No external fonts, CDNs, or network calls.

## 6. Information architecture

The app gains a top-level mode switch: **Folder browser** ↔ **Single review** (the current flow). The browser is the default landing mode.

```
[ Folder browser (default) ]
  import strip:  [ Select a use-case folder ]   status line
  catalog grid:  one card per use-case
     ┌────────────────────────────────────────────┐
     │ PAYMENTXML        DEBULKING      ● Errors   │  ← name / type / health chip
     │ status: START   3 stages                    │
     │ PREPROCESS  direct:debulking.xml.preprocess  ✓ debulking.xml.preprocess.json
     │ PROCESS     direct:debulking.xml.api.process ✓
     │ POSTPROCESS direct:debulking.xml.api.postprocess ✕ no route
     │ XSLT transform · target http://mockip…/sepaInstantPayment
     │ Findings: PARAM_UNUSED ×5 · XML_REF_UNDECLARED ×4 · +2 more
     │ [Open full review →]                          │
     └────────────────────────────────────────────┘
  side items:  samples (0) · raw XML (1) · duplicates (1) · unrecognised (0)
```

*Illustrative layout only — the real values are in the grouped-summary paragraph below (per the `REVIEW_COMMENTS_FOLDER_BROWSER.md` ground truth). The chip, canonical file name, and grouped findings are corrected to match that ground truth.*

The card renders the **real grouped summary** (D7), not a mock. Per the review §2 ground truth, the two sample folders render as:

- **`debulking/` — ● Errors**, 3 stage rows (POSTPROCESS broken / no route), engine XSLT on PROCESS, grouped findings such as `PARAM_MISSING recordCount ×1`, `PARAM_UNUSED ×5`, `XML_REF_UNDECLARED ×4`, `ROUTE_ID_MISMATCH ×1`, plus the duplicate pair and the `payment.xml` side item.
- **`eventToApi Registration/` — ● Warnings**, 1 stage row (route matched by id and from URI), engine JOLT, grouped findings `PARAM_UNUSED ×1`, and the `eventtoapieventpayload.json` sample side item.

A group line like `PARAM_UNUSED ×5` collapses repeated findings; at most 4 groups are shown, then `+N more`. The full parameter table, XML route flow, and raw content remain in the reviewer reached by **Open full review** (F7) — tier 2 only. This keeps the catalog fast (tier 1 is registration + classification only, per D4).

## 7. Data flow

1. **Read.** `<input type="file" multiple webkitdirectory>` (no `accept`) → `FileList` (each `File` carries `webkitRelativePath`). Read **sequentially** with `file.arrayBuffer()` + fatal `TextDecoder('utf-8')` (D2/D5), applying the D5 caps and yield points. A decode failure yields `FILE_NOT_UTF8` + an `unrecognised` entry, not a throw.
2. **Classify (F1, D8).** Pure, synchronous over the read entries, in the fixed order `registration → template → sample → raw-xml → unrecognised`, reusing the app's existing `isRegistration`/`isTemplate` predicates (moved to `src/folder.ts`). A `.json` that fails to parse is `unrecognised` and **stays visible** with its `JSON_SYNTAX`/`JSON_OBJECT` note. Non-JSON: `.xml` → `raw-xml` (never parsed); `.pdf`/other → `unrecognised`.
3. **De-duplicate (D3, before matching).** Group entries by decoded text (FNV-1a); the lexicographically smallest `relativePath` is canonical, the rest are `duplicate` side items (`DUPLICATE_TEMPLATE_FILE` / `DUPLICATE_FILE`). Matching uses **canonical entries only**, so a duplicate can never resolve an entry to the wrong file (S1).
4. **Match (F3, tier 1).** For each registration, match declared entries to canonical template files on exact `id` + `type`. Missing/extra entries, orphans, and shared templates become `TEMPLATE_SET_MISMATCH` / `ORPHAN_TEMPLATE` / `TEMPLATE_SHARED` findings. **No `buildReview`, no Base64, no `DOMParser` here** (D4 tier 1).
5. **Summarize (F4/F5, tier 1).** Derive each card's stage rows (from the registration) and grouped health summary (D7) from the classification + match.
6. **Render.** Catalog + side items, with a visible "Catalog incomplete — folder cap reached" state when `truncated`.
7. **Drill-down (F7, tier 2).** "Open full review" runs the extracted `buildReview` (from `src/review.ts`) over the canonical files and opens the reviewer with its single-source-of-truth findings.

## 8. UI design (consistent with existing patterns)

- **Mode switch** in the header (pill, reusing `.load-button`/tab styling).
- **Import strip** reuses the two-stage import visual language (numbered state-aware control, `role="status"` line).
- **Cards** reuse the panel + `Badge` severity chips and the template-reference table styling (`.template-ref`/`.ref-state`), so the ✓/✕ route state looks identical to the reviewer.
- **Health chip** reuses the severity accent system: green (Valid), amber (Warning), red (Invalid), grey (Not verified).
- **Overflow** for wide card content reuses `OverflowTable`/`useTableOverflow`.
- **Side items** render as a muted, non-interactive list (chips) to avoid competing with the catalog.

## 9. Reuse of existing logic (no duplication)

| Concern | Reused from |
|---|---|
| JSON/shape parsing | `parseJson`, `parseRegistration`, `parseTemplate` (`parser.ts`) |
| Role detection | `isRegistration`, `isTemplate` — **moved from `main.tsx` into `src/folder.ts`** and imported back; plus a new `isSample` (defined in F1: `eventId`/`eventType` string predicate, evaluated after the other two) |
| Matching + findings | `buildReview` — **moved from `main.tsx` into a new pure `src/review.ts`** (D1) — with `validateCrossArtifact`, `routeIdMatches`, `processReferenceFor` |
| Effective params / summary | `effectiveParameters`, `transformEngine`/`transformSpec` |
| Reviewer | the existing 5-tab reviewer UI, now consuming `src/review.ts` |
| Redaction / safety | `safety.ts`, `redactSecrets` |

The new code is thin: `src/review.ts` (extracted matching/`buildReview`), `src/folder.ts` (read/classify/de-dup/`composeCatalog`), and `src/Catalog.tsx` (mode switch, import strip, cards, side items) — each *assembles* existing outputs rather than re-deriving verdicts. This is what makes N4 (no divergent verdicts) hold: the catalog and the reviewer consume the same `Finding` objects.

**Catalog finding ids** (`category: 'Catalog'`): `FILE_NOT_UTF8` (Warning), `FOLDER_LIMIT` (Invalid), `DUPLICATE_TEMPLATE_FILE` / `DUPLICATE_FILE` (Warning), `ORPHAN_TEMPLATE` (Warning), `TEMPLATE_SHARED` (Warning), and **`TEMPLATE_FILE_UNREADABLE` (Invalid)** — a declared entry whose candidate file exists but could not be decoded. The catalog **reuses the existing `TEMPLATE_SET_MISMATCH`** id for missing declared entries (it does not invent a new "missing" id). The single-review gate ids (`REG_NOT_READ` / `FILE_COUNT` / `FILE_ROLES` / `TEMPLATE_COUNT`) are never emitted by the catalog.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `webkitdirectory` availability / permission quirks | Feature-detect; fall back to the existing single-file import with a clear note. No blocking on older browsers. |
| Lossy text from folder read (N3, D2) | Read via `arrayBuffer()` + **fatal** UTF-8 decode, never `file.text()`; a decode failure is a `FILE_NOT_UTF8` finding + `Not verified` note. **Loud-failure property:** the Base64 `xmlRoute` is ASCII, so a byte-level corruption breaks the strict Base64 alphabet check and surfaces as `BASE64_INVALID` — silent corruption of the critical payload is unlikely. |
| Large folders (N2, D5) | `FOLDER_MAX_FILES`/`FOLDER_MAX_BYTES` caps with sequential reads + browser yields; a cap hit raises `FOLDER_LIMIT` and shows a "Catalog incomplete" state. |
| Ambiguity: multiple registrations (F8) | One card per registration; a shared template raises `TEMPLATE_SHARED` (D9) and is listed under every card; never merged. |
| Duplicates (`preprocess (1).json`) | Resolved **before** matching (D3) by lexicographically-smallest canonical `relativePath`; the other becomes a `duplicate` side item + `DUPLICATE_TEMPLATE_FILE`; matching uses canonical files only so it can never resolve to the wrong file (S1). |
| Incomplete file set (B1) | Degraded mode (F9): missing declared entries render as broken rows with `TEMPLATE_SET_MISMATCH`; the catalog never aborts. |
| Unreadable vs. missing (R2) | A declared entry whose candidate file exists but fails the UTF-8 decode raises `TEMPLATE_FILE_UNREADABLE` (Invalid), not `TEMPLATE_SET_MISMATCH` — "present but unreadable" and "absent" get different diagnoses and fixes; tier 1 distinguishes them for free. |
| Scope creep toward authoring/export | Out of scope; this is browse + review only (matches hard constraints in `DESIGN.md`). |

## 11. Out of scope (this increment)

- `.zip` upload, multi-folder import, and remote/file-system scanning.
- Authoring, generation, export, or editing (see `EVENTTOAPI_UI_DESIGN_AND_IMPLEMENTATION_PLAN.md`).
- Runtime validation or endpoint calls.
- Cross-use-case comparison/analytics (a future increment).

## 12. Definition of done

The authoritative DoD is the list in [`REVIEW_COMMENTS_FOLDER_BROWSER.md`](REVIEW_COMMENTS_FOLDER_BROWSER.md) ("Definition of done"), with the regression fixtures and test plan in that document's "Tests" and "Verified ground truth" sections. In short:

- `pnpm test` stays green at ≥ 16 existing tests plus the new `folder.test.ts` cases; `pnpm run build` is clean.
- Selecting a folder with a registration + templates + a **duplicate** template + a **sample** + a **raw XML** file produces a correct catalog with **no blocking gates** (the B1 regression).
- The duplicate pair resolves to the canonical path (`debulking/debulking.xml.preprocess.json`); the duplicate is a labeled side item (S1/D3).
- `debulking/` renders one card with a **● Errors** chip, three stage rows (POSTPROCESS broken), and a **grouped** finding summary; `eventToApi Registration/` renders one card with a **● Warnings** chip and one sample side item — per the verified ground truth in `REVIEW_COMMENTS_FOLDER_BROWSER.md`, not the earlier mock.
- Drill-down opens the existing reviewer with tier-2 findings **identical** to the single-review flow for the same files (N4).
- No new dependency; no external network call; a corrupt envelope surfaces a loud `BASE64_INVALID` finding rather than a wrong answer.
- Docs updated: `DESIGN.md` (capability + new modules + new finding ids including `TEMPLATE_FILE_UNREADABLE`), `README.md` (browse section + caps + side-item note), and this file.
