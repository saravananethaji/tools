# EventToApi Reviewer - Application Review Gaps

**Review date:** 2026-09-12  
**Scope reviewed:** Phase 1 read-only loading, decoding, presentation, and static validation  
**Verdict:** Not ready for Phase 1 acceptance

## Evidence

- `pnpm test` passed: 5 tests in 1 test file.
- `pnpm run build` passed.
- The supplied EventToApi sample loaded in the browser.
- The XML Template, Adapter Configuration, Relationship, Validation, and Raw views were inspected.

Passing the build and five narrow unit tests does not satisfy the Phase 1 acceptance criteria in `EVENTTOAPI_UI_DESIGN_AND_IMPLEMENTATION_PLAN.md`.

---

## P1 - Must fix before Phase 1 can be accepted

### G-01 - Literal credentials are published and displayed

**Evidence**

- The credential-bearing EventToApi fixture is copied under `public/eventToApi Registration/`, which Vite copies to `dist/`.
- The "Load supplied sample" action fetches that public fixture.
- XML Template and Raw views render the complete decoded XML without redacting credential values.

**Impact**

A production build distributes sensitive credential material. Anyone opening the XML view can read it. The current warning does not mitigate exposure.

**Required correction**

1. Remove secret-bearing fixtures from `public/` and the production bundle.
2. Use a sanitized fixture for the sample-load action, or remove that action.
3. Detect and redact sensitive XML attributes and text before rendering any structured view, raw view, diagnostic, log, test snapshot, or error message.
4. Preserve a finding that identifies the location and type of secret without showing its value.

**Verification**

- Build the application and search `dist/`; no known fixture credential or secret value is present.
- Load the sensitive fixture locally; security findings appear, but rendered output does not reveal the value.

---

### G-02 - Claimed Camel DSL validation is not implemented

**Evidence**

`decodeTemplate()` currently checks Base64, XML well-formedness, and a DTD/entity string pattern. It then inventories routes, beans, endpoints, and expression text. It does not validate Camel DSL structure.

**Impact**

The UI and footer imply a Camel static ruleset exists, while malformed or unsupported Camel structures can pass as apparently valid. Reviewers could treat an inventory as a validation result.

**Required correction**

Implement a versioned local Camel Spring XML schema or supported-DSL ruleset. At minimum validate:

- Spring and Camel namespaces and expected root element
- Supported Camel elements and attributes
- Required attributes such as route IDs, `uri`, `ref`, and `name`
- Valid parent/child placement
- `choice`, `when`, `otherwise`, and `onException` nesting
- Redelivery-policy structure
- Duplicate route IDs and route-source identity rules
- Static URI syntax and balanced dynamic placeholders
- XML-escaped Simple expressions
- Direct endpoint and locally declared bean references where statically resolvable
- Unsupported elements, components, and expression languages

**Verification**

- Each invalid construct above produces an `Invalid` or `Warning` finding with its XML location.
- The UI displays the exact DSL/schema-ruleset version used.
- If no exact version is configured, version-dependent checks show `Not verified`, not `Valid`.

---

### G-03 - Effective parameter values ignore template defaults

**Evidence**

The UI computes defaults only from `registration.templates[].defaultParameters`. It never considers `template.defaultParameters`.

**Impact**

The Adapter Configuration View can report a parameter missing or calculate the wrong effective value. The supplied Debulking definitions demonstrate that template-level defaults exist, so this is not theoretical.

**Required correction**

Define and implement an explicit precedence model, pending Java-runtime confirmation. Until then, show the sources separately and label the final effective value `Not verified` if precedence is unknown.

The presentation must show:

```text
declaration -> template default -> registration default -> registration supplied -> effective value
```

**Verification**

- Tests cover declared-only, template-defaulted, registration-defaulted, registration-supplied, conflicting-default, and missing-mandatory cases.
- No value is described as effective when the precedence rule is unknown.

---

### G-04 - XML-reference validation is both false-positive and incomplete

**Evidence**

- `${exchange}` is reported as an undeclared value in the supplied fixture even though it is framework-provided.
- `${exchangeProperty.httpEndPoint}` and similar expressions are skipped at the `exchangeProperty` root, so their parameter names are never compared with template declarations.

**Impact**

The supplied sample displays misleading warnings while failing to detect the very mismatch the validator is supposed to find. This makes the validation tab untrustworthy.

**Required correction**

Parse expression references into typed categories, for example:

