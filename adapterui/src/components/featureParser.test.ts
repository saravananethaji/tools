import { describe, expect, it } from 'vitest';
import { parseFeatureText, generateMarkdownExplanation } from './featureParser';
import { SAMPLE_FEATURE_CONTENT } from './sampleFeature';

describe('featureParser', () => {
  it('parses feature metadata and tags correctly', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.feature.name).toBe('01_adapter_apitoapi validation');
    expect(analysis.feature.dependencyNotes.length).toBeGreaterThan(0);
  });

  it('parses background steps with headers and payloads', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.background.steps.length).toBe(8);
    expect(analysis.background.headers['Content-Type']).toBe('application/json');
    expect(analysis.background.headers['UUID']).toBe('adapqi-da5244e-a140-470e-83ad-768cb225640');
    expect(analysis.background.requestBodyFile).toContain('apitoapirequestpayload.json');
    expect(analysis.background.expectedStatus).toBe(201);
  });

  it('parses scenarios and infers categories correctly', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.scenarios.length).toBe(6);

    const scenario1 = analysis.scenarios[0];
    expect(scenario1.type).toBe('Template Configuration');
    expect(scenario1.expectedStatus).toBe(201);

    const scenarioNegative = analysis.scenarios[4];
    expect(scenarioNegative.type).toBe('Negative / Error Test');
    expect(scenarioNegative.expectedStatus).toBe(400);

    const scenarioFail = analysis.scenarios[5];
    expect(scenarioFail.type).toBe('Negative / Error Test');
    expect(scenarioFail.expectedStatus).toBe(500);
  });

  it('parses step data tables accurately', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    const dbScenario = analysis.scenarios[3];
    expect(dbScenario.name).toContain('ms_inbox_events');

    const criteriaStep = dbScenario.steps.find(s => s.text.includes('data criteria'));
    expect(criteriaStep?.table).toBeDefined();
    expect(criteriaStep?.table?.headers).toContain('TestCaseID');
    expect(criteriaStep?.table?.headers).toContain('ColumnName');
    expect(criteriaStep?.table?.rows.length).toBe(2);

    const validationStep = dbScenario.steps.find(s => s.text.includes('ms_inbox_events'));
    expect(validationStep?.table).toBeDefined();
    expect(validationStep?.table?.headers).toContain('ColumnValue');
    expect(validationStep?.table?.rows[0]).toContain('PROCESSED');
  });

  it('detects API endpoints and database validations', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.apiCalls.length).toBeGreaterThan(0);
    expect(analysis.apiCalls.some(a => a.uri.includes('/system/adapters/templates'))).toBe(true);
    expect(analysis.dataValidations.length).toBeGreaterThan(0);
    expect(analysis.dataValidations.some(v => v.tableName === 'ms_inbox_events')).toBe(true);
  });

  it('extracts artifacts such as payloads, UUIDs, and JWTs', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.artifacts.payloadFiles.length).toBeGreaterThan(0);
    expect(analysis.artifacts.uuids.length).toBeGreaterThan(0);
    expect(analysis.artifacts.jwtTokens.length).toBeGreaterThan(0);
    expect(analysis.artifacts.dbTables).toContain('ms_inbox_events');
  });

  it('generates a clean markdown explanation', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    const md = generateMarkdownExplanation(analysis);
    expect(md).toContain('# Feature Analysis: 01_adapter_apitoapi validation');
    expect(md).toContain('## Scenarios Breakdown');
    expect(md).toContain('## Detected API Interactions');
    expect(md).toContain('## Database Assertions & Validations');
  });
});
