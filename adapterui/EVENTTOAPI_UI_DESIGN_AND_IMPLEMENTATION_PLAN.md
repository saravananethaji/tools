# EventToApi Route Designer

## UI Design and Implementation Plan

**Status:** Revalidated draft - conditional approval only  
**Scope:** EventToApi pattern only  
**Source reference:** `AdapterMS_Architecture_and_Specification_Guide.pdf`  
**Implementation status:** No implementation is authorized by this document

---

## 1. Purpose

Build a UI that lets an integration engineer:

1. Configure an AdapterMS `EVENTTOAPI` route without manually writing the complete registration JSON, template JSON, transformation specification, or Camel Spring XML.
2. Validate the configuration before it is exported.
3. Generate two related artifacts: a reusable template-definition JSON containing parameter metadata and encoded Camel XML, and an adapter-registration JSON containing the selected template identity plus concrete parameter values.
4. Load existing adapter and template documents for structured, read-only review.
5. Decode and display the Camel XML and encoded transformation configuration used by the service.
6. Preserve configuration constructs that the UI does not understand.

The first release is a constrained configurator for one supported route pattern. It is not a general-purpose Apache Camel visual programming environment.

---

## 2. Problem Statement

AdapterMS executes integration routes dynamically from configuration. The current configuration model combines several concerns:

- Adapter lifecycle and registration metadata
- Template identity and runtime parameters
- Event-source settings
- Transformation specifications such as JOLT or XSLT
- Target HTTP endpoint settings
- Error and retry behavior
- Base64-encoded Camel Spring XML

Editing these documents manually is error-prone. A syntactically valid document can still contain broken route references, invalid encoded content, unsafe endpoints, or behavior inconsistent with the user's intent.

The UI must therefore be a structured authoring and validation layer over the existing Java runtime contract. It must not invent a replacement contract.

---

## 3. Scope

### 3.1 Included in the first release

- `EVENTTOAPI` adapter type
- One `PROCESS` template
- JSON or XML event payload sample for transformation testing; event-consumer configuration is not authored because it is absent from the supplied contract
- Format-driven transformation: JSON uses JOLT and XML uses XSLT
- HTTP target invocation
- Configurable HTTP method, `https.config`, endpoint, and JOLT specification as evidenced by the EventToApi template contract
- Review-only display of TLS, exception, retry, responder-route, bean, and shutdown behavior embedded in Camel XML
- Adapter registration JSON generation
- Template JSON generation
- Camel Spring XML generation
- Base64 encoding and decoding
- Import and review of an existing adapter registration and template
- Structural and semantic validation
- Human-readable preview and semantic diff
- Preservation of unsupported JSON fields and Camel XML elements

### 3.2 Explicitly excluded

- `APITOEVENT`, `BULKING`, `DEBULKING`, `SYSTEM`, and `MDAL`
- Arbitrary drag-and-drop Camel processor composition
- Editing arbitrary Spring beans
- Direct deployment, route activation, or runtime restart
- Secret creation or storage
- Runtime monitoring and operational dashboards
- Collaborative editing and approval workflow
- Automatic conversion of unsupported Camel constructs into managed UI fields
- Multi-stage `PREPROCESS` and `POSTPROCESS` authoring unless required by the actual EventToApi runtime contract
- Kafka/JMS broker, topic, queue, consumer group, offset, acknowledgement, and concurrency authoring
- Selecting a transformation engine independently from payload format; JSON/JOLT and XML/XSLT are fixed valid pairings
- User-configurable HTTP headers, authentication, path/query models, timeouts, success-code sets, retry policies, or TLS material until corresponding runtime parameters are confirmed

---

## 4. Available Configuration Evidence

The supplied EventToApi files were inspected:

- `eventToApi Registration/eventtoapiadapterconfigpayload.json`
- `eventToApi Registration/eventtoapieventpayload.json`
- `eventToApi Registration/eventtoapitemplateconfigpayload.json`

The adapter configuration sample establishes that:

- The adapter has `type`, `name`, `status`, `templates`, and top-level `parameters`.
- A template instance is embedded in the adapter registration payload.
- The embedded template instance contains `id`, `type`, concrete `inputParameters` name/value entries, and `defaultParameters`.
- `process.routeId`, `httpRequestType`, `https.config`, `httpEndPoint`, and `data.transform.spec` are represented as name/value entries.
- `data.transform.spec` decodes to the JOLT mapping shown in the PDF.
- The adapter registration does not contain `xmlRoute`, source-connector configuration, retry configuration, authentication, timeout values, or schema/version metadata.

The template-definition sample establishes that:

- A reusable template is a separate JSON document with `id`, `name`, `type`, `inputParameters`, `defaultParameters`, and `xmlRoute`.
- Template `inputParameters` describe the contract using `name`, `helpText`, and string-valued `isMandatory` rather than carrying runtime values.
- The adapter registration refers to the template by the shared `id` and `type`, then supplies parameter values.
- `xmlRoute` decodes to complete Camel Spring XML rather than a single `<route>` fragment.
- The XML includes exception policies, responder routes, TLS configuration, route logic, imported configuration, and Spring bean declarations.
- `process.routeId` is declared and supplied, but the decoded XML uses a fixed route/from URI; whether the parameter is used by orchestration outside this XML remains unresolved.
- The XML contains an embedded keystore path and literal keystore credentials. That is a critical secret-management defect in the sample and must not be reproduced by the UI.

The supplied EventToApi event sample establishes this JSON input shape:

- Envelope: `eventId`, `dateTime`, `correlationId`, `priority`, `status`, and `eventType`
- Business data nested under `payload`

The product requirement additionally establishes:

- EventToApi supports JSON payloads transformed with JOLT.
- EventToApi supports XML payloads transformed with XSLT.
- Debulking supports both JSON and XML inputs, using the corresponding transformation mechanism.

Only the EventToApi JSON/JOLT combination and Debulking XML/XSLT combination are demonstrated by the current samples. EventToApi XML/XSLT and Debulking JSON/JOLT require golden samples before their generators can be considered validated.

The observed relationship is therefore:

```text
Template definition
  id + type + parameter declarations + encoded Camel XML
                  │
                  │ matched by id and type
                  ▼
Adapter registration
  adapter metadata + embedded template instance + parameter values
```

The remaining unknown is how template definitions are stored, retrieved, versioned, and matched when multiple definitions share an ID across environments or releases.

### 4.1 Debulking evidence used for contract comparison

The Debulking samples are outside the first-release product scope, but they reveal weaknesses in the shared configuration contract:

- Debulking uses separate `PREPROCESS`, `PROCESS`, and `POSTPROCESS` template definitions, while the registration embeds three corresponding template instances.
- The two preprocess template files are byte-for-byte duplicates.
- Mandatory fields are expressed as strings such as `"true"`, not JSON booleans.
- Declared and supplied parameters drift. For example, the preprocess template declares `recordCount`, while its registration supplies `expectedRecordCount` and `data.split.size`.
- Decoded XML references parameters not declared by its template definition. This means the current template metadata cannot be trusted as a complete schema.