- `exchangeProperty.<parameterName>`
- `header.<headerName>`
- `body`
- `exchange`
- `exception`

Compare only `exchangeProperty.<parameterName>` against template declarations. Maintain an explicit allow-list for framework-provided expressions. Do not use string splitting and substring checks as the reference model.

**Verification**

- The supplied EventToApi sample has no bogus warning for `${exchange}`.
- A referenced but undeclared `exchangeProperty.foo` generates a clear warning.
- Parameter usage appears once per XML location, not as duplicate free-text strings.

---

### G-05 - Imported raw artifacts are not preserved for review

**Evidence**

- The parser rebuilds a reduced `AdapterRegistration` object and drops unknown fields.
- Raw registration output serializes that reduced object rather than the original file content.
- Original filenames and raw template JSON are not retained.

**Impact**

The "Raw" view is not a reliable expert-review source. Unknown fields may be absent, and a reviewer cannot verify exactly what was loaded.

**Required correction**

Keep immutable source records for each input:

- Original file name
- Original raw text
- Parsed object
- File role
- Source location/provenance

Show original raw template JSON and original raw registration JSON. Keep unknown fields in the inspection model and report them as unknown rather than discarding them.

**Verification**

- A fixture containing an unknown field shows it in Raw and Unmanaged/Unknown views.
- The raw-view text matches the loaded source byte-for-byte, subject only to explicit redaction in a separate safe-rendered view.

---

### G-06 - XSLT and transformation-format validation is missing

**Evidence**

Any successfully Base64-decoded XSLT value is displayed as `Valid`; it is not parsed as XML or checked as an XSLT stylesheet. JSON/JOLT versus XML/XSLT pairing is inferred from parameter naming and not enforced.

**Impact**

Invalid XSLT can receive a green validity badge. Unsupported pairings can pass without a finding.

**Required correction**

- Parse JOLT as JSON.
- Parse XSLT as XML and validate the expected XSLT root/namespace statically.
- Determine payload format from explicit configuration or mark it `Not verified`.
- Enforce only valid pairs: JSON/JOLT and XML/XSLT.
- Do not execute JOLT or XSLT as part of Phase 1 review.

**Verification**

- Invalid JOLT JSON is `Invalid`.
- Malformed XSLT and non-XSLT XML are `Invalid`.
- Unsupported or unknown payload/transform pairings are `Invalid` or `Not verified` as appropriate.

---

### G-07 - XML Template View does not provide the required route meaning

**Evidence**

The route view lists only direct child element names as chips. Nested `choice`, `when`, and `otherwise` structures are flattened. Exception policies, retry settings, result statuses, responder relationships, headers, and properties are not summarized.

**Impact**

The view tells the reviewer that a `choice` exists but not what it means. It does not meet the purpose of converting XML into a meaningful template view.

**Required correction**

Build a parsed route tree with node type, attributes, text expressions, source XML location, and nested children. Add dedicated sections for:

- Main and responder routes
- Error policies and redelivery settings
- Result-status outcomes
- Headers and properties written
- Imports, beans, TLS resources, and endpoints
- Parameter usage

Unknown nodes must remain visible as unmanaged nodes.

**Verification**

- The supplied EventToApi template renders both `choice` branches and all exception policies with their nested actions.
- Selecting a structured node identifies its raw XML location.

---

### G-08 - Relationship View does not trace configuration to route behavior

**Evidence**

The Relationship View only displays the registration and template identities matched by `id` and `type`.

**Impact**

It does not answer the core review question: which adapter-supplied value is declared by the template, consumed by which XML expression, and affects what static route behavior.

**Required correction**

For each declared/supplied/defaulted parameter, show:

```text
adapter value -> template declaration -> XML expression/location -> static route behavior
```

Use explicit states: Matched, Missing declaration, Missing value, Defaulted, Declared but unused, XML reference undeclared, Ambiguous, and Not statically resolvable.

**Verification**

- `httpRequestType`, `https.config`, `httpEndPoint`, and `data.transform.spec` are each traceable through the supplied EventToApi template.

---

### G-09 - Parser trusts malformed nested objects and can crash

**Evidence**

`parseRegistration()` checks only top-level fields and type-casts template instances. Later code assumes `inputParameters` exists and calls `.find()` or `.map()` on it.

**Impact**

An invalid imported registration can cause a UI exception instead of an actionable validation finding.

**Required correction**

Validate every nested object and array before constructing typed models:

- Template instances
- Parameter declarations
- Parameter values
- Defaults
- `parameters` object

