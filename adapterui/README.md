# AdapterMS configuration reviewer

A browser-based, read-only reviewer for existing AdapterMS configuration artifacts. It supports EventToApi and Debulking registrations, with static inspection of adapter configuration, Camel Spring XML, JOLT, and XSLT payloads.

It does not start Camel routes, contact endpoints, run transformations, or write configuration changes.

## Run locally

Requirements: Node.js and pnpm.

```bash
cd /Users/saravanakumar/01_Coding/Active-Projects/tools/adapterui
pnpm install
pnpm dev
```

Open the local URL shown by Vite, normally `http://localhost:5173`.

Useful checks:

```bash
pnpm test
pnpm run build
```

## Load a review

Select an adapter-registration JSON first, then select every template-definition JSON declared by that registration. Template files can be selected one at a time; each new selection is added to the existing set.

The reviewer requires exact `id` and `type` matches between registration and template files.

| Pattern | Registration | Required template files |
| --- | --- | --- |
| EventToApi | `eventToApi Registration/eventtoapiadapterconfigpayload.json` | `eventToApi Registration/eventtoapitemplateconfigpayload.json` |
| Debulking | `debulking/paymentxmlupload.json` | `debulking.xml.preprocess.json`, `debulking.xml.api.process.json`, `debulking.xml.api.postprocess.json` |

`eventtoapieventpayload.json` is an event message, not an adapter registration, and must not be selected.

## What the UI shows

- **Adapter Configuration**: effective parameters and the configured runtime entry route.
- **XML Template**: route flow, local bean classes, bean references, static Camel expression references, and a color-coded collapsible XML viewer.
- **Relationship**: adapter value → template declaration → Camel XML reference.
- **Validation**: JSON, Base64, XML, JOLT/XSLT, and limited Camel Spring DSL structural findings.
- **Raw**: imported source JSON with displayed sensitive values redacted.

The XML viewer is read-only. The configured entry route is highlighted and expanded by default; other XML elements can be collapsed or expanded by clicking their opening tags.

## Package and deploy on a remote machine

This is a static application. The remote runtime needs only a web server; it does not need Node.js, pnpm, Camel, Spring, or `node_modules`.

Build a deployable package:

```bash
pnpm run build
tar -czf adapterui-dist.tar.gz dist
```

Copy `adapterui-dist.tar.gz` to the remote host, then extract it:

```bash
sudo mkdir -p /opt/adapterui
sudo tar -xzf adapterui-dist.tar.gz -C /opt/adapterui --strip-components=1
```

Serve `/opt/adapterui` through Nginx or another static web server. Example Nginx server block:

```nginx
server {
    listen 80;
    server_name adapterui.example.internal;

    root /opt/adapterui;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Validate and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Use HTTPS and restrict access to intended internal users or an SSO group.

## Data handling and limits

All imported JSON and decoded content are processed in the browser. A static web server does not receive or persist the selected files.

Static validation does not prove runtime behavior. It does not verify runtime bean availability, Camel component availability, endpoint connectivity, route execution, transformation output, or parameter precedence. DTD and external entity content are rejected before XML/XSLT parsing. Potential inline secrets are flagged and redacted in displayed XML.

## Git hygiene

Commit source, tests, package metadata, and `pnpm-lock.yaml`. Do not commit local dependency, cache, build, or secret files:

```gitignore
node_modules/
.pnpm-store/
dist/
.env
.env.*
!.env.example
```