The UI must validate against XML usage and authoritative Java behavior, not only the template's `inputParameters` list.

---

## 5. Assumptions Requiring Verification

These are working assumptions, not settled requirements:

1. Adapter registration and template definitions are separate persisted documents; the exact persistence APIs remain unknown.
2. A template definition and embedded template instance are matched by `id` and `type`; the lookup, versioning, and uniqueness rules remain unknown.
3. `inputParameters` are injected into Camel Exchange properties or headers.
4. `defaultParameters` are used when an input value is absent, but precedence rules are not documented.
5. `xmlRoute` contains Base64-encoded complete Camel Spring XML; this is confirmed for the supplied definitions, but runtime size and structure limits remain unknown.
6. JSON uses a Base64-encoded JOLT specification and XML uses a Base64-encoded XSLT specification. The exact EventToApi XML parameter name and Camel template are not yet evidenced.
7. The Java service owns execution semantics; generated artifacts must conform to its exact supported Camel and Spring versions.
8. Kafka/JMS consumer configuration may live outside the PROCESS template shown in the reference PDF.

No implementation should begin until the existing Java service confirms these assumptions and supplies representative production configurations.

---

## 6. Primary Users

### Integration engineer

Creates and changes EventToApi configurations. Understands endpoints, payloads, mappings, retries, and environment-specific settings but should not need to hand-author Camel XML.

### Reviewer or architect

Loads an existing configuration and verifies what it will do. Needs decoded values, warnings, source-to-target mapping, and a trustworthy diff.

### Platform administrator

Defines permitted endpoint hosts, authentication references, supported route capabilities, schema versions, and export restrictions. Administration UI is outside the first release; these policies are consumed by it.

---

## 7. Design Principles

1. **Intent first:** Users configure integration intent; the system generates implementation syntax.
2. **Generated output remains visible:** JSON, transformation specification, and XML are never hidden behind forms.
3. **Lossless round trip:** Unknown content is preserved and disclosed rather than silently dropped.
4. **Review before mutation:** Imported configurations open read-only. Editing requires an explicit action.
5. **No false validity:** JSON/XML syntax validity is not presented as proof that a route will execute.
6. **Secrets stay external:** The UI stores only approved secret or credential references.
7. **Environment separation:** Environment-specific values are parameters, not copied into route logic where avoidable.
8. **Deterministic generation:** The same canonical model and generator version produce stable output.

---

## 8. Information Architecture

The product has three top-level modes.

### 8.1 Create Template

Creates a reusable EventToApi template definition:

1. Template identity
2. Parameter contract
3. Camel XML preset and decoded review
4. Validate and export template JSON

### 8.2 Create Registration

Creates an adapter registration using an existing or newly created template:

1. Adapter details
2. Template selection
3. Parameter values
4. Event-payload/JOLT test
5. Validate and export registration JSON

### 8.3 Review Existing

The review workflow contains:

1. Import and file association
2. Configuration summary
3. Source configuration
4. Transformation review
5. Target API review
6. Resilience review
7. Decoded artifacts
8. Validation findings
9. Semantic diff, when comparing revisions

---

## 9. Authoring Workflows

### 9.1 Create Template

The initial release generates a template from an approved, versioned EventToApi Camel XML preset. It does not offer arbitrary route-node editing.

Template fields:

| Field | Requirement |
|---|---|
| Template ID | Required; sample value `direct:eventtoapi.json.process` |
| Name | Required |
| Type | Fixed to `PROCESS` |
| Input parameter declarations | Starts with the five parameters evidenced by the supplied template |
| Default parameters | Preserved and reviewable; precedence remains unresolved |
| Camel XML | Generated from an approved preset, Base64-encoded for export, decoded for review |

The baseline parameter contract is:

- `process.routeId`
- `httpRequestType`
- `https.config`
- `httpEndPoint`
- `data.transform.spec`

Changing the Camel exception policy, responder routes, TLS material, bean declarations, imported Spring resources, or arbitrary processors is outside managed editing. Imported variations are displayed as recognized read-only or unknown content.

### 9.2 Create Registration

#### Adapter details

Fields:

| Field | Requirement |
|---|---|
| Adapter type | Fixed to `EVENTTOAPI` |
| Name | Required; length and character rules come from the Java contract |
| Adapter identifier | Required if distinct from name |
| Status | `START` or `STOP`; default should be `STOP` for safe export |
| Description | Optional, if supported by the schema |
| Template ID | Selected from or matched to a template definition |
| Template type | Fixed to `PROCESS` for the initial pattern |
| Route ID | Required; normally matches or maps deterministically to the template ID |
| Configuration version | Required if supported by persistence/runtime APIs |

Decisions and validation:

- Do not default new configurations to active execution unless product owners explicitly require it.
- Detect duplicate template or route identifiers.
- Show any mismatch between template ID, route ID, and `process.routeId`.

#### Template parameter values

The registration form is generated from the selected template's parameter declarations. The five evidenced fields receive concrete values. The UI must also detect registration values that are undeclared by the template and declarations unused by the XML.

#### Payload format and transformation

Supported payload choices:

- JSON, which automatically selects JOLT
- XML, which automatically selects XSLT

Capabilities:

- Event payload editor with format-specific JSON or XML syntax validation
- Transformation specification editor
- Structured field-mapping view where feasible
- Transformation test using a user-supplied sample payload
- Output preview
- Error location and diagnostic message
- Automatic Base64 encoding during export
- Decoded source retained in the UI's working model

Payload format and transformation engine are not independent controls. Selecting JSON selects JOLT; selecting XML selects XSLT. The UI must reject JSON/XSLT and XML/JOLT combinations.

The supplied EventToApi route directly invokes `joltTransformer`, so it is the validated preset for JSON/JOLT. An EventToApi XML/XSLT template preset, parameter contract, and golden sample are required before XML can be generated safely. The UI must not claim that a syntactically valid transformation is business-correct.

#### Target API

Fields:

- HTTP method: `POST`, `GET`, `PUT`, or `DELETE`, constrained by runtime support
- HTTP endpoint string
- `https.config` string value, constrained to `"true"` or `"false"` for compatibility with the supplied route

Safety rules:

- Validate URI syntax.
- Reject embedded credentials.
- Enforce an approved scheme and host allow-list.
- Warn about literal environment-specific hostnames.
- Make the configured endpoint visible without exposing secrets.
- Do not invent structured headers, authentication, path/query, or timeout output fields until the runtime contract supports them.

#### Error and retry review

In the supplied EventToApi contract these rules are encoded in `xmlRoute`, not represented by editable template or registration parameters. The UI therefore decodes and summarizes them but does not pretend they are safely configurable.

Observed sample behavior:

| Failure | Retry | Result status |
|---|---:|---|
| HTTP 4xx | 0 | `NON_RETRIABLE_FAILURE` |
| HTTP 5xx | 1 | `RETRIABLE_FAILURE` |
| I/O/connectivity | 0 in XML | `SYSTEM_FAILURE` |
| Transformation/schema | 0 | `NON_RETRIABLE_FAILURE` |

