import { describe, expect, it } from 'vitest';
import {
  matchesPath,
  normalizePath,
  isSamplePayloadPath,
  inspectPayloadJson,
  buildReviewsFromPayloads,
  getBundledSampleResolutions,
} from './featureAdapterBridge';
import { SAMPLE_ADAPTER_JSON, SAMPLE_TEMPLATE_JSON, SAMPLE_ADAPTER_PATH, SAMPLE_TEMPLATE_PATH } from './samplePayloads';

describe('featureAdapterBridge', () => {
  it('normalizes paths and strips redundant test/resources prefix', () => {
    const raw = 'src/test/resources/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json';
    const norm = normalizePath(raw);
    expect(norm).not.toContain('test/resources/test/resources');
    expect(norm).toContain('test/resources/integration-cucumber-json-payload');
  });

  it('matches target feature paths with filenames or relative paths', () => {
    const featurePath = 'src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapiadapterconflayoutpayload.json';
    expect(matchesPath(featurePath, 'usecasesjsonpayload/02_apitoapi/apitoapiadapterconflayoutpayload.json', 'apitoapiadapterconflayoutpayload.json')).toBe(true);
    expect(matchesPath(featurePath, 'other/path/apitoapiadapterconflayoutpayload.json', 'apitoapiadapterconflayoutpayload.json')).toBe(true);
    expect(matchesPath(featurePath, 'unrelated/path/other.json', 'other.json')).toBe(false);
  });

  it('matches grandparent-relative paths (../../ prefix) for template files', () => {
    const featurePath = 'src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json';
    // Simulates: feature file references payload at src/test/resources/...,
    // but selected folder is a subfolder, so file appears at ../../src/test/resources/...
    expect(matchesPath(
      '../../src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json',
      'src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json',
      'apitoapirequestpayload.json'
    )).toBe(true);

    // Also matches when only filename is available
    expect(matchesPath(
      '../../../src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json',
      'apitoapirequestpayload.json',
      'apitoapirequestpayload.json'
    )).toBe(true);
  });

  it('does not match unrelated grandparent paths', () => {
    expect(matchesPath(
      '../../src/test/resources/other/payload.json',
      'src/test/resources/unrelated/file.json',
      'file.json'
    )).toBe(false);
  });

  it('detects sample payload paths accurately', () => {
    expect(isSamplePayloadPath(SAMPLE_ADAPTER_PATH)).toBe('adapter');
    expect(isSamplePayloadPath(SAMPLE_TEMPLATE_PATH)).toBe('template');
    expect(isSamplePayloadPath('some/random/file.json')).toBe(null);
  });

  it('inspects payload JSON structure and identifies roles', () => {
    const adapterInspection = inspectPayloadJson(SAMPLE_ADAPTER_JSON, 'adapter.json');
    expect(adapterInspection.kind).toBe('registration');
    expect(adapterInspection.summary).toContain('EVENTTOAPI');

    const templateInspection = inspectPayloadJson(SAMPLE_TEMPLATE_JSON, 'template.json');
    expect(templateInspection.kind).toBe('template');
    expect(templateInspection.summary).toContain('PROCESS');
  });

  it('builds reviews from bundled sample payloads', () => {
    const samples = getBundledSampleResolutions();
    const adapterFile = samples.find(s => s.fileKind === 'registration')!;
    const templateFiles = samples.filter(s => s.fileKind === 'template');

    const { reviews, findings, error } = buildReviewsFromPayloads(adapterFile, templateFiles);
    expect(error).toBeUndefined();
    expect(reviews.length).toBe(1);
    expect(reviews[0].registration.type).toBe('EVENTTOAPI');
    expect(reviews[0].template.id).toBe('direct:eventtoapi.json.process');
    expect(reviews[0].decoded.routes.length).toBeGreaterThan(0);
    expect(findings.length).toBeGreaterThan(0);
  });
});
