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
function TemplateView({ review }: { review: ReviewModel }) {
  const entry = runtimeEntryParameter(review); const entryRoute = entry?.provisionalValue;
  return <div className="grid">
    <section className="panel hero"><p className="eyebrow">XML TEMPLATE VIEW · READ ONLY</p><h2>{review.template.name}</h2><p className="muted"><code>{review.template.id}</code> · {review.template.type}</p><p className="runtime-entry-summary"><strong>Runtime entry point</strong><code>{entryRoute || 'Not configured'}</code><span>{entry ? `Mapped from ${entry.name}` : 'No route-ID parameter was found in the adapter configuration.'}</span></p></section>
    <section className="panel"><h2>Dependencies & security</h2><h3>Imports</h3>{review.decoded.imports.map((item) => <code className="block" key={item}>{safeText(item)}</code>)}<h3>Beans / references</h3>{review.decoded.beans.map((item, index) => <code className="block" key={`${item}-${index}`}>{item || '(anonymous)'}</code>)}<h3>Security</h3>{review.decoded.securityFindings.length ? review.decoded.securityFindings.map((item) => <p className="warning" key={item.id}>⚠ {item.message}</p>) : <p className="muted">No static secret pattern found.</p>}</section>
    <section className="panel wide"><h2>Route flow</h2>{review.decoded.routes.map((route, index) => { const isEntry = !!entryRoute && (route.id === entryRoute || route.from === entryRoute); return <article className={`route ${isEntry ? 'runtime-entry-route' : ''}`} key={`${route.id}-${index}`}><strong>{route.id || '(unnamed route)'}{isEntry ? <span className="entry-badge">Runtime entry point</span> : null}</strong><span>from {route.from || 'missing'}{isEntry ? ' · matches adapter process.routeId' : ''}</span><ul className="tree"><NodeTree node={route.tree}/></ul></article>; })}</section>
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
function AdapterView({ review }: { review: ReviewModel }) { const transformSummary = review.transformEngine ? `${review.transformEngine} transformation` : 'Transformation not detected'; const entry = runtimeEntryParameter(review); return <div className="grid"><section className="panel hero"><p className="eyebrow">ADAPTER CONFIGURATION VIEW · RUNTIME ENTRY POINT</p><h2><code>{entry?.provisionalValue || 'Not configured'}</code></h2><p>This is the route the adapter invokes when the template starts.</p><p className="muted">Configured by <code>{entry?.name || 'No route-ID parameter found'}</code> · status <strong>{review.registration.status}</strong></p><p>Adapter: {review.registration.name}<br/>Matched template: <code>{review.instance.id}</code> / {review.instance.type}</p></section><TemplateRefPanel review={review}/><section className="panel wide"><h2>Effective configuration</h2><p className="muted">Precedence is displayed provisionally: supplied → registration default → template default. Runtime precedence is not verified.</p><OverflowTable><table><thead><tr><th>Meaning / parameter</th><th>Supplied</th><th>Registration default</th><th>Template default</th><th>Provisional value</th><th>XML use</th><th>State</th></tr></thead><tbody>{review.effectiveParameters.map((parameter) => <tr key={parameter.name}><td><strong>{parameter.declaration?.helpText || parameter.name}</strong><code>{parameter.name}</code></td><td>{parameter.suppliedValue && parameter.name.includes('transform') ? transformSummary : parameter.suppliedValue || '—'}</td><td>{parameter.registrationDefault || '—'}</td><td>{parameter.templateDefault || '—'}</td><td>{parameter.provisionalValue && parameter.name.includes('transform') ? transformSummary : parameter.provisionalValue || 'Missing'}</td><td>{parameter.xmlReferences.length ? parameter.xmlReferences.map((ref) => ref.location).join(', ') : 'Not found'}</td><td>{parameter.state}</td></tr>)}</tbody></table></OverflowTable></section><section className="panel"><h2>Transformation</h2><p><Badge severity={review.transformSpec ? 'Valid' : 'Not verified'}/> {transformSummary}</p><pre className="code small">{review.transformSpec ? typeof review.transformSpec === 'string' ? safeText(review.transformSpec) : JSON.stringify(review.transformSpec, null, 2) : 'No decoded transformation is available.'}</pre></section><section className="panel"><h2>Target API</h2><dl>{['httpRequestType', 'https.config', 'httpEndPoint'].map((name) => { const parameter = review.effectiveParameters.find((item) => item.name === name); return <React.Fragment key={name}><dt>{name}</dt><dd>{parameter?.provisionalValue || 'Not supplied'}</dd></React.Fragment>; })}</dl></section><section className="panel wide"><h2>Unmanaged fields</h2><p>Registration: {Object.keys(review.registration.unknownFields).join(', ') || 'none'} · Template: {Object.keys(review.template.unknownFields).join(', ') || 'none'}</p></section></div>; }
function RelationshipView({ review }: { review: ReviewModel }) { return <section className="panel"><h2>Adapter → template → route relationship</h2><OverflowTable><table><thead><tr><th>Adapter value</th><th>Template declaration</th><th>XML location</th><th>Static result</th></tr></thead><tbody>{review.effectiveParameters.map((parameter) => <tr key={parameter.name}><td>{parameter.provisionalValue && parameter.name.includes('transform') ? `${review.transformEngine ?? 'Unknown'} transformation` : parameter.provisionalValue || 'Missing'}<code>{parameter.name}</code></td><td>{parameter.declaration ? parameter.declaration.helpText || 'Declared' : 'Missing declaration'}</td><td>{parameter.xmlReferences.length ? parameter.xmlReferences.map((ref) => ref.location).join(', ') : 'Not statically referenced'}</td><td>{parameter.state}{parameter.xmlReferences.length ? ' → consumed by Exchange property' : ''}</td></tr>)}</tbody></table></OverflowTable></section>; }
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
const [view, setView] = useState<'catalog' | 'single' | 'feature-explorer'>('catalog');
  const [registrationFile, setRegistrationFile] = useState<File | null>(null); const [templateFiles, setTemplateFilesState] = useState<File[]>([]); const [importStatus, setImportStatus] = useState('');
  const [preloadedRegistration, setPreloadedRegistration] = useState<RegistrationPreload | null>(null);
  const [reading, setReading] = useState(false);
  function setTemplateFiles(selectedFiles: File[]) { setTemplateFilesState((existing) => { const knownFiles = new Set(existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`)); return [...existing, ...selectedFiles.filter((file) => !knownFiles.has(`${file.name}:${file.size}:${file.lastModified}`))]; }); }
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
    setView('single');
  };
  const modeSwitch = <nav className="tabs" role="tablist" aria-label="Application mode">
    <button role="tab" aria-selected={view === 'catalog'} className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')}>Folder browser</button>
    <button role="tab" aria-selected={view === 'single'} className={view === 'single' ? 'active' : ''} onClick={() => setView('single')}>Single review</button>
    <button role="tab" aria-selected={view === 'feature-explorer'} className={view === 'feature-explorer' ? 'active' : ''} onClick={() => setView('feature-explorer')}>Feature Explorer</button>
  </nav>;
  if (view === 'catalog') {
    return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h1>Use-case folder browser</h1><p className="subtitle">Select a use-case folder. Files are read in this browser and never uploaded.</p></div>{modeSwitch}</header><section className="notice"><strong>Static only</strong><span>Cards summarise registration and file structure. Open a use case for the full review; runtime behavior remains Not verified.</span></section><section className="panel"><Catalog onOpenReviews={openFromCatalog}/></section></main>;
  }
  if (view === 'feature-explorer') {
    return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h1>Feature File Explorer</h1><p className="subtitle">Analyze Gherkin/Cucumber .feature files — execution flow, API calls, artifacts, and validations.</p></div>{modeSwitch}</header><section className="panel"><FeatureFileExplorer onOpenReviews={openFromCatalog} /></section></main>;
  }
  return <main><header><div><p className="eyebrow">ADAPTERMS / INSPECTOR</p><h1>Adapter configuration review</h1><p className="subtitle">Read-only local inspection. No runtime execution, route loading, or endpoint calls.</p></div>{modeSwitch}</header><section className="notice"><strong>Static only</strong><span>Results describe JSON, XML, transformation, and Camel DSL structure. Runtime behavior remains Not verified.</span></section>{!review ? <section className="empty import-panel"><h2>Start a review</h2><p>The registration is read first so its template references drive the next step. Files remain on this device.</p><p className="muted">For the supplied EventToApi examples, use <code>eventtoapiadapterconfigpayload.json</code> as the registration and <code>eventtoapitemplateconfigpayload.json</code> as the template. Do not select <code>eventtoapieventpayload.json</code>; it is an event message, not a configuration artifact.</p>
      <div className="import-grid import-staged">
        <label className={`file-control ${registrationFile ? 'filled' : ''}`}>
          <span>1. Adapter registration JSON</span>
          <input aria-label="Adapter registration JSON" type="file" accept="application/json,.json" onChange={(event) => { const f = event.target.files?.[0] ?? null; setRegistrationFile(f); setPreloadedRegistration(null); setImportStatus(''); if (f) void readRegistration(f).catch(() => {}); }}/>
          <small>{registrationFile?.name ?? 'No registration file selected'}</small>
        </label>
        <label className={`file-control ${registrationReady ? 'ready' : 'locked'}`}>
          <span>2. Template definition JSON file(s)</span>
          <input aria-label="Template definition JSON files" type="file" accept="application/json,.json" multiple disabled={!registrationReady} onChange={(event) => { setTemplateFiles(Array.from(event.target.files ?? [])); setImportStatus(''); }}/>
          <small>{!registrationReady ? 'Read the registration first — its template references unlock this picker.' : templateFiles.length ? templateFiles.map((file) => file.name).join(', ') : `Select ${requiredCount || 'the'} matching template file${requiredCount === 1 ? '' : 's'}`}</small>
        </label>
      </div>
      {registrationReady && preloadedRegistration ? <div className="reg-required"><h3>Template references in this registration</h3><p className="muted">The template picker below is gated on these ids. A template file is accepted only when its <code>id</code> and <code>type</code> match one of these exactly.</p><ul>{preloadedRegistration.requiredTemplates.map((item, index) => <li key={`${item.id}-${index}`}><code>{item.id}</code><span>{item.type}</span></li>)}</ul></div> : null}
      <div className="import-actions">
        <button className="load-button" disabled={!registrationFile || reading} onClick={() => { if (registrationFile) void readRegistration(registrationFile).catch(() => {}); }}>{reading ? 'Reading…' : registrationFile ? 'Read registration' : 'Choose registration'}</button>
        <button className="load-button primary" disabled={!registrationReady || !templateFiles.length || templateFiles.length > Math.max(requiredCount, FOLDER_MAX_TEMPLATES)} onClick={() => { void importFiles(templateFiles).catch((error: unknown) => { setReviews([]); setFindings([{ id: 'IMPORT_FAILURE', severity: 'Invalid', category: 'Import', artifact: 'local files', message: `Unable to load the selected files: ${error instanceof Error ? error.message : 'unexpected error'}` }]); setImportStatus('Import failed. See the validation finding below.'); }); }}>Load review</button>
      </div>
      {importStatus ? <p className="import-status" role="status">{importStatus}</p> : null}
      {findings.length ? <Findings findings={findings}/> : null}
    </section> : <><section className="template-picker panel"><strong>Matched templates</strong>{reviews.map((item, index) => <button className={index === active ? 'active' : ''} onClick={() => { setActive(index); setTab('adapter'); }} key={`${item.template.id}-${index}`}><span>{item.template.type}</span><code>{item.template.id}</code></button>)}</section><nav className="tabs" aria-label="Review sections">{[['adapter', 'Adapter Configuration'], ['template', 'XML Template'], ['relationship', 'Relationship'], ['validation', `Validation (${counts.invalid + counts.warning})`], ['raw', 'Raw']].map(([id, label]) => <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)} key={id}>{label}</button>)}</nav>{tab === 'template' && <TemplateView review={review}/>} {tab === 'adapter' && <AdapterView review={review}/>} {tab === 'relationship' && <RelationshipView review={review}/>} {tab === 'validation' && <Findings findings={visibleFindings}/>} {tab === 'raw' && <RawView review={review}/>}</>}<footer>Ruleset: camel-spring-static-v1 · Runtime behavior: <Badge severity="Not verified"/></footer></main>;
}

