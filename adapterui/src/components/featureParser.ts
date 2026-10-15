export interface StepTable {
  headers: string[];
  rows: string[][];
}

export interface FeatureStep {
  keyword: string;
  text: string;
  lineNumber: number;
  table?: StepTable;
  docString?: string;
}

export interface ApiCall {
  scenarioIndex: number | 'background';
  scenarioName: string;
  method: string;
  uri: string;
  expectedStatus?: number;
  requestBodyFile?: string;
  uuid?: string;
  headers: Record<string, string>;
  stepLine: number;
  rawStep: string;
}

export interface DbValidation {
  scenarioIndex: number;
  scenarioName: string;
  tableName: string;
  recordCount?: number;
  criteria: Array<{ column: string; operator: string; type: string; value: string }>;
  expectedValues: Array<{ column: string; value: string }>;
  stepLine: number;
  rawStep: string;
}

export interface FeatureScenario {
  index: number;
  name: string;
  tags: string[];
  steps: FeatureStep[];
  lineNumber: number;
  type: string;
  expectedStatus?: number;
  apiCalls: ApiCall[];
  dbValidations: DbValidation[];
}

export interface DetectedAdapterConfig {
  scenarioIndex: number;
  scenarioName: string;
  path: string;
  fileName: string;
  adapterId?: string;
  uri?: string;
  uuid?: string;
  stepLine: number;
}

export interface DetectedTemplateConfig {
  scenarioIndex: number;
  scenarioName: string;
  path: string;
  fileName: string;
  templateId?: string;
  uri?: string;
  uuid?: string;
  stepLine: number;
}

export interface DetectedInvocationConfig {
  scenarioIndex: number;
  scenarioName: string;
  path: string;
  fileName: string;
  uri?: string;
  uuid?: string;
  expectedStatus?: number;
  stepLine: number;
}

export interface ConfigPair {
  id: string;
  adapterConfig?: DetectedAdapterConfig;
  templateConfigs: DetectedTemplateConfig[];
  invocations: DetectedInvocationConfig[];
  correlationUuid?: string;
  matchReason: string;
}

export interface FeatureConfigurations {
  adapterConfigs: DetectedAdapterConfig[];
  templateConfigs: DetectedTemplateConfig[];
  invocationConfigs: DetectedInvocationConfig[];
  pairs: ConfigPair[];
}

export interface FeatureAnalysis {
  feature: {
    name: string;
    tags: string[];
    description: string[];
    dependencyNotes: string[];
  };
  background: {
    steps: FeatureStep[];
    lineNumber?: number;
    headers: Record<string, string>;
    requestBodyFile?: string;
    expectedStatus?: number;
  };
  scenarios: FeatureScenario[];
  apiCalls: ApiCall[];
  dataValidations: DbValidation[];
  artifacts: {
    payloadFiles: string[];
    uuids: string[];
    jwtTokens: string[];
    dbTables: string[];
  };
  configurations: FeatureConfigurations;
  stats: {
    totalScenarios: number;
    totalSteps: number;
    totalApiCalls: number;
    totalValidations: number;
    statusCodes: number[];
  };
  rawText: string;
}

