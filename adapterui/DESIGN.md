# Adapter configuration reviewer — Requirements & design

This document specifies the requirements and the design that are **implemented** in this project, for the AdapterMS configuration reviewer as a whole (all registration types). It describes what the tool does today, not what is planned.

Read it alongside:

- [`README.md`](README.md) — how to run, build, load a review, package, and deploy the app.
- [`EVENTTOAPI_UI_DESIGN_AND_IMPLEMENTATION_PLAN.md`](EVENTTOAPI_UI_DESIGN_AND_IMPLEMENTATION_PLAN.md) — EventToApi-specific design rationale, roadmap, and future authoring modes (Phase 0+).
- [`EVENTTOAPI_UI_DESIGN_VALIDATION_REPORT.md`](EVENTTOAPI_UI_DESIGN_VALIDATION_REPORT.md) — evidence review and the EventToApi/Debulking contract finding register.
- [`APPLICATION_REVIEW_GAPS.md`](APPLICATION_REVIEW_GAPS.md) — known gaps still open against the broader plan.

Division of scope: the README owns usage and deployment. The EventToApi plan/validation/gaps docs own EventToApi-specific rationale, the full product roadmap, and open gaps. This document owns the product-level requirements and the design of the code that exists.

## 1. Requirements

### 1.1 Purpose

A browser-based, read-only reviewer for existing AdapterMS configuration artifacts. It loads an adapter registration together with the template definitions it references, decodes them, computes effective configuration, and reports static findings. It supports every registration type — `EventToApi`, `Debulking`, and others that share the same shape — because its checks are driven by the registration's declared references, not by a hard-coded type.

### 1.2 Hard constraints

- **Read-only.** The tool never starts Camel routes, contacts endpoints, runs transformations, or writes configuration back out. Imported bytes are never re-exported.
- **Local only.** All parsing, Base64 decoding, and validation run in the browser against the selected files. No file is uploaded or persisted; a static web server that serves the built app receives nothing.
- **No runtime claims.** Static checks describe structure. Anything that depends on runtime beans, Camel components, endpoint connectivity, route execution, or parameter precedence must be reported as *Not verified*, never asserted.
- **No secret leakage.** Potential credentials in decoded XML, raw JSON, and displayed attributes are redacted everywhere they are shown.
- **Deterministic and testable.** The entire logic layer is pure functions over in-memory data, covered by automated tests.

### 1.3 Functional requirements

- **R1 — Two-stage import.** The registration is read first; its declared template references drive (and gate) which template files the user can load. The template picker is disabled until a valid registration is loaded.
- **R2 — Exact matching.** A review is built only when a template file's `id` and `type` exactly match one of the registration's template references, and the selected set exactly covers the declared set (no missing, no extra, no duplicate).
- **R3 — Decoding.** The template's Base64 `xmlRoute` is decoded to Camel Spring XML, and a format-appropriate transformation spec (JOLT for JSON, XSLT for XML) is decoded from the registration's supplied parameters — without executing it.
- **R4 — Effective configuration.** For every parameter, the tool resolves a provisional value by precedence *supplied → registration default → template default*, shows all three layers, and links each to its Camel XML usage.
- **R5 — Route/reference matching.** For each registration entry, the **process id the adapter mentions** must have a corresponding route in that entry's template XML. The process id is the entry's template `id`, or the supplied `process.routeId` when it names a different route.
- **R6 — Relationship trace.** A view traces each value as *adapter value → template declaration → Camel XML reference* with a static result.
- **R7 — Security.** DTD/external entities are rejected before parsing, and inline credential patterns are flagged and redacted.
- **R8 — Severity classification.** Every finding is classified as *Valid*, *Invalid*, *Warning*, or *Not verified*, with a stable machine id.
- **R9 — Faithful review.** The effective model preserves unknown fields and raw source, so the tool reports rather than guesses about data it does not understand.

### 1.4 Non-functional requirements