The XML comment claims that Kafka offset is held, but the XML only handles the exception and sets properties/headers. The UI must report the offset behavior as **unverified**, not as established behavior.

### 9.3 Validate and export

The screen presents:

- Validation summary grouped by errors, warnings, and informational findings
- Generated adapter registration JSON and template JSON as separate outputs
- Decoded Camel Spring XML
- Decoded JOLT or XSLT specification, according to payload format
- Resolved parameter table
- Generator/schema version
- Separate export controls with explicit artifact labels

Export is blocked by errors. Warnings require acknowledgement if policy permits export.

---

## 10. Review Existing Workflow

### 10.1 Import

Required inputs:

- Adapter registration JSON
- Associated template JSON

Optional inputs, depending on storage format:

- Separate Camel XML
- Separate transformation specification
- Environment parameter/override document

Import behavior:

1. Parse JSON without modifying it.
2. Identify adapter type and schema/version.
3. Resolve template references.
4. Decode `xmlRoute` and encoded transformation fields.
5. Parse XML with external entity resolution disabled.
6. Compare route IDs and parameter references.
7. Classify every field and XML construct as managed, recognized read-only, or unknown.
8. Present findings before offering edit mode.

### 10.2 Review summary

The summary must answer:

- What starts this route?
- What transformation is applied?
- Which endpoint is called and with what method?
- Which dynamic values affect the endpoint?
- What happens for each failure class?
- What output status is produced?
- Which parts cannot be safely interpreted by the UI?

### 10.3 Required Phase 1 views

After loading and matching an adapter registration and template definition, the UI converts the encoded/raw documents into two separate read-only presentation models. This conversion is in memory only; it does not rewrite the imported files.

#### A. XML Template View

Purpose: explain what the reusable Camel template does independently of a particular adapter registration.

The default view is a structured route outline, not a wall of XML:

```text
Template: direct:eventtoapi.json.process (PROCESS)
├── Imported Spring resources
├── TLS context
├── Exception policies
│   ├── HTTP 5xx -> retry -> RETRIABLE_FAILURE
│   ├── HTTP 4xx -> NON_RETRIABLE_FAILURE
│   ├── I/O -> SYSTEM_FAILURE
│   └── General errors -> API error responder
├── Supporting responder routes
├── Main PROCESS route
│   ├── direct input endpoint
│   ├── JOLT or XSLT transformation
│   ├── HTTP method setup
│   ├── endpoint construction
│   └── dynamic HTTP invocation
└── Referenced Spring beans
```

Required panels:

- **Overview:** Template ID, name, type, detected payload format, transformation engine, route count, and validation state.
- **Route flow:** Ordered route steps with choices, processors, beans, endpoints, and dynamic expressions.
- **Error handling:** Exception types, conditions, retry settings, handled state, responder routes, and result-status assignments.
- **Dependencies:** Imports, beans, Camel components, namespaces, TLS configuration, and external resource paths.
- **Parameter usage:** Every Exchange property/header referenced by the XML and where it is used.
- **Security findings:** Inline credentials, dynamic endpoint risks, prohibited components, and external resources.
- **Raw XML:** Decoded, syntax-highlighted, searchable source for expert verification.

Selecting a structured item highlights the corresponding XML element. Unsupported elements remain visible as **Unmanaged**; the UI must not omit them from the route outline.

#### B. Adapter Configuration View

Purpose: explain how a specific adapter instance configures the selected template.

Required panels:

- **Adapter summary:** Type, name, status, top-level parameters, template count, and validation state.
- **Template association:** Registration template ID/type, matched template definition, and missing/ambiguous-match errors.
- **Effective configuration:** Meaningful labels, decoded values, source, and validation result for each parameter.
- **Transformation:** Payload format, derived JOLT/XSLT engine, decoded specification, and optional sample-input/result preview.
- **Target API:** HTTP method, endpoint, HTTPS flag, and any endpoint construction behavior found in XML.
- **Operational behavior:** Effective exception/result statuses inherited from the template, clearly labelled as template behavior rather than adapter-entered configuration.
- **Unresolved configuration:** Undeclared supplied values, mandatory missing values, unused declarations, XML references without declarations, and unknown fields.
- **Raw JSON:** Original registration JSON for expert verification.

The effective configuration table should use this structure:

| Meaning | Parameter | Declared | Supplied value | Default | Effective value | Used by XML | Status |
|---|---|---:|---|---|---|---:|---|
| HTTP method | `httpRequestType` | Yes | `POST` | - | `POST` | Yes | Valid |
| HTTPS enabled | `https.config` | Yes | `false` | - | `false` | Yes | Valid |
| Target endpoint | `httpEndPoint` | Yes | Displayed URL | - | Displayed URL | Yes | Policy check |
| Transformation | `data.transform.spec` or XML equivalent | Yes | Decoded separately | - | JOLT/XSLT | Yes | Validated |

Long encoded values are never used as the primary display. The decoded value appears first, with Base64 available only under raw/details.

#### C. Relationship view

A compact relationship view joins both presentations:

```text
Adapter registration
  template id/type + supplied values
               │
               │ resolves to
               ▼
Template definition
  parameter contract + Camel XML behavior
               │
               ▼
Effective adapter behavior
  transformation + HTTP call + error outcomes
```

This is not a third raw-document screen. It exists to explain which behavior comes from the adapter and which comes from the template.

#### D. Static validation view

Phase 1 validates document format and Camel Spring XML DSL structure without starting or constructing a Camel runtime.

Validation groups:

1. **JSON format**
   - Valid JSON syntax and supported character encoding
   - Expected top-level object shape
   - Required fields and field types
   - Valid enum-like values such as adapter/template type and status
   - Duplicate template IDs and duplicate parameter names

2. **Base64 and embedded-content format**
   - Strict Base64 decoding
   - Decoded content is non-empty and within size limits
   - `xmlRoute` decodes as XML
   - JSON payload/JOLT content parses as JSON
   - XML payload/XSLT content parses as XML
   - Payload format and transformation pairing is JSON/JOLT or XML/XSLT

3. **XML format**
   - Well-formed XML
   - Correct Spring Beans and Camel namespaces
   - Expected root element
   - Namespace declarations and schema-location format
   - No prohibited DTD, external entity, or remote-resource resolution

4. **Camel DSL syntax and structure**
   - Elements, attributes, and parent/child placement are valid for the selected supported Camel Spring XML DSL version
   - Required attributes such as route IDs and endpoint URIs are present
   - Route IDs and `from` endpoint identities are unique where required
   - `choice`, `when`, `otherwise`, `onException`, `redeliveryPolicy`, `setHeader`, `setProperty`, `to`, `toD`, `process`, `bean`, and related elements have valid structure
   - Simple-language expressions are non-empty, correctly XML-escaped, and pass available static parsing
   - Static URI syntax is valid; dynamic URI placeholders are structurally balanced
   - Referenced direct endpoints, route IDs, bean IDs, processors, properties, and headers are inventoried and cross-checked where statically possible
   - Unsupported DSL elements are reported rather than silently accepted

