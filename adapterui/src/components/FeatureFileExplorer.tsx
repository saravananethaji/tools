import React, { useState, useRef, useMemo, useEffect } from 'react';
import './FeatureFileExplorer.css';
import {
  parseFeatureText,
  generateMarkdownExplanation,
  type FeatureAnalysis,
  type FeatureScenario,
  type FeatureStep,
  type ApiCall,
  type DbValidation,
} from './featureParser';
import { SAMPLE_FEATURE_CONTENT, SAMPLE_FEATURE_NAME } from './sampleFeature';

type TabView = 'scenarios' | 'apis' | 'validations' | 'artifacts' | 'explanation' | 'raw';

export const FeatureFileExplorer: React.FC = () => {
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [rawText, setRawText] = useState<string>('');
  const [analysis, setAnalysis] = useState<FeatureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabView>('scenarios');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('all');
  const [expandedScenarios, setExpandedScenarios] = useState<Record<number, boolean>>({});
  const [allExpanded, setAllExpanded] = useState<boolean>(true);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, 2400);
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label} to clipboard!`);
    } catch {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      showToast(`Copied ${label} to clipboard!`);
    }
  };

  // Load and parse content
  const processFeatureContent = (content: string, name: string, size: number) => {
    setError(null);
    try {
      const parsed = parseFeatureText(content);
      setAnalysis(parsed);
      setRawText(content);
      setFileName(name);
      setFileSize(size);

      // Expand all scenarios initially
      const initialExpanded: Record<number, boolean> = {};
      parsed.scenarios.forEach(s => {
        initialExpanded[s.index] = true;
      });
      setExpandedScenarios(initialExpanded);
      setAllExpanded(true);
    } catch (err) {
      setError(`Failed to parse feature file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.feature') && !file.name.endsWith('.txt')) {
      setError('Please select a valid .feature or .txt file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      processFeatureContent(content, file.name, file.size);
    };
    reader.onerror = () => {
      setError('Error reading file from disk');
    };
    reader.readAsText(file);
  };

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.feature') && !file.name.endsWith('.txt')) {
      setError('Please drop a valid .feature file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      processFeatureContent(content, file.name, file.size);
    };
    reader.readAsText(file);
  };

  const loadSample = () => {
    processFeatureContent(SAMPLE_FEATURE_CONTENT, SAMPLE_FEATURE_NAME, SAMPLE_FEATURE_CONTENT.length);
    showToast('Loaded sample feature file!');
  };

  const toggleScenario = (index: number) => {
    setExpandedScenarios(prev => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const toggleAllScenarios = () => {
    if (!analysis) return;
    const nextState = !allExpanded;
    const updated: Record<number, boolean> = {};
    analysis.scenarios.forEach(s => {
      updated[s.index] = nextState;
    });
    setExpandedScenarios(updated);
    setAllExpanded(nextState);
  };

  // Filtered scenarios
  const filteredScenarios = useMemo(() => {
    if (!analysis) return [];
    return analysis.scenarios.filter(s => {
      if (filterType !== 'all') {
        if (filterType === 'apis' && s.apiCalls.length === 0) return false;
        if (filterType === 'validations' && s.dbValidations.length === 0) return false;
        if (filterType === 'errors' && (!s.expectedStatus || s.expectedStatus < 400)) return false;
        if (filterType === 'success' && (s.expectedStatus && s.expectedStatus >= 400)) return false;
      }

      if (!searchQuery.trim()) return true;
      const query = searchQuery.toLowerCase();
      const matchName = s.name.toLowerCase().includes(query);
      const matchTags = s.tags.some(t => t.toLowerCase().includes(query));
      const matchSteps = s.steps.some(st => st.text.toLowerCase().includes(query));
      const matchApi = s.apiCalls.some(a => a.uri.toLowerCase().includes(query) || a.method.toLowerCase().includes(query));
      const matchDb = s.dbValidations.some(v => v.tableName.toLowerCase().includes(query));
      return matchName || matchTags || matchSteps || matchApi || matchDb;
    });
  }, [analysis, filterType, searchQuery]);

  const generatedExplanation = useMemo(() => {
    if (!analysis) return '';
    return generateMarkdownExplanation(analysis);
  }, [analysis]);

  return (
    <div className="ffe-container">
      {/* Header & File Dropzone */}
      <div className="ffe-header-card">
        <div className="ffe-header-top">
          <div className="ffe-title-block">
            <h2>Feature File Explorer</h2>
            <p>Inspect Gherkin/Cucumber .feature tests — execution flow, API payloads, tokens, and database assertions.</p>
          </div>

          <div className="ffe-header-actions">
            <button
              className="ffe-btn ffe-btn-accent"
              onClick={loadSample}
              title="Load the bundled sample 01_adapter_apitoapi.feature"
            >
              ⚡ Load Sample Feature
            </button>
            <button
              className="ffe-btn ffe-btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              📂 Browse .feature file
            </button>
          </div>
        </div>

        <input
          type="file"
          accept=".feature,.txt"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="ffe-hidden-input"
        />

        <div
          className={`ffe-dropzone ${isDragOver ? 'ffe-dragover' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="ffe-dropzone-icon">📥</div>
          <div className="ffe-dropzone-text">
            {fileName ? `Active file: ${fileName}` : 'Drop your .feature file here, or click to browse'}
          </div>
          <div className="ffe-dropzone-subtext">
            Supports Gherkin specifications (.feature, .txt) with background steps, tables, and assertions
          </div>
        </div>

        {fileName && analysis && (
          <div className="ffe-file-pill">
            <span className="ffe-file-name">📄 {fileName}</span>
            <div className="ffe-file-meta">
              <span>{(fileSize / 1024).toFixed(1)} KB</span>
              <span>{analysis.stats.totalScenarios} Scenarios</span>
              <span>{analysis.stats.totalSteps} Steps</span>
              <span>{analysis.stats.totalApiCalls} API Calls</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="notice" style={{ borderColor: '#ef4444', background: '#3b1c1c', color: '#fca5a5' }}>
          <strong>Error:</strong> <span>{error}</span>
        </div>
      )}

      {analysis && (
        <>
          {/* Metrics Ribbon */}
          <div className="ffe-metrics-grid">
            <div className="ffe-stat-card blue">
              <span className="ffe-stat-label">Total Scenarios</span>
              <span className="ffe-stat-value">{analysis.stats.totalScenarios}</span>
              <span className="ffe-stat-desc">{analysis.background.steps.length > 0 ? '+ Background Setup' : 'No Background'}</span>
            </div>

            <div className="ffe-stat-card teal">
              <span className="ffe-stat-label">API Endpoints</span>
              <span className="ffe-stat-value">{analysis.stats.totalApiCalls}</span>
              <span className="ffe-stat-desc">HTTP Calls detected</span>
            </div>

            <div className="ffe-stat-card purple">
              <span className="ffe-stat-label">DB Validations</span>
              <span className="ffe-stat-value">{analysis.stats.totalValidations}</span>
              <span className="ffe-stat-desc">{analysis.artifacts.dbTables.join(', ') || 'None'}</span>
            </div>

            <div className="ffe-stat-card amber">
              <span className="ffe-stat-label">Artifacts & Files</span>
              <span className="ffe-stat-value">{analysis.artifacts.payloadFiles.length}</span>
              <span className="ffe-stat-desc">{analysis.artifacts.uuids.length} Correlation UUIDs</span>
            </div>

            <div className="ffe-stat-card rose">
              <span className="ffe-stat-label">Response Statuses</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                {analysis.stats.statusCodes.length > 0 ? (
                  analysis.stats.statusCodes.map(code => (
                    <span
                      key={code}
                      className={`ffe-status-badge ${code < 400 ? 's2xx' : code < 500 ? 's4xx' : 's5xx'}`}
                    >
                      {code}
                    </span>
                  ))
                ) : (
                  <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>None specified</span>
                )}
              </div>
              <span className="ffe-stat-desc">Expected HTTP codes</span>
            </div>
          </div>

          {/* Feature Overview & Dependencies */}
          <div className="ffe-overview-banner">
            <div className="ffe-overview-header">
              <h3 className="ffe-overview-title">Feature: {analysis.feature.name || fileName}</h3>
              {analysis.feature.tags.length > 0 && (
                <div className="ffe-tag-list">
                  {analysis.feature.tags.map((tag, i) => (
                    <span key={i} className="ffe-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>

            {analysis.feature.description.length > 0 && (
              <p style={{ margin: 0, color: '#cbd5e1', fontSize: '0.88rem' }}>
                {analysis.feature.description.join(' ')}
              </p>
            )}

            {analysis.feature.dependencyNotes.length > 0 && (
              <div className="ffe-dep-notice">
                <div className="ffe-dep-title">📌 Execution Order & Prerequisites</div>
                <ul className="ffe-dep-list">
                  {analysis.feature.dependencyNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Navigation Tabs & Search Toolbar */}
          <div className="ffe-toolbar">
            <div className="ffe-tab-list" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === 'scenarios'}
                className={`ffe-tab-btn ${activeTab === 'scenarios' ? 'active' : ''}`}
                onClick={() => setActiveTab('scenarios')}
              >
                📜 Scenarios & Flow <span className="ffe-tab-count">{analysis.scenarios.length}</span>
              </button>

              <button
                role="tab"
                aria-selected={activeTab === 'apis'}
                className={`ffe-tab-btn ${activeTab === 'apis' ? 'active' : ''}`}
                onClick={() => setActiveTab('apis')}
              >
                🌐 API Matrix <span className="ffe-tab-count">{analysis.apiCalls.length}</span>
              </button>

              <button
                role="tab"
                aria-selected={activeTab === 'validations'}
                className={`ffe-tab-btn ${activeTab === 'validations' ? 'active' : ''}`}
                onClick={() => setActiveTab('validations')}
              >
                🗄️ Validations <span className="ffe-tab-count">{analysis.dataValidations.length}</span>
              </button>

              <button
                role="tab"
                aria-selected={activeTab === 'artifacts'}
                className={`ffe-tab-btn ${activeTab === 'artifacts' ? 'active' : ''}`}
                onClick={() => setActiveTab('artifacts')}
              >
                📦 Artifacts & Tokens <span className="ffe-tab-count">{analysis.artifacts.payloadFiles.length + analysis.artifacts.uuids.length}</span>
              </button>

              <button
                role="tab"
                aria-selected={activeTab === 'explanation'}
                className={`ffe-tab-btn ${activeTab === 'explanation' ? 'active' : ''}`}
                onClick={() => setActiveTab('explanation')}
              >
                📝 Human Explanation
              </button>

              <button
                role="tab"
                aria-selected={activeTab === 'raw'}
                className={`ffe-tab-btn ${activeTab === 'raw' ? 'active' : ''}`}
                onClick={() => setActiveTab('raw')}
              >
                📄 Raw .feature
              </button>
            </div>

            {activeTab === 'scenarios' && (
              <div className="ffe-search-box">
                <span>🔍</span>
                <input
                  type="text"
                  placeholder="Filter scenarios, steps, endpoints..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="ffe-btn-icon" onClick={() => setSearchQuery('')} title="Clear search">
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>

          {/* TAB 1: SCENARIOS & FLOW */}
          {activeTab === 'scenarios' && (
            <div className="ffe-scenarios-container">
              <div className="ffe-section-bar">
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <h3>Scenarios ({filteredScenarios.length} of {analysis.scenarios.length})</h3>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      className={`ffe-btn ffe-btn-sm ${filterType === 'all' ? 'ffe-btn-primary' : ''}`}
                      onClick={() => setFilterType('all')}
                    >
                      All
                    </button>
                    <button
                      className={`ffe-btn ffe-btn-sm ${filterType === 'apis' ? 'ffe-btn-primary' : ''}`}
                      onClick={() => setFilterType('apis')}
                    >
                      API Calls ({analysis.apiCalls.length})
                    </button>
                    <button
                      className={`ffe-btn ffe-btn-sm ${filterType === 'validations' ? 'ffe-btn-primary' : ''}`}
                      onClick={() => setFilterType('validations')}
                    >
                      Validations ({analysis.dataValidations.length})
                    </button>
                    <button
                      className={`ffe-btn ffe-btn-sm ${filterType === 'errors' ? 'ffe-btn-primary' : ''}`}
                      onClick={() => setFilterType('errors')}
                    >
                      Errors (4xx/5xx)
                    </button>
                  </div>
                </div>

                <button
                  className="ffe-btn ffe-btn-sm"
                  onClick={toggleAllScenarios}
                >
                  {allExpanded ? '▲ Collapse All' : '▼ Expand All'}
                </button>
              </div>

              {/* Background Card */}
              {analysis.background.steps.length > 0 && filterType === 'all' && !searchQuery && (
                <div className="ffe-card background-card">
                  <div className="ffe-card-header">
                    <div className="ffe-card-title-group">
                      <span className="ffe-type-badge" style={{ background: '#0f3c36', color: '#5eead4', borderColor: '#0d9488' }}>
                        PRE-CONDITIONS / SETUP
                      </span>
                      <h4 className="ffe-scenario-name">Background ({analysis.background.steps.length} steps)</h4>
                    </div>
                    <div className="ffe-badge-group">
                      {analysis.background.expectedStatus && (
                        <span className="ffe-status-badge s2xx">
                          Expected: {analysis.background.expectedStatus}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="ffe-card-body">
                    <ul className="ffe-steps-list">
                      {analysis.background.steps.map((step, idx) => (
                        <StepItem key={idx} step={step} onCopy={copyToClipboard} />
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Scenario Cards */}
              {filteredScenarios.map((scenario) => {
                const isExpanded = !!expandedScenarios[scenario.index];
                return (
                  <div key={scenario.index} className="ffe-card">
                    <div
                      className="ffe-card-header"
                      onClick={() => toggleScenario(scenario.index)}
                    >
                      <div className="ffe-card-title-group">
                        <span className="ffe-scenario-num">#{scenario.index}</span>
                        <h4 className="ffe-scenario-name">{scenario.name}</h4>
                        <span className={`ffe-type-badge ${
                          scenario.type.includes('Negative') || scenario.type.includes('Error') ? 'negative' :
                          scenario.type.includes('Validation') ? 'validation' :
                          scenario.type.includes('Adapter') ? 'adapter' : ''
                        }`}>
                          {scenario.type}
                        </span>
                      </div>

                      <div className="ffe-badge-group">
                        {scenario.expectedStatus && (
                          <span className={`ffe-status-badge ${
                            scenario.expectedStatus < 400 ? 's2xx' : scenario.expectedStatus < 500 ? 's4xx' : 's5xx'
                          }`}>
                            {scenario.expectedStatus} {scenario.expectedStatus === 201 ? 'Created' : scenario.expectedStatus === 400 ? 'Bad Request' : scenario.expectedStatus === 500 ? 'Server Error' : ''}
                          </span>
                        )}
                        <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="ffe-card-body">
                        {scenario.tags.length > 0 && (
                          <div className="ffe-tag-list" style={{ marginBottom: '8px' }}>
                            {scenario.tags.map((t, idx) => (
                              <span key={idx} className="ffe-tag">{t}</span>
                            ))}
                          </div>
                        )}

                        <ul className="ffe-steps-list">
                          {scenario.steps.map((step, idx) => (
                            <StepItem key={idx} step={step} onCopy={copyToClipboard} />
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredScenarios.length === 0 && (
                <div className="empty">
                  <h3>No scenarios match your query</h3>
                  <p className="muted">Try adjusting your search query or category filters.</p>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: API MATRIX */}
          {activeTab === 'apis' && (
            <div className="ffe-matrix-card">
              <div className="ffe-matrix-header">
                <h3>Detected HTTP API Endpoints ({analysis.apiCalls.length})</h3>
                <button
                  className="ffe-btn ffe-btn-sm"
                  onClick={() => copyToClipboard(
                    analysis.apiCalls.map(a => `${a.method} ${a.uri}`).join('\n'),
                    'API endpoints list'
                  )}
                >
                  📋 Copy All Endpoints
                </button>
              </div>

              <div className="ffe-matrix-table-wrap">
                <table className="ffe-matrix-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Endpoint URI</th>
                      <th>Expected Status</th>
                      <th>Request Payload</th>
                      <th>Correlation UUID</th>
                      <th>Scenario Context</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.apiCalls.map((api, i) => (
                      <tr key={i}>
                        <td>
                          <span className={`ffe-method-badge ${api.method}`}>{api.method}</span>
                        </td>
                        <td>
                          <span className="ffe-uri-code">{api.uri}</span>
                        </td>
                        <td>
                          {api.expectedStatus ? (
                            <span className={`ffe-status-badge ${
                              api.expectedStatus < 400 ? 's2xx' : api.expectedStatus < 500 ? 's4xx' : 's5xx'
                            }`}>
                              {api.expectedStatus}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {api.requestBodyFile ? (
                            <code className="ffe-token-path" title={api.requestBodyFile}>
                              {api.requestBodyFile.split('/').pop()}
                            </code>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {api.uuid ? (
                            <code className="ffe-token-quote" style={{ fontSize: '0.72rem' }}>
                              {api.uuid.substring(0, 18)}...
                            </code>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                            #{api.scenarioIndex} {api.scenarioName}
                          </span>
                        </td>
                        <td>
                          <button
                            className="ffe-btn-icon"
                            onClick={() => copyToClipboard(api.uri, 'API URI')}
                            title="Copy URI"
                          >
                            📋
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: DATA VALIDATIONS */}
          {activeTab === 'validations' && (
            <div className="ffe-matrix-card">
              <div className="ffe-matrix-header">
                <h3>Database Assertions & Validations ({analysis.dataValidations.length})</h3>
              </div>

              <div className="ffe-matrix-table-wrap">
                <table className="ffe-matrix-table">
                  <thead>
                    <tr>
                      <th>Target Table</th>
                      <th>Record Count</th>
                      <th>Filter Criteria</th>
                      <th>Expected Values</th>
                      <th>Scenario</th>
                      <th>Step Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.dataValidations.map((val, i) => (
                      <tr key={i}>
                        <td>
                          <strong style={{ color: '#5eead4', fontFamily: 'ui-monospace, monospace' }}>
                            {val.tableName}
                          </strong>
                        </td>
                        <td>
                          {val.recordCount !== undefined ? (
                            <span className="ffe-cell-status-processed">
                              Count = {val.recordCount}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {val.criteria.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              {val.criteria.map((c, cIdx) => (
                                <code key={cIdx} style={{ fontSize: '0.74rem', color: '#93c5fd' }}>
                                  {c.column} {c.operator} "{c.value}"
                                </code>
                              ))}
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {val.expectedValues.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              {val.expectedValues.map((ev, evIdx) => (
                                <code key={evIdx} style={{ fontSize: '0.74rem', color: '#6ee7b7' }}>
                                  {ev.column} = "{ev.value}"
                                </code>
                              ))}
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: '0.8rem' }}>#{val.scenarioIndex} {val.scenarioName}</span>
                        </td>
                        <td>
                          <span style={{ fontFamily: 'monospace', color: '#64748b' }}>Line {val.stepLine}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: ARTIFACTS & TOKENS */}
          {activeTab === 'artifacts' && (
            <div className="ffe-artifacts-grid">
              {/* Payload Files */}
              <div className="ffe-artifact-card">
                <div className="ffe-artifact-header">
                  <h4>Payload Files ({analysis.artifacts.payloadFiles.length})</h4>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() => copyToClipboard(analysis.artifacts.payloadFiles.join('\n'), 'Payload files')}
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.payloadFiles.map((file, i) => (
                    <li key={i} className="ffe-artifact-item">
                      <span>📄 {file}</span>
                      <button
                        className="ffe-btn-icon"
                        onClick={() => copyToClipboard(file, 'file path')}
                        title="Copy Path"
                      >
                        📋
                      </button>
                    </li>
                  ))}
                  {analysis.artifacts.payloadFiles.length === 0 && (
                    <li className="muted">No payload files detected</li>
                  )}
                </ul>
              </div>

              {/* Correlation UUIDs */}
              <div className="ffe-artifact-card">
                <div className="ffe-artifact-header">
                  <h4>Correlation UUIDs ({analysis.artifacts.uuids.length})</h4>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() => copyToClipboard(analysis.artifacts.uuids.join('\n'), 'UUIDs')}
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.uuids.map((uuid, i) => (
                    <li key={i} className="ffe-artifact-item">
                      <span style={{ color: '#a78bfa' }}>🔑 {uuid}</span>
                      <button
                        className="ffe-btn-icon"
                        onClick={() => copyToClipboard(uuid, 'UUID')}
                        title="Copy UUID"
                      >
                        📋
                      </button>
                    </li>
                  ))}
                  {analysis.artifacts.uuids.length === 0 && (
                    <li className="muted">No UUIDs detected</li>
                  )}
                </ul>
              </div>

              {/* Database Tables */}
              <div className="ffe-artifact-card">
                <div className="ffe-artifact-header">
                  <h4>Database Tables ({analysis.artifacts.dbTables.length})</h4>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() => copyToClipboard(analysis.artifacts.dbTables.join('\n'), 'Tables')}
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.dbTables.map((table, i) => (
                    <li key={i} className="ffe-artifact-item">
                      <span style={{ color: '#5eead4' }}>🗃️ {table}</span>
                      <button
                        className="ffe-btn-icon"
                        onClick={() => copyToClipboard(table, 'table name')}
                        title="Copy Table"
                      >
                        📋
                      </button>
                    </li>
                  ))}
                  {analysis.artifacts.dbTables.length === 0 && (
                    <li className="muted">No tables detected</li>
                  )}
                </ul>
              </div>

              {/* JWT Tokens */}
              <div className="ffe-artifact-card">
                <div className="ffe-artifact-header">
                  <h4>JWT Tokens ({analysis.artifacts.jwtTokens.length})</h4>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() => copyToClipboard(analysis.artifacts.jwtTokens.join('\n'), 'JWT tokens')}
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.jwtTokens.map((token, i) => (
                    <li key={i} className="ffe-artifact-item">
                      <span style={{ color: '#38bdf8' }}>
                        🛡️ {token.substring(0, 22)}...{token.substring(token.length - 10)} ({token.length} chars)
                      </span>
                      <button
                        className="ffe-btn-icon"
                        onClick={() => copyToClipboard(token, 'JWT Token')}
                        title="Copy Token"
                      >
                        📋
                      </button>
                    </li>
                  ))}
                  {analysis.artifacts.jwtTokens.length === 0 && (
                    <li className="muted">No JWT tokens detected</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* TAB 5: HUMAN EXPLANATION */}
          {activeTab === 'explanation' && (
            <div className="ffe-code-view-card">
              <div className="ffe-code-toolbar">
                <span style={{ fontWeight: 600, color: '#f8fafc' }}>
                  Generated Human-Readable Documentation & Sequence
                </span>
                <button
                  className="ffe-btn ffe-btn-primary ffe-btn-sm"
                  onClick={() => copyToClipboard(generatedExplanation, 'Explanation markdown')}
                >
                  📋 Copy Markdown
                </button>
              </div>
              <pre className="ffe-code-content">{generatedExplanation}</pre>
            </div>
          )}

          {/* TAB 6: RAW FEATURE */}
          {activeTab === 'raw' && (
            <div className="ffe-code-view-card">
              <div className="ffe-code-toolbar">
                <span style={{ fontWeight: 600, color: '#f8fafc' }}>
                  Raw Feature Source: {fileName || 'feature'}
                </span>
                <button
                  className="ffe-btn ffe-btn-primary ffe-btn-sm"
                  onClick={() => copyToClipboard(rawText, 'Raw feature content')}
                >
                  📋 Copy Raw Feature
                </button>
              </div>
              <pre className="ffe-code-content">{rawText}</pre>
            </div>
          )}
        </>
      )}

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="ffe-toast">
          <span>✓</span>
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// Helper Component: StepItem
// -----------------------------------------------------------------------------

interface StepItemProps {
  step: FeatureStep;
  onCopy: (text: string, label: string) => void;
}

const StepItem: React.FC<StepItemProps> = ({ step, onCopy }) => {
  const kwClass = `ffe-keyword-${step.keyword.toLowerCase()}`;

  return (
    <li className="ffe-step-item">
      <div className="ffe-step-row">
        <span className="ffe-step-line">L{step.lineNumber}</span>
        <span className={`ffe-step-keyword ${kwClass}`}>{step.keyword}</span>
        <div className="ffe-step-text-wrap">
          <FormattedStepText text={step.text} onCopy={onCopy} />
        </div>
      </div>

      {step.table && (
        <div className="ffe-table-wrapper">
          <table className="ffe-step-table">
            <thead>
              <tr>
                {step.table.headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {step.table.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}>
                      {cell === 'PROCESSED' ? (
                        <span className="ffe-cell-status-processed">{cell}</span>
                      ) : cell.includes('-') && cell.length > 15 ? (
                        <span className="ffe-cell-highlight">{cell}</span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {step.docString && (
        <pre className="ffe-jwt-expanded" style={{ marginLeft: '104px' }}>
          {step.docString}
        </pre>
      )}
    </li>
  );
};

// -----------------------------------------------------------------------------
// Helper Component: FormattedStepText with Token Truncation
// -----------------------------------------------------------------------------

interface FormattedStepTextProps {
  text: string;
  onCopy: (text: string, label: string) => void;
}

const FormattedStepText: React.FC<FormattedStepTextProps> = ({ text, onCopy }) => {
  const [jwtExpanded, setJwtExpanded] = useState<boolean>(false);

  // Check for JWT token pattern
  const jwtMatch = text.match(/(jwt\s+)?(eyJ[a-zA-Z0-9_\-\.]{30,})/);

  if (jwtMatch) {
    const prefix = text.substring(0, jwtMatch.index);
    const token = jwtMatch[2];
    const suffix = text.substring((jwtMatch.index || 0) + jwtMatch[0].length);
    const preview = `${token.substring(0, 16)}...${token.substring(token.length - 12)}`;

    return (
      <span>
        {renderQuotedText(prefix)}
        <span className="ffe-jwt-chip-container">
          <span className="ffe-jwt-chip">
            <span className="ffe-jwt-tag">JWT TOKEN</span>
            <span className="ffe-jwt-preview">{preview}</span>
            <span style={{ color: '#64748b' }}>({token.length} chars)</span>
            <button
              className="ffe-btn-icon"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(token, 'JWT Token');
              }}
              title="Copy full JWT"
            >
              📋
            </button>
            <button
              className="ffe-btn-icon"
              onClick={(e) => {
                e.stopPropagation();
                setJwtExpanded(!jwtExpanded);
              }}
              title={jwtExpanded ? 'Collapse token' : 'Expand full token'}
            >
              {jwtExpanded ? '▲' : '▼'}
            </button>
          </span>
          {jwtExpanded && (
            <div className="ffe-jwt-expanded">
              {token}
            </div>
          )}
        </span>
        {renderQuotedText(suffix)}
      </span>
    );
  }

  return <>{renderQuotedText(text)}</>;
};

function renderQuotedText(str: string): React.ReactNode {
  const parts = str.split(/(".*?"|'.*?')/g);

  return parts.map((part, index) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      const inner = part.slice(1, -1);
      const isPath = inner.includes('/') || inner.endsWith('.json') || inner.endsWith('.xml');
      return (
        <code
          key={index}
          className={isPath ? 'ffe-token-path' : 'ffe-token-quote'}
        >
          {part}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export default FeatureFileExplorer;
