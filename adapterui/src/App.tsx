import React, { useMemo, useState } from 'react';
import { strictBase64Decode } from './parser';
import { XmlViewer } from './xml-viewer';
import type { Finding, ReviewModel, SourceArtifact, TemplateDefinition, XmlNode } from './model';
import { decodeTemplate, decodeTransformation, effectiveParameters, parseJson, parseRegistration, parseTemplate, processReferenceFor, routeIdMatches, validateCrossArtifact } from './parser';
import { buildReview } from './review';
import { isRegistration, isTemplate } from './folder';
import { FOLDER_MAX_TEMPLATES } from './folder';
import type { TemplateReference } from './model';

function runtimeEntryParameter(review: ReviewModel) { return review.effectiveParameters.find((parameter) => parameter.name === 'process.routeId' || parameter.name === 'routeId' || parameter.name.endsWith('.routeId')); }
import { Badge, Findings, OverflowTable, NodeTree, safeText } from './ui';
import { Catalog } from './Catalog';
import FeatureFileExplorer from './components/FeatureFileExplorer';
function RouteBehaviorPanel({
  onExceptions,
  setHeaders,
  setProperties,
  endpoints,
  redeliveries,
}: {
  onExceptions: Element[];
  setHeaders: Element[];
  setProperties: Element[];
  endpoints: string[];
  redeliveries?: Element[];
}) {
  return (
    <section className="panel wide">
      <h2>Route behavior &amp; policies</h2>
      <p className="muted">
        Static summary of error policies, headers/properties written, and endpoints declared in this template.
      </p>
      <div className="policy-summary">
        {onExceptions.length ? (
          <>
            <h3>Error policies</h3>
            <ul>
              {onExceptions.map((oe, index) => (
                <li key={index}>
                  <code>{oe.getAttribute('id') || '(unnamed)'}</code>
                  {oe.children.length ? (
                    <span>
                      ·{' '}
                      {Array.from(oe.children).map((child) => child.localName).join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">
            No <code>onException</code> error policies declared.
          </p>
        )}
        {setHeaders.length || setProperties.length ? (
          <>
            <h3>Headers &amp; properties written</h3>
            <ul>
              {setHeaders.map((sh, index) => (
                <li key={`h-${index}`}>
                  Header <code>{sh.getAttribute('name')}</code>
                </li>
              ))}
              {setProperties.map((sp, index) => (
                <li key={`p-${index}`}>
                  Property <code>{sp.getAttribute('name')}</code>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">
            No headers or exchange properties written.
          </p>
        )}
        {endpoints.length ? (
          <>
            <h3>Endpoints</h3>
            <ul>
              {endpoints.map((uri, index) => (
                <li key={index}>
                  <code>{safeText(uri)}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {redeliveries?.length ? (
          <>
            <h3>Redelivery policies</h3>
            <ul>
              {redeliveries.map((rd, index) => (
                <li key={index}>
                  <code>{rd.getAttribute('id') || '(unnamed)'}</code>
                  {rd.getAttribute('maximumRedeliveries') ? <span> · max={rd.getAttribute('maximumRedeliveries')}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}

function TemplateView({ review }: { review: ReviewModel }) {
  const entry = runtimeEntryParameter(review); const entryRoute = entry?.provisionalValue;
  const onExceptions = Array.from(review.decoded.document.querySelectorAll('onException')); const setHeaders = Array.from(review.decoded.document.querySelectorAll('setHeader')); const setProperties = Array.from(review.decoded.document.querySelectorAll('setProperty')); const endpoints = Array.from(review.decoded.document.querySelectorAll('[uri]')).map((node) => node.getAttribute('uri')).filter((u): u is string => u !== null); const redeliveries = Array.from(review.decoded.document.querySelectorAll('redeliveryPolicy, redelivery'));
  return <div className="grid">
    <section className="panel hero"><p className="eyebrow">XML TEMPLATE VIEW · READ ONLY</p><h2>{review.template.name}</h2><p className="muted"><code>{review.template.id}</code> · {review.template.type}</p><p className="runtime-entry-summary"><strong>Runtime entry point</strong><code>{entryRoute || 'Not configured'}</code><span>{entry ? `Mapped from ${entry.name}` : 'No route-ID parameter was found in the adapter configuration.'}</span></p></section>
    <section className="panel"><h2>Dependencies & security</h2><h3>Imports</h3>{review.decoded.imports.map((item) => <code className="block" key={item}>{safeText(item)}</code>)}<h3>Beans / references</h3>{review.decoded.beans.map((item, index) => <code className="block" key={`${item}-${index}`}>{item || '(anonymous)'}</code>)}<h3>Security</h3>{review.decoded.securityFindings.length ? review.decoded.securityFindings.map((item) => <p className="warning" key={item.id}>⚠ {item.message}</p>) : <p className="muted">No static secret pattern found.</p>}</section>
    <section className="panel wide"><h2>Route flow</h2>{review.decoded.routes.map((route, index) => { const isEntry = !!entryRoute && (route.id === entryRoute || route.from === entryRoute); return <article className={`route ${isEntry ? 'runtime-entry-route' : ''}`} key={`${route.id}-${index}`}><strong>{route.id || '(unnamed route)'}{isEntry ? <span className="entry-badge">Runtime entry point</span> : null}</strong><span>from {route.from || 'missing'}{isEntry ? ' · matches adapter process.routeId' : ''}</span><ul className="tree"><NodeTree node={route.tree}/></ul></article>; })}</section>
    <section className="panel wide"><h2>Responder routes</h2><p className="muted">Routes that respond to or are triggered by the adapter entry point.</p>{review.decoded.routes.filter((route) => route.id !== entryRoute && (route.id || route.from)).length ? <ul>{review.decoded.routes.filter((route) => route.id !== entryRoute && (route.id || route.from)).map((route, index) => <li key={index}><code>{route.id || '(unnamed)'}</code> · from <code>{route.from || 'missing'}</code></li>)}</ul> : <p className="muted">No responder routes declared.</p>}</section>
    <RouteBehaviorPanel onExceptions={onExceptions} setHeaders={setHeaders} setProperties={setProperties} endpoints={endpoints} redeliveries={redeliveries} />
    <section className="panel wide"><h2>Camel expression references</h2><p className="muted">Static route references only; this does not prove runtime execution.</p><OverflowTable><table><thead><tr><th>Expression</th><th>Source type</th><th>Route</th><th>Camel step</th><th>Purpose</th></tr></thead><tbody>{review.decoded.references.map((ref, index) => <tr key={`${ref.location}-${index}`}><td><code>{'${'}{ref.expression}{'}'}</code></td><td>{ref.kind}{ref.name ? <code>{ref.name}</code> : null}</td><td>{ref.routeId || 'Outside a route'}</td><td><code>{ref.step}</code></td><td>{ref.purpose}</td></tr>)}</tbody></table></OverflowTable></section>
    <section className="panel wide"><h2>Decoded Camel XML (sensitive values redacted)</h2><p className="muted">Click a tag to minimise or expand its matching XML element. The runtime entry route starts expanded.</p><XmlViewer document={review.decoded.document} entryRoute={entryRoute}/></section>
  </div>;
}
function TemplateRefPanel({ review }: { review: ReviewModel }) {
  const refs = review.templateReferences;
  if (!refs?.length) return null;
  return <section className="panel wide"><h2>Template reference resolution</h2><p className="muted">For each process / preprocess / postprocess entry, the process id the adapter mentions must have a corresponding route in that entry's template XML. The reference is the entry's template id, or the supplied <code>process.routeId</code> when it names a different route.</p>
    <OverflowTable><table><thead><tr><th>Entry</th><th>Type</th><th>Process id (adapter)</th><th>Resolved template file</th><th>Route in XML</th><th>Result</th></tr></thead>
      <tbody>{refs.map((ref) => (
        <tr key={ref.templateId} className={`template-ref ${ref.referenceMatchesRouteId ? 'ok' : 'broken'}`}>
          <td><code>{ref.templateId}</code></td>
          <td>{ref.templateType}</td>
          <td><code>{ref.processReference}</code>{ref.processReference !== ref.templateId ? <small className="muted"> (process.routeId)</small> : null}</td>
          <td>{ref.resolved ? <span className="ref-state ok">✓ resolved</span> : <span className="ref-state broken">✕ not resolved</span>}{ref.templateFile ? <code className="ref-file">{ref.templateFile}</code> : null}</td>
          <td>{ref.matchedRouteId ? <code>{ref.matchedRouteId}</code> : <span className="muted">no matching route</span>}</td>
          <td>{ref.referenceMatchesRouteId ? <span className="ref-state ok">✓ route present</span> : <span className="ref-state broken">✕ no route</span>}</td>
        </tr>
      ))}</tbody></table></OverflowTable>
  </section>;
}
function AdapterView({ review }: { review: ReviewModel }) {
  const transformSummary = review.transformEngine ? `${review.transformEngine} transformation` : 'Transformation not detected';
  const entry = runtimeEntryParameter(review);
  const counts = useMemo(() => {
    const c: Record<string, number> = { Valid: 0, Warning: 0, Invalid: 0, 'Not verified': 0 };
    review.effectiveParameters.forEach((p) => { c[p.state] = (c[p.state] ?? 0) + 1; });
    return c;
  }, [review.effectiveParameters]);
  const stateBadge = (state: string) => {
    const s = state.toLowerCase();
    if (s === 'missing' || s === 'undeclared supplied') return <span className="param-state invalid">✕ Invalid</span>;
    if (s === 'template default') return <span className="param-state warning">⚠ Warning</span>;
    if (s === 'supplied' || s === 'registration default') return <span className="param-state valid">✓ Valid</span>;
    return <span className="param-state not-verified">? Not verified</span>;
  };

  const invalidParams = review.effectiveParameters.filter((p) => p.state === 'Missing' || p.state === 'Undeclared supplied');
  const warningParams = review.effectiveParameters.filter((p) => p.state === 'Template default');
  const requiredCount = review.effectiveParameters.filter((p) => p.declaration?.isMandatory === 'true' || p.declaration?.isMandatory === true).length;
  const attentionItems = [
    ...invalidParams.map((p) => ({ param: p, type: 'invalid' as const })),
    ...warningParams.map((p) => ({ param: p, type: 'warning' as const })),
  ];

  const rowStateClass = (state: string) => {
    const s = state.toLowerCase();
    if (s === 'missing' || s === 'undeclared supplied') return 'config-row invalid';
    if (s === 'template default') return 'config-row warning';
    if (s === 'supplied' || s === 'registration default') return 'config-row ok';
    return 'config-row not-verified';
  };

  const sourceConfidence = (parameter: any) => {
    if (parameter.suppliedValue) return <span className="source-confidence high">Supplied</span>;
    if (parameter.registrationDefault) return <span className="source-confidence medium">Registration default</span>;
    if (parameter.templateDefault) return <span className="source-confidence low">Template default</span>;
    return <span className="source-confidence low">Missing</span>;
  };

  return (
    <div className="grid">
      {/* Hero Header */}
      <section className="panel hero">
        <p className="eyebrow">ADAPTER CONFIGURATION VIEW · RUNTIME ENTRY POINT</p>
        <h2><code>{entry?.provisionalValue || 'Not configured'}</code></h2>
        <p>This is the route the adapter invokes when the template starts.</p>
        <p className="muted">Configured by <code>{entry?.name || 'No route-ID parameter found'}</code> · status <strong>{review.registration.status}</strong></p>
        <div className="metric-grid">
          <div className="metric-card">
            <p className="metric-label">Adapter</p>
            <p className="metric-value">{review.registration.name}</p>
            <p className="metric-sub">{review.registration.type}</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Matched Template</p>
            <p className="metric-value">{review.instance.id}</p>
            <p className="metric-sub">{review.instance.type}</p>
          </div>
          <div className={`metric-card ${invalidParams.length ? 'alert' : ''}`}>
            <p className="metric-label">Parameters</p>
            <p className="metric-value">{review.effectiveParameters.length}</p>
            <p className="metric-sub">{requiredCount} required</p>
          </div>
          <div className={`metric-card ${counts.Invalid > 0 ? 'alert' : counts.Warning > 0 ? 'highlight' : ''}`}>
            <p className="metric-label">Config Health</p>
            <p className="metric-value">{counts.Invalid > 0 ? 'Errors' : counts.Warning > 0 ? 'Warnings' : 'Healthy'}</p>
            <p className="metric-sub">{counts.Invalid} invalid · {counts.Warning} warnings</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Transform</p>
            <p className="metric-value">{review.transformEngine || '—'}</p>
            <p className="metric-sub">{review.transformSpec ? 'decoded' : 'not available'}</p>
          </div>
        </div>
      </section>

      {/* Snapshot Grid: Registration + Template */}
      <div className="snapshot-grid">
        <div className="snapshot-card">
          <h3>Registration Details</h3>
          <div className="snapshot-row">
            <span className="snapshot-label">Name</span>
            <span className="snapshot-value">{review.registration.name}</span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">Type</span>
            <span className="snapshot-value">{review.registration.type}</span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">Status</span>
            <span className="snapshot-value"><strong>{review.registration.status}</strong></span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">File</span>
            <span className="snapshot-value"><code>{review.registrationSource.name}</code></span>
          </div>
        </div>
        <div className="snapshot-card">
          <h3>Template Details</h3>
          <div className="snapshot-row">
            <span className="snapshot-label">Name</span>
            <span className="snapshot-value">{review.template.name}</span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">ID</span>
            <span className="snapshot-value"><code>{review.template.id}</code></span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">Type</span>
            <span className="snapshot-value">{review.template.type}</span>
          </div>
          <div className="snapshot-row">
            <span className="snapshot-label">File</span>
            <span className="snapshot-value"><code>{review.templateSource.name}</code></span>
          </div>
        </div>
      </div>

      {/* Critical Parameters Callout */}
      {(attentionItems.length > 0) && (
        <section className={`panel critical-callout ${invalidParams.length > 0 ? '' : 'warning'}`}>
          <h3>
            {invalidParams.length > 0 ? '⚠' : 'ℹ'} Attention Required
          </h3>
          {attentionItems.map((item, idx) => (
            <div key={idx} className={`critical-item ${item.type}`}>
              <span className="critical-param">{item.param.declaration?.helpText || item.param.name}<code>{item.param.name}</code></span>
              <span className={`critical-reason ${item.type}`}>{item.type === 'invalid' ? 'Invalid or missing value' : 'Declared but may need review'}</span>
            </div>
          ))}
        </section>
      )}

      {/* Effective Configuration Table */}
      <section className="panel wide review-section">
        <h2>Effective Configuration</h2>
        <p className="muted">Sources are shown separately; the final effective value is <strong>Not verified</strong> because runtime parameter precedence is not confirmed.</p>
        <OverflowTable>
          <table>
            <thead>
              <tr>
                <th>Meaning / Parameter</th>
                <th>Declaration</th>
                <th>Template Default</th>
                <th>Registration Default</th>
                <th>Supplied Value</th>
                <th>Effective Value</th>
                <th>Source</th>
                <th>XML Use</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {review.effectiveParameters.map((parameter) => {
                const isRequired = parameter.declaration?.isMandatory === 'true' || parameter.declaration?.isMandatory === true;
                const isTransform = parameter.name.includes('transform');
                return (
                  <tr key={parameter.name} className={rowStateClass(parameter.state)}>
                    <td>
                      <strong>{parameter.declaration?.helpText || parameter.name}</strong>
                      <code>{parameter.name}</code>{isRequired && <span className="required-marker">required</span>}
                    </td>
                    <td>{parameter.declaration ? 'Declared' : 'Missing declaration'}</td>
                    <td>{parameter.templateDefault || '—'}</td>
                    <td>{parameter.registrationDefault || '—'}</td>
                    <td>{isTransform ? transformSummary : parameter.suppliedValue || '—'}</td>
                    <td>{sourceConfidence(parameter)}</td>
                    <td>{parameter.xmlReferences.length ? parameter.xmlReferences.map((ref) => ref.location).join(', ') : 'Not found'}</td>
                    <td>{stateBadge(parameter.state)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </OverflowTable>
      </section>

      {/* Template Reference Resolution */}
      <TemplateRefPanel review={review} />

      {/* Transformation */}
      <section className="panel wide review-section">
        <h2>Transformation</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Badge severity={review.transformSpec ? 'Valid' : 'Not verified'} />
          <span className="muted">{transformSummary}</span>
        </div>
        <pre className="code small">{review.transformSpec ? typeof review.transformSpec === 'string' ? safeText(review.transformSpec) : JSON.stringify(review.transformSpec, null, 2) : 'No decoded transformation is available.'}</pre>
      </section>

      {/* Target API */}
      <section className="panel review-section">
        <h2>Target API Configuration</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {['httpRequestType', 'https.config', 'httpEndPoint'].map((name) => {
            const parameter = review.effectiveParameters.find((item) => item.name === name);
            const value = parameter?.provisionalValue || 'Not supplied';
            const hasValue = parameter && parameter.provisionalValue;
            return (
              <div key={name} className="snapshot-card" style={{ padding: '12px' }}>
                <h3 style={{ margin: '0 0 6px 0', fontSize: '0.7rem' }}>{name}</h3>
                <div className="snapshot-value" style={{ fontSize: '0.9rem', color: hasValue ? '#7adcb4' : '#9ca8bb' }}>{value}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Unmanaged Fields */}
      <section className="panel review-section">
        <h2>Unmanaged Fields</h2>
        <div style={{ display: 'flex', gap: 20 }}>
          <div style={{ flex: 1 }}>
            <p className="muted" style={{ margin: '0 0 4px 0' }}>Registration</p>
            <code>{Object.keys(review.registration.unknownFields).join(', ') || 'none'}</code>
          </div>
          <div style={{ flex: 1 }}>
            <p className="muted" style={{ margin: '0 0 4px 0' }}>Template</p>
            <code>{Object.keys(review.template.unknownFields).join(', ') || 'none'}</code>
          </div>
        </div>
      </section>
    </div>
  );
}
function RelationshipView({ review }: { review: ReviewModel }) {
  const transformSummary = review.transformEngine ? `${review.transformEngine} transformation` : 'Transformation not detected';
  const relationshipState = (parameter: { xmlReferences: { length: number }; suppliedValue?: string; registrationDefault?: string; templateDefault?: string; declaration?: { helpText?: string } }): string => {
    if (!parameter.declaration) return 'Missing declaration';
    if (!parameter.suppliedValue && !parameter.registrationDefault && !parameter.templateDefault) return 'Missing value';
    if (parameter.suppliedValue) return parameter.xmlReferences.length ? 'Matched' : 'Declared but unused';
    return 'Defaulted';
  };
  return <section className="panel"><h2>Adapter → template → route relationship</h2><p className="muted">For each parameter: adapter value → template declaration → XML expression/location → static route behavior.</p><OverflowTable><table><thead><tr><th>Adapter value</th><th>Template declaration</th><th>XML expression / location</th><th>Static route behavior</th><th>Result state</th></tr></thead><tbody>{review.effectiveParameters.map((parameter) => <tr key={parameter.name}><td>{parameter.name.includes('transform') ? transformSummary : parameter.suppliedValue || parameter.registrationDefault || parameter.templateDefault || 'Missing'}<code>{parameter.name}</code></td><td>{parameter.declaration ? parameter.declaration.helpText || 'Declared' : 'Missing declaration'}</td><td>{parameter.xmlReferences.length ? parameter.xmlReferences.map((ref) => `${ref.expression} @ ${ref.step}`).join(', ') : 'Not statically referenced'}</td><td>{parameter.xmlReferences.length ? parameter.xmlReferences.map((ref) => ref.purpose).join('; ') : 'No static route behavior'}</td><td><span className={`state-${relationshipState(parameter).replace(/\s+/g, '-').toLowerCase()}`}>{relationshipState(parameter)}</span></td></tr>)}</tbody></table></OverflowTable></section>; }
function RawView({ review }: { review: ReviewModel }) {
  const xmlDecoded = review.decoded?.safeXml ?? null;
  return <div className="grid"><section className="panel wide"><h2>Loaded registration JSON (sensitive values redacted)</h2><pre className="code">{safeText(review.registrationSource.rawText)}</pre></section><section className="panel wide"><h2>Loaded template JSON (sensitive values redacted)</h2><pre className="code raw-collapsed">{safeText(review.templateSource.rawText)}</pre>{xmlDecoded ? <details className="decoded-detail"><summary>Decoded xmlRoute (Base64 decoded, secrets redacted)</summary><pre className="code">{xmlDecoded}</pre></details> : null}</section></div>;
}

type RegistrationPreload = {
  registration: ReturnType<typeof parseRegistration>['registration'];
  registrationFindings: Finding[];
  importFindings: Finding[];
  requiredTemplates: Array<{ id: string; type: string }>;
  fileName: string;
  rawText: string;
  loadedAt: number;
};

export function App() {
  const [reviews, setReviews] = useState<ReviewModel[]>([]); 
const [findings, setFindings] = useState<Finding[]>([]); 
const [active, setActive] = useState(0); 
const [tab, setTab] = useState('adapter');
const [view, setView] = useState<'catalog' | 'feature-explorer'>('catalog');
  const [registrationFile, setRegistrationFile] = useState<File | null>(null); const [templateFiles, setTemplateFilesState] = useState<File[]>([]); const [importStatus, setImportStatus] = useState('');
  const [preloadedRegistration, setPreloadedRegistration] = useState<RegistrationPreload | null>(null);
  const [reading, setReading] = useState(false);
  function setTemplateFiles(selectedFiles: File[]) { setTemplateFilesState((existing) => { const knownFiles = new Set(existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`)); return [...existing, ...selectedFiles.filter((file) => !knownFiles.has(`${file.name}:${file.size}:${file.lastModified}`))]; }); }
  function clearTemplateFiles() { setTemplateFilesState([]); setImportStatus(''); }
  function clearRegistration() { setRegistrationFile(null); setPreloadedRegistration(null); setTemplateFilesState([]); setImportStatus(''); }
  async function readRegistration(file: File) {
    setReading(true); setImportStatus('Reading adapter registration…');
    try {
      const rawText = await file.text();
      const result = parseJson(rawText, file.name);
      if (!isRegistration(result.value)) {
        setPreloadedRegistration(null);
        setFindings([...result.findings, { id: 'FILE_ROLES_REG', severity: 'Invalid', category: 'Import', artifact: 'registration', message: 'The selected file is not an adapter-registration JSON (top-level object with type, name, status, and a templates array).' }]);
        setImportStatus('Cannot read registration: the file is not an adapter-registration JSON.');
        return;
      }
      const registrationResult = parseRegistration(result.value);
      const parsedRegistration = registrationResult.registration;
      setPreloadedRegistration({
        registration: parsedRegistration ?? undefined,
        registrationFindings: registrationResult.findings,
        importFindings: result.findings,
        requiredTemplates: parsedRegistration?.templates.map((item) => ({ id: item.id, type: item.type })) ?? [],
        fileName: file.name,
        rawText,
        loadedAt: Date.now(),
      });
      setFindings([...result.findings, ...registrationResult.findings]);
      setImportStatus(parsedRegistration ? `Registration read. ${parsedRegistration.templates.length} template reference${parsedRegistration.templates.length === 1 ? '' : 's'} identified — now pick the matching template file${parsedRegistration.templates.length === 1 ? '' : 's'}.` : 'Registration read, but it is invalid. See findings.');
    } catch (error) {
      setPreloadedRegistration(null);
      setFindings([{ id: 'IMPORT_FAILURE', severity: 'Invalid', category: 'Import', artifact: 'local files', message: `Unable to read the registration file: ${error instanceof Error ? error.message : 'unexpected error'}` }]);
      setImportStatus('Import failed. See the validation finding below.');
    } finally {
      setReading(false);
    }
  }
  async function importFiles(templates: File[]) {
    const preloaded = preloadedRegistration;
    setImportStatus('Reading selected template files…');
    if (!preloaded || !preloaded.registration) { setReviews([]); setFindings([{ id: 'REG_NOT_READ', severity: 'Invalid', category: 'Import', artifact: 'local files', message: 'Read the adapter-registration JSON first; its template references drive which files to load.' }]); setImportStatus('Cannot load: read the adapter registration first.'); return; }
    if (!templates.length) { setReviews([]); setFindings([{ id: 'FILE_COUNT', severity: 'Invalid', category: 'Import', artifact: 'local files', message: 'Choose every template-definition JSON the registration declares.' }]); setImportStatus('Cannot load: no template files selected.'); return; }
    const entries = await Promise.all(templates.map(async (file) => ({ name: file.name, rawText: await file.text() })));
    const parsed = entries.map((entry) => ({ entry, result: parseJson(entry.rawText, entry.name) }));
    const templateEntries = parsed; const importFindings = parsed.flatMap(({ result }) => result.findings);
    if (templateEntries.some(({ result }) => !isTemplate(result.value))) { setReviews([]); setFindings([...importFindings, { id: 'FILE_ROLES', severity: 'Invalid', category: 'Import', artifact: 'selected files', message: 'The template selector must contain only template-definition JSON files (top-level object with id, name, type, xmlRoute, and inputParameters/defaultParameters arrays).' }]); setImportStatus('Cannot load: one or more files are the wrong artifact type.'); return; }
    const registration = preloaded.registration; const templateResults = templateEntries.map(({ result }) => parseTemplate(result.value)); const nextReviews: ReviewModel[] = []; const nextFindings = [...preloaded.importFindings, ...preloaded.registrationFindings, ...importFindings];
    const requiredTemplates = registration.templates; if (templates.length !== requiredTemplates.length) { setReviews([]); setFindings([...nextFindings, { id: 'TEMPLATE_COUNT', severity: 'Invalid', category: 'Import', artifact: 'registration', message: `${registration.type} requires ${requiredTemplates.length} template file${requiredTemplates.length === 1 ? '' : 's'} (${requiredTemplates.map((item) => item.type).join(', ')}); ${templates.length} selected.` }]); setImportStatus(`Cannot load: ${registration.type} requires ${requiredTemplates.length} matching template file${requiredTemplates.length === 1 ? '' : 's'}.`); return; }
    const loadedTemplates = templateResults.flatMap((result) => result.template ? [result.template] : []); const missingTemplates = requiredTemplates.filter((required) => !loadedTemplates.some((loaded) => loaded.id === required.id && loaded.type === required.type)); const unexpectedTemplates = loadedTemplates.filter((loaded) => !requiredTemplates.some((required) => required.id === loaded.id && required.type === loaded.type)); if (missingTemplates.length || unexpectedTemplates.length) { setReviews([]); setFindings([...nextFindings, { id: 'TEMPLATE_SET_MISMATCH', severity: 'Invalid', category: 'Import', artifact: 'selected files', message: `Template files must match the registration exactly. Missing: ${missingTemplates.map((item) => `${item.type} (${item.id})`).join(', ') || 'none'}. Unexpected: ${unexpectedTemplates.map((item) => `${item.type} (${item.id})`).join(', ') || 'none'}.` }]); setImportStatus('Cannot load: selected templates do not match the adapter registration.'); return; }
    templateResults.forEach((result, index) => { nextFindings.push(...result.findings); if (result.template && registration) { const templateSource: SourceArtifact = { ...templateEntries[index].entry, parsed: templateEntries[index].result.value, role: 'template' }; const registrationSource: SourceArtifact = { name: preloaded.fileName, rawText: preloaded.rawText, parsed: registration, role: 'registration' }; const review = buildReview(result.template, registration, templateSource, registrationSource, result.findings); nextFindings.push(...review.findings.filter((item) => !result.findings.includes(item))); if (review.review) nextReviews.push(review.review); } });
    setReviews(nextReviews); setFindings(nextFindings); setActive(0); setTab('adapter'); setImportStatus(nextReviews.length ? `Loaded ${nextReviews.length} matched template review${nextReviews.length === 1 ? '' : 's'}.` : 'Files were read, but no template matched the registration. See validation findings.');
  }
  const review = reviews[active]; const visibleFindings = review?.findings ?? findings; const counts = useMemo(() => ({ invalid: visibleFindings.filter((item) => item.severity === 'Invalid').length, warning: visibleFindings.filter((item) => item.severity === 'Warning').length }), [visibleFindings]);
  const registrationReady = !!preloadedRegistration?.registration;
  const requiredCount = preloadedRegistration?.requiredTemplates.length ?? 0;
  // Drill-down from the folder browser: hand the pre-built reviews to the existing reviewer so the
  // catalog and the review can never disagree (single source of truth).
  const openFromCatalog = (nextReviews: ReviewModel[], nextFindings: Finding[]) => {
    console.debug('[App] openFromCatalog called', { nextReviewsCount: nextReviews.length, nextFindingsCount: nextFindings.length, nextReviews: nextReviews.map(r => r.template.id) });
    setReviews(nextReviews);
    setFindings(nextFindings);
    setActive(0);
    setTab('adapter');
    setView('catalog');
  };
  const modeSwitch = <nav className="tabs" role="tablist" aria-label="Application mode">
    <button role="tab" aria-selected={view === 'catalog'} className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')}>Adapter Catalog</button>
    <button role="tab" aria-selected={view === 'feature-explorer'} className={view === 'feature-explorer' ? 'active' : ''} onClick={() => setView('feature-explorer')}>Feature Explorer</button>
  </nav>;
  if (view === 'feature-explorer') {
    return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h2>Feature File Explorer</h2><p className="subtitle">Analyze Gherkin/Cucumber .feature files — execution flow, API calls, artifacts, and validations.</p></div>{modeSwitch}</header><section className="panel"><FeatureFileExplorer onOpenReviews={openFromCatalog} /></section></main>;
  }

  // view === 'catalog'
  // If reviews are loaded (from folder scan or file selection), show the 5-tab reviewer
  if (review) {
    return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h2>Adapter configuration review</h2><p className="subtitle">Read-only local inspection. No runtime execution, route loading, or endpoint calls.</p></div>{modeSwitch}</header><section className="notice"><strong>Static only</strong><span>Results describe JSON, XML, transformation, and Camel DSL structure. Runtime behavior remains Not verified.</span></section><section className="template-picker panel"><strong>Matched templates</strong>{reviews.map((item, index) => <button className={index === active ? 'active' : ''} onClick={() => { setActive(index); setTab('adapter'); }} key={`${item.template.id}-${index}`}><span>{item.template.type}</span><code>{item.template.id}</code></button>)}</section><nav className="tabs" aria-label="Review sections">{[['adapter', 'Adapter Configuration'], ['template', 'XML Template'], ['relationship', 'Relationship'], ['validation', `Validation (${counts.invalid + counts.warning})`], ['raw', 'Raw']].map(([id, label]) => <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>{label}</button>)}</nav>{tab === 'template' && <TemplateView review={review}/>} {tab === 'adapter' && <AdapterView review={review}/>} {tab === 'relationship' && <RelationshipView review={review}/>} {tab === 'validation' && <Findings findings={visibleFindings}/>} {tab === 'raw' && <RawView review={review}/>}<footer>Ruleset: camel-spring-static-v1 · Runtime behavior: <Badge severity="Not verified"/></footer></main>;
  }

  // No reviews loaded — show two loading options inside Adapter Catalog
  return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h2>Adapter Catalog</h2><p className="subtitle">Choose how to load adapters: scan a folder to discover registrations, or select registration and template files directly.</p></div>{modeSwitch}</header><section className="notice"><strong>Static only</strong><span>Cards summarise registration and file structure. Open a use case for the full review; runtime behavior remains Not verified.</span></section><section className="panel catalog-options"><div className="option-group"><div className="option-card"><h3>A. Scan Folder</h3><p>Select a folder containing adapter registration and template definition JSON files. Cards summarise each registration found.</p><Catalog onOpenReviews={openFromCatalog} /></div><div className="option-card"><h3>B. Select Files</h3><p>Pick an adapter registration JSON, then its matching template definition JSON files.</p><div className="import-grid import-staged"><label className={`file-control ${registrationFile ? 'filled' : ''}`}><span>1. Adapter registration JSON</span><input aria-label="Adapter registration JSON" type="file" accept="application/json,.json" onClick={(e) => { e.currentTarget.value = ''; }} onChange={(event) => { const f = event.target.files?.[0] ?? null; setRegistrationFile(f); setPreloadedRegistration(null); setImportStatus(''); if (f) void readRegistration(f).catch(() => {}); }}/><small>{registrationFile?.name ?? 'No registration file selected'}</small>{registrationFile && <button type="button" className="reset-file-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearRegistration(); }} title="Clear the selected registration file">⏎ Reset</button>}</label><label className={`file-control ${registrationReady ? 'ready' : 'locked'}`}><span>2. Template definition JSON file(s)</span><input aria-label="Template definition JSON files" type="file" accept="application/json,.json" multiple disabled={!registrationReady} onClick={(e) => { e.currentTarget.value = ''; }} onChange={(event) => { setTemplateFiles(Array.from(event.target.files ?? [])); setImportStatus(''); }}/>
<small>{!registrationReady ? 'Read the registration first — its template references unlock this picker.' : templateFiles.length ? templateFiles.map((file) => file.name).join(', ') : `Select ${requiredCount || 'the'} matching template file${requiredCount === 1 ? '' : 's'}`}</small>{templateFiles.length > 0 && registrationReady && <button type="button" className="reset-file-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearTemplateFiles(); }} title="Clear all selected template files">⏎ Reset</button>}</label>
</div>
{registrationReady && preloadedRegistration ? <div className="reg-required"><h3>Template references in this registration</h3><p className="muted">The template picker below is gated on these ids. A template file is accepted only when its <code>id</code> and <code>type</code> match one of these exactly.</p><ul>{preloadedRegistration.requiredTemplates.map((item, index) => <li key={`${item.id}-${index}`}><code>{item.id}</code><span>{item.type}</span></li>)}</ul></div> : null}
<div className="import-actions"><button className="load-button" disabled={!registrationFile || reading} onClick={() => { if (registrationFile) void readRegistration(registrationFile).catch(() => {}); }}>{reading ? 'Reading…' : registrationFile ? 'Read registration' : 'Choose registration'}</button><button className="load-button primary" disabled={!registrationReady || !templateFiles.length || templateFiles.length > Math.max(requiredCount, FOLDER_MAX_TEMPLATES)} onClick={() => { void importFiles(templateFiles).catch((error: unknown) => { setReviews([]); setFindings([{ id: 'IMPORT_FAILURE', severity: 'Invalid', category: 'Import', artifact: 'local files', message: `Unable to load the selected files: ${error instanceof Error ? error.message : 'unexpected error'}` }]); setImportStatus('Import failed. See the validation finding below.'); }); }}>Load review</button></div>{importStatus ? <p className="import-status" role="status">{importStatus}</p> : null}{findings.length ? <Findings findings={findings}/> : null}</div></div></section></main>;
}