5. **Cross-artifact format and contract**
   - Template definition matches registration instance by `id` and `type`
   - Declared mandatory inputs are supplied or defaulted
   - Supplied parameters are declared
   - XML-referenced Exchange values are declared or explicitly classified as framework-provided
   - Transformation parameter name and content agree with the selected payload format

Validation results use four states:

- **Valid:** Passed the applicable static check.
- **Invalid:** Definite syntax, format, or structural failure.
- **Warning:** Valid syntax but suspicious, unsafe, inconsistent, or unsupported content.
- **Not verified:** Requires runtime classes, beans, components, endpoint resolution, or execution.

The view must display the DSL/schema version used for validation. If the Camel version is unknown, version-dependent checks are reported as **Not verified**, not passed.

### 10.4 Edit mode

Editing is outside Phase 1. In a later phase, editing an imported configuration requires an explicit **Create editable revision** action. The original remains immutable in the client session and is used as the diff base.

Before export, display a semantic diff such as:

- HTTP method: `POST` → `PUT`
- Endpoint profile: `payment-core-v1` → `payment-core-v2`
- Retry count: `1` → `3`
- Transformation mapping: `amount` target changed
- Unknown Camel XML: preserved unchanged

Text-only Base64 differences must not be the primary review representation.

---

## 11. Canonical UI Data Model

The frontend should use a canonical domain model rather than binding forms directly to source JSON or XML.

```text
EventToApiDefinition
├── sourceDocuments
│   ├── adapterRegistrationRaw
│   ├── templateRaw
│   └── originalEncodings
├── adapter
│   ├── identity
│   ├── lifecycle
│   └── templateReferences
├── testEvent
│   ├── envelope
│   ├── payload
│   └── provenance (test-only, never exported unless contract adds it)
├── transformation
│   ├── payloadFormat (JSON | XML)
│   ├── engine (derived: JOLT | XSLT)
│   ├── decodedSpecification
│   └── sampleInput
├── target
│   ├── method
│   ├── endpoint
│   └── httpsConfig
├── routeReview
│   ├── exceptionRules
│   ├── retryPolicy
│   ├── responderRoutes
│   ├── tlsMaterialFindings
│   └── resultStatusMappings
├── unmanagedContent
│   ├── adapterFields
│   ├── templateFields
│   └── camelXmlFragments
└── metadata
    ├── inputSchemaVersion
    ├── generatorVersion
    └── warningsAcknowledged
```

Each value should retain provenance:

- Source document and path
- Original raw value
- Decoded value
- Effective value after default/override resolution
- Whether it was user-edited
- Whether the generator manages it

---

## 12. Lossless Import and Export

This is the highest-risk part of the design.

### 12.1 Content classification

Every imported field or XML node is classified as:

- **Managed:** Fully represented and safely editable in the UI.
- **Recognized read-only:** Understood enough to explain but not regenerate safely.
- **Unknown:** Preserved exactly; no behavioral interpretation claimed.

### 12.2 Export rules

- New configurations are generated from the canonical model.
- Imported configurations are patched structurally rather than regenerated wholesale when unknown content exists.
- Unknown JSON fields retain their values and relative object ownership.
- Unknown XML nodes, namespaces, attributes, and ordering are preserved wherever the XML library permits.
- If a managed edit would invalidate or relocate unknown XML, export is blocked pending manual resolution.
- Encoding and whitespace changes are separated from semantic changes in the diff.
- The UI never reports “unchanged” solely because decoded values match; raw and semantic comparisons are both retained.

### 12.3 Advanced source editing

Free-form source editing should not be part of the first release. If it is later introduced, it must operate as an expert mode with reparsing, model reconciliation, and explicit conflict handling.

---

## 13. Validation Model

Validation runs in layers.

### Layer 1: Document syntax

- Valid JSON
- Valid Base64
- Well-formed XML
- Valid JOLT JSON for JSON payloads or XSLT XML for XML payloads
- Valid payload/transform pairing: JSON/JOLT or XML/XSLT

### Layer 2: Schema

- Adapter registration JSON Schema
- Template JSON Schema
- Version-matched, locally controlled Camel Spring XML schema or an explicitly versioned supported-DSL ruleset

### Layer 3: Cross-document references

- Adapter template reference resolves
- Template ID, route ID, and `process.routeId` are consistent
- Every required parameter exists
- Parameter names used in XML resolve to declared parameters
- Default and input parameter conflicts follow defined precedence

### Layer 4: Semantic behavior

- A test event, when supplied, is valid for its selected JSON/XML format and can be processed by the corresponding JOLT/XSLT test harness
- HTTP endpoint can be constructed
- HTTP method is supported
- Transformation input/output types are compatible
- Exception rules are ordered correctly
- XML comments and executable exception behavior are distinguished; offset behavior remains unverified until runtime evidence exists

### Layer 5: Security and policy

- Endpoint scheme and host are allowed
- No inline secrets or credentials
- Dynamic URI expressions are constrained
- XML parsing prevents XXE and external resource loading
- Bean and processor references are allow-listed
- Imported XML does not contain prohibited components or scripting languages

### Layer 6: Runtime validation - excluded from Phase 1

This layer is not executed or presented as completed in Phase 1. A later phase may use the Java service to:

- Load configuration without starting consumers
- Resolve Camel components and bean references
- Build the route in an isolated validation context
- Return structured diagnostics

Phase 1 must not instantiate `CamelContext`, load Spring application contexts, resolve runtime beans/components, connect to endpoints, start consumers, or execute routes. Static Camel DSL validation cannot prove that a route is executable against the deployed AdapterMS runtime.

---

## 14. Generated Camel XML Strategy

Do not concatenate XML strings in the browser.

Use a versioned generator with:

- A supported EventToApi route model
- Approved XML templates or an XML object builder
- Deterministic ordering
- Proper XML escaping, including logical expressions
- Version-specific Camel namespaces and exception classes
- A strict allow-list of beans and components
- Unit tests against representative runtime configurations

The generator must expose its version in exported metadata or an accompanying manifest. Without this, regenerated configurations cannot be traced to the logic that produced them.

---

## 15. Suggested Component Boundaries

This section describes responsibilities, not a mandatory technology stack.

### UI application

- Forms and workflow state
- Read-only review presentation
- Decoded previews
- Local validation feedback
- Semantic diff presentation

### Configuration API

- Authoritative schema validation
- Canonical-model validation
- Import parsing and normalization
- Camel XML generation
- Lossless patching for imported documents
- Base64 encoding/decoding
- Policy enforcement
- Export packaging

### Optional AdapterMS validation bridge

- Uses the same Camel/Spring versions and beans as the runtime
- Performs isolated build-time validation
- Never starts event consumers or invokes target endpoints

Keeping XML generation solely in frontend code would create two competing implementations of the runtime contract and make version control unreliable.

---

## 16. Security Requirements

