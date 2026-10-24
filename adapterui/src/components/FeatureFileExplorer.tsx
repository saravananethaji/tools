import React, { useState, useRef, useMemo, useEffect } from 'react';
import './FeatureFileExplorer.css';
import type { Finding, ReviewModel } from '../model';
import {
  parseFeatureText,
  generateMarkdownExplanation,
  type FeatureAnalysis,
  type FeatureScenario,
  type FeatureStep,
  type ApiCall,
  type DbValidation,
  type ConfigPair,
  type DetectedAdapterConfig,
  type DetectedTemplateConfig,
} from './featureParser';
import { SAMPLE_FEATURE_CONTENT, SAMPLE_FEATURE_NAME } from './sampleFeature';
import {
  inspectPayloadJson,
  buildReviewsFromPayloads,
  matchesPath,
  isSamplePayloadPath,
  getBundledSampleResolutions,
  type ResolvedPayloadFile,
} from './featureAdapterBridge';
import { strictBase64Decode } from '../parser';

type TabView = 'scenarios' | 'adapters' | 'apis' | 'validations' | 'artifacts' | 'explanation' | 'raw';

export interface FeatureFileExplorerProps {
  onOpenReviews?: (reviews: ReviewModel[], findings: Finding[]) => void;
}

import { DiscoveryModeUI } from './DiscoveryModeUI';

