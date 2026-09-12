# EventToApi configuration review

Phase 1 is a local, read-only browser reviewer for existing AdapterMS EventToApi artifacts. It loads one template-definition JSON and one adapter-registration JSON, matches them by exact `id` and `type`, decodes the embedded Camel XML and JOLT specification, derives a route outline, and reports static findings.

## Run

```bash
pnpm install
pnpm dev
pnpm test
pnpm run build
```

Processing is browser-local. The supplied fixture copies under `public/eventToApi Registration/` are immutable sample inputs used by the **Load supplied sample** action. You can also import exactly two local JSON files; file roles are detected from structure.

## Scope and limitations

This increment does not create, edit, export, persist, deploy, start, or stop configurations. It never instantiates Camel/Spring, resolves runtime beans/components, runs JOLT/XSLT, contacts target endpoints, or makes network validation calls. `Not verified` findings explicitly mark runtime-only claims. XML parsing uses browser DOMParser after rejecting DTD/entity content; the static Camel ruleset is intentionally limited to structural inventory and contract checks, not a version-specific runtime schema.

The current sample contains literal TLS credential material in its encoded XML. The reviewer flags that content as a security finding; raw content is shown only because this is a local expert review and should not be copied into generated configurations.