- Never store API keys, passwords, tokens, private keys, or truststore passwords in generated configuration.
- Accept only named credential references supported by the platform.
- Treat imported JSON, XML, JOLT, and XSLT as untrusted input.
- Disable XML external entities, DTD resolution, remote schema fetching, and XSLT external resource access.
- Allow-list Camel components, bean identifiers, expression languages, URI schemes, and target hosts.
- Apply document size, nesting-depth, field-count, and decoded-payload limits.
- Redact sensitive parameter values from logs, previews, diagnostics, and diffs.
- Record generator version and validation results for auditability.
- Keep review/import read-only until the user explicitly creates a revision.
- Do not permit the UI to activate or deploy a route in the first release.

---

## 17. UX States and Error Handling

Every screen must handle:

- Empty state
- Loading state
- Valid configuration
- Field validation error
- Cross-document conflict
- Unsupported construct warning
- Decode failure
- Schema-version mismatch
- Import association failure
- Generator failure
- Export blocked
- Unsaved changes

Diagnostics must identify:

- Artifact
- JSON path or XML location where available
- Severity
- Explanation
- Effect on export or execution
- Corrective action

Avoid generic messages such as “Invalid configuration.”

---

## 18. Review Deliverables

The design review should evaluate and approve:

1. Scope and explicit exclusions
2. Create and review workflows
3. Adapter/template document boundary
4. Canonical UI data model
5. Lossless round-trip rules
6. Validation layers
7. Security restrictions
8. Generator ownership and versioning
9. Implementation phases
10. Open decisions and evidence required from the Java service

---

## 19. Implementation Plan

### Phase 0: Contract discovery

**Objective:** Replace PDF assumptions with evidence from the Java service.

Activities:

- Identify persistence/API models for adapter registration and templates.
- Collect anonymized EventToApi configurations covering simple and complex routes.
- Identify supported Camel, Spring, JOLT, and XSLT versions.
- Obtain EventToApi golden templates for both JSON/JOLT and XML/XSLT.
- Record Debulking JSON/JOLT and XML/XSLT as a future pattern capability, not part of the EventToApi MVP implementation.
- Trace parameter injection and default precedence.
- Trace route loading, startup, shutdown, and status behavior.
- Confirm Kafka/JMS consumer ownership and offset behavior.
- Inventory permitted Camel components, beans, and expression languages.
- Document exact error classification behavior.

Deliverables:

- Versioned adapter and template schemas
- Parameter dictionary
- Supported EventToApi capability matrix
- Representative golden configurations
- Confirmed import/export artifact boundaries

Acceptance gate:

- A developer can explain how a real EventToApi registration becomes a running Camel route without relying on undocumented assumptions.

### Phase 1: Load and review existing configurations

**Objective:** Deliver a read-only UI that loads existing template definitions and adapter registrations and explains their effective behavior.

Phase 1 supports only existing artifacts. It does not create, edit, generate, save, or export configurations.

Activities:

- Load a template-definition JSON file.
- Load an adapter-registration JSON file.
- Match template definitions to embedded registration instances by `id` and `type`.
- Report missing, duplicate, or ambiguous matches.
- Parse both JSON structures without modifying them.
- Convert the loaded documents into separate in-memory XML Template and Adapter Configuration presentation models.
- Validate JSON, Base64, XML, JOLT, and XSLT formats.
- Validate Camel Spring XML DSL syntax and structural rules against an explicitly selected local schema/ruleset version.
- Base64-decode and display Camel Spring XML.
- Detect the payload/transformation format from the configuration where possible.
- Decode and display JOLT for JSON or XSLT for XML.
- Display template parameter declarations with help text and mandatory status.
- Display registration-supplied and default parameter values.
- Compare declared, supplied, defaulted, and Camel-XML-referenced parameters.
- Summarize routes, direct endpoints, target HTTP configuration, exception rules, retry behavior, result statuses, responder routes, beans, imports, and shutdown behavior.
- Identify inline credentials, unsafe endpoints, malformed encodings, unsupported elements, and unverified behavior.
- Produce validation errors and warnings without changing the source files.
- Clearly separate static validation results from behavior that is not verified without a runtime.
- Provide a relationship view showing how adapter values configure template behavior.
- Produce wireframes and field-to-artifact mapping only for this review workflow.

Deliverables:

- Read-only import and review UI
- Separate XML Template View and Adapter Configuration View
- Adapter-to-template relationship view
- Secure JSON, Base64, XML, JOLT, and XSLT parsers
- Template-to-registration matching logic
- Effective parameter comparison
- Camel-route summary
- Validation findings panel
- Camel DSL syntax and artifact-format validation report
- Approved review-mode wireframes
- Field-to-artifact mapping
- Validation-message catalogue
- Golden tests using the supplied samples

Explicit exclusions:

- Create Template
- Create Adapter Registration
- Editing imported values
- Generating or regenerating Camel XML
- Exporting modified JSON
- Draft persistence
- Semantic revision diff
- Deployment, activation, start, stop, or runtime invocation
- Camel context creation, Spring bean resolution, component loading, endpoint connectivity checks, or route execution
- Debulking-specific authoring screens

Acceptance gate:

- A reviewer can load a matching EventToApi template and registration and accurately identify the route ID, declared and effective inputs, transformation, target HTTP call, error behavior, security findings, and unsupported constructs without examining Base64 manually.
- The UI performs no writes and preserves the imported files unchanged.
- The supplied EventToApi sample is covered by automated golden tests.
- No Phase 1 status or message claims that static validation proves runtime executability.

### Phase 2: Create and edit UI

**Objective:** Author supported EventToApi configurations.

Activities:

- Separate template and registration authoring workflows
- Format-specific JOLT and XSLT transformation testing
- Target endpoint construction preview
- Error-policy configuration
- Generated artifact previews
- Draft persistence and export

Acceptance gate:

- An integration engineer can reproduce each approved golden configuration without manually editing JSON or XML.

### Phase 3: Runtime-assisted validation

**Objective:** Check compatibility against the actual AdapterMS runtime without executing integrations.

Activities:

- Isolated route-build validation
- Bean/component resolution
- Version compatibility checks
- Structured diagnostic responses

Acceptance gate:

- Every exported configuration passes both static validation and isolated validation using the target runtime version.

### Phase 4: Pilot and hardening

**Objective:** Validate operational suitability before expansion.

Activities:

- Pilot with a small set of EventToApi integrations
- Measure validation failures and unsupported constructs
- Perform security testing
- Document recovery and support procedures
- Decide whether the supported route model should expand

Acceptance gate:

- Pilot users can create and review supported routes without manual artifact repair, silent data loss, or production activation from the UI.

---

## 20. Test Strategy

### Unit tests

- Encoding and decoding
- JSON/XML parsing
- Field validation
- Parameter precedence
- Endpoint construction
- Exception rule generation
- Deterministic output

### Golden-file tests

- New route generation matches approved artifacts.
- JSON always generates/requires JOLT; XML always generates/requires XSLT.
- Import and export preserve supported configurations.
- Unknown JSON/XML content remains intact.
- XML escaping is valid.
- Semantic diff ignores formatting-only changes.

### Integration tests

