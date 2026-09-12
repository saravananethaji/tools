# EventToApi UI Design Validation Report

**Result:** Conditionally valid; not implementation-ready  
**Validated document:** `EVENTTOAPI_UI_DESIGN_AND_IMPLEMENTATION_PLAN.md`  
**Validation basis:** AdapterMS architecture PDF and all supplied EventToApi and Debulking samples

## 1. Executive Verdict

The product direction is valid: separate template authoring, adapter registration authoring, and existing-configuration review are justified by the samples.

The earlier six-step route wizard was not fully valid. It exposed Kafka/JMS, authentication, timeouts, headers, and retry-policy editing without evidence that the current EventToApi registration/template contracts accept those values. The design has been corrected to a compatibility-first MVP. The user has confirmed that payload format controls transformation choice: JSON uses JOLT and XML uses XSLT.

Implementation remains blocked on the Java runtime contract. Static samples establish document shape, but they do not establish persistence APIs, template lookup/versioning, parameter precedence, consumer behavior, or successful runtime loading.

## 2. Evidence Reviewed

- `AdapterMS_Architecture_and_Specification_Guide.pdf`
- `eventToApi Registration/eventtoapitemplateconfigpayload.json`
- `eventToApi Registration/eventtoapiadapterconfigpayload.json`
- `eventToApi Registration/eventtoapieventpayload.json`
- `debulking/debulking.xml.preprocess.json`
- `debulking/debulking.xml.preprocess (1).json`
- `debulking/debulking.xml.api.process.json`
- `debulking/debulking.xml.api.postprocess.json`
- `debulking/paymentxmlupload.json`
- `debulking/payment.xml`

All supplied JSON documents parse successfully. Every supplied `xmlRoute` value is valid Base64 and decodes to well-formed XML. The duplicate Debulking preprocess template files are byte-for-byte identical.

## 3. Validated Contract

### Template definition

Confirmed fields:

- `id`
- `name`
- `type`
- `inputParameters`
- `defaultParameters`
- `xmlRoute`

An input-parameter declaration contains:

- `name`
- `helpText`
- `isMandatory`, represented as a string in the samples

### Adapter registration

Confirmed fields:

- `type`
- `name`
- `status`
- `templates`
- `parameters`

Each embedded template instance contains:

- `id`
- `type`
- `inputParameters` with `name` and concrete `value`
- `defaultParameters`

### Relationship

The EventToApi template definition and embedded registration instance share the same `id` and `type`. No explicit template version is present.

## 4. Finding Register

| ID | Severity | Finding | Design response |
|---|---|---|---|
| V-01 | Blocker | Template persistence, lookup, uniqueness, and version selection are not defined. | Keep as Phase 0 contract work; do not freeze import/export API. |
| V-02 | Blocker | Event source configuration is absent. The route begins at `direct:eventtoapi.json.process`. | Remove Kafka/JMS authoring from MVP; show event payload only as test input. |
| V-03 | High | Requirement confirms EventToApi JSON/JOLT and XML/XSLT, but the samples prove only EventToApi JSON/JOLT. | Support both in the product design; block XML/XSLT generation until its EventToApi preset and golden sample are supplied. |
| V-04 | High | Retry, exception, TLS, responder, and shutdown behavior are embedded in Camel XML rather than declared as configurable parameters. | Make them decoded review-only in MVP. |
| V-05 | Critical | The supplied EventToApi XML embeds literal keystore credentials and a filesystem path. | Block secret-bearing generated templates; require a runtime-supported external reference before managed TLS authoring. |
| V-06 | High | The XML comment claims Kafka offset retention, but the XML does not demonstrate offset-control behavior. | Label offset behavior unverified and require Java runtime evidence. |
| V-07 | High | Debulking parameter declarations, registration values, and XML property usage drift. | Validate all three sources; do not treat template declarations as a complete schema. |
| V-08 | Medium | `isMandatory` and `https.config` are strings rather than JSON booleans. | Preserve wire compatibility while using booleans internally in the UI. |
| V-09 | Medium | `process.routeId` is declared and supplied, but the EventToApi XML uses a literal route/from URI. | Validate equality and investigate external orchestration usage. |
| V-10 | Medium | No schema or generator version exists in the samples. | Do not add fields to runtime payloads without approval; use export manifest/metadata outside payload if necessary. |
| V-11 | Medium | The single sample cannot prove allowed HTTP methods or endpoint-expression grammar. | Constrain choices using Java enums/validation, not the PDF alone. |
| V-12 | Medium | Full lossless XML editing is substantially harder than decoding and reviewing XML. | Imported XML remains read-only unless it exactly matches a managed preset. |

