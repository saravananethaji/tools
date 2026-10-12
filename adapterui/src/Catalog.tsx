import React, { useState } from 'react';
import { readFolder } from './folder';
import { composeCatalog } from './folder';
import { buildReview } from './review';
import type { CatalogModel, Finding, FolderScan, ReviewModel, SourceArtifact } from './model';
import { parseJson, parseTemplate } from './parser';
import { Findings, OverflowTable } from './ui';

// We'll also need to import the Css classes? We'll assume they are available via the existing CSS.

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
      <h1>Folder Browser</h1>
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
            <div key={useCase.registrationPath} style={{ border: '1px solid #ccc', margin: '10px', padding: '10px' }}>
              <h3>{useCase.registration.name} ({useCase.registration.type})</h3>
              <p>Status: {useCase.registration.status}</p>
              <h4>Stages</h4>
              <OverflowTable>
                <table>
                  <thead>
                    <tr>
                      <th>Entry Type</th>
                      <th>Entry ID</th>
                      <th>Template File</th>
                      <th>Matched</th>
                      <th>Process Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {useCase.stages.map((stage, stageIndex) => (
                      <tr key={stageIndex}>
                        <td>{stage.entryType}</td>
                        <td>{stage.entryId}</td>
                        <td>{stage.templateFilePath ?? 'None'}</td>
                        <td>{stage.matched ? 'Yes' : 'No'}</td>
                        <td>{stage.processReference}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </OverflowTable>
              <h4>Missing</h4>
              <ul>
                {useCase.missing.map((m, idx) => (
                  <li key={idx}>{m.id} ({m.type})</li>
                ))}
              </ul>
              <h4>Extra</h4>
              <ul>
                {useCase.extra.map((e, idx) => (
                  <li key={idx}>{e}</li>
                ))}
              </ul>
              <h4>Duplicates</h4>
              <ul>
                {useCase.duplicates.map((d, idx) => (
                  <li key={idx}>{d}</li>
                ))}
              </ul>
              <h4>Health</h4>
              <p>{useCase.health}</p>
              <h4>Finding Groups</h4>
              <OverflowTable>
                <table>
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
                        <td>{fg.severity}</td>
                        <td>{fg.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </OverflowTable>
              <button
                className="load-button primary"
                onClick={() => handleOpenReview(useCase.registrationPath)}
                aria-label={`Open full review for ${useCase.registration.name}`}
              >
                {openedPath === useCase.registrationPath ? 'Opened in reviewer →' : 'Open full review →'}
              </button>
            </div>
          ))}
          <h3>Side Items</h3>
          <ul>
            {catalog.sideItems.map((item, idx) => (
              <li key={idx}>
                {item.relativePath} - {item.kind}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}