- Generated documents are accepted by the Java validation layer.
- Camel context builds without starting consumers.
- Required beans and components resolve.
- Unsupported runtime versions fail clearly.

### Security tests

- XXE and external resource attempts
- Dangerous XSLT features
- Prohibited Camel components and scripts
- Endpoint allow-list bypass attempts
- Oversized and deeply nested documents
- Secret leakage through logs and diffs

### UI tests

- Step validation and navigation
- Import failure recovery
- Read-only/edit-mode boundary
- Unsupported-content warnings
- Accessible keyboard navigation and error announcements
- Unsaved-change protection

---

## 21. First-Release Acceptance Criteria

The first release is acceptable only when:

1. It supports the agreed EventToApi capability subset and rejects everything else explicitly.
2. It generates adapter registration and template documents accepted by the target Java service version.
3. It displays decoded Camel XML and transformation specifications before export.
4. It never stores literal credentials or secrets.
5. It detects broken template and route references.
6. It validates XML safely and correctly escapes generated expressions.
7. Imported documents open read-only.
8. Unknown fields and Camel constructs cannot disappear silently.
9. A semantic diff is shown before exporting edits to an imported configuration.
10. Exports are deterministic and identify the schema and generator versions.
11. Static and runtime-assisted validation results are distinguishable.
12. The UI does not deploy, start, stop, or invoke the configured integration.

---

## 22. Open Decisions

| ID | Decision needed | Why it matters | Owner |
|---|---|---|---|
| D-01 | Exact adapter and template schemas | Defines all screens and export shape | AdapterMS team |
| D-02 | How registrations reference templates | Required for import association and export | AdapterMS team |
| D-03 | Location of Kafka/JMS consumer configuration | PDF example does not contain the source consumer | AdapterMS team |
| D-04 | Input versus default parameter precedence | Required for effective-value review | AdapterMS team |
| D-05 | Supported Camel/Spring versions | Determines XML namespaces and DSL syntax | Platform team |
| D-06 | Supported beans/components and expression languages | Defines safe generator boundary | Platform/security |
| D-07 | Environment override strategy | Prevents endpoint duplication across environments | Architecture |
| D-08 | Whether editing imported unknown content is allowed | Determines lossless patching behavior | Product/architecture |
| D-09 | Runtime validation API availability | Determines strength of pre-export validation | AdapterMS team |
| D-10 | Draft storage and access control | Affects backend and audit design | Product/security |
| D-11 | Required configuration approval process | Affects future workflow but may remain out of MVP | Product/operations |
| D-12 | Output packaging and filenames | Required for downstream operational use | Operations |
| D-13 | Template lookup and version selection rules | Registration carries ID/type but no explicit template version | AdapterMS team |

---

## 23. Review Checklist

Reviewers should answer:

- Is EventToApi sufficiently constrained for the first release?
- Which source connectors are actually supported?
- Is the observed template-definition versus embedded template-instance boundary correct for every registration API version?
- Which fields are mandatory in production but absent from the PDF?
- Can the Java service offer schema and dry-run validation APIs?
- Is preserving unknown XML acceptable, or must such imports be review-only?
- Which target hosts, Camel components, beans, and expressions are permitted?
- Should every new export default to `STOP`?
- What evidence is required before configuration is approved for deployment?
- Which phase can be considered the first usable release: read-only review or route creation?
- How does the runtime select the correct template definition when a registration contains only template ID and type?

---

## 24. Recommended Review Outcome

Approve the direction conditionally, with Phase 0 as the immediate next step.

Do not approve implementation against the PDF alone. The PDF describes the architectural idea but does not provide enough contract detail for reliable generation, round-trip editing, or runtime compatibility. The existing Java service and real configuration samples must become the source of truth before the UI data model and generator are frozen.

---

## 25. Local LLM Development Guidelines

This section is the implementation brief to give to a local coding LLM. It is intentionally explicit because the repository currently contains requirements and samples, not an established application architecture.

### 25.1 Assignment

Implement **Phase 1 only**: a local, read-only application that loads an existing AdapterMS template-definition JSON and adapter-registration JSON, converts them into separate human-readable views, and performs static format and Camel DSL validation.

The implementation must use the supplied files as initial test fixtures and must not modify them.

### 25.2 Non-negotiable scope boundary

The application must:

- Load local template-definition and adapter-registration JSON files.
- Parse, match, decode, inspect, and display them.
- Present a separate XML Template View and Adapter Configuration View.
- Perform static validation only.
- Work without connecting to AdapterMS, Camel runtime, Kafka, JMS, or target APIs.

The application must not:

- Create or edit template definitions.
- Create or edit adapter registrations.
- Regenerate or export JSON, XML, JOLT, or XSLT.
- Write changes back to imported files.
- Instantiate Camel or Spring.
- Load runtime beans or Camel components.
- Contact configured HTTP endpoints.
- Start routes, consumers, schedules, or jobs.
- Claim that static validity proves runtime executability.
- Add Debulking authoring merely because Debulking samples are present.

If a requested implementation detail conflicts with this boundary, stop and document the conflict instead of silently expanding the product.

### 25.3 Evidence hierarchy

When sources disagree, use this order:

1. Explicit decisions recorded in this document
2. Supplied JSON/XML samples for their demonstrated structures
3. Java service DTOs, schemas, or source code when later provided
4. Architecture PDF
5. Developer inference

Inference must never be presented as a confirmed AdapterMS rule. Mark it `Not verified` and explain what evidence is missing.

### 25.4 Required development sequence

The local LLM must work in small reviewable increments:

1. Inspect the repository and all supplied fixtures.
2. Record the proposed technology stack and file changes before implementation.
3. Define typed internal models for template definitions, registrations, parameters, decoded artifacts, findings, and presentation models.
4. Implement parsing and safe decoding independently of the UI.
5. Implement static validation independently of rendering.
6. Add unit and golden-fixture tests for parsing and validation.
7. Implement file loading and template/registration matching.
8. Implement the XML Template View.
9. Implement the Adapter Configuration View.
10. Implement the relationship and validation views.
11. Add accessibility, responsive layout, and failure-state handling.
12. Run the complete automated test suite and perform a manual fixture walkthrough.
13. Update project documentation with setup, run, test, and known-limit instructions.

Do not begin with visual polish while parsing, matching, and validation behavior remain untested.

### 25.5 Technology selection rules

No frontend or backend framework is mandated yet. The local LLM must:

- Inspect existing repository conventions before introducing a framework.
- Prefer the smallest maintainable stack that supports local file loading, structured views, syntax highlighting, tests, and static validation.
- Avoid adding a server when browser-local processing is sufficient.
- Avoid sending loaded configuration to any remote API, analytics service, CDN-hosted processor, or LLM.
- Pin dependency versions and commit the appropriate lockfile.
- Explain why each major dependency is required.
- Prefer libraries with active maintenance and licenses acceptable to the project.
- Keep parsing, validation, presentation-model construction, and UI rendering in separate modules.

If Camel XSD resources are used, bundle an approved version locally. Do not fetch schemas from the network while processing a file.