export function parseFeatureText(content: string): FeatureAnalysis {
  const lines = content.split(/\r?\n/);
  
  const analysis: FeatureAnalysis = {
    feature: {
      name: '',
      tags: [],
      description: [],
      dependencyNotes: [],
    },
    background: {
      steps: [],
      headers: {},
    },
    scenarios: [],
    apiCalls: [],
    dataValidations: [],
    artifacts: {
      payloadFiles: [],
      uuids: [],
      jwtTokens: [],
      dbTables: [],
    },
    configurations: {
      adapterConfigs: [],
      templateConfigs: [],
      invocationConfigs: [],
      pairs: [],
    },
    stats: {
      totalScenarios: 0,
      totalSteps: 0,
      totalApiCalls: 0,
      totalValidations: 0,
      statusCodes: [],
    },
    rawText: content,
  };

  const payloadFilesSet = new Set<string>();
  const uuidsSet = new Set<string>();
  const jwtTokensSet = new Set<string>();
  const dbTablesSet = new Set<string>();
  const statusCodesSet = new Set<number>();

  let currentSection: 'header' | 'feature' | 'background' | 'scenario' = 'header';
  let currentScenario: FeatureScenario | null = null;
  let currentStep: FeatureStep | null = null;
  let pendingTags: string[] = [];
  let inDocString = false;
  let docStringBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const lineNum = i + 1;

    // Handle docstrings (""")
    if (trimmed.startsWith('"""')) {
      if (inDocString) {
        if (currentStep) {
          currentStep.docString = docStringBuffer.join('\n');
        }
        inDocString = false;
        docStringBuffer = [];
      } else {
        inDocString = true;
        docStringBuffer = [];
      }
      continue;
    }

    if (inDocString) {
      docStringBuffer.push(rawLine);
      continue;
    }

    // Tags (@tag1 @tag2)
    if (trimmed.startsWith('@')) {
      const tags = trimmed.split(/\s+/).filter(t => t.startsWith('@'));
      pendingTags.push(...tags);
      continue;
    }

    // Comment lines (# ...)
    if (trimmed.startsWith('#')) {
      const commentText = trimmed.substring(1).trim();
      // Look for tag-like comments e.g. #InvalidInputException
      if (/^[a-zA-Z0-9_\-]+$/.test(commentText)) {
        pendingTags.push(`@${commentText}`);
      } else if (
        (currentSection === 'header' || currentSection === 'feature') &&
        (commentText.includes('DEPENDENC') ||
          commentText.includes('requires') ||
          commentText.includes('Template') ||
          commentText.includes('Adapter') ||
          commentText.includes('Scenario'))
      ) {
        if (!commentText.startsWith('===') && commentText.length > 0) {
          analysis.feature.dependencyNotes.push(commentText);
        }
      }
      continue;
    }

    // Empty lines
    if (!trimmed) {
      currentStep = null;
      continue;
    }

    // Feature: declaration
    if (trimmed.startsWith('Feature:')) {
      analysis.feature.name = trimmed.substring(8).trim();
      analysis.feature.tags = [...pendingTags];
      pendingTags = [];
      currentSection = 'feature';
      currentStep = null;
      continue;
    }

    // Feature description
    if (currentSection === 'feature' && !trimmed.startsWith('Background:') && !trimmed.startsWith('Scenario:')) {
      analysis.feature.description.push(trimmed);
      continue;
    }

    // Background: declaration
    if (trimmed.startsWith('Background:')) {
      currentSection = 'background';
      analysis.background.lineNumber = lineNum;
      currentStep = null;
      continue;
    }

    // Scenario: or Scenario Outline: declaration
    const scenarioMatch = trimmed.match(/^(?:Scenario|Scenario Outline):\s*(.*)$/);
    if (scenarioMatch) {
      currentSection = 'scenario';
      const scenarioName = scenarioMatch[1].trim();
      const scenarioIdx = analysis.scenarios.length + 1;

      const scenarioTags = [...pendingTags];
      currentScenario = {
        index: scenarioIdx,
        name: scenarioName || `Scenario ${scenarioIdx}`,
        tags: scenarioTags,
        steps: [],
        lineNumber: lineNum,
        type: inferScenarioType(scenarioName, scenarioTags),
        apiCalls: [],
        dbValidations: [],
      };

      pendingTags = [];
      analysis.scenarios.push(currentScenario);
      currentStep = null;
      continue;
    }

    // Step data tables (| col1 | col2 |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map(cell => cell.trim());

      if (currentStep) {
        if (!currentStep.table) {
          currentStep.table = {
            headers: cells,
            rows: [],
          };
        } else {
          currentStep.table.rows.push(cells);
        }
      }
      continue;
    }

    // Gherkin step (Given, When, Then, And, But)
    const stepMatch = trimmed.match(/^(Given|When|Then|And|But)\s+(.*)$/);
    if (stepMatch && (currentSection === 'background' || currentSection === 'scenario')) {
      const keyword = stepMatch[1];
      const stepText = stepMatch[2].trim();

      currentStep = {
        keyword,
        text: stepText,
        lineNumber: lineNum,
      };

      if (currentSection === 'background') {
        analysis.background.steps.push(currentStep);
      } else if (currentScenario) {
        currentScenario.steps.push(currentStep);
      }
      continue;
    }
  }

  // Second pass: Extract rich semantics (APIs, Status Codes, Validations, Artifacts)
  // Background steps extraction
  for (const step of analysis.background.steps) {
    extractArtifactsFromStep(step.text, payloadFilesSet, uuidsSet, jwtTokensSet, dbTablesSet);
    
    // Background headers
    const headerMatch = step.text.match(/MS request header "([^"]+)" is set to (?:jwt )?"([^"]+)"/i) ||
                        step.text.match(/header "([^"]+)" is set to "([^"]+)"/i);
    if (headerMatch) {
      analysis.background.headers[headerMatch[1]] = headerMatch[2];
    }
    
    const bodyMatch = step.text.match(/MS request body is set to the contents of "([^"]+)"/i) ||
                      step.text.match(/contents of "([^"]+\.(?:json|xml|txt))"/i);
    if (bodyMatch) {
      analysis.background.requestBodyFile = bodyMatch[1];
    }

    const statusMatch = step.text.match(/response code should be (\d{3})/i);
    if (statusMatch) {
      const code = parseInt(statusMatch[1], 10);
      analysis.background.expectedStatus = code;
      statusCodesSet.add(code);
    }
  }

  // Scenarios extraction
  analysis.scenarios.forEach((scenario, sIdx) => {
    let pendingUri = '';
    let pendingMethod = '';
    let expectedStatus: number | undefined;
    let requestBodyFile: string | undefined = analysis.background.requestBodyFile;
    const headers: Record<string, string> = { ...analysis.background.headers };
    let lastStepLine = scenario.lineNumber;

    for (let stIdx = 0; stIdx < scenario.steps.length; stIdx++) {
      const step = scenario.steps[stIdx];
      lastStepLine = step.lineNumber;
      extractArtifactsFromStep(step.text, payloadFilesSet, uuidsSet, jwtTokensSet, dbTablesSet);

      // Check URI
      const uriMatch = step.text.match(/MS request URI is "([^"]+)"/i) ||
                       step.text.match(/request URI is "([^"]+)"/i) ||
                       step.text.match(/sent to "([^"]+)"/i) ||
                       step.text.match(/request is made to "([^"]+)"/i) ||
                       step.text.match(/["'](\/(?:system|api|jobs)[^"']*)["']/i);
      if (uriMatch) {
        pendingUri = uriMatch[1];
      }

      // Check Header
      const headerMatch = step.text.match(/MS request header "([^"]+)" is set to (?:jwt )?"([^"]+)"/i) ||
                          step.text.match(/header "([^"]+)" is set to "([^"]+)"/i);
      if (headerMatch) {
        headers[headerMatch[1]] = headerMatch[2];
      }

      // Check Body File
      const bodyMatch = step.text.match(/MS request body is set to the contents of "([^"]+)"/i) ||
                        step.text.match(/contents of "([^"]+\.(?:json|xml|txt))"/i) ||
                        step.text.match(/payload\s+"([^"]+\.(?:json|xml|txt))"/i);
      if (bodyMatch) {
        requestBodyFile = bodyMatch[1];
        payloadFilesSet.add(bodyMatch[1]);
      }

      // Check Method
      const methodMatch = step.text.match(/a "([A-Z]+)" request is sent/i) ||
                          step.text.match(/\b(POST|GET|PUT|DELETE|PATCH)\b/);
      if (methodMatch) {
        pendingMethod = methodMatch[1].toUpperCase();
      }

      // Check Status Code
      const statusMatch = step.text.match(/response code should be (\d{3})/i) ||
                          step.text.match(/status code should be (\d{3})/i) ||
                          step.text.match(/status (\d{3})\b/i);
      if (statusMatch) {
        expectedStatus = parseInt(statusMatch[1], 10);
        statusCodesSet.add(expectedStatus);
      }

      // Check DB Validation
      const dbTableMatch = step.text.match(/db table\s+([a-zA-Z0-9_]+)/i) ||
                           step.text.match(/table\s+([a-zA-Z0-9_]+)/i);
      if (dbTableMatch) {
        const tableName = dbTableMatch[1];
        dbTablesSet.add(tableName);
        
        // Count match
        const countMatch = step.text.match(/check no of record is (\d+)/i) ||
                           step.text.match(/record count is (\d+)/i);
        const recordCount = countMatch ? parseInt(countMatch[1], 10) : undefined;

        // Collect criteria from preceding step if it had criteria
        const criteria: Array<{ column: string; operator: string; type: string; value: string }> = [];
        if (stIdx > 0 && scenario.steps[stIdx - 1].table) {
          const prevTable = scenario.steps[stIdx - 1].table!;
          const colIdx = prevTable.headers.findIndex(h => /ColumnName/i.test(h));
          const opIdx = prevTable.headers.findIndex(h => /Operator/i.test(h));
          const typeIdx = prevTable.headers.findIndex(h => /DataType/i.test(h));
          const valIdx = prevTable.headers.findIndex(h => /ColumnValue/i.test(h));

          if (colIdx >= 0 && valIdx >= 0) {
            prevTable.rows.forEach(row => {
              criteria.push({
                column: row[colIdx] || '',
                operator: opIdx >= 0 ? row[opIdx] : 'eq',
                type: typeIdx >= 0 ? row[typeIdx] : 'string',
                value: row[valIdx] || '',
              });
            });
          }
        }

        // Expected values from current step table
        const expectedValues: Array<{ column: string; value: string }> = [];
        if (step.table) {
          const colIdx = step.table.headers.findIndex(h => /ColumnName/i.test(h));
          const valIdx = step.table.headers.findIndex(h => /ColumnValue/i.test(h));
          if (colIdx >= 0 && valIdx >= 0) {
            step.table.rows.forEach(row => {
              expectedValues.push({
                column: row[colIdx] || '',
                value: row[valIdx] || '',
              });
            });
          }
        }

        const dbVal: DbValidation = {
          scenarioIndex: scenario.index,
          scenarioName: scenario.name,
          tableName,
          recordCount,
          criteria,
          expectedValues,
          stepLine: step.lineNumber,
          rawStep: step.text,
        };

        scenario.dbValidations.push(dbVal);
        analysis.dataValidations.push(dbVal);
      }
    }

    scenario.expectedStatus = expectedStatus;

    if (pendingUri || pendingMethod) {
      const apiCall: ApiCall = {
        scenarioIndex: scenario.index,
        scenarioName: scenario.name,
        method: pendingMethod || 'POST',
        uri: pendingUri || (pendingMethod ? 'Default MS endpoint' : 'Unknown URI'),
        expectedStatus,
        requestBodyFile,
        uuid: headers['UUID'],
        headers,
        stepLine: lastStepLine,
        rawStep: `${pendingMethod || 'REQUEST'} ${pendingUri || ''}`,
      };
      scenario.apiCalls.push(apiCall);
      analysis.apiCalls.push(apiCall);
    }
  });

  // Calculate statistics
  analysis.artifacts = {
    payloadFiles: Array.from(payloadFilesSet),
    uuids: Array.from(uuidsSet),
    jwtTokens: Array.from(jwtTokensSet),
    dbTables: Array.from(dbTablesSet),
  };

  const totalSteps =
    analysis.background.steps.length +
    analysis.scenarios.reduce((acc, s) => acc + s.steps.length, 0);

  // Third pass: Meaningful understanding of Adapter & Template configurations
  const adapterConfigs: DetectedAdapterConfig[] = [];
  const templateConfigs: DetectedTemplateConfig[] = [];
  const invocationConfigs: DetectedInvocationConfig[] = [];

  const inspectCallForConfig = (
    scenarioIndex: number,
    scenarioName: string,
    uri: string,
    requestBodyFile?: string,
    uuid?: string,
    stepLine: number = 1,
    expectedStatus?: number
  ) => {
    if (!requestBodyFile) return;
    const cleanUri = uri || '';
    const lowerUri = cleanUri.toLowerCase();
    const lowerName = scenarioName.toLowerCase();
    const fileName = requestBodyFile.split('/').pop() || requestBodyFile;
    const lowerFile = fileName.toLowerCase();

    // Check if this is an API invocation / execution test
    const isInvocation =
      lowerName.includes('invoke') ||
      lowerName.includes('execution') ||
      lowerName.includes('trigger') ||
      lowerName.includes('internally') ||
      lowerName.includes('negative') ||
      lowerUri.includes('/jobs/') ||
      lowerUri.includes('jobs') ||
      (!lowerUri.includes('/adapters') && (lowerUri.includes('/system/') || lowerUri.includes('/api/')));

    // Check for Template Configuration
    const templateUriMatch = cleanUri.match(/\/system\/adapters\/templates\/([^"'\s]+)/i);
    const isTemplateUri = !!templateUriMatch || lowerUri.includes('/templates/');
    const isTemplateName =
      (lowerName.includes('template configuration') ||
        lowerName.includes('create a template') ||
        lowerName.includes('register a template')) &&
      !isInvocation;
    const isTemplateFile =
      (lowerFile.includes('template') || lowerFile.includes('templateconfig')) && !isInvocation;

    // Check for Adapter Configuration
    const adapterUriMatch = !isTemplateUri ? cleanUri.match(/\/system\/adapters\/([^"'\s/]+)$/i) : null;
    const isAdapterUri =
      !isTemplateUri &&
      !isInvocation &&
      (!!adapterUriMatch || (lowerUri.startsWith('/system/adapters') && !lowerUri.includes('/templates')));
    const isAdapterName =
      (lowerName.includes('adapter configuration') ||
        lowerName.includes('create an adapter') ||
        lowerName.includes('register an adapter')) &&
      !isInvocation;
    const isAdapterFile =
      (lowerFile.includes('adapterconflayout') ||
        lowerFile.includes('adapterconfig') ||
        lowerFile.includes('adapter_config')) &&
      !isInvocation;

    if (isInvocation) {
      invocationConfigs.push({
        scenarioIndex,
        scenarioName,
        path: requestBodyFile,
        fileName,
        uri: cleanUri,
        uuid,
        expectedStatus,
        stepLine,
      });
    } else if (isTemplateUri || isTemplateName || isTemplateFile) {
      let templateId = templateUriMatch ? templateUriMatch[1] : undefined;
      if (!templateId) {
        const idMatch = scenarioName.match(/(?:direct:[a-zA-Z0-9_.-]+|[a-zA-Z0-9_.-]+Template)/i);
        if (idMatch) templateId = idMatch[0];
      }
      templateConfigs.push({
        scenarioIndex,
        scenarioName,
        path: requestBodyFile,
        fileName,
        templateId,
        uri: cleanUri,
        uuid,
        stepLine,
      });
    } else if (isAdapterUri || isAdapterName || isAdapterFile) {
      let adapterId = adapterUriMatch ? adapterUriMatch[1] : undefined;
      if (!adapterId) {
        const idMatch = scenarioName.match(/(?:generic\.[a-zA-Z0-9_.-]+|[a-zA-Z0-9_.-]+Adapter)/i);
        if (idMatch) adapterId = idMatch[0];
      }
      adapterConfigs.push({
        scenarioIndex,
        scenarioName,
        path: requestBodyFile,
        fileName,
        adapterId,
        uri: cleanUri,
        uuid,
        stepLine,
      });
    } else {
      invocationConfigs.push({
        scenarioIndex,
        scenarioName,
        path: requestBodyFile,
        fileName,
        uri: cleanUri,
        uuid,
        expectedStatus,
        stepLine,
      });
    }
  };

  // Inspect Background
  if (analysis.background.requestBodyFile) {
    inspectCallForConfig(
      0,
      'Background Pre-conditions',
      '',
      analysis.background.requestBodyFile,
      analysis.background.headers['UUID'],
      analysis.background.lineNumber || 1,
      analysis.background.expectedStatus
    );
  }

  // Inspect all API calls
  for (const api of analysis.apiCalls) {
    inspectCallForConfig(
      typeof api.scenarioIndex === 'number' ? api.scenarioIndex : 0,
      api.scenarioName,
      api.uri,
      api.requestBodyFile,
      api.uuid,
      api.stepLine,
      api.expectedStatus
    );
  }

  // Deduplicate entries by path and scenarioIndex
  const dedup = <T extends { path: string; scenarioIndex: number }>(items: T[]): T[] => {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = `${item.path}#${item.scenarioIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const finalAdapters = dedup(adapterConfigs);
  const finalTemplates = dedup(templateConfigs);
  const finalInvocations = dedup(invocationConfigs);

  // Correlate into configuration pairs
  const pairs: ConfigPair[] = [];
  finalAdapters.forEach((adapter, idx) => {
    // 1. Match by correlation UUID
    let matchedTemplates = finalTemplates.filter(t => t.uuid && adapter.uuid && t.uuid === adapter.uuid);

    // 2. Match by common directory in path
    if (matchedTemplates.length === 0) {
      const adapterDir = adapter.path.substring(0, adapter.path.lastIndexOf('/'));
      matchedTemplates = finalTemplates.filter(t => {
        const tplDir = t.path.substring(0, t.path.lastIndexOf('/'));
        return adapterDir && tplDir && adapterDir === tplDir;
      });
    }

    // 3. Match by scenario sequence / proximity for multiple adapters
    if (matchedTemplates.length === 0 && finalAdapters.length > 1) {
      const prevAdapterScenario = idx > 0 ? finalAdapters[idx - 1].scenarioIndex : 0;
      const nextAdapterScenario = idx < finalAdapters.length - 1 ? finalAdapters[idx + 1].scenarioIndex : 999999;
      matchedTemplates = finalTemplates.filter(
        t => t.scenarioIndex > prevAdapterScenario && t.scenarioIndex <= adapter.scenarioIndex
      );
      if (matchedTemplates.length === 0) {
        matchedTemplates = finalTemplates.filter(
          t => t.scenarioIndex >= adapter.scenarioIndex && t.scenarioIndex < nextAdapterScenario
        );
      }
    }

    // 4. Fallback: all templates if only 1 adapter exists
    if (matchedTemplates.length === 0 && finalAdapters.length === 1 && finalTemplates.length > 0) {
      matchedTemplates = finalTemplates;
    }

    // Find invocations matching UUID, folder, name/URI, or scenario proximity
    const invocations = finalInvocations.filter(inv => {
      if (adapter.uuid && inv.uuid && adapter.uuid === inv.uuid) return true;
      const adapterDir = adapter.path.substring(0, adapter.path.lastIndexOf('/'));
      const invDir = inv.path.substring(0, inv.path.lastIndexOf('/'));
      if (adapterDir && invDir && adapterDir === invDir) return true;

      // Check explicit identifier or filename matches
      const adapterBase = adapter.fileName.replace(/\.[^.]+$/, '').toLowerCase();
      const adapterId = adapter.adapterId?.toLowerCase();
      const invText = `${inv.uri} ${inv.scenarioName} ${inv.path}`.toLowerCase();
      if (adapterId && invText.includes(adapterId)) return true;
      if (adapterBase && adapterBase.length > 3 && invText.includes(adapterBase)) return true;

      if (finalAdapters.length > 1) {
        const nextAdapterScenario = idx < finalAdapters.length - 1 ? finalAdapters[idx + 1].scenarioIndex : 999999;
        return inv.scenarioIndex > adapter.scenarioIndex && inv.scenarioIndex < nextAdapterScenario;
      }
      return true;
    });

    const reasons: string[] = [];
    if (adapter.uuid && matchedTemplates.some(t => t.uuid === adapter.uuid)) {
      reasons.push(`Matching UUID: ${adapter.uuid}`);
    }
    const adapterDir = adapter.path.split('/').slice(-2, -1)[0];
    if (adapterDir) {
      reasons.push(`Shared path group: '${adapterDir}'`);
    }
    if (reasons.length === 0) {
      reasons.push(`Sequential scenario flow #${idx + 1}`);
    }

    pairs.push({
      id: `pair-${idx + 1}`,
      adapterConfig: adapter,
      templateConfigs: matchedTemplates,
      invocations,
      correlationUuid: adapter.uuid,
      matchReason: reasons.join(' · '),
    });
  });

  // If no adapter was found, but template configs exist
  if (finalAdapters.length === 0 && finalTemplates.length > 0) {
    pairs.push({
      id: 'pair-template-only',
      templateConfigs: finalTemplates,
      invocations: finalInvocations,
      matchReason: 'Standalone template configuration(s)',
    });
  }

  analysis.configurations = {
    adapterConfigs: finalAdapters,
    templateConfigs: finalTemplates,
    invocationConfigs: finalInvocations,
    pairs,
  };

  analysis.stats = {
    totalScenarios: analysis.scenarios.length,
    totalSteps,
    totalApiCalls: analysis.apiCalls.length,
    totalValidations: analysis.dataValidations.length,
    statusCodes: Array.from(statusCodesSet).sort(),
  };

  return analysis;
}

function inferScenarioType(name: string, tags: string[] = []): string {
  const lower = name.toLowerCase();
  const allText = `${lower} ${tags.join(' ').toLowerCase()}`;
  if (allText.includes('negative') || allText.includes('invalid') || allText.includes('fail') || allText.includes('error')) {
    return 'Negative / Error Test';
  }
  if (lower.includes('template')) return 'Template Configuration';
  if (lower.includes('invoke')) return 'API Invocation';
  if (lower.includes('adapter')) return 'Adapter Configuration';
  if (lower.includes('validate') || lower.includes('check') || lower.includes('db')) {
    return 'Database Validation';
  }
  return 'Functional Scenario';
}

function extractArtifactsFromStep(
  text: string,
  payloadFiles: Set<string>,
  uuids: Set<string>,
  jwtTokens: Set<string>,
  dbTables: Set<string>
) {
  // Specific UUID header extraction: header "UUID" is set to "..."
  const explicitUuidMatch = text.match(/header\s+["']?UUID["']?\s+is\s+set\s+to\s+["']([^"']+)["']/i);
  if (explicitUuidMatch) {
    uuids.add(explicitUuidMatch[1]);
  }

  // Standard UUID regex (8-4-4-4-12 hex)
  const standardUuids = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
  if (standardUuids) {
    standardUuids.forEach(u => uuids.add(u));
  }

  // Adapter custom UUID format (e.g., adapqi-da5244e-a140-470e-83ad-768cb225640)
  const adapterUuids = text.match(/\badap[a-z0-9]*-[0-9a-f]{7,}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{10,}\b/gi);
  if (adapterUuids) {
    adapterUuids.forEach(u => uuids.add(u));
  }

  // Payload files (.json, .xml, .txt)
  const fileMatches = text.match(/["']([^"']+\.(?:json|xml|txt|yaml|yml))["']/g);
  if (fileMatches) {
    fileMatches.forEach(m => payloadFiles.add(m.replace(/["']/g, '')));
  }

  // JWT tokens
  const jwtMatch = text.match(/eyJ[a-zA-Z0-9_\-\.]{20,}/);
  if (jwtMatch) {
    jwtTokens.add(jwtMatch[0]);
  }

  // Database tables
  if (text.includes('adapter_context')) dbTables.add('adapter_context');
  if (text.includes('ms_inbox_events')) dbTables.add('ms_inbox_events');
}

export function generateMarkdownExplanation(analysis: FeatureAnalysis): string {
  let doc = `# Feature Analysis: ${analysis.feature.name || 'Unnamed Feature'}\n\n`;

  if (analysis.feature.tags.length > 0) {
    doc += `**Tags:** ${analysis.feature.tags.map(t => `\`${t}\``).join(' ')}\n\n`;
  }

  if (analysis.feature.description.length > 0) {
    doc += `## Overview\n${analysis.feature.description.join('\n')}\n\n`;
  }

  // Dependencies block
  if (analysis.feature.dependencyNotes.length > 0) {
    doc += `## Execution Dependencies & Prerequisites\n`;
    analysis.feature.dependencyNotes.forEach(note => {
      doc += `- ${note}\n`;
    });
    doc += `\n`;
  }

  // Adapter & Template Configurations
  if (analysis.configurations && (analysis.configurations.pairs.length > 0 || analysis.configurations.adapterConfigs.length > 0)) {
    doc += `## Adapter & Template Configurations\n\n`;
    analysis.configurations.pairs.forEach((pair, idx) => {
      doc += `### Configuration Flow ${idx + 1}\n`;
      doc += `**Correlation:** ${pair.matchReason}\n\n`;
      if (pair.templateConfigs.length > 0) {
        pair.templateConfigs.forEach(t => {
          doc += `- **Template Definition:** \`${t.path}\`\n`;
          doc += `  - Endpoint: \`${t.uri || 'POST /system/adapters/templates'}\`\n`;
          if (t.templateId) doc += `  - Template ID: \`${t.templateId}\`\n`;
          doc += `  - Declared in: ${t.scenarioName} (Line ${t.stepLine})\n`;
        });
      }
      if (pair.adapterConfig) {
        doc += `- **Adapter Registration:** \`${pair.adapterConfig.path}\`\n`;
        doc += `  - Endpoint: \`${pair.adapterConfig.uri || 'POST /system/adapters'}\`\n`;
        if (pair.adapterConfig.adapterId) doc += `  - Adapter ID: \`${pair.adapterConfig.adapterId}\`\n`;
        doc += `  - Declared in: ${pair.adapterConfig.scenarioName} (Line ${pair.adapterConfig.stepLine})\n`;
      }
      if (pair.invocations.length > 0) {
        doc += `- **Invocations (${pair.invocations.length}):**\n`;
        pair.invocations.forEach(inv => {
          doc += `  - \`${inv.path}\` -> \`${inv.uri}\` (${inv.scenarioName})\n`;
        });
      }
      doc += `\n`;
    });
  }

  // Background
  if (analysis.background.steps.length > 0) {
    doc += `## Pre-Conditions (Background)\n`;
    doc += `Executed prior to every scenario in this feature file:\n`;
    analysis.background.steps.forEach(s => {
      doc += `- **${s.keyword}** ${s.text}\n`;
    });
    doc += `\n`;
  }

  // Scenarios Summary Table
  doc += `## Scenarios Breakdown (${analysis.scenarios.length})\n\n`;
  doc += `| # | Scenario Name | Category | Expected Status | API Calls |\n`;
  doc += `|---|---------------|----------|-----------------|-----------|\n`;
  analysis.scenarios.forEach(s => {
    const status = s.expectedStatus ? `\`${s.expectedStatus}\`` : '—';
    const apis = s.apiCalls.map(a => `${a.method} ${a.uri}`).join(', ') || '—';
    doc += `| ${s.index} | ${s.name} | ${s.type} | ${status} | ${apis} |\n`;
  });
  doc += `\n`;

  // API Endpoints
  if (analysis.apiCalls.length > 0) {
    doc += `## Detected API Interactions (${analysis.apiCalls.length})\n\n`;
    analysis.apiCalls.forEach((api, idx) => {
      doc += `### ${idx + 1}. \`${api.method}\` ${api.uri}\n`;
      doc += `- **Scenario:** ${api.scenarioName} (Line ${api.stepLine})\n`;
      if (api.expectedStatus) doc += `- **Expected Response:** \`${api.expectedStatus}\`\n`;
      if (api.requestBodyFile) doc += `- **Request Payload:** \`${api.requestBodyFile}\`\n`;
      if (api.uuid) doc += `- **Correlation UUID:** \`${api.uuid}\`\n`;
      doc += `\n`;
    });
  }

  // Validations
  if (analysis.dataValidations.length > 0) {
    doc += `## Database Assertions & Validations\n\n`;
    analysis.dataValidations.forEach((val, idx) => {
      doc += `### ${idx + 1}. Table \`${val.tableName}\`\n`;
      doc += `- **Scenario:** ${val.scenarioName} (Line ${val.stepLine})\n`;
      if (val.recordCount !== undefined) doc += `- **Expected Record Count:** \`${val.recordCount}\`\n`;
      if (val.criteria.length > 0) {
        doc += `- **Filter Criteria:**\n`;
        val.criteria.forEach(c => {
          doc += `  - \`${c.column}\` ${c.operator} \`${c.value}\` (${c.type})\n`;
        });
      }
      if (val.expectedValues.length > 0) {
        doc += `- **Expected Column Values:**\n`;
        val.expectedValues.forEach(ev => {
          doc += `  - \`${ev.column}\` = \`${ev.value}\`\n`;
        });
      }
      doc += `\n`;
    });
  }

  // Artifacts
  doc += `## Referenced Artifacts & Files\n\n`;
  if (analysis.artifacts.payloadFiles.length > 0) {
    doc += `### Payload Files\n`;
    analysis.artifacts.payloadFiles.forEach(f => doc += `- \`${f}\`\n`);
  }
  if (analysis.artifacts.uuids.length > 0) {
    doc += `### Correlation UUIDs\n`;
    analysis.artifacts.uuids.forEach(u => doc += `- \`${u}\`\n`);
  }
  if (analysis.artifacts.dbTables.length > 0) {
    doc += `### Database Tables\n`;
    analysis.artifacts.dbTables.forEach(t => doc += `- \`${t}\`\n`);
  }

  return doc;
}