## 5. Requirement Traceability

| User requirement | Evidence | Validation status |
|---|---|---|
| Prepare EventToApi routes | Template contains complete Camel Spring XML; requirement defines JSON/JOLT and XML/XSLT variants | Supported through format-specific approved presets; arbitrary route design excluded |
| Generate template JSON | Separate EventToApi template-definition sample exists | Confirmed |
| Generate adapter registration JSON | Separate registration sample exists | Confirmed |
| Load existing template and adapter configuration | Both artifact types have a matchable ID/type | Confirmed, version-selection rule unresolved |
| Provide Camel template for review | `xmlRoute` decodes to well-formed Camel Spring XML | Confirmed |
| Provide inputs JSON configuration for review | Template declares inputs; registration supplies values | Confirmed, drift detection required |

## 6. Product Modes and Phase Boundary

### Later mode: Create Template

- Start from an approved EventToApi XML preset.
- Edit template identity and supported parameter declarations.
- Review decoded Camel XML.
- Reject literal credentials.
- Export template-definition JSON.

### Later mode: Create Registration

- Select/match a template.
- Enter adapter name and status.
- Select JSON or XML payload format; transformation engine is derived, not independently selected.
- Supply parameters required by the matching format-specific template.
- Test JOLT for JSON or XSLT for XML against a matching sample payload.
- Export adapter-registration JSON.

### Phase 1 mode: Review Existing

- Load template and registration JSON.
- Match by ID/type and report ambiguity.
- Present a separate XML Template View containing structured route flow, error handling, dependencies, parameter usage, security findings, and decoded raw XML.
- Present a separate Adapter Configuration View containing meaningful adapter summary, template association, effective parameter values, transformation, target API, inherited operational behavior, unresolved configuration, and raw JSON.
- Present a relationship view distinguishing adapter-supplied values from behavior inherited from the template.
- Decode Camel XML and the format-appropriate JOLT or XSLT specification.
- Validate JSON, Base64, XML, JOLT, and XSLT formats.
- Validate Camel Spring XML DSL syntax, element placement, required attributes, expression escaping, URI structure, identifiers, and static references using an explicitly versioned local schema or supported-DSL ruleset.
- Classify results as Valid, Invalid, Warning, or Not verified.
- Compare declared, supplied, defaulted, and XML-referenced parameters.
- Summarize HTTP invocation and exception behavior.
- Identify literal secrets and unmanaged constructs.
- Remain read-only unless the XML matches a supported preset.

Phase 1 contains only this Review Existing mode. “Conversion” means deriving human-readable in-memory views; it does not create replacement XML/JSON files. Template creation, registration creation, editing, generation, export, and runtime activation are excluded.

Camel validation in Phase 1 is static only. It must not instantiate a Camel or Spring context, resolve runtime beans/components, contact endpoints, start consumers, or execute routes. When the exact Camel DSL/schema version is unavailable, version-dependent checks must be reported as Not verified.

## 7. Required Phase 0 Evidence

Before implementation approval, obtain:

1. Java DTOs or JSON schemas for template definitions and registrations.
2. Controller/API contracts for create, read, update, validation, and lookup.
3. Template ID uniqueness and version-selection rules.
4. Parameter injection and default-precedence implementation.
5. Event consumer and Kafka/JMS offset-control implementation.
6. Exact Camel, Spring, JOLT, and Java versions.
7. Approved replacement for embedded TLS credentials.
8. EventToApi XML/XSLT template, registration, and sample payload.
9. Debulking JSON/JOLT samples before that future pattern is designed.
10. At least three real EventToApi examples covering meaningful variations.
11. Evidence that a supplied sample loads successfully in an isolated runtime.

## 8. Review Decision

Approve the corrected Phase 1 read-only loading and review scope plus Phase 0 discovery work.

Do not include deterministic generation in Phase 1. The first usable increment is strictly read-only import, decoding, matching, validation, and review of existing artifacts.