- **N1 — Static build, no runtime dependency.** The deployable is a static site; a plain web server suffices. No Node.js, pnpm, Camel, or Spring is required on the serving host.
- **N2 — Bounded input.** Files and decoded content are size-capped so the in-browser parser cannot be made to exhaust memory.
- **N3 — Safe decoding.** Base64 is validated strictly and decoded as UTF-8 with fatal error handling; malformed or non-UTF-8 content is a finding, not a crash.
- **N4 — Readable at a glance.** Validation severity must be signaled with both a word and a shape/color so findings remain legible when text is truncated or read out of order.
- **N5 — No third-party data dependency.** No external fonts, CDNs, or network calls; all rendering and parsing is local.

## 2. Design

### 2.1 Architecture and module boundaries

The app is a single-page React 19 + TypeScript SPA built with Vite. Logic is split so the interesting behavior is pure and independently testable:

| Module | Responsibility | Depends on |
|---|---|---|
| `src/model.ts` | All shared TypeScript types (artifacts, model, findings, severities). | — |
| `src/parser.ts` | Pure logic: JSON/Base64/XML parsing, schema validation, Camel DSL checks, effective-parameter computation, cross-artifact checks, transformation decoding. | `model` |
| `src/safety.ts` | Secret redaction and sensitive-content detection (regex transforms). | — |
| `src/xml-viewer.tsx` | Collapsible, color-coded, redacted Camel XML tree viewer. | `safety` (redact), CSS |
| `src/main.tsx` | React shell: import flow, tab navigation, and the five review views that compose `parser` + `model` + `safety` outputs. | all |
| `src/styles.css`, `entry-point.css`, `xml-viewer.css` | Hand-rolled visual layer. | — |

`parser.ts` has no DOM writes and no React imports; it returns plain data and `Finding[]` objects. This keeps the matching, precedence, and DSL logic unit-testable in `vitest` and means the UI cannot silently change a verdict.

### 2.2 Data model

Canonical types live in `src/model.ts`. Key shapes:

