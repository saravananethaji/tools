import React, { useState } from 'react';
import { readFolder } from './folder';
import { composeCatalog } from './folder';
import { buildReview } from './review';
import type { CatalogModel, Finding, FolderScan, ReviewModel, SourceArtifact } from './model';
import { parseJson, parseTemplate } from './parser';
import { Findings, OverflowTable, Badge } from './ui';

// Helper to determine transformation engine from a template instance
function getTransformationEngine(instance: any): string | null {
  const transformParam = instance.inputParameters.find((param: any) => 
    /(?:data\.)?(?:jolt|xslt)\.transform\.spec|data\.transform\.spec/i.test(param.name)
  );
  
  if (!transformParam) return null;
  
  return transformParam.name.toLowerCase().includes('xslt') ? 'XSLT' : 'JOLT';
}

// Helper to get health badge props
function getHealthBadgeProps(health: 'Healthy' | 'Warnings' | 'Errors' | 'Not verified'): { severity: Finding['severity']; label: string } {
  switch (health) {
    case 'Errors': return { severity: 'Invalid', label: 'Errors' };
    case 'Warnings': return { severity: 'Warning', label: 'Warnings' };
    case 'Not verified': return { severity: 'Not verified', label: 'Not verified' };
    case 'Healthy': return { severity: 'Valid', label: 'Healthy' };
    default: return { severity: 'Valid', label: 'Healthy' };
  }
}