export const FeatureFileExplorer: React.FC<FeatureFileExplorerProps> = ({ onOpenReviews }) => {
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [rawText, setRawText] = useState<string>('');
  const [analysis, setAnalysis] = useState<FeatureAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabView>('scenarios');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('all');
  const [expandedScenarios, setExpandedScenarios] = useState<Record<number, boolean>>({});
  const [expandedPreconditions, setExpandedPreconditions] = useState<boolean>(true);
  const [allExpanded, setAllExpanded] = useState<boolean>(true);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Resolved payload files state (keyed by feature target path)
  const [resolvedFiles, setResolvedFiles] = useState<Record<string, ResolvedPayloadFile>>({});
  const [folderResolving, setFolderResolving] = useState<boolean>(false);

  // Inspecting payload modal
  const [inspectingPayload, setInspectingPayload] = useState<{
    name: string;
    path: string;
    file?: ResolvedPayloadFile;
  } | null>(null);

  // Pasting JSON modal
  const [pastingForPath, setPastingForPath] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState<string>('');

  const [targetUploadPath, setTargetUploadPath] = useState<string | null>(null);
  const [focusedFlowId, setFocusedFlowId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'single' | 'discovery'>('single');
  const isDiscoveryMode = mode === 'discovery';
  const [discoveredFeatures, setDiscoveredFeatures] = useState<Array<{
    name: string; fileName: string; relativePath: string; scenarioCount: number;
    backgroundSteps: number; tagsList: string[]; rawText: string;
  }>>([]);
  const [selectedFeature, setSelectedFeature] = useState<{ name: string; fileName: string; relativePath: string; scenarioCount: number; backgroundSteps: number; tagsList: string[]; rawText: string } | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const singleFileInputRef = useRef<HTMLInputElement>(null);

  const jumpToFlow = (flowId: string) => {
    setActiveTab('adapters');
    setFocusedFlowId(flowId);
    setTimeout(() => {
      const el = document.getElementById(`flow-${flowId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  };

  const jumpToScenario = (scenarioIndex: number) => {
    setActiveTab('scenarios');
    setExpandedScenarios(prev => ({ ...prev, [scenarioIndex]: true }));
    setTimeout(() => {
      const el = document.getElementById(`scenario-${scenarioIndex}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, 2500);
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label} to clipboard!`);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      showToast(`Copied ${label} to clipboard!`);
    }
  };

  // Auto-resolve known sample payloads
  
  const scanFolderForFeatures = (folderHandle: FileSystemDirectoryHandle) => {
    const features: Array<{ name: string; fileName: string; relativePath: string; scenarioCount: number; backgroundSteps: number; tagsList: string[]; rawText: string }> = [];
    const scanDir = async (dir: FileSystemDirectoryHandle, basePath = '') => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && name.endsWith('.feature')) {
          try {
            const file = await handle.getFile();
            const text = await file.text();
            const parsed = parseFeatureText(text);
            features.push({
              name: parsed.feature.name || name.replace('.feature', ''),
              fileName: name,
              relativePath: basePath ? `${basePath}/${name}` : name,
              scenarioCount: parsed.scenarios.length,
              backgroundSteps: parsed.background.steps.length,
              tagsList: parsed.feature.tags || [],
              rawText: text,
            });
          } catch {
            // Skip unparseable feature files
          }
        } else if (handle.kind === 'directory') {
          await scanDir(handle, basePath ? `${basePath}/${name}` : name);
        }
      }
    };
    return scanDir(folderHandle).then(() => features);
  };

  const selectFeatureForExploration = (feat: typeof discoveredFeatures[0]) => {
    setSelectedFeature(feat);
    setMode('single');
    setFileName(feat.fileName);
    setFileSize(feat.rawText.length);
    setRawText(feat.rawText);
    const parsed = parseFeatureText(feat.rawText);
    setAnalysis(parsed);
    autoResolveKnownFiles(parsed);
    setError(null);
    setActiveTab('scenarios');
    setExpandedScenarios({});
    setExpandedPreconditions(true);
  };

  const goBackToDiscovery = () => {
    setSelectedFeature(null);
    setMode('discovery');
    setAnalysis(null);
    setFileName('');
    setRawText('');
    setFileSize(0);
    setError(null);
    setActiveTab('scenarios');
  };

  const handleParentFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    setDiscoveryError('Scanning folder...');
    setDiscoveredFeatures([]);
    
    try {
      const filesList = Array.from(files);
      const discovered: typeof discoveredFeatures = [];
      
      for (const f of filesList) {
        if (f.name.endsWith('.feature')) {
          const relPath = f.webkitRelativePath || f.name;
          try {
            const text = await f.text();  // Actually read the file content
            const parsed = parseFeatureText(text);
            discovered.push({
              name: parsed.feature.name || f.name.replace('.feature', ''),
              fileName: f.name,
              relativePath: relPath,
              scenarioCount: parsed.scenarios.length,
              backgroundSteps: parsed.background.steps.length,
              tagsList: parsed.feature.tags || [],
              rawText: text,
            });
          } catch {
            // Skip unparseable files
          }
        }
      }
      
      setDiscoveredFeatures(discovered);
      if (discovered.length === 0) {
        setDiscoveryError('No .feature files found in the selected folder.');
      } else {
        setDiscoveryError(null);
      }
    } catch (err) {
      setDiscoveryError(`Failed to scan folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    
    // Reset so same folder can be re-selected
    if (e.target) e.target.value = '';
  };

  const autoResolveKnownFiles = (parsed: FeatureAnalysis) => {
    const resolutions: Record<string, ResolvedPayloadFile> = {};
    const bundledSamples = getBundledSampleResolutions();

    parsed.artifacts.payloadFiles.forEach(path => {
      const sampleType = isSamplePayloadPath(path);
      if (sampleType === 'adapter') {
        const sampleAdapter = bundledSamples.find(s => s.fileKind === 'registration');
        if (sampleAdapter) {
          resolutions[path] = {
            ...sampleAdapter,
            path,
          };
        }
      } else if (sampleType === 'template') {
        const sampleTemplate = bundledSamples.find(s => s.fileKind === 'template');
        if (sampleTemplate) {
          resolutions[path] = {
            ...sampleTemplate,
            path,
          };
        }
      }
    });

    setResolvedFiles(prev => ({
      ...prev,
      ...resolutions,
    }));
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

      // Auto-resolve matching sample payloads
      autoResolveKnownFiles(parsed);
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
    setExpandedPreconditions(nextState);
  };

  // Resolve files from local folder picker - auto-discovers feature files and resolves payloads
  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setFolderResolving(true);
    setError(null);

    // Generate path variants: exact, parent (..), grandparent (../../), great-grandparent (../../../)
    // This handles cases where template paths in the feature file are relative to a parent/grandparent
    // folder of where the feature file was selected.
    const pathVariants = (targetPath: string): string[] => [
      targetPath,
      `../${targetPath}`,
      `../../${targetPath}`,
      `../../../${targetPath}`,
    ];

    try {
      const fileList = Array.from(files);

      // Step 1: Find and parse .feature files from the selected folder
      const featureFiles = fileList.filter(f => f.name.endsWith('.feature'));

      if (featureFiles.length === 0) {
        showToast('No .feature files found in the selected folder.');
        return;
      }

      // Step 2: Parse the first .feature file found
      const featureFile = featureFiles[0];
      const featureText = await featureFile.text();
      const parsed = parseFeatureText(featureText);
      setAnalysis(parsed);
      setRawText(featureText);
      setFileName(featureFile.name);
      setFileSize(featureFile.size);

      // Expand all scenarios initially
      const initialExpanded: Record<number, boolean> = {};
      parsed.scenarios.forEach(s => {
        initialExpanded[s.index] = true;
      });
      setExpandedScenarios(initialExpanded);
      setAllExpanded(true);

      // Step 3: Extract payload paths from the parsed feature and match against folder contents
      const targetPaths = parsed.artifacts.payloadFiles;
      let matchedCount = 0;
      const newResolutions: Record<string, ResolvedPayloadFile> = {};

      if (targetPaths.length > 0) {
        for (const targetPath of targetPaths) {
          const variants = pathVariants(targetPath);
          const matchedFile = fileList.find(f => {
            const relPath = f.webkitRelativePath || f.name;
            return variants.some(v => matchesPath(v, relPath, f.name));
          });

          if (matchedFile) {
            const text = await matchedFile.text();
            const inspection = inspectPayloadJson(text, matchedFile.name);
            newResolutions[targetPath] = {
              name: matchedFile.name,
              path: targetPath,
              rawText: text,
              source: 'folder',
              fileKind: inspection.kind,
              parsedJson: inspection.parsed,
              parseError: inspection.error,
            };
            matchedCount++;
          }
        }
      }

      setResolvedFiles(prev => ({ ...prev, ...newResolutions }));

      if (matchedCount > 0) {
        showToast(`Loaded "${featureFile.name}" — auto-resolved ${matchedCount} payload file${matchedCount === 1 ? '' : 's'} from folder!`);
      } else {
        const suggested = suggestFolderFromPaths(targetPaths);
        const hint = suggested
          ? ` Try selecting the "${suggested}" folder (common ancestor containing both feature and payload files).`
          : ' Try selecting a parent folder that contains both the feature file and its payload/template files.';
        showToast(`Loaded "${featureFile.name}" — no payload files matched.${hint}`);
      }
    } catch (err) {
      setError(`Failed to process folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setFolderResolving(false);
      if (e.target) e.target.value = '';
    }
  };

  // Derive a suggested folder from payload paths referenced in the feature file.
  // If a payload path starts with a drive letter (Windows absolute) or an absolute path,
  // we can't derive the base folder from the browser. But if it's a relative path like
  // src/test/resources/..., the user should select a folder that, combined with that path,
  // reaches the actual payload files.
  const suggestFolderFromPaths = (paths: string[]): string | null => {
    for (const p of paths) {
      const norm = p.replace(/\\/g, '/').replace(/^([a-zA-Z]:)/, '');
      const parts = norm.split('/').filter(Boolean);
      if (parts.length >= 3) {
        // Return the first 2-3 path segments as a suggested folder prefix
        return parts.slice(0, 3).join('/');
      }
    }
    return null;
  };

  // Single file upload trigger
  const triggerSingleUpload = (path: string) => {
    setTargetUploadPath(path);
    singleFileInputRef.current?.click();
  };

  const handleSingleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const path = targetUploadPath;
    if (!file || !path) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const inspection = inspectPayloadJson(text, file.name);
      setResolvedFiles(prev => ({
        ...prev,
        [path]: {
          name: file.name,
          path,
          rawText: text,
          source: 'upload',
          fileKind: inspection.kind,
          parsedJson: inspection.parsed,
          parseError: inspection.error,
        },
      }));
      showToast(`Loaded ${file.name} for ${path.split('/').pop()}!`);
    };
    reader.readAsText(file);
    if (singleFileInputRef.current) singleFileInputRef.current.value = '';
  };

  // Pasted JSON save
  const handleSavePastedJson = () => {
    if (!pastingForPath || !pastedText.trim()) return;
    const fileName = pastingForPath.split('/').pop() || 'pasted.json';
    const inspection = inspectPayloadJson(pastedText, fileName);
    if (inspection.error) {
      showToast(`Invalid JSON: ${inspection.error}`);
      return;
    }

    setResolvedFiles(prev => ({
      ...prev,
      [pastingForPath]: {
        name: fileName,
        path: pastingForPath,
        rawText: pastedText,
        source: 'pasted',
        fileKind: inspection.kind,
        parsedJson: inspection.parsed,
      },
    }));
    showToast(`Saved JSON for ${fileName}!`);
    setPastingForPath(null);
    setPastedText('');
  };

  // Launch review into adapter reviewer
  const handleOpenInReviewer = (pair: ConfigPair) => {
    if (!onOpenReviews) {
      showToast('Adapter reviewer is not wired in current context');
      return;
    }

    const adapterPath = pair.adapterConfig?.path;
    const adapterFile = adapterPath ? resolvedFiles[adapterPath] : undefined;

    const templateFiles: ResolvedPayloadFile[] = [];
    pair.templateConfigs.forEach(t => {
      const tplFile = resolvedFiles[t.path];
      if (tplFile) templateFiles.push(tplFile);
    });

    if (!adapterFile) {
      showToast(`Adapter configuration file missing for ${pair.adapterConfig?.fileName || 'adapter'}`);
      return;
    }
    if (templateFiles.length === 0) {
      showToast(`Template configuration file missing for ${pair.templateConfigs[0]?.fileName || 'template'}`);
      return;
    }

    const result = buildReviewsFromPayloads(adapterFile, templateFiles);
    if (result.error || result.reviews.length === 0) {
      setError(`Could not launch review: ${result.error || 'No matching reviews'}`);
      showToast(`Review error: ${result.error || 'Check findings'}`);
      return;
    }

    onOpenReviews(result.reviews, result.findings);
  };

  // Filtered scenarios
  const filteredScenarios = useMemo(() => {
    if (!analysis) return [];
    return analysis.scenarios.filter(s => {
      if (filterType !== 'all') {
        if (filterType === 'apis' && s.apiCalls.length === 0) return false;
        if (filterType === 'validations' && s.dbValidations.length === 0) return false;
        if (filterType === 'errors' && (!s.expectedStatus || s.expectedStatus < 400)) return false;
        if (filterType === 'success' && s.expectedStatus && s.expectedStatus >= 400) return false;
      }

      if (!searchQuery.trim()) return true;
      const query = searchQuery.toLowerCase();
      const matchName = s.name.toLowerCase().includes(query);
      const matchTags = s.tags.some(t => t.toLowerCase().includes(query));
      const matchSteps = s.steps.some(st => st.text.toLowerCase().includes(query));
      const matchApi = s.apiCalls.some(
        a => a.uri.toLowerCase().includes(query) || a.method.toLowerCase().includes(query)
      );
      const matchDb = s.dbValidations.some(v => v.tableName.toLowerCase().includes(query));
      return matchName || matchTags || matchSteps || matchApi || matchDb;
    });
  }, [analysis, filterType, searchQuery]);

  const generatedExplanation = useMemo(() => {
    if (!analysis) return '';
    return generateMarkdownExplanation(analysis);
  }, [analysis]);

  // Decoded XML route for inspectingPayload
  const decodedXml = useMemo(() => {
    if (!inspectingPayload?.file?.rawText) return null;
    try {
      const parsed = JSON.parse(inspectingPayload.file.rawText);
      if (parsed && typeof parsed.xmlRoute === 'string') {
        const decoded = strictBase64Decode(parsed.xmlRoute, 'template', '$.xmlRoute');
        return decoded.text || null;
      }
    } catch {
      return null;
    }
    return null;
  }, [inspectingPayload]);

  if (isDiscoveryMode) {
    const folderHandleRef = folderInputRef;
    return (
      <DiscoveryModeUI
        discoveredFeatures={discoveredFeatures}
        discoveryError={discoveryError}
        selectedFeature={selectedFeature}
        onParentFolderSelect={handleParentFolderSelect}
        onSelectFeature={selectFeatureForExploration}
        onBackToDiscovery={goBackToDiscovery}
      />
    );
  }

  return (
    <div className="ffe-container">
      {/* Hidden Folder & Single File Inputs */}
      <input
        type="file"
        multiple
        ref={folderInputRef}
        style={{ display: 'none' }}
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={handleFolderSelect}
      />
      <input
        type="file"
        accept=".json,.xml,.txt"
        ref={singleFileInputRef}
        style={{ display: 'none' }}
        onChange={handleSingleFileUpload}
      />

      {/* Header & File Dropzone */}
      <div className="ffe-header-card">
        <div className="ffe-header-top">
          <div className="ffe-title-block">
            <h2>Feature File Explorer</h2>
            <p>
              Inspect Gherkin/Cucumber .feature tests — execution flow, adapter configs, API payloads, and assertions.
            </p>
          </div>

          <div className="ffe-header-actions">
            {(
              isDiscoveryMode ? (
                <>
                  <button
                    className="ffe-btn ffe-btn-secondary"
                    onClick={() => setMode('single')}
                  >
                    📄 Single Feature Mode
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="ffe-btn ffe-btn-secondary"
                    onClick={() => setMode('discovery')}
                  >
                    🔍 Feature Discovery
                  </button>
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
                </>
              )
            )}
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
            Supports Gherkin specifications (.feature, .txt) with adapter/template payloads, tables, and assertions
          </div>
        </div>

        {fileName && analysis && (
          <div className="ffe-file-pill">
            <span className="ffe-file-name">📄 {fileName}</span>
            <div className="ffe-file-meta">
              <span>{(fileSize / 1024).toFixed(1)} KB</span>
              <span>{analysis.stats.totalScenarios} Scenarios</span>
              <span>{analysis.stats.totalApiCalls} API Calls</span>
              <span>{analysis.configurations.pairs.length} Adapter Flows</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div
          className="notice"
          style={{ borderColor: '#ef4444', background: '#3b1c1c', color: '#fca5a5' }}
        >
          <strong>Notice:</strong> <span>{error}</span>
        </div>
      )}

      {analysis && (
        <>
          {/* Metrics Ribbon */}
          <div className="ffe-metrics-grid">
            <div className="ffe-stat-card blue">
              <span className="ffe-stat-label">Total Scenarios</span>
              <span className="ffe-stat-value">{analysis.stats.totalScenarios}</span>
              <span className="ffe-stat-desc">
                {analysis.background.steps.length > 0 ? '+ Background Setup' : 'No Background'}
              </span>
            </div>

            <div className="ffe-stat-card teal">
              <span className="ffe-stat-label">Adapter Flows</span>
              <span className="ffe-stat-value">
                {analysis.configurations.pairs.length || analysis.configurations.adapterConfigs.length}
              </span>
              <span className="ffe-stat-desc">Configurations detected</span>
            </div>

            <div className="ffe-stat-card purple">
              <span className="ffe-stat-label">API Endpoints</span>
              <span className="ffe-stat-value">{analysis.stats.totalApiCalls}</span>
              <span className="ffe-stat-desc">HTTP Calls detected</span>
            </div>

            <div className="ffe-stat-card amber">
              <span className="ffe-stat-label">Payload Files</span>
              <span className="ffe-stat-value">{analysis.artifacts.payloadFiles.length}</span>
              <span className="ffe-stat-desc">
                {Object.keys(resolvedFiles).length} of {analysis.artifacts.payloadFiles.length} Resolved
              </span>
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
                    <span key={i} className="ffe-tag">
                      {tag}
                    </span>
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
                aria-selected={activeTab === 'adapters'}
                className={`ffe-tab-btn ${activeTab === 'adapters' ? 'active' : ''}`}
                onClick={() => setActiveTab('adapters')}
              >
                🔌 Adapter & Templates{' '}
                <span className="ffe-tab-count">
                  {analysis.configurations.pairs.length || analysis.configurations.adapterConfigs.length}
                </span>
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
                📦 Artifacts & Tokens{' '}
                <span className="ffe-tab-count">
                  {analysis.artifacts.payloadFiles.length + analysis.artifacts.uuids.length}
                </span>
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
                  <button
                    className="ffe-btn-icon"
                    onClick={() => setSearchQuery('')}
                    title="Clear search"
                  >
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
                  <h3>
                    Scenarios ({filteredScenarios.length} of {analysis.scenarios.length})
                  </h3>
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

                <button className="ffe-btn ffe-btn-sm" onClick={toggleAllScenarios}>
                  {allExpanded ? '▲ Collapse All' : '▼ Expand All'}
                </button>
              </div>

              {/* Background Card */}
              {analysis.background.steps.length > 0 && filterType === 'all' && !searchQuery && (
                <div className="ffe-card background-card">
                  <div
                    className="ffe-card-header clickable"
                    onClick={() => setExpandedPreconditions(prev => !prev)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="ffe-card-title-group">
                      <span
                        className="ffe-type-badge"
                        style={{ background: '#0f3c36', color: '#5eead4', borderColor: '#0d9488' }}
                      >
                        PRE-CONDITIONS / SETUP
                      </span>
                      <h4 className="ffe-scenario-name">
                        Background ({analysis.background.steps.length} steps)
                      </h4>
                    </div>
                    <span className="ffe-collapse-icon">{expandedPreconditions ? '▲' : '▼'}</span>
                  </div>
                  {expandedPreconditions && (
                    <div className="ffe-card-body">
                      <ul className="ffe-steps-list">
                        {analysis.background.steps.map((step, idx) => (
                          <StepItem key={idx} step={step} onCopy={copyToClipboard} />
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Scenarios List */}
              {filteredScenarios.map(scenario => {
                const isExpanded = expandedScenarios[scenario.index] !== false;
                const isConfigScenario =
                  scenario.type === 'Template Configuration' ||
                  scenario.type === 'Adapter Configuration';

                const matchedFlow = analysis.configurations.pairs.find(
                  p =>
                    p.adapterConfig?.scenarioIndex === scenario.index ||
                    p.templateConfigs.some(t => t.scenarioIndex === scenario.index) ||
                    p.invocations.some(inv => inv.scenarioIndex === scenario.index)
                );
                const matchedFlowIdx = matchedFlow
                  ? analysis.configurations.pairs.findIndex(p => p.id === matchedFlow.id)
                  : -1;

                return (
                  <div key={scenario.index} id={`scenario-${scenario.index}`} className="ffe-card">
                    <div
                      className="ffe-card-header clickable"
                      onClick={() => toggleScenario(scenario.index)}
                    >
                      <div className="ffe-card-title-group">
                        <span className="ffe-scenario-index">#{scenario.index}</span>
                        <span className={`ffe-type-badge ${scenario.type.replace(/\s+/g, '-').toLowerCase()}`}>
                          {scenario.type}
                        </span>

                        {scenario.expectedStatus && (
                          <span
                            className={`ffe-status-badge ${
                              scenario.expectedStatus < 400
                                ? 's2xx'
                                : scenario.expectedStatus < 500
                                ? 's4xx'
                                : 's5xx'
                            }`}
                          >
                            HTTP {scenario.expectedStatus}
                          </span>
                        )}

                        <h4 className="ffe-scenario-name">{scenario.name}</h4>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {matchedFlow ? (
                          <button
                            className="ffe-btn ffe-btn-sm ffe-btn-accent"
                            onClick={(e) => {
                              e.stopPropagation();
                              jumpToFlow(matchedFlow.id);
                            }}
                            title={`Jump to Flow #${matchedFlowIdx + 1} in Adapter & Templates tab`}
                          >
                            🔌 View Flow #{matchedFlowIdx + 1}
                          </button>
                        ) : isConfigScenario ? (
                          <button
                            className="ffe-btn ffe-btn-sm ffe-btn-accent"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveTab('adapters');
                            }}
                            title="Inspect in Adapter & Templates Tab"
                          >
                            🔌 View Config
                          </button>
                        ) : null}
                        <span className="ffe-scenario-line">Line {scenario.lineNumber}</span>
                        <span className="ffe-collapse-icon">{isExpanded ? '▲' : '▼'}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="ffe-card-body">
                        {scenario.tags.length > 0 && (
                          <div className="ffe-tag-list" style={{ marginBottom: '8px' }}>
                            {scenario.tags.map((t, idx) => (
                              <span key={idx} className="ffe-tag">
                                {t}
                              </span>
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

          {/* TAB 2: ADAPTER & TEMPLATES CONFIGURATIONS */}
          {activeTab === 'adapters' && (
            <div className="ffe-config-container">
              {/* Flow Sequence Banner */}
              <div className="ffe-config-banner">
                <h4 className="ffe-config-banner-title">
                  <span>🔄</span> Feature Execution Architecture & Mediator Configuration Flow
                </h4>
                <div className="ffe-flow-steps">
                  <div className="ffe-flow-step">
                    <span className="ffe-flow-step-num">Step 1</span>
                    <span className="ffe-flow-step-title">Template Definition</span>
                    <span className="ffe-flow-step-desc">
                      Registers Camel XML routes and parameters at <code>/system/adapters/templates/*</code>.
                    </span>
                  </div>
                  <div className="ffe-flow-arrow">➔</div>
                  <div className="ffe-flow-step">
                    <span className="ffe-flow-step-num">Step 2</span>
                    <span className="ffe-flow-step-title">Adapter Registration</span>
                    <span className="ffe-flow-step-desc">
                      Binds adapter to template, configuring endpoint URLs, methods, and transformation spec.
                    </span>
                  </div>
                  <div className="ffe-flow-arrow">➔</div>
                  <div className="ffe-flow-step">
                    <span className="ffe-flow-step-num">Step 3</span>
                    <span className="ffe-flow-step-title">Execution & Assertions</span>
                    <span className="ffe-flow-step-desc">
                      Sends event/API requests and verifies <code>adapter_context</code> or <code>ms_inbox_events</code>.
                    </span>
                  </div>
                </div>
              </div>

              {/* Local File Resolver Toolbar */}
              <div className="ffe-config-toolbar">
                <div className="ffe-config-toolbar-left">
                  <button
                    className="ffe-btn ffe-btn-primary"
                    onClick={() => folderInputRef.current?.click()}
                    disabled={folderResolving}
                  >
                    📂 {folderResolving ? 'Resolving Files…' : 'Select Project / Resources Folder'}
                  </button>
                  <span style={{ fontSize: '0.84rem', color: '#94a3b8' }}>
                    Auto-match feature paths against your local files on disk
                  </span>
                </div>

                <div className="ffe-config-toolbar-right">
                  <span
                    className={`ffe-status-pill ${
                      Object.keys(resolvedFiles).length >= analysis.artifacts.payloadFiles.length
                        ? 'resolved'
                        : 'pending'
                    }`}
                  >
                    {Object.keys(resolvedFiles).length} of {analysis.artifacts.payloadFiles.length} Payloads Loaded
                  </span>
                  {Object.keys(resolvedFiles).length > 0 && (
                    <button
                      className="ffe-btn ffe-btn-sm ffe-btn-accent"
                      onClick={() => {
                        setResolvedFiles({});
                        showToast('All payload files reset!');
                      }}
                      title="Clear all loaded adapter and template JSON files"
                    >
                      🔄 Reset All Files
                    </button>
                  )}
                </div>
              </div>

              {/* Flow Switcher for multiple flows */}
              {analysis.configurations.pairs.length > 1 && (
                <div className="ffe-config-flow-switcher">
                  <span style={{ fontSize: '0.84rem', fontWeight: 600, color: '#94a3b8' }}>
                    Adapter Flows ({analysis.configurations.pairs.length}):
                  </span>
                  {analysis.configurations.pairs.map((p, idx) => (
                    <button
                      key={p.id}
                      className={`ffe-btn ffe-btn-sm ${focusedFlowId === p.id ? 'ffe-btn-primary' : ''}`}
                      onClick={() => jumpToFlow(p.id)}
                    >
                      Flow #{idx + 1}: {p.adapterConfig?.adapterId || `Adapter ${idx + 1}`} ({p.templateConfigs.length} {p.templateConfigs.length === 1 ? 'Template' : 'Templates'})
                    </button>
                  ))}
                </div>
              )}

              {/* Configuration Pairs */}
              {analysis.configurations.pairs.map((pair, pIdx) => {
                const adapterPath = pair.adapterConfig?.path;
                const adapterFile = adapterPath ? resolvedFiles[adapterPath] : undefined;
                const hasAdapter = !!adapterFile;

                const totalTemplates = pair.templateConfigs.length;
                const resolvedTemplates = pair.templateConfigs.filter(t => !!resolvedFiles[t.path]);
                const allTemplatesResolved = totalTemplates > 0 && resolvedTemplates.length === totalTemplates;
                const hasTemplates = totalTemplates === 0 || resolvedTemplates.length > 0;

                const canLaunch = hasAdapter && hasTemplates;

                return (
                  <div
                    key={pair.id}
                    id={`flow-${pair.id}`}
                    className={`ffe-config-card ${focusedFlowId === pair.id ? 'ffe-focused-flow' : ''}`}
                  >
                    <div className="ffe-config-card-header">
                      <div className="ffe-config-card-title">
                        <div>
                          <h4>
                            Configuration Flow #{pIdx + 1}: {pair.adapterConfig?.adapterId || 'Adapter Flow'}
                          </h4>
                          <div className="ffe-config-match-reason">
                            🔗 {pair.matchReason}
                            {pair.correlationUuid && (
                              <span style={{ color: '#a78bfa', marginLeft: '6px' }}>
                                (UUID: {pair.correlationUuid})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span className={`ffe-status-pill ${canLaunch ? 'resolved' : 'pending'}`}>
                          {canLaunch ? '✓ Ready for Review' : '⚠ Missing JSON Payloads'}
                        </span>

                        <button
                          className="ffe-btn ffe-btn-launch"
                          disabled={!canLaunch}
                          onClick={() => handleOpenInReviewer(pair)}
                          title={
                            canLaunch
                              ? 'Launch full configuration inspection in Adapter Reviewer'
                              : 'Resolve or upload both Adapter and Template JSONs to inspect'
                          }
                        >
                          🚀 Open in Adapter Reviewer
                        </button>
                      </div>
                    </div>

                    <div className="ffe-config-pair-grid">
                      {/* Column 1: Adapter Registration */}
                      <div className="ffe-config-col adapter">
                        <div className="ffe-config-col-header">
                          <span className="ffe-config-col-title">
                            <span>🔌</span> Adapter Registration JSON
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className={`ffe-status-pill ${hasAdapter ? 'resolved' : 'pending'}`}>
                              {hasAdapter
                                ? `✓ ${adapterFile?.source === 'bundled-sample' ? 'Sample' : 'Loaded'}`
                                : 'Pending File'}
                            </span>
                            {hasAdapter && (
                              <button
                                className="ffe-btn ffe-btn-sm ffe-btn-accent"
                                onClick={() => {
                                  setResolvedFiles(prev => {
                                    const next = { ...prev };
                                    if (pair.adapterConfig?.path) {
                                      delete next[pair.adapterConfig.path];
                                    }
                                    return next;
                                  });
                                  showToast('Reset adapter JSON file!');
                                }}
                                title="Clear the loaded adapter JSON file"
                              >
                                🔄 Reset
                              </button>
                            )}
                          </div>
                        </div>

                        {pair.adapterConfig && (
                          <>
                            <div className="ffe-config-field">
                              <span className="ffe-config-field-label">Feature Scenario</span>
                              <button
                                type="button"
                                className="ffe-scenario-link"
                                onClick={() => jumpToScenario(pair.adapterConfig!.scenarioIndex)}
                                title="Jump to scenario in Scenarios & Flow tab"
                              >
                                Scenario #{pair.adapterConfig.scenarioIndex}: {pair.adapterConfig.scenarioName} ↗
                              </button>
                            </div>

                            <div className="ffe-config-field">
                              <span className="ffe-config-field-label">Target REST URI</span>
                              <span className="ffe-config-field-value">
                                POST {pair.adapterConfig.uri || '/system/adapters'}
                              </span>
                            </div>

                            <div className="ffe-config-field">
                              <span className="ffe-config-field-label">Feature Payload Path</span>
                              <span className="ffe-config-field-value">{pair.adapterConfig.path}</span>
                            </div>

                            <div className="ffe-config-actions-row">
                              {hasAdapter ? (
                                <>
                                  <button
                                    className="ffe-btn ffe-btn-sm ffe-btn-accent"
                                    onClick={() =>
                                      setInspectingPayload({
                                        name: adapterFile.name,
                                        path: pair.adapterConfig!.path,
                                        file: adapterFile,
                                      })
                                    }
                                  >
                                    👁️ Preview JSON
                                  </button>
                                  <button
                                    className="ffe-btn ffe-btn-sm"
                                    onClick={() => {
                                      setResolvedFiles(prev => {
                                        const next = { ...prev };
                                        if (pair.adapterConfig?.path) {
                                          delete next[pair.adapterConfig.path];
                                        }
                                        return next;
                                      });
                                      showToast('Reset adapter JSON file!');
                                    }}
                                    title="Clear the loaded adapter JSON file"
                                  >
                                    🔄 Reset
                                  </button>
                                </>
                              ) : null}

                              <button
                                className="ffe-btn ffe-btn-sm"
                                onClick={() => copyToClipboard(pair.adapterConfig!.path, 'Adapter file path')}
                              >
                                📋 Copy Path
                              </button>

                              <button
                                className="ffe-btn ffe-btn-sm"
                                onClick={() => triggerSingleUpload(pair.adapterConfig!.path)}
                              >
                                📤 Upload
                              </button>

                              <button
                                className="ffe-btn ffe-btn-sm"
                                onClick={() => {
                                  setPastingForPath(pair.adapterConfig!.path);
                                  setPastedText('');
                                }}
                              >
                                📝 Paste
                              </button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Column 2: Template Definitions (All Associated Templates) */}
                      <div className="ffe-config-col template">
                        <div className="ffe-config-col-header">
                          <span className="ffe-config-col-title">
                            <span>🧩</span> {totalTemplates > 1 ? `Associated Templates (${totalTemplates})` : 'Template Definition JSON'}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className={`ffe-status-pill ${allTemplatesResolved ? 'resolved' : 'pending'}`}>
                              {totalTemplates === 0
                                ? 'No Template'
                                : allTemplatesResolved
                                ? `✓ ${totalTemplates > 1 ? `All ${totalTemplates} Loaded` : (resolvedFiles[pair.templateConfigs[0].path]?.source === 'bundled-sample' ? 'Sample' : 'Loaded')}`
                                : `${resolvedTemplates.length} of ${totalTemplates} Loaded`}
                            </span>
                            {(resolvedTemplates.length > 0) && (
                              <button
                                className="ffe-btn ffe-btn-sm ffe-btn-accent"
                                onClick={() => {
                                  setResolvedFiles(prev => {
                                    const next = { ...prev };
                                    pair.templateConfigs.forEach(tpl => {
                                      delete next[tpl.path];
                                    });
                                    return next;
                                  });
                                  showToast(`Reset ${resolvedTemplates.length} template file${resolvedTemplates.length === 1 ? '' : 's'}!`);
                                }}
                                title="Clear all loaded template JSON files for this adapter flow"
                              >
                                🔄 Reset All
                              </button>
                            )}
                          </div>
                        </div>

                        {totalTemplates === 0 ? (
                          <div style={{ color: '#94a3b8', fontSize: '0.84rem', padding: '12px 0' }}>
                            No associated template registration scenario detected for this adapter.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {pair.templateConfigs.map((tpl, tIdx) => {
                              const tplFile = resolvedFiles[tpl.path];
                              const hasTpl = !!tplFile;

                              return (
                                <div key={tIdx} className="ffe-template-subcard">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#38bdf8' }}>
                                      Template #{tIdx + 1}: {tpl.fileName}
                                    </span>
                                    <span
                                      className={`ffe-status-pill ${hasTpl ? 'resolved' : 'pending'}`}
                                      style={{ fontSize: '0.72rem', padding: '2px 6px' }}
                                    >
                                      {hasTpl
                                        ? `✓ ${tplFile?.source === 'bundled-sample' ? 'Sample' : 'Loaded'}`
                                        : 'Pending File'}
                                    </span>
                                  </div>

                                  <div className="ffe-config-field">
                                    <span className="ffe-config-field-label">Feature Scenario</span>
                                    <button
                                      type="button"
                                      className="ffe-scenario-link"
                                      onClick={() => jumpToScenario(tpl.scenarioIndex)}
                                      title="Jump to scenario in Scenarios & Flow tab"
                                    >
                                      Scenario #{tpl.scenarioIndex}: {tpl.scenarioName} ↗
                                    </button>
                                  </div>

                                  <div className="ffe-config-field">
                                    <span className="ffe-config-field-label">Target REST URI</span>
                                    <span className="ffe-config-field-value">
                                      POST {tpl.uri || '/system/adapters/templates'}
                                    </span>
                                  </div>

                                  <div className="ffe-config-field">
                                    <span className="ffe-config-field-label">Feature Payload Path</span>
                                    <span className="ffe-config-field-value">{tpl.path}</span>
                                  </div>

                                  <div className="ffe-config-actions-row">
                                    {hasTpl ? (
                                      <>
                                        <button
                                          className="ffe-btn ffe-btn-sm ffe-btn-accent"
                                          onClick={() =>
                                            setInspectingPayload({
                                              name: tplFile.name,
                                              path: tpl.path,
                                              file: tplFile,
                                            })
                                          }
                                        >
                                          👁️ Preview JSON / XML
                                        </button>
                                        <button
                                          className="ffe-btn ffe-btn-sm"
                                          onClick={() => {
                                            setResolvedFiles(prev => {
                                              const next = { ...prev };
                                              delete next[tpl.path];
                                              return next;
                                            });
                                            showToast(`Reset template: ${tpl.fileName}`);
                                          }}
                                          title={`Clear this template JSON file (${tpl.fileName})`}
                                        >
                                          🔄 Reset
                                        </button>
                                      </>
                                    ) : null}

                                    <button
                                      className="ffe-btn ffe-btn-sm"
                                      onClick={() => copyToClipboard(tpl.path, 'Template file path')}
                                    >
                                      📋 Copy Path
                                    </button>

                                    <button
                                      className="ffe-btn ffe-btn-sm"
                                      onClick={() => triggerSingleUpload(tpl.path)}
                                    >
                                      📤 Upload
                                    </button>

                                    <button
                                      className="ffe-btn ffe-btn-sm"
                                      onClick={() => {
                                        setPastingForPath(tpl.path);
                                        setPastedText('');
                                      }}
                                    >
                                      📝 Paste
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Linked Invocations */}
                    {pair.invocations.length > 0 && (
                      <div className="ffe-config-invocations">
                        <span className="ffe-config-invocations-title">
                          ⚡ Invocation Scenarios Testing This Adapter ({pair.invocations.length})
                        </span>
                        <ul className="ffe-config-invocations-list">
                          {pair.invocations.map((inv, idx) => (
                            <li key={idx} className="ffe-config-invocations-item">
                              <div>
                                <button
                                  type="button"
                                  className="ffe-scenario-link"
                                  style={{ fontWeight: 600, fontSize: '0.88rem' }}
                                  onClick={() => jumpToScenario(inv.scenarioIndex)}
                                  title="Jump to scenario in Scenarios & Flow tab"
                                >
                                  Scenario #{inv.scenarioIndex}: {inv.scenarioName} ↗
                                </button>
                                <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>
                                  <code>POST {inv.uri}</code> · Payload: <code>{inv.fileName}</code>
                                </div>
                              </div>
                              {inv.expectedStatus && (
                                <span
                                  className={`ffe-status-badge ${
                                    inv.expectedStatus < 400
                                      ? 's2xx'
                                      : inv.expectedStatus < 500
                                      ? 's4xx'
                                      : 's5xx'
                                  }`}
                                >
                                  HTTP {inv.expectedStatus}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}

              {analysis.configurations.pairs.length === 0 && (
                <div className="empty">
                  <h3>No Adapter Configuration flows detected</h3>
                  <p className="muted">
                    This feature file does not reference endpoints matching <code>/system/adapters/*</code>.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: API MATRIX */}
          {activeTab === 'apis' && (
            <div className="ffe-matrix-card">
              <div className="ffe-matrix-header">
                <h3>Detected HTTP API Endpoints ({analysis.apiCalls.length})</h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() =>
                      copyToClipboard(
                        analysis.apiCalls.map(a => `${a.method} ${a.uri}`).join('\n'),
                        'API endpoints list'
                      )
                    }
                  >
                    📋 Copy All Endpoints
                  </button>
                  <button
                    className="ffe-btn ffe-btn-sm ffe-btn-accent"
                    onClick={() => downloadPostmanCollection(analysis.apiCalls, analysis.feature.name || 'api-collection', resolvedFiles)}
                    title="Download Postman Collection v2.1 JSON"
                  >
                    📥 Download Postman Collection
                  </button>
                </div>
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
                          <code>{api.uri}</code>
                        </td>
                        <td>
                          {api.expectedStatus ? (
                            <span
                              className={`ffe-status-badge ${
                                api.expectedStatus < 400
                                  ? 's2xx'
                                  : api.expectedStatus < 500
                                  ? 's4xx'
                                  : 's5xx'
                              }`}
                            >
                              {api.expectedStatus}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {api.requestBodyFile ? (
                            <span style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
                              {api.requestBodyFile.split('/').pop()}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {api.uuid ? (
                            <span style={{ fontSize: '0.78rem', color: '#a78bfa' }}>{api.uuid}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: '0.82rem', color: '#cbd5e1' }}>
                            {api.scenarioName}
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

          {/* TAB 4: VALIDATIONS */}
          {activeTab === 'validations' && (
            <div className="ffe-validations-container">
              <div className="ffe-matrix-header">
                <h3>Database Assertions & Validations ({analysis.dataValidations.length})</h3>
                <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                  Extracted from db criteria tables and record checks
                </span>
              </div>

              {analysis.dataValidations.map((val, idx) => (
                <div key={idx} className="ffe-card">
                  <div className="ffe-card-header">
                    <div className="ffe-card-title-group">
                      <span className="ffe-type-badge database-validation">TABLE ASSERTION</span>
                      <h4 className="ffe-scenario-name">
                        Table: <span style={{ color: '#38bdf8' }}>{val.tableName}</span>
                      </h4>
                      {val.recordCount !== undefined && (
                        <span className="ffe-status-badge s2xx">Expected count: {val.recordCount}</span>
                      )}
                    </div>
                    <span className="ffe-scenario-line">Line {val.stepLine}</span>
                  </div>

                  <div className="ffe-card-body">
                    <p style={{ margin: '0 0 10px 0', fontSize: '0.85rem', color: '#94a3b8' }}>
                      Context: {val.scenarioName}
                    </p>

                    {val.criteria.length > 0 && (
                      <div style={{ marginBottom: '14px' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#94a3b8',
                            textTransform: 'uppercase',
                          }}
                        >
                          Filter Criteria
                        </span>
                        <div className="ffe-table-wrapper" style={{ marginTop: '6px' }}>
                          <table className="ffe-step-table">
                            <thead>
                              <tr>
                                <th>Column</th>
                                <th>Operator</th>
                                <th>Type</th>
                                <th>Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {val.criteria.map((c, cIdx) => (
                                <tr key={cIdx}>
                                  <td>
                                    <strong>{c.column}</strong>
                                  </td>
                                  <td>{c.operator}</td>
                                  <td>{c.type}</td>
                                  <td>
                                    <code>{c.value}</code>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {val.expectedValues.length > 0 && (
                      <div>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#94a3b8',
                            textTransform: 'uppercase',
                          }}
                        >
                          Expected Database Column Values
                        </span>
                        <div className="ffe-table-wrapper" style={{ marginTop: '6px' }}>
                          <table className="ffe-step-table">
                            <thead>
                              <tr>
                                <th>Column</th>
                                <th>Expected Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {val.expectedValues.map((ev, evIdx) => (
                                <tr key={evIdx}>
                                  <td>
                                    <strong>{ev.column}</strong>
                                  </td>
                                  <td>
                                    <span className="ffe-cell-status-processed">{ev.value}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {analysis.dataValidations.length === 0 && (
                <div className="empty">
                  <h3>No database assertions found</h3>
                  <p className="muted">
                    No steps validating <code>ms_inbox_events</code> or <code>adapter_context</code> were found.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 5: ARTIFACTS & TOKENS */}
          {activeTab === 'artifacts' && (
            <div className="ffe-artifacts-grid">
              {/* Payload Files */}
              <div className="ffe-artifact-card">
                <div className="ffe-artifact-header">
                  <h4>Payload Files ({analysis.artifacts.payloadFiles.length})</h4>
                  <button
                    className="ffe-btn ffe-btn-sm"
                    onClick={() =>
                      copyToClipboard(analysis.artifacts.payloadFiles.join('\n'), 'Payload files')
                    }
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.payloadFiles.map((file, i) => {
                    const res = resolvedFiles[file];
                    return (
                      <li key={i} className="ffe-artifact-item">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span>📄 {file}</span>
                          <span style={{ fontSize: '0.72rem', color: res ? '#34d399' : '#fbbf24' }}>
                            {res ? `✓ Resolved (${res.source})` : '⚠ File not loaded'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {res && (
                            <button
                              className="ffe-btn-icon"
                              onClick={() =>
                                setInspectingPayload({
                                  name: res.name,
                                  path: file,
                                  file: res,
                                })
                              }
                              title="Preview JSON"
                            >
                              👁️
                            </button>
                          )}
                          <button
                            className="ffe-btn-icon"
                            onClick={() => copyToClipboard(file, 'file path')}
                            title="Copy Path"
                          >
                            📋
                          </button>
                        </div>
                      </li>
                    );
                  })}
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
                    onClick={() =>
                      copyToClipboard(analysis.artifacts.jwtTokens.join('\n'), 'JWT tokens')
                    }
                  >
                    📋 Copy
                  </button>
                </div>
                <ul className="ffe-artifact-list">
                  {analysis.artifacts.jwtTokens.map((token, i) => (
                    <li key={i} className="ffe-artifact-item">
                      <div className="ffe-token-pill">
                        <span style={{ color: '#fb7185' }}>🔒 {token.substring(0, 32)}...</span>
                        <button
                          className="ffe-btn-icon"
                          onClick={() => copyToClipboard(token, 'JWT Token')}
                          title="Copy Full Token"
                        >
                          📋
                        </button>
                      </div>
                    </li>
                  ))}
                  {analysis.artifacts.jwtTokens.length === 0 && (
                    <li className="muted">No JWT tokens detected</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* TAB 6: HUMAN EXPLANATION */}
          {activeTab === 'explanation' && (
            <div className="ffe-explanation-card">
              <div className="ffe-explanation-header">
                <h3>Structured Human-Readable Documentation</h3>
                <button
                  className="ffe-btn ffe-btn-sm ffe-btn-primary"
                  onClick={() =>
                    copyToClipboard(generatedExplanation, 'Human-Readable Markdown Documentation')
                  }
                >
                  📋 Copy Full Documentation
                </button>
              </div>
              <pre className="ffe-explanation-body">{generatedExplanation}</pre>
            </div>
          )}

          {/* TAB 7: RAW FEATURE SOURCE */}
          {activeTab === 'raw' && (
            <div className="ffe-explanation-card">
              <div className="ffe-explanation-header">
                <h3>Raw .feature Source Content</h3>
                <button
                  className="ffe-btn ffe-btn-sm"
                  onClick={() => copyToClipboard(rawText, 'Raw Feature Source')}
                >
                  📋 Copy Raw Feature
                </button>
              </div>
              <pre className="ffe-explanation-body" style={{ color: '#93c5fd' }}>
                {rawText}
              </pre>
            </div>
          )}
        </>
      )}

      {/* Inspecting Payload Modal */}
      {inspectingPayload && (
        <div className="ffe-modal-overlay" onClick={() => setInspectingPayload(null)}>
          <div className="ffe-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="ffe-modal-header">
              <div>
                <h3>{inspectingPayload.name}</h3>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  {inspectingPayload.path}
                </span>
              </div>
              <button
                className="ffe-btn-icon"
                onClick={() => setInspectingPayload(null)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="ffe-modal-body">
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span className="ffe-status-pill resolved">
                  Role: {inspectingPayload.file?.fileKind || 'JSON'}
                </span>
                <span className="ffe-status-pill resolved">
                  Source: {inspectingPayload.file?.source || 'Local'}
                </span>
              </div>

              {decodedXml && (
                <div className="ffe-xml-preview-box">
                  <h5>Camel Route XML (Decoded from xmlRoute)</h5>
                  <pre className="ffe-json-pre">{decodedXml}</pre>
                </div>
              )}

              <h5 style={{ margin: '8px 0 0 0', color: '#94a3b8', fontSize: '0.85rem' }}>
                Raw JSON Payload
              </h5>
              <pre className="ffe-json-pre">
                {inspectingPayload.file?.rawText || 'No text content available'}
              </pre>
            </div>

            <div className="ffe-modal-footer">
              <button
                className="ffe-btn ffe-btn-sm"
                onClick={() =>
                  copyToClipboard(
                    inspectingPayload.file?.rawText || '',
                    inspectingPayload.name
                  )
                }
              >
                📋 Copy JSON
              </button>
              <button
                className="ffe-btn ffe-btn-sm ffe-btn-primary"
                onClick={() => setInspectingPayload(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pasting JSON Modal */}
      {pastingForPath && (
        <div className="ffe-modal-overlay" onClick={() => setPastingForPath(null)}>
          <div className="ffe-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="ffe-modal-header">
              <div>
                <h3>Paste JSON Payload</h3>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  For target path: <code>{pastingForPath}</code>
                </span>
              </div>
              <button
                className="ffe-btn-icon"
                onClick={() => setPastingForPath(null)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="ffe-modal-body">
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#cbd5e1' }}>
                Paste the adapter configuration or template definition JSON content below:
              </p>
              <textarea
                className="ffe-paste-textarea"
                placeholder='{ "type": "EVENTTOAPI", "name": "...", "templates": [ ... ] }'
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
              />
            </div>

            <div className="ffe-modal-footer">
              <button
                className="ffe-btn ffe-btn-sm"
                onClick={() => setPastingForPath(null)}
              >
                Cancel
              </button>
              <button
                className="ffe-btn ffe-btn-sm ffe-btn-accent"
                disabled={!pastedText.trim()}
                onClick={handleSavePastedJson}
              >
                Save & Resolve
              </button>
            </div>
          </div>
        </div>
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
// Postman Collection Generator (v2.1)
// -----------------------------------------------------------------------------

function downloadJson(data: any, filename: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.postman_collection.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function generatePostmanCollection(apiCalls: ApiCall[], collectionName: string, resolvedFiles?: Record<string, ResolvedPayloadFile>) {
  const items = apiCalls.map((api, idx) => {
    const url = api.uri || `http://localhost/api/endpoint-${idx + 1}`;
    const headers: Array<{ key: string; value: string }> = Object.entries(api.headers || {}).map(
      ([key, value]) => ({ key, value })
    );
    // Ensure UUID header is present if available
    if (api.uuid && !headers.find(h => h.key.toLowerCase() === 'uuid')) {
      headers.push({ key: 'UUID', value: api.uuid });
    }

    // Try to load actual payload content from resolved files
    let bodyContent: { mode: string; raw: string; options: { raw: { language: string } } } | undefined;
    if (api.requestBodyFile) {
      const resolved = resolvedFiles?.[api.requestBodyFile];
      const payloadText = resolved?.rawText;
      if (payloadText) {
        bodyContent = {
          mode: 'raw',
          raw: payloadText,
          options: { raw: { language: 'json' } },
        };
      } else {
        bodyContent = {
          mode: 'raw',
          raw: `/* Payload file not loaded: ${api.requestBodyFile.split('/').pop() || api.requestBodyFile} */\n{}`,
          options: { raw: { language: 'json' } },
        };
      }
    }

    return {
      name: `${api.scenarioName || `API Call ${idx + 1}`}`,
      event: [
        {
          listen: 'prerequest',
          script: {
            type: 'text/javascript',
            exec: [
              `// Auto-generated from feature file scenario: ${api.scenarioName}`,
              `// URI: ${api.uri}`,
              `// Method: ${api.method}`,
            ].join('\n'),
          },
        },
      ],
      request: {
        method: api.method || 'POST',
        header: headers,
        url: {
          raw: url,
          protocol: 'http',
          host: url.replace(/^https?:\/\//, '').split('/')[0] || 'localhost',
          path: url.replace(/^https?:\/\/[^/]+/, '') || '/',
        },
        ...(bodyContent ? { body: bodyContent } : {}),
        description: `Scenario: ${api.scenarioName}\nStep line: ${api.stepLine}\n${api.requestBodyFile ? `Payload file: ${api.requestBodyFile}` : ''}${api.uuid ? `\nUUID: ${api.uuid}` : ''}${api.expectedStatus ? `\nExpected status: ${api.expectedStatus}` : ''}`,
      },
    };
  });

  return {
    info: {
      name: collectionName,
      description: `Postman collection generated from feature file API endpoints.\nTotal endpoints: ${apiCalls.length}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

function downloadPostmanCollection(apiCalls: ApiCall[], collectionName: string, resolvedFiles?: Record<string, ResolvedPayloadFile>) {
  const collection = generatePostmanCollection(apiCalls, collectionName, resolvedFiles);
  downloadJson(collection, collectionName);
}

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
        <pre className="ffe-docstring">
          <code>{step.docString}</code>
        </pre>
      )}
    </li>
  );
};

// -----------------------------------------------------------------------------
// Helper Component: FormattedStepText
// -----------------------------------------------------------------------------

interface FormattedStepTextProps {
  text: string;
  onCopy: (text: string, label: string) => void;
}

const FormattedStepText: React.FC<FormattedStepTextProps> = ({ text, onCopy }) => {
  const [tokenExpanded, setTokenExpanded] = useState<boolean>(false);

  const parts = text.split(/("[^"]*")/g);

  return (
    <span>
      {parts.map((part, index) => {
        if (part.startsWith('"') && part.endsWith('"')) {
          const inner = part.slice(1, -1);

          if (inner.startsWith('jwt eyJ') || inner.startsWith('eyJ')) {
            const token = inner.startsWith('jwt ') ? inner.substring(4) : inner;
            const preview = `${token.substring(0, 16)}...${token.slice(-8)}`;

            return (
              <span key={index} className="ffe-token-pill">
                <span className="ffe-token-icon">🔒</span>
                <span className="ffe-token-preview">jwt {tokenExpanded ? token : preview}</span>
                <button
                  type="button"
                  className="ffe-btn-icon"
                  onClick={() => setTokenExpanded(!tokenExpanded)}
                  title={tokenExpanded ? 'Collapse Token' : 'Expand Token'}
                >
                  {tokenExpanded ? '▲' : '▼'}
                </button>
                <button
                  type="button"
                  className="ffe-btn-icon"
                  onClick={() => onCopy(token, 'JWT Token')}
                  title="Copy Full Token"
                >
                  📋
                </button>
              </span>
            );
          }

          if (inner.includes('-') && inner.length >= 16) {
            return (
              <span key={index} className="ffe-uuid-pill">
                <span>🔑 {inner}</span>
                <button
                  type="button"
                  className="ffe-btn-icon"
                  onClick={() => onCopy(inner, 'UUID')}
                  title="Copy UUID"
                >
                  📋
                </button>
              </span>
            );
          }

          if (inner.endsWith('.json') || inner.endsWith('.xml') || inner.endsWith('.txt')) {
            return (
              <code key={index} className="ffe-path-highlight">
                📄 {inner}
              </code>
            );
          }

          if (
            inner.startsWith('/system/') ||
            inner.startsWith('/api/') ||
            inner.startsWith('system/') ||
            inner.startsWith('http://') ||
            inner.startsWith('https://')
          ) {
            return (
              <code key={index} className="ffe-endpoint-highlight">
                🌐 {inner}
              </code>
            );
          }

          return (
            <code key={index} className="ffe-param-highlight">
              {part}
            </code>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </span>
  );
};

export default FeatureFileExplorer;
