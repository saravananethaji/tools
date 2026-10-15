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

  it('detects adapter and template configurations and correlates them into pairs', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    expect(analysis.configurations).toBeDefined();
    // Exactly 1 template definition (Scenario 1) and 1 adapter registration (Scenario 2)
    expect(analysis.configurations.templateConfigs.length).toBe(1);
    expect(analysis.configurations.adapterConfigs.length).toBe(1);
    expect(analysis.configurations.invocationConfigs.length).toBeGreaterThan(0);

    const templateConfig = analysis.configurations.templateConfigs[0];
    expect(templateConfig.scenarioIndex).toBe(1);
    expect(templateConfig.templateId).toBe('direct:ApiToApi');
    expect(templateConfig.path).toContain('apitoapirequestpayload.json');

    const adapterConfig = analysis.configurations.adapterConfigs[0];
    expect(adapterConfig.scenarioIndex).toBe(2);
    expect(adapterConfig.adapterId).toBe('generic.Routeid');
    expect(adapterConfig.path).toContain('apitoapiadapterconflayoutpayload.json');

    // Exactly 1 configuration flow pair (Adapter Scenario 2 + Template Scenario 1)
    expect(analysis.configurations.pairs.length).toBe(1);
    const pair = analysis.configurations.pairs[0];
    expect(pair.adapterConfig?.scenarioIndex).toBe(2);
    expect(pair.adapterConfig?.adapterId).toBe('generic.Routeid');
    expect(pair.templateConfigs[0].scenarioIndex).toBe(1);
    expect(pair.templateConfigs[0].templateId).toBe('direct:ApiToApi');
    expect(pair.invocations.some(inv => inv.scenarioIndex === 5)).toBe(true);
    expect(pair.invocations.some(inv => inv.scenarioIndex === 6)).toBe(true);
    expect(pair.matchReason).toContain('adapqi-da5244e-a140-470e-83ad-768cb225640');
  });

  it('generates a clean markdown explanation including configurations', () => {
    const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);
    const md = generateMarkdownExplanation(analysis);
    expect(md).toContain('# Feature Analysis: 01_adapter_apitoapi validation');
    expect(md).toContain('## Scenarios Breakdown');
    expect(md).toContain('## Detected API Interactions');
    expect(md).toContain('## Database Assertions & Validations');
    expect(md).toContain('## Adapter & Template Configurations');
    expect(md).toContain('direct:ApiToApi');
    expect(md).toContain('generic.Routeid');
  });

  it('correctly parses and pairs multiple adapters with multiple templates', () => {
    const multiFeature = `
Feature: Multi Adapter and Template Pipeline

Scenario: Register Preprocess Template
  When a "POST" request is made to "/system/adapters/templates/inbound" with payload "inbound-tpl.json"
  Then the response status should be 200

Scenario: Register Main Template
  When a "POST" request is made to "/system/adapters/templates/process" with payload "process-tpl.json"
  Then the response status should be 200

Scenario: Register Adapter Flow 1
  When a "POST" request is made to "/system/adapters" with payload "adapter-one.json"
  Then the response status should be 200

Scenario: Register Second Adapter Template
  When a "POST" request is made to "/system/adapters/templates/outbound" with payload "outbound-tpl.json"
  Then the response status should be 200

Scenario: Register Adapter Flow 2
  When a "POST" request is made to "/system/adapters" with payload "adapter-two.json"
  Then the response status should be 200

Scenario: Invoke First Flow
  When a "POST" request is made to "/jobs/execute/adapter-one" with payload "exec1.json"
  Then the response status should be 200

Scenario: Invoke Second Flow
  When a "POST" request is made to "/jobs/execute/adapter-two" with payload "exec2.json"
  Then the response status should be 200
`;

    const analysis = parseFeatureText(multiFeature);
    expect(analysis.configurations.pairs.length).toBe(2);

    const flow1 = analysis.configurations.pairs[0];
    expect(flow1.adapterConfig?.fileName).toBe('adapter-one.json');
    // Flow 1 receives templates before it (inbound-tpl and process-tpl)
    expect(flow1.templateConfigs.length).toBe(2);
    expect(flow1.templateConfigs[0].fileName).toBe('inbound-tpl.json');
    expect(flow1.templateConfigs[1].fileName).toBe('process-tpl.json');
    expect(flow1.invocations.some(inv => inv.fileName === 'exec1.json')).toBe(true);

    const flow2 = analysis.configurations.pairs[1];
    expect(flow2.adapterConfig?.fileName).toBe('adapter-two.json');
    expect(flow2.templateConfigs.length).toBe(1);
    expect(flow2.templateConfigs[0].fileName).toBe('outbound-tpl.json');
    expect(flow2.invocations.some(inv => inv.fileName === 'exec2.json')).toBe(true);
  });
});