- **Artifacts.** `TemplateDefinition` (`id`, `name`, `type`, `inputParameters` declarations, `defaultParameters`, Base64 `xmlRoute`), `TemplateInstance` (the registration's embedded copy: `id`, `type`, supplied `inputParameters`, `defaultParameters`), and `AdapterRegistration` (`type`, `name`, `status`, `templates[]`, `parameters`). Each preserves `raw` and `unknownFields` for faithful review (R9).
- **Decoded template.** `DecodedTemplate` carries the decoded + redacted XML, a DOM `document`, `routes` (id, `from`, processor list, tree), `imports`, `beans`, `endpoints`, static `references`, and `securityFindings`.
- **Effective parameters.** `EffectiveParameter` holds the declaration plus the four layers (`suppliedValue`, `registrationDefault`, `templateDefault`, `provisionalValue`), a `state` (`Supplied` | `Registration default` | `Template default` | `Missing` | `Undeclared supplied`), and its `xmlReferences`.
- **Template reference.** `TemplateReference` records, per registration entry, the template id/type/name, the resolved file, the `processReference`, the `matchedRouteId`, and `referenceMatchesRouteId` (R5).
- **Findings.** `Finding` = `{ id, severity, category, artifact, location?, message, consequence?, suggestedAction? }` where `Severity` is the four-value set from R8.
- **Review.** `ReviewModel` binds one template to one registration instance plus the decoded XML, effective parameters, findings, transformation spec/engine, and `templateReferences`.

### 2.3 Import flow (two-stage)

The import is intentionally staged so the registration, not the user's guess, drives which templates are required (R1, R2).

1. **Stage 1 — read the registration.** On file selection the app immediately parses it: JSON shape check, `isRegistration` role check, then `parseRegistration`. The result is held in a `RegistrationPreload` (parsed registration, findings, and the `requiredTemplates` list of `{ id, type }`). A status line reports how many template references were found. If the file is not a valid registration, the findings panel shows why and the flow stops.
2. **Stage 2 — load templates.** The template `<input>` is `disabled` until stage 1 yields a valid registration. A "Template references in this registration" panel lists the required `(id, type)` pairs so the user can see exactly what to pick. The user may add template files one at a time (deduplicated by name+size+mtime). **Load review** then:
   - rejects if the registration was never read (`REG_NOT_READ`);
   - rejects if zero template files are selected (`FILE_COUNT`);
   - rejects any file that is not a template-definition JSON (`FILE_ROLES`);
   - rejects a count that differs from the declared references (`TEMPLATE_COUNT`);
   - rejects a set that does not exactly cover the declared references — reporting both `missing` and `unexpected` (`TEMPLATE_SET_MISMATCH`).

Only after all gates pass does the app build a `ReviewModel` per matched template. This gate design means a Debulking registration (three entries: PREPROCESS/PROCESS/POSTPROCESS) can never be reviewed with the wrong number or wrong identity of template files, and an EventToApi registration (one entry) behaves the same with one.

### 2.4 Matching and the process-id → route rule

- **Identity matching (R2).** A template file matches a registration entry only on exact `id` **and** `type`. Ambiguous (multiple) or absent matches are `Invalid` findings (`AMBIGUOUS_MATCH` / `NO_EXACT_MATCH`).
- **Process-id → route matching (R5).** For each entry, `processReferenceFor(instance)` computes the process id the adapter mentions: the entry's `id`, overridden by a supplied `process.routeId` parameter when one is present. That reference must equal a `<route id>` **or** a `<from uri>` in the entry's decoded XML (`routeIdMatches`). A miss produces a single `ROUTE_ID_MISMATCH` *Warning* (cross-artifact), and the review's `templateReferences` records whether the reference resolved to a route.

This rule is type-agnostic: it applies identically to `EventToApi` (one PROCESS entry whose route id equals the entry id) and to `Debulking` (PREPROCESS/PROCESS entries whose supplied `process.routeId` names the route, plus a POSTPROCESS entry whose id has no matching route and is therefore flagged). It is exercised by dedicated unit tests, including the case where a supplied `process.routeId` deliberately names a *different* route than the entry id.

### 2.5 Effective parameter computation (R4)

`effectiveParameters(template, instance, decoded)` builds the union of all parameter names across template declarations, template defaults, and registration defaults, then for each:

- `provisionalValue = supplied ?? registrationDefault ?? templateDefault`;
- `state` reflects the highest layer present (`Supplied` → `Registration default` → `Template default` → `Missing`);
- `xmlReferences` are the decoded Camel `exchangeProperty` references whose name equals the parameter.

Registration-supplied parameters that the template never declares are emitted separately with state `Undeclared supplied`, so the tool never silently merges them into a declaration. Precedence is shown, not asserted: the UI labels it provisional and a standing *Not verified* finding states that runtime precedence is not checked (hard constraint).

### 2.6 Static validation model (R3, R7, R8)

Findings are produced by pure functions and tagged with the ruleset constant `camel-spring-static-v1`. The categories:

- **JSON / import** — size cap (`FILE_TOO_LARGE`), object shape (`JSON_OBJECT`), syntax (`JSON_SYNTAX`), role mismatches.
- **Schema** — template/registration/parameter shape, duplicate declarations and values. Unknown keys are preserved, not errors.
- **Base64** — strict alphabet/padding check, non-UTF-8 rejection, empty and oversize decoded content.
- **XML format** — DTD/external-entity rejection *before* parsing (R7), well-formedness, Spring `<beans>` root, Camel namespace/schemaLocation.
- **Camel DSL** — route `id` presence/uniqueness, required `<from>`, supported `camelContext` and route-child element sets, `choice` structure, `uri` presence and balanced placeholders, empty `<simple>`.
- **Cross-artifact** — the `ROUTE_ID_MISMATCH` (R5), undeclared-supplied parameters, missing mandatory parameters, declared-but-unreferenced parameters, and XML-referenced-but-undeclared exchange properties.
- **Transformation** — detects a JOLT or XSLT spec parameter, decodes it, and validates shape only (JOLT as JSON; XSLT as well-formed, DTD-free, `xsl:stylesheet`-rooted). No execution (hard constraint).
- **Security** — inline credential pattern detection; matched values are redacted in every rendered form.
- **Not verified** — a standing finding makes the static-only posture explicit (`RUNTIME_UNVERIFIED`, `DSL_RULESET`).

Every finding carries a stable string id so the UI can key lists and tests can assert on it.

### 2.7 Security and redaction (R7, hard constraint)

Three layers keep secrets out of the display:

1. **Rejection.** `decodeTemplate` and `decodeTransformation` reject DTD and external entities before any XML parse.
2. **Redaction.** `safety.ts` redacts credential `key=value` / `key>value` pairs and userinfo in URLs; `parser.redactSecrets` redacts XML attribute values; the XML viewer and the Raw view additionally redact attribute values inline.
3. **Detection.** `containsSensitiveContent` and the `INLINE_SECRET` finding flag likely credentials so a reviewer knows where values were masked.

### 2.8 Presentation design (N4, N1)

The UI is a hand-rolled, dependency-free presentation layer (no UI framework, no external CSS). Its design decisions are driven by usability findings from an earlier UX review:

- **Five review tabs** — *Adapter Configuration*, *XML Template*, *Relationship*, *Validation (N)*, *Raw* — plus a "Matched templates" picker when multiple templates load.
- **Signal-readable validation (N4).** Each finding shows a severity **icon + word** (`✓ Valid`, `✕ Invalid`, `⚠ Warning`, `? Not verified`), findings are sorted Invalid → Warning → Not verified → Valid, and each severity chip and finding row carries a distinct accent. The Validation tab's count `N` reflects invalid + warning (actionable items) and excludes *Not verified*.
- **Effective-configuration table (N1, wide).** The parameter table is wrapped in `OverflowTable`, which toggles a horizontal-scroll affordance via a `ResizeObserver` when the table exceeds its container, so long help-text and XML-reference columns never clip.
- **XML Template view.** Structured panels (hero with runtime entry point, dependencies & security, route flow, Camel expression references, and a collapsible decoded XML viewer). The runtime entry route is highlighted and expanded by default; other elements collapse/expand on click.
- **Raw view (no Base64 dominance).** Raw shows the registration JSON and the template JSON as the primary content; the decoded `xmlRoute` is a collapsed `<details>` that expands on demand, so encoded Base64 does not dominate the review.
- **Template reference resolution panel.** Per entry: `Entry | Type | Process id (adapter) | Resolved template file | Route in XML | Result`, with a green "✓ route present" / red "✕ no route" chip and an explicit note when the process id comes from `process.routeId` rather than the entry id.
- **Two-stage import affordances.** The staged import uses numbered, state-aware file controls (`filled`/`locked`/`ready`), a "Template references in this registration" chip list, and two explicit buttons — **Read registration** and **Load review** — with the load button disabled until both stages are satisfied and the count is within the declared range.

### 2.9 Testing (R2, R4, R5, hard constraints)

The logic layer is covered by 16 `vitest` unit tests in `src/parser.test.ts`, focused on behavior the requirements make load-bearing:

- contract parsing and matching;
- rejection of malformed JSON, Base64, XML, and DTD *before* XML parsing (N3, R7);
- duplicate route ids and invalid `choice` structure;
- nested registration object validation instead of casting;
- local bean vs. unresolved reference classification;
- provisional precedence with template defaults and distinct treatment of undeclared values (R4);
- JOLT and XSLT shape validation without execution;
- preservation of unknown fields alongside duplicate detection;
- non-UTF-8 / empty Base64 rejection;
- required route parts, unsupported DSL nodes, bad URIs, empty `simple` expressions;
- missing / unused / XML-only exchange-property references;
- **process-id → route matching** — the no-route flag, the aligned no-flag, and the supplied-`process.routeId`-names-a-different-route case (R5);
- external entities and malformed transformation rejection.

Debulking samples additionally serve as end-to-end fixtures: PREPROCESS and PROCESS entries resolve to their routes, while the POSTPROCESS entry (no `process.routeId`, id with no matching route) surfaces exactly one `ROUTE_ID_MISMATCH` warning.

## 3. What is intentionally out of scope here

Authoring/generation (Create Template, Create Registration), lossless export, editing, runtime-assisted validation, and the EventToApi roadmap are covered by the EventToApi plan document and are not part of the implemented design described above. Open gaps against that broader plan are tracked in [`APPLICATION_REVIEW_GAPS.md`](APPLICATION_REVIEW_GAPS.md).