Use schema guards or a schema-validation library. Never cast untrusted JSON directly to a domain type.

**Verification**

- Malformed nested arrays/objects show field-location findings.
- The UI remains usable and permits either file to be replaced after invalid input.

---

## P2 - Required for a complete, maintainable Phase 1

### G-10 - Base64 decoding is not UTF-8 safe

**Evidence**

The decoder returns `atob()` output directly as a JavaScript string.

**Impact**

UTF-8 XML/JOLT containing non-ASCII text can be corrupted before parsing or display.

**Required correction**

Decode Base64 into bytes and use `TextDecoder('utf-8', { fatal: true })`. Report invalid UTF-8 as an artifact-format failure.

---

### G-11 - DTD/entity rejection happens after XML parsing

**Evidence**

The document is passed to `DOMParser` before the code checks for `DOCTYPE` or `ENTITY`.

**Impact**

The intended security control is applied too late and relies on browser implementation details.

**Required correction**

Reject prohibited XML declarations before parsing. Retain the browser parser as a second layer, not the security boundary.

---

### G-12 - Encoded values remain the primary configuration display

**Evidence**

The Effective Parameters table displays the Base64 value for `data.transform.spec` as supplied and effective.

**Impact**

The UI forces reviewers to read opaque data in the primary configuration view, contrary to the project requirement.

**Required correction**

Display a concise decoded summary in the parameter table, such as `JOLT transformation (valid JSON)` or `XSLT transformation (valid XML)`. Put Base64 only in a collapsed raw/details section.

---

### G-13 - Global and per-template validation results can diverge

**Evidence**

The validation-tab count comes from global `errors`, while the rendered Validation tab uses the selected review's findings. Findings such as template-set validation are not consistently included in both places.

**Impact**

The visible count can disagree with the list a reviewer sees, particularly with multiple templates.

**Required correction**

Create one normalized validation store with clear scopes: import, template, registration, relationship, and global. Both badge count and tabs must derive from the same scoped data.

---

### G-14 - Scope and documentation conflict

**Evidence**

The design's Phase 1 brief specifies one template-definition JSON and one registration JSON for the initial release. The application accepts one to three templates and validates PREPROCESS/PROCESS/POSTPROCESS combinations.

**Impact**

The implementation introduces multi-stage behavior outside the agreed EventToApi Phase 1 boundary and makes testing/review harder.

**Required correction**

Either:

- Restrict Phase 1 UI to one EventToApi `PROCESS` template and one registration, or
- Update the approved design, acceptance criteria, fixtures, and tests before treating multi-template support as in scope.

---

### G-15 - External font dependency and unpinned package declarations

**Evidence**

- `styles.css` imports fonts from Google Fonts.
- `package.json` declares dependencies as `latest`.

**Impact**

The reviewer is not fully offline and reproducible dependency selection depends on the lockfile alone.

**Required correction**

- Bundle or use system fonts for Phase 1.
- Replace `latest` with exact compatible versions and keep the lockfile committed.
- Move build tooling such as Vite, TypeScript, and the Vite React plugin into development dependencies where appropriate.

---

### G-16 - Test coverage is far below the accepted requirement

**Evidence**

Only 5 unit tests exist. There are no UI tests and no golden tests using the supplied EventToApi files.

**Impact**

Most required failure states and acceptance criteria are untested. Passing `pnpm test` is weak evidence.

**Required correction**

Implement the automated checks in Section 25.17 of the design plan, including fixture loading, matching, Base64/XML/JOLT/XSLT failures, DTD rejection, DSL structure, credentials/redaction, no-network behavior, no-write behavior, and UI accessibility/failure states.

---

## Recommended remediation order

1. G-01: remove distributed secrets and add redaction.
2. G-09 and G-05: make imported data safe, typed, and preserved.
3. G-02, G-04, and G-06: implement trustworthy static validation.
4. G-03, G-07, and G-08: make configuration and route behavior meaningful.
5. G-10 through G-16: improve correctness, scope discipline, reproducibility, and test coverage.

## Re-review gate

Request re-review only when:

- Every P1 gap is fixed and covered by tests.
- No credential-bearing fixture or secret is shipped in `public/` or `dist/`.
- The UI correctly reviews the supplied EventToApi sample without false XML-reference warnings.
- Camel DSL validation is clearly static and versioned.
- Test coverage includes the required positive, negative, security, and UI cases.
- The implementation remains strictly read-only and performs no runtime validation.
