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
                       step.text.match(/["'](\/(?:system|api)[^"']*)["']/i);
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
                        step.text.match(/contents of "([^"]+\.(?:json|xml|txt))"/i);
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