### 25.6 Required internal models

At minimum, define separate models for:

```text
TemplateDefinition
  id
  name
  type
  inputParameterDeclarations
  defaultParameters
  xmlRouteBase64

AdapterRegistration
  type
  name
  status
  templateInstances
  parameters

TemplateInstance
  id
  type
  inputParameterValues
  defaultParameterValues

DecodedTemplate
  rawXml
  routes
  exceptionPolicies
  endpoints
  beans
  imports
  exchangeReferences
  securityFindings

EffectiveParameter
  name
  declaration
  suppliedValue
  defaultValue
  effectiveValue
  xmlUsages
  state

ValidationFinding
  id
  severity
  category
  artifact
  location
  message
  consequence
  suggestedAction
```

Do not bind UI components directly to untyped raw JSON objects.

### 25.7 Import and matching behavior

The import workflow must:

1. Accept exactly one template-definition JSON and one adapter-registration JSON for the initial release.
2. Retain original file names and raw content in memory for raw views.
3. Parse each independently so an error in one does not hide diagnostics from the other.
4. Identify which file is the template and which is the registration from structure, not filename.
5. Match the selected registration template instance to the definition using `id` and `type`.
6. Report no match, multiple instances, duplicate IDs, and type disagreement explicitly.
7. Avoid guessing a match based on name similarity.
8. Perform no filesystem write after loading.

If the registration contains multiple template instances, Phase 1 may list them but must require an unambiguous matching definition before showing combined effective behavior.

### 25.8 Safe decoding rules

- Enforce configurable maximum file and decoded-content sizes.
- Decode Base64 strictly; reject illegal characters and invalid padding.
- Never execute decoded content.
- Parse XML with DTDs, external entities, network access, and external schema resolution disabled.
- Do not execute XSLT during ordinary review.
- Do not invoke JOLT during ordinary review unless a later approved, local, sandboxed test feature is explicitly added.
- Show decoding failures with the artifact and JSON path.
- Preserve the original encoded value for the raw view, but collapse long Base64 values by default.
- Redact probable credentials from rendered raw views and diagnostics while clearly reporting that redaction occurred.

### 25.9 XML Template View requirements

The view must contain:

- Template ID, name, type, and match status
- Decoded XML validation status
- Ordered list of every Camel route
- Each route's ID, source endpoint, and ordered processors
- Nested representation for `choice`, `when`, `otherwise`, and exception policies
- HTTP/static and dynamic endpoints
- Redelivery settings
- Headers and properties set by the route
- `result.status` outcomes
- Direct responder-route relationships
- Spring imports and bean declarations
- TLS configuration with secret values redacted
- Exchange-property/header references found in expressions and URIs
- Unsupported or unknown elements shown as unmanaged nodes
- Syntax-highlighted raw decoded XML

The structured route view must derive from the parsed XML. Do not hard-code the sample route diagram.

### 25.10 Adapter Configuration View requirements

The view must contain:

- Adapter name, type, status, and template count
- Template instance ID/type and definition-match result
- Meaningful parameter labels derived from `helpText` with the raw name also visible
- Supplied, default, and effective values
- Mandatory/missing status
- Whether and where each parameter is referenced by Camel XML
- Detected payload format and derived transformation engine
- Decoded JOLT JSON or XSLT XML with validation result
- HTTP method, endpoint, and HTTPS flag where present
- Error behavior inherited from the template, visually distinguished from adapter-supplied values
- Undeclared supplied parameters
- Declared but unused parameters
- XML-referenced but undeclared parameters
- Unknown top-level and nested fields
- Original raw JSON

Never show a Base64 value as the meaningful configuration when decoded content is available.

### 25.11 Relationship View requirements

The relationship view must make provenance explicit:

```text
Adapter field or parameter value
  -> matching template declaration
  -> XML location where consumed
  -> resulting static route behavior
```

For each link, show one of:

- Matched
- Missing declaration
- Missing value
- Defaulted
- Declared but unused
- XML reference undeclared
- Ambiguous
- Not statically resolvable

Do not infer a behavioral link merely because two names look similar.

### 25.12 Static validation implementation

Implement validators as independent, testable functions. At minimum:

#### JSON validator

- Syntax and top-level object
- Required fields
- Field types
- Supported adapter and template types
- Status format
- Array/object shape
- Duplicate IDs and parameter names

#### Base64 and embedded-content validator

- Strict Base64 syntax
- Decoded size
- Expected decoded content type
- Non-empty content

#### XML validator

- Well-formedness
- Expected root and namespaces
- Prohibited DTD and external entities
- Duplicate XML IDs where applicable
- Local schema or supported-ruleset validation

#### Camel DSL static validator

- Supported elements and attributes
- Required attributes
- Allowed parent/child structure
- Route/source identity rules
- `choice`/`when`/`otherwise` structure
- `onException` and redelivery structure
- Required `uri`, `ref`, `name`, or expression bodies
- XML-escaped Simple expressions
- Balanced `${...}` placeholders
- Statically valid URI structure
- Direct-endpoint references where both ends are present
- Bean references where a declaration is present in the same XML
- Unsupported components and expression languages

#### Cross-artifact validator

- Template ID/type match
- Mandatory values supplied or defaulted
- Declared versus supplied parameters
- Declared versus XML-referenced parameters
- Valid format/transform pairing
- Adapter status and template count consistency

#### Security validator

- Literal passwords, tokens, keys, or credentials
- Credentials embedded in URLs
- Unsafe URI schemes
- Target hosts outside an optional configured allow-list
- Filesystem paths and external resources
- Dynamic `toD` endpoints
- Script or unsupported language execution

Every validator returns structured `ValidationFinding` objects. Validation logic must not be embedded inside UI components.

### 25.13 Validation language

Use these states consistently:

| State | Meaning |
|---|---|
| Valid | The specific static check passed |
| Invalid | A definite syntax, format, or structural error exists |
| Warning | Content is syntactically valid but suspicious, inconsistent, unsafe, or only partially supported |
| Not verified | The claim requires unavailable version information or runtime behavior |

Prohibited messages:

- “Route is executable”
- “Runtime valid”
- “Deployment ready”
- “Endpoint works”
- “Bean exists” when only a textual reference was found
- “Kafka offset will not commit” based only on an XML comment

Preferred message example:

> Camel XML is well-formed and passes the configured static DSL ruleset. Runtime bean, component, endpoint, and execution behavior were not verified.

### 25.14 UI and interaction guidelines

- Start with one import screen and one review workspace.
- Use persistent tabs or clearly labelled navigation for Template, Adapter Configuration, Relationship, Validation, and Raw views.
- Keep Template and Adapter views separate; do not merge them into one undifferentiated property table.
- Present decoded, meaningful values before raw encodings.
- Preserve raw field names beside friendly labels.
- Use expandable tree rows for nested Camel processors.
- Selecting a structured XML node should reveal or highlight its raw XML location where practical.
- Display errors beside the affected value and in the validation summary.
- Do not use green success styling for `Not verified` findings.
- Provide keyboard navigation, visible focus, semantic headings, labelled inputs, and screen-reader-readable validation summaries.
- Support desktop review first, while keeping core content usable on a narrow viewport.
- Do not add dashboards, metrics, deployment controls, or decorative charts.