export function Catalog({ onOpenReviews }: {
  /** Hands the built reviews to the App so the existing 5-tab reviewer can render them. */
  onOpenReviews: (reviews: ReviewModel[], findings: Finding[]) => void;
}) {
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const requestId = React.useRef(0);

  // Handler for folder selection (webkitdirectory)
  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const current = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const scanResult = await readFolder(Array.from(files));
      if (current !== requestId.current) return; // a newer folder selection superseded this one
      setScan(scanResult);
      setCatalog(composeCatalog(scanResult));
      setOpenedPath(null);
    } catch (err) {
      if (current !== requestId.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  };

  /**
   * Tier 2 (F7): build the reviews for one use case from its canonical template files and hand them
   * to the App's existing 5-tab reviewer. This is the only place `buildReview` is called, so the
   * catalog and the reviewer can never disagree.
   */
  const handleOpenReview = (registrationPath: string) => {
    console.debug('[Catalog] handleOpenReview called', { registrationPath });
    if (!scan || !catalog) {
      console.debug('[Catalog] handleOpenReview: no scan or catalog');
      return;
    }
    const useCase = catalog.useCases.find((u) => u.registrationPath === registrationPath);
    if (!useCase) {
      console.debug('[Catalog] handleOpenReview: useCase not found for', registrationPath);
      console.debug('[Catalog] Available useCases:', catalog.useCases.map(u => u.registrationPath));
      return;
    }
    console.debug('[Catalog] Found useCase', { registrationPath: useCase.registrationPath, stages: useCase.stages.length });
    const registrationSource: SourceArtifact = {
      name: registrationPath,
      rawText: scan.entries.find((e) => e.relativePath === registrationPath)?.text ?? '',
      parsed: useCase.registration,
      role: 'registration',
    };
    const built: ReviewModel[] = [];
    const allFindings: Finding[] = [];
    for (const stage of useCase.stages) {
      console.debug('[Catalog] Processing stage', { entryType: stage.entryType, entryId: stage.entryId, matched: stage.matched, templateFilePath: stage.templateFilePath });
      if (!stage.matched || !stage.templateFilePath) {
        console.debug('[Catalog] Skipping stage: not matched or no templateFilePath');
        continue;
      }
      const entry = scan.entries.find((e) => e.relativePath === stage.templateFilePath);
      console.debug('[Catalog] Looking for template entry at', stage.templateFilePath, '->', entry ? 'FOUND' : 'NOT FOUND');
      if (entry) {
        console.debug('[Catalog] Template entry kind:', entry.kind, 'hasText:', !!entry.text);
      }
      const root = entry?.relativePath.split('/').pop() ?? stage.templateFilePath;
      if (!entry?.text) {
        console.debug('[Catalog] Template file unreadable');
        allFindings.push({
          id: 'TEMPLATE_FILE_UNREADABLE',
          severity: 'Invalid',
          category: 'Import',
          artifact: stage.templateFilePath,
          message: `Template file ${stage.templateFilePath} could not be read, so this entry could not be reviewed.`,
          location: stage.templateFilePath,
        });
        continue;
      }
      const parsed = parseJson(entry.text, entry.name);
      if (parsed.findings.length) allFindings.push(...parsed.findings);
      const parsedTemplate = parseTemplate(parsed.value);
      if (parsedTemplate.findings.length) allFindings.push(...parsedTemplate.findings);
      if (!parsedTemplate.template) {
        console.debug('[Catalog] parseTemplate returned no template');
        continue;
      }
      const templateSource: SourceArtifact = { name: root, rawText: entry.text, parsed: parsed.value, role: 'template' };
      const built1 = buildReview(parsedTemplate.template, useCase.registration, templateSource, registrationSource, parsedTemplate.findings);
      console.debug('[Catalog] buildReview result', { hasReview: !!built1.review, findings: built1.findings.map(f => f.id) });
      allFindings.push(...built1.findings);
      if (built1.review) built.push(built1.review);
    }
    console.debug('[Catalog] Calling onOpenReviews', { builtCount: built.length, allFindingsCount: allFindings.length });
    setOpenedPath(registrationPath);
    onOpenReviews(built, allFindings);
  };

  // Render the catalog UI.
  return (
    <div>
      <h2>Adapter Catalog</h2>
      <input
        type="file"
        multiple
        aria-label="Select a use-case folder"
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={handleFolderSelect}
        disabled={loading}
      />
      {loading && <p>Loading...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {scan && (
        <div>
          <h2>Scan Results</h2>
          <p>Files read: {scan.fileCount}</p>
          <p>Truncated: {scan.truncated ? 'Yes' : 'No'}</p>
          <p>Total bytes: {scan.totalBytes}</p>
          <h3>Findings</h3>
          <Findings findings={catalog ? catalog.findings : scan.findings} />
        </div>
      )}
      {catalog && (
        <div>
          <h2>Catalog</h2>
          <p>Number of use cases: {catalog.useCases.length}</p>
          <h3>Use Cases</h3>
          {catalog.useCases.map((useCase, index) => (
            <div key={useCase.registrationPath} className="catalog-card">
              <div className="card-header">
                <div>
                  <h2>{useCase.registration.name}</h2>
                  <div className="registration-type">{useCase.registration.type}</div>
                </div>
                <div className="health-chip-container">
                  <Badge severity={getHealthBadgeProps(useCase.health).severity} />
                  <span>{getHealthBadgeProps(useCase.health).label}</span>
                </div>
              </div>
              
              <div className="card-body">
                <div className="card-status">
                  <p>Status: <strong>{useCase.registration.status}</strong></p>
                  <p>Stages: {useCase.stages.length}</p>
                </div>

                <div className="registration-details">
                  <h3>Registration Details</h3>
                  <dl className="details-list">
                    <dt>Name</dt>
                    <dd>{useCase.registration.name}</dd>
                    <dt>Type</dt>
                    <dd>{useCase.registration.type}</dd>
                    <dt>Registration file</dt>
                    <dd><code>{useCase.registrationPath}</code></dd>
                  </dl>
                  {useCase.registration.parameters && Object.keys(useCase.registration.parameters).length > 0 && (
                    <>
                      <h4>Parameters</h4>
                      <dl className="details-list">
                        {Object.entries(useCase.registration.parameters).map(([key, value]) => (
                          <React.Fragment key={key}>
                            <dt>{key}</dt>
                            <dd>{String(value)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    </>
                  )}
                  <h4>Template Instances</h4>
                  <table className="details-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Input Parameters</th>
                        <th>Default Parameters</th>
                      </tr>
                    </thead>
                    <tbody>
                      {useCase.registration.templates.map((inst: any, idx: number) => (
                        <tr key={idx}>
                          <td><code>{inst.id}</code></td>
                          <td>{inst.type}</td>
                          <td>
                            {inst.inputParameters?.length ? (
                              <ul className="compact-list">
                                {inst.inputParameters.map((p: any, pidx: number) => (
                                  <li key={pidx}><code>{p.name}</code>: {String(p.value)}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            {inst.defaultParameters?.length ? (
                              <ul className="compact-list">
                                {inst.defaultParameters.map((p: any, pidx: number) => (
                                  <li key={pidx}><code>{p.name}</code>: {String(p.value)}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="stage-section">
                  <h3>Stages</h3>
                  <OverflowTable>
                    <table className="stage-table">
                      <thead>
                        <tr>
                          <th>Entry Type</th>
                          <th>Entry ID</th>
                          <th>Template File</th>
                          <th>Matched</th>
                          <th>Process Reference</th>
                          <th>Transform Engine</th>
                        </tr>
                      </thead>
                      <tbody>
                        {useCase.stages.map((stage, stageIndex) => {
                          // Find the matching template instance to determine transformation engine
                          const matchingInstance = useCase.registration.templates.find(
                            (inst: any) => inst.id === stage.entryId && inst.type === stage.entryType
                          );
                          const transformEngine = matchingInstance ? getTransformationEngine(matchingInstance) : null;
                          
                          return (
                            <tr key={stageIndex} className={`template-ref ${stage.matched ? 'ok' : 'broken'}`}>
                              <td>{stage.entryType}</td>
                              <td>{stage.entryId}</td>
                              <td>
                                {stage.templateFilePath ? (
                                  <code className="ref-file">{stage.templateFilePath}</code>
                                ) : (
                                  <span className="ref-state broken">None</span>
                                )}
                              </td>
                              <td>{stage.matched ? 'Yes' : 'No'}</td>
                              <td>{stage.processReference}</td>
                              <td>
                                {transformEngine ? `${transformEngine} transform` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </OverflowTable>
                </div>
                
                {useCase.missing.length > 0 && (
                  <div className="missing-section">
                    <h3>Missing</h3>
                    <ul className="missing-list">
                      {useCase.missing.map((m, idx) => (
                        <li key={idx}>
                          <code>{m.id}</code> (<span className="muted">{m.type}</span>)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {useCase.extra.length > 0 && (
                  <div className="extra-section">
                    <h3>Extra</h3>
                    <ul className="extra-list">
                      {useCase.extra.map((e, idx) => (
                        <li key={idx}><code>{e}</code></li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {useCase.duplicates.length > 0 && (
                  <div className="duplicates-section">
                    <h3>Duplicates</h3>
                    <ul className="duplicates-list">
                      {useCase.duplicates.map((d, idx) => (
                        <li key={idx}><code>{d}</code></li>
                      ))}
                    </ul>
                  </div>
                )}
                
                <div className="finding-section">
                  <h3>Finding Groups</h3>
                  <OverflowTable>
                    <table className="finding-table">
                      <thead>
                        <tr>
                          <th>Finding ID</th>
                          <th>Severity</th>
                          <th>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {useCase.findingGroups.map((fg, idx) => (
                          <tr key={idx}>
                            <td>{fg.id}</td>
                            <td>
                              <Badge severity={fg.severity} />
                            </td>
                            <td>{fg.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </OverflowTable>
                </div>
                
                <div className="card-actions">
                  <button
                    className="load-button primary"
                    onClick={() => handleOpenReview(useCase.registrationPath)}
                    aria-label={`Open full review for ${useCase.registration.name}`}
                  >
                    {openedPath === useCase.registrationPath ? 'Opened in reviewer →' : 'Open full review →'}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <h3>Side Items</h3>
          <div className="side-items-container">
            {catalog.sideItems.map((item, idx) => (
              <div key={idx} className="side-item">
                <span className="side-item-path">{item.relativePath}</span>
                <span className="side-item-kind">({item.kind})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}