### 25.15 Required failure states

Implement and test:

- Invalid JSON
- Wrong file type
- Template file supplied twice
- Registration file supplied twice
- Missing template or registration
- Invalid Base64
- Base64 decodes to the wrong content type
- Malformed XML
- Unsupported XML namespace
- Prohibited DTD/entity
- Template ID/type mismatch
- Duplicate parameters
- Missing mandatory parameter
- Undeclared supplied parameter
- XML reference without declaration
- Unknown Camel element
- Literal credential detected
- File or decoded content exceeds limit
- Unknown Camel DSL version

The application must remain usable after each error and allow replacement of either loaded file.

### 25.16 Test fixture rules

- Treat supplied samples as immutable fixtures.
- Copy fixture content into a dedicated test-fixture directory only if project structure requires it; do not alter the originals.
- Add derived negative fixtures for one failure at a time.
- Never include real credentials in new fixtures.
- Redact the literal keystore credential already present when producing snapshots, logs, screenshots, or documentation.
- Golden tests must compare structured results, not formatting-sensitive pretty-printed output alone.

### 25.17 Required automated tests

At minimum, include tests proving:

1. Supplied EventToApi template and registration load successfully.
2. Their `id` and `type` match.
3. `xmlRoute` decodes and parses as XML.
4. `data.transform.spec` decodes and parses as JOLT JSON.
5. The XML route tree is derived rather than hard-coded.
6. All declared and supplied EventToApi parameters appear in the effective-configuration table.
7. Missing and undeclared parameters are distinguished.
8. Invalid Base64 is rejected.
9. Malformed XML is rejected.
10. DTD/external-entity input is rejected.
11. Invalid Camel parent/child structure produces an `Invalid` finding.
12. Unknown DSL elements produce an explicit finding.
13. Literal credentials are detected and redacted.
14. No parser or validator contacts the network.
15. Loading files causes no write to the fixtures.
16. Runtime-only claims are classified `Not verified`.
17. JSON/JOLT and XML/XSLT pairings are enforced.
18. The duplicate Debulking preprocess fixtures can be identified as identical without adding Debulking authoring behavior.

### 25.18 Definition of done for each increment

An increment is complete only when:

- Its behavior is demonstrated through the UI.
- Unit tests cover its parser/validator logic.
- Failure behavior is tested.
- No existing tests regress.
- Linting and type checking pass.
- User-facing errors identify artifact and location.
- Documentation reflects the implemented behavior.
- Known limitations are recorded.

“Code added” or “screen renders” is not completion.

### 25.19 Local LLM working rules

The local coding LLM must:

- Inspect before editing.
- Preserve user files and unrelated changes.
- State assumptions before relying on them.
- Make small, reviewable changes.
- Run relevant tests after every meaningful change.
- Report exact commands run and their outcomes.
- Never weaken validation merely to make a fixture pass.
- Never hard-code outputs for the supplied sample.
- Never invent missing AdapterMS semantics.
- Stop and record a blocker when a decision would materially change the contract.
- Keep a short implementation decision log in the repository.

### 25.20 Phase 1 acceptance criteria

Phase 1 passes only if every criterion below is satisfied.

#### Import and preservation

- [ ] User can load one template-definition JSON and one adapter-registration JSON.
- [ ] File roles are detected structurally rather than by filename.
- [ ] The original files remain byte-for-byte unchanged.
- [ ] Either file can be replaced without restarting the application.
- [ ] Invalid or missing files produce actionable errors.

#### Matching and configuration meaning

- [ ] Template definition and registration instance are matched by exact `id` and `type`.
- [ ] Missing, duplicate, mismatched, and ambiguous associations are reported.
- [ ] Declared, supplied, default, effective, and XML-used parameter states are shown separately.
- [ ] Friendly help text never hides the original parameter name.
- [ ] Behavior inherited from XML is visually distinguished from adapter-supplied configuration.

#### XML Template View

- [ ] Base64 Camel XML is decoded and displayed.
- [ ] Every route and its ordered processors are represented from parsed XML.
- [ ] Choices and exception policies retain their nesting.
- [ ] Imports, beans, endpoints, properties, headers, and result statuses are listed.
- [ ] Unknown or unsupported XML nodes remain visible.
- [ ] Probable credentials are redacted in rendered views.
- [ ] Raw decoded XML is available for expert review.

#### Adapter Configuration View

- [ ] Adapter identity, type, status, and associated template are shown.
- [ ] HTTP method, endpoint, HTTPS setting, and transformation are shown when present.
- [ ] JOLT JSON or XSLT XML is decoded according to payload format.
- [ ] Base64 is secondary to the meaningful decoded representation.
- [ ] Missing mandatory, undeclared supplied, declared-unused, and XML-undeclared parameters are reported independently.
- [ ] Original registration JSON is available in a raw view.

#### Static format and Camel DSL validation

- [ ] JSON, Base64, XML, JOLT, and XSLT format checks are implemented.
- [ ] XML parsing blocks DTDs, external entities, and network resolution.
- [ ] Camel DSL structure is checked using a displayed, versioned local schema or ruleset.
- [ ] Required elements/attributes, nesting, identifiers, expressions, and URIs are checked.
- [ ] Cross-artifact and parameter consistency checks are implemented.
- [ ] Findings use only Valid, Invalid, Warning, and Not verified states.
- [ ] Unknown Camel version prevents a false Valid result for version-dependent checks.

#### No runtime validation

- [ ] No Camel or Spring context is instantiated.
- [ ] No runtime beans or components are loaded.
- [ ] No configured endpoint, Kafka broker, JMS service, or external schema is contacted.
- [ ] No route, consumer, job, or transformation is executed during ordinary review.
- [ ] The UI never claims runtime, deployment, or endpoint validity.

#### Quality and handoff

- [ ] Automated tests cover the supplied EventToApi fixtures and required negative cases.
- [ ] Linting, type checking, and tests pass from documented commands.
- [ ] The UI supports keyboard use and accessible validation messages.
- [ ] Setup, run, test, architecture, and known-limit documentation is complete.
- [ ] No secrets appear in logs, snapshots, screenshots, or generated documentation.
- [ ] A reviewer can understand the supplied EventToApi adapter without manually decoding Base64.

Any unchecked criterion means Phase 1 is not complete.

### 25.21 Required local LLM completion report

When implementation is finished, the local LLM must report:

1. Files created and changed
2. Architecture and dependency decisions
3. Implemented requirements mapped to acceptance criteria
4. Tests and static checks run, including exact results
5. Manual walkthrough performed with the supplied EventToApi fixtures
6. Known limitations and `Not verified` behaviors
7. Any deviations from this document and why
8. Confirmation that imported fixtures were not modified
9. Confirmation that no runtime validation or external connectivity occurred

The completion report must not call the work complete while any required acceptance criterion is failing or untested.
