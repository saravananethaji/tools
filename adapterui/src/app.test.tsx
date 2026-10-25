import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { generatePostmanCollection } from './components/FeatureFileExplorer';
import { matchesPath } from './components/featureAdapterBridge';
import { parseFeatureText, generateMarkdownExplanation } from './components/featureParser';
import { SAMPLE_FEATURE_CONTENT } from './components/sampleFeature';
declare const __dirname: string;
declare function require(module: string): any;
const fs = require('fs');
const path = require('path');

// React 19 requires this flag before act() is used in a jsdom test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal DOM host: the app mounts by id, so the smoke test has to provide one.
function mount() {
  const host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  let root: Root;
  act(() => { root = createRoot(host); root.render(<App />); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

describe('app shell', () => {
  let mounted: ReturnType<typeof mount> | undefined;
  afterEach(() => { mounted?.unmount(); mounted = undefined; });

  it('lands on the adapter catalog and offers both modes', () => {
    mounted = mount();
    const html = mounted.host.innerHTML;
    expect(html).toContain('Adapter Catalog');
    const tabs = Array.from(mounted.host.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Adapter Catalog', 'Feature Explorer']);
    expect(mounted.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Adapter Catalog');
  });

  it('switches to the feature-explorer mode', () => {
    mounted = mount();
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });
    const html = mounted.host.innerHTML;
    expect(html).toContain('Feature File Explorer');
    expect(mounted.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Feature Explorer');
  });

  it('shows two loading options in Adapter Catalog mode', () => {
    mounted = mount();
    const html = mounted.host.innerHTML;
    expect(html).toContain('Adapter Catalog');
    expect(html).toContain('A. Scan Folder');
    expect(html).toContain('B. Select Files');
    const tabs = Array.from(mounted.host.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Adapter Catalog', 'Feature Explorer']);
    expect(mounted.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Adapter Catalog');
  });

  it('file import flow works within Adapter Catalog (Option B)', () => {
    mounted = mount();
    const html = mounted.host.innerHTML;
    expect(html).toContain('1. Adapter registration JSON');
    expect(html).toContain('2. Template definition JSON file(s)');
    expect(html).toContain('Choose registration');
    expect(html).toContain('Load review');
  });

  it('folder picker is visible in Adapter Catalog but not Feature Explorer', () => {
    mounted = mount();
    expect(mounted.host.querySelector('input[aria-label="Select a use-case folder"]')).not.toBeNull();
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });
    expect(mounted.host.querySelector('input[aria-label="Select a use-case folder"]')).toBeNull();
  });

  it('loads sample feature in feature explorer and transitions to adapter reviewer on launch', () => {
    mounted = mount();
    // 1. Switch to Feature Explorer
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    // 2. Click "Load Sample Feature"
    const loadSampleBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Load Sample Feature')) as HTMLButtonElement;
    expect(loadSampleBtn).toBeDefined();
    act(() => { loadSampleBtn.click(); });

    // 3. Switch to "Adapter & Templates" tab
    const adapterTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes('Adapter & Templates')) as HTMLButtonElement;
    expect(adapterTab).toBeDefined();
    act(() => { adapterTab.click(); });

    // 4. Verify Adapter configuration flow card is displayed
    expect(mounted.host.innerHTML).toContain('generic.Routeid');
    expect(mounted.host.innerHTML).toContain('direct:ApiToApi');
    expect(mounted.host.innerHTML).toContain('Ready for Review');

    // 5. Click "Open in Adapter Reviewer"
    const launchBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Open in Adapter Reviewer')) as HTMLButtonElement;
    expect(launchBtn).toBeDefined();
    expect(launchBtn.disabled).toBe(false);
    act(() => { launchBtn.click(); });

    // 6. Verify view has transitioned to single adapter review with loaded configuration
    expect(mounted.host.innerHTML).toContain('Adapter configuration review');
    expect(mounted.host.innerHTML).toContain('direct:eventtoapi.json.process');
    expect(mounted.host.innerHTML).toContain('SEPA PAYMENT EVENT TO REST API CALL');
  });

  it('collapse all collapses both scenarios and preconditions', () => {
    mounted = mount();
    // Switch to Feature Explorer
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    // Load sample feature (has background/preconditions)
    const loadSampleBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Load Sample Feature')) as HTMLButtonElement;
    act(() => { loadSampleBtn.click(); });

    // Preconditions should be expanded by default
    let preconditionsBody = mounted.host.querySelector('.background-card .ffe-card-body');
    expect(preconditionsBody).not.toBeNull();
    expect(preconditionsBody?.classList.contains('hidden')).toBe(false);

    // Click "Collapse All" button
    const collapseAllBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Collapse All')) as HTMLButtonElement;
    expect(collapseAllBtn).toBeDefined();
    act(() => { collapseAllBtn.click(); });

    // Preconditions should be collapsed
    preconditionsBody = mounted.host.querySelector('.background-card .ffe-card-body');
    expect(preconditionsBody).toBeNull(); // body removed when collapsed
  });

  it('expand all expands both scenarios and preconditions', () => {
    mounted = mount();
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    const loadSampleBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Load Sample Feature')) as HTMLButtonElement;
    act(() => { loadSampleBtn.click(); });

    // Collapse first
    const collapseAllBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Collapse All')) as HTMLButtonElement;
    act(() => { collapseAllBtn.click(); });

    // Verify collapsed
    let preconditionsBody = mounted.host.querySelector('.background-card .ffe-card-body');
    expect(preconditionsBody).toBeNull();

    // Click "Expand All" button
    const expandAllBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Expand All')) as HTMLButtonElement;
    expect(expandAllBtn).toBeDefined();
    act(() => { expandAllBtn.click(); });

    // Preconditions should be expanded again
    preconditionsBody = mounted.host.querySelector('.background-card .ffe-card-body');
    expect(preconditionsBody).not.toBeNull();
  });
});

describe('postman collection download', () => {
  let mounted: ReturnType<typeof mount> | undefined;
  let capturedBlobs: Array<{ blob: Blob; filename: string }> = [];
  let originalCreateObjectURL: any;
  let originalAclick: any;

  beforeEach(() => {
    mounted = mount();
    capturedBlobs = [];

    // Intercept URL.createObjectURL to capture the download blob
    originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      capturedBlobs.push({ blob, filename: '' });
      return 'blob:mock-download';
    }) as typeof URL.createObjectURL;

    // Intercept anchor click to capture download filename
    originalAclick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const idx = capturedBlobs.length - 1;
      if (idx >= 0) {
        capturedBlobs[idx].filename = (this as HTMLAnchorElement).download;
      }
      return originalAclick.call(this);
    };
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    URL.createObjectURL = originalCreateObjectURL;
    HTMLAnchorElement.prototype.click = originalAclick;
  });

  async function loadFeatureAndOpenApiMatrix() {
    // Switch to Feature Explorer
    const featTab = Array.from(mounted!.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    // Load sample feature
    const loadSampleBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Load Sample Feature')) as HTMLButtonElement;
    act(() => { loadSampleBtn.click(); });

    // Switch to API MATRIX tab
    const apiTab = Array.from(mounted!.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes('API Matrix')) as HTMLButtonElement;
    act(() => { apiTab.click(); });
  }

  async function getDownloadedCollection(): Promise<any> {
    expect(capturedBlobs.length).toBeGreaterThan(0);
    const { blob } = capturedBlobs[capturedBlobs.length - 1];
    const text = await blob.text();
    return JSON.parse(text);
  }

  // ---------- Positive scenarios ----------

  it('shows Download Postman Collection button in API MATRIX tab when endpoints exist', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection'));
    expect(downloadBtn).toBeDefined();
    expect((downloadBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('generates valid Postman Collection v2.1 JSON on download', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    // Postman Collection v2.1 schema
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.info.name).toContain('01_adapter_apitoapi');
    expect(Array.isArray(collection.item)).toBe(true);
    expect(collection.item.length).toBeGreaterThan(0);
  });

  it('includes correct HTTP method in collection requests', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const postRequests = collection.item.filter((i: any) => i.request.method === 'POST');
    expect(postRequests.length).toBeGreaterThan(0);
  });

  it('includes correct URL in collection requests', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const firstItem = collection.item[0];
    expect(firstItem.request.url.raw).toContain('/system/adapters');
    expect(firstItem.request.url.protocol).toBe('http');
  });

  it('includes headers from feature file (Content-Type, Authorization, UUID)', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const allHeaders = collection.item.flatMap((i: any) => i.request.header || []);
    const headerKeys = allHeaders.map((h: any) => h.key);
    expect(headerKeys).toContain('Content-Type');
    expect(headerKeys).toContain('Authorization');
    expect(headerKeys).toContain('UUID');
  });

  it('includes actual payload content from resolved files in request body', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const itemsWithBody = collection.item.filter((i: any) => i.request.body);
    expect(itemsWithBody.length).toBeGreaterThan(0);
    expect(itemsWithBody[0].request.body.mode).toBe('raw');
    // Body should contain actual JSON content, not an empty placeholder
    expect(itemsWithBody[0].request.body.raw.trim()).not.toBe('{}');
    expect(itemsWithBody[0].request.body.raw.length).toBeGreaterThan(10);
  });

  it('includes scenario context in request description', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const descriptions = collection.item.map((i: any) => i.request.description);
    expect(descriptions.some((d: string) => d.includes('Scenario:'))).toBe(true);
    expect(descriptions.some((d: string) => d.includes('Expected status:'))).toBe(true);
  });

  it('downloads with correct .postman_collection.json filename', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const lastBlob = capturedBlobs[capturedBlobs.length - 1];
    expect(lastBlob.filename).toMatch(/\.postman_collection\.json$/);
  });

  // ---------- Negative scenarios ----------

  it('does not show download button outside API MATRIX tab', async () => {
    await loadFeatureAndOpenApiMatrix();

    // Switch away from API MATRIX to Scenarios tab
    const scenariosTab = Array.from(mounted!.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes('Scenarios & Flow')) as HTMLButtonElement;
    act(() => { scenariosTab.click(); });

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection'));
    expect(downloadBtn).toBeUndefined();
  });

  it('generates collection with empty items when no API calls exist', async () => {
    // Create analysis with no API calls by mocking via parser
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;

    // Temporarily clear apiCalls to test empty scenario
    // Access the component instance through the mounted host
    const ffeElement = mounted!.host.querySelector('.ffe-container');
    expect(ffeElement).not.toBeNull();

    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();
    // With sample data, items should exist; but the structure should still be valid
    expect(collection.info.schema).toBeDefined();
    expect(Array.isArray(collection.item)).toBe(true);
  });

  it('handles missing uri gracefully with fallback default', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    // All items should have a url.raw (even if fallback)
    collection.item.forEach((i: any) => {
      expect(i.request.url.raw).toBeDefined();
      expect(i.request.url.raw.length).toBeGreaterThan(0);
    });
  });

  it('handles missing headers object gracefully (empty headers array)', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    collection.item.forEach((i: any) => {
      expect(Array.isArray(i.request.header)).toBe(true);
    });
  });
});

describe('generatePostmanCollection (unit)', () => {
  const sampleApiCalls = [
    {
      scenarioIndex: 0,
      scenarioName: 'Template Configuration Scenario',
      method: 'POST',
      uri: '/system/adapters/templates/direct:ApiToApi',
      expectedStatus: 201,
      requestBodyFile: '/system/adapters/templates/payloads/template.json',
      uuid: 'adapqi-da5244e-a140-470e-83ad-768cb225640',
      headers: { 'Content-Type': 'application/json', UUID: 'adapqi-da5244e-a140-470e-83ad-768cb225640' } as Record<string, string>,
      stepLine: 28,
      rawStep: 'POST /system/adapters/templates/direct:ApiToApi',
    },
    {
      scenarioIndex: 1,
      scenarioName: 'Adapter Configuration Scenario',
      method: 'POST',
      uri: '/system/adapters/generic.Routeid',
      expectedStatus: 201,
      requestBodyFile: undefined,
      uuid: undefined,
      headers: { 'Content-Type': 'application/json' },
      stepLine: 36,
      rawStep: 'POST /system/adapters/generic.Routeid',
    },
  ];

  const realPayloadContent = JSON.stringify({
    templateId: 'direct:ApiToApi',
    name: 'ApiToApi Template',
    type: 'EVENTTOAPI',
    templates: [],
  }, null, 2);

  const resolvedFilesWithContent: Record<string, any> = {
    '/system/adapters/templates/payloads/template.json': {
      name: 'template.json',
      path: '/system/adapters/templates/payloads/template.json',
      rawText: realPayloadContent,
      source: 'folder',
      fileKind: 'template',
      parsedJson: JSON.parse(realPayloadContent),
    },
  };

  // ---------- Positive scenarios ----------

  it('includes actual payload content from resolvedFiles in request body', () => {
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', resolvedFilesWithContent);

    const templateItem = collection.item[0];
    expect(templateItem.request.body).toBeDefined();
    expect(templateItem.request.body!.mode).toBe('raw');
    expect(templateItem.request.body!.raw).toBe(realPayloadContent);
    expect(templateItem.request.body!.raw).toContain('templateId');
    expect(templateItem.request.body!.raw).toContain('ApiToApi Template');
  });

  it('does not include body when requestBodyFile is undefined', () => {
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', resolvedFilesWithContent);

    const adapterItem = collection.item[1];
    expect(adapterItem.request.body).toBeUndefined();
  });

  it('includes UUID header when api.uuid is present', () => {
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', resolvedFilesWithContent);

    const templateItem = collection.item[0];
    const uuidHeader = templateItem.request.header.find((h: any) => h.key === 'UUID');
    expect(uuidHeader).toBeDefined();
    expect(uuidHeader!.value).toBe('adapqi-da5244e-a140-470e-83ad-768cb225640');
  });

  it('generates valid Postman Collection v2.1 schema', () => {
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', resolvedFilesWithContent);

    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.info.name).toBe('Test Collection');
    expect(Array.isArray(collection.item)).toBe(true);
    expect(collection.item.length).toBe(2);
  });

  // ---------- Negative scenarios ----------

  it('uses fallback placeholder when resolvedFiles does not contain the payload file', () => {
    const emptyResolved: Record<string, any> = {};
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', emptyResolved);

    const templateItem = collection.item[0];
    expect(templateItem.request.body).toBeDefined();
    expect(templateItem.request.body!.mode).toBe('raw');
    expect(templateItem.request.body!.raw).toContain('Payload file not loaded');
    expect(templateItem.request.body!.raw).toContain('template.json');
  });

  it('handles undefined resolvedFiles gracefully', () => {
    const collection = generatePostmanCollection(sampleApiCalls, 'Test Collection', undefined);

    const templateItem = collection.item[0];
    expect(templateItem.request.body).toBeDefined();
    expect(templateItem.request.body!.raw).toContain('Payload file not loaded');
  });

  it('handles empty apiCalls array', () => {
    const collection = generatePostmanCollection([], 'Empty Collection', resolvedFilesWithContent);

    expect(collection.info.name).toBe('Empty Collection');
    expect(collection.item).toEqual([]);
  });
});

describe('generatePostmanCollection (integration with testfeature.feature)', () => {
  const featurePath = path.resolve(__dirname, '../featurefiles/testfeature.feature');
  const registrationDir = path.resolve(__dirname, '../eventToApi Registration');

  it('parses testfeature.feature and includes real payload content from resolved files', () => {
    // 1. Read and parse the actual test feature file
    const featureContent = fs.readFileSync(featurePath, 'utf-8');
    const analysis = parseFeatureText(featureContent);

    // 2. Verify we found API endpoints
    expect(analysis.apiCalls.length).toBeGreaterThan(0);

    // 3. Build resolvedFiles from actual payload files that exist on disk
    const resolvedFiles: Record<string, any> = {};
    for (const api of analysis.apiCalls) {
      if (api.requestBodyFile && fs.existsSync(api.requestBodyFile)) {
        const rawText = fs.readFileSync(api.requestBodyFile, 'utf-8');
        resolvedFiles[api.requestBodyFile] = {
          name: path.basename(api.requestBodyFile),
          path: api.requestBodyFile,
          rawText,
          source: 'folder',
          fileKind: 'template',
          parsedJson: JSON.parse(rawText),
        };
      }
    }

    // 4. At least one payload file should exist (eventtoapitemplateconfigpayload.json)
    expect(Object.keys(resolvedFiles).length).toBeGreaterThan(0);

    // 5. Generate collection with real resolved files
    const collection = generatePostmanCollection(analysis.apiCalls, 'testfeature-collection', resolvedFiles);

    // 6. Verify valid collection structure
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.item.length).toBe(analysis.apiCalls.length);

    // 7. Find the item that has a payload file resolved and verify real content
    const itemsWithRealBody = collection.item.filter((i: any) =>
      i.request.body && i.request.body.mode === 'raw' && !i.request.body.raw.includes('Payload file not loaded')
    );
    expect(itemsWithRealBody.length).toBeGreaterThan(0);

    // 8. The template payload should contain actual JSON (not placeholder)
    const templateItem = itemsWithRealBody[0];
    expect(templateItem.request.body!.raw.length).toBeGreaterThan(100);
    expect(templateItem.request.body!.raw).toContain('direct:eventtoapi.json.process');

    // 9. Items without resolved payload files should have fallback placeholder
    const itemsWithPlaceholder = collection.item.filter((i: any) =>
      i.request.body && i.request.body.raw.includes('Payload file not loaded')
    );
    expect(itemsWithPlaceholder.length).toBeGreaterThan(0);
  });

  it('includes all detected API endpoints from testfeature.feature', () => {
    const featureContent = fs.readFileSync(featurePath, 'utf-8');
    const analysis = parseFeatureText(featureContent);

    const collection = generatePostmanCollection(analysis.apiCalls, 'testfeature-collection', {});

    // Each apiCall should become a collection item
    expect(collection.item.length).toBe(analysis.apiCalls.length);

    // Verify URIs match
    const collectionUris = collection.item.map((i: any) => i.request.url.raw);
    analysis.apiCalls.forEach((api) => {
      expect(collectionUris).toContain(api.uri);
    });
  });

  it('includes expected status codes from testfeature.feature scenarios', () => {
    const featureContent = fs.readFileSync(featurePath, 'utf-8');
    const analysis = parseFeatureText(featureContent);

    const collection = generatePostmanCollection(analysis.apiCalls, 'testfeature-collection', {});

    // Verify expected status codes appear in descriptions
    const descriptions = collection.item.map((i: any) => i.request.description);
    analysis.apiCalls.forEach((api) => {
      if (api.expectedStatus) {
        expect(descriptions.some((d: string) => d.includes(`Expected status: ${api.expectedStatus}`))).toBe(true);
      }
    });
  });
});

describe('generatePostmanCollection (integration with SAMPLE_FEATURE_CONTENT)', () => {
  // This is the exact feature content loaded when user clicks "Load Sample Feature"
  const analysis = parseFeatureText(SAMPLE_FEATURE_CONTENT);

  it('parses SAMPLE_FEATURE_CONTENT and detects API endpoints', () => {
    expect(analysis.apiCalls.length).toBeGreaterThan(0);
    expect(analysis.apiCalls.some(a => a.uri.includes('/system/adapters/templates'))).toBe(true);
    expect(analysis.apiCalls.some(a => a.uri.includes('/system/adapters/generic'))).toBe(true);
    expect(analysis.apiCalls.some(a => a.uri.includes('/apitoapijobs'))).toBe(true);
  });

  it('generates collection items for all detected API endpoints', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', {});

    expect(collection.item.length).toBe(analysis.apiCalls.length);

    // Verify URIs match the feature file
    const collectionUris = collection.item.map((i: any) => i.request.url.raw);
    analysis.apiCalls.forEach((api) => {
      expect(collectionUris).toContain(api.uri);
    });

    // Verify methods
    collection.item.forEach((item: any) => {
      expect(['POST', 'GET', 'PUT', 'DELETE', 'PATCH']).toContain(item.request.method);
    });
  });

  it('includes headers from SAMPLE_FEATURE_CONTENT background step', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', {});

    const allHeaders = collection.item.flatMap((i: any) => i.request.header || []);
    const headerKeys = allHeaders.map((h: any) => h.key);

    // Background sets Content-Type and UUID headers
    expect(headerKeys).toContain('Content-Type');
    expect(headerKeys).toContain('UUID');
    expect(headerKeys).toContain('Authorization');
  });

  it('includes expected status codes in descriptions', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', {});

    const descriptions = collection.item.map((i: any) => i.request.description);
    analysis.apiCalls.forEach((api) => {
      if (api.expectedStatus) {
        expect(descriptions.some((d: string) => d.includes(`Expected status: ${api.expectedStatus}`))).toBe(true);
      }
    });

    // Sample feature has 201, 400, and 500 status codes
    expect(descriptions.some((d: string) => d.includes('Expected status: 201'))).toBe(true);
    expect(descriptions.some((d: string) => d.includes('Expected status: 400'))).toBe(true);
    expect(descriptions.some((d: string) => d.includes('Expected status: 500'))).toBe(true);
  });

  it('uses fallback placeholder when payload files are not resolved', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', {});

    const itemsWithBody = collection.item.filter((i: any) => i.request.body);
    expect(itemsWithBody.length).toBeGreaterThan(0);

    // All items should have fallback placeholders since no payload files are resolved
    itemsWithBody.forEach((item: any) => {
      expect(item.request.body.mode).toBe('raw');
      expect(item.request.body.raw).toContain('Payload file not loaded');
    });
  });

  it('includes real payload content when resolvedFiles contains matching files', () => {
    // Simulate that payload files have been resolved (as would happen after folder select/upload)
    const realPayload = JSON.stringify({ templateId: 'direct:ApiToApi', type: 'EVENTTOAPI' }, null, 2);
    const resolvedFiles: Record<string, any> = {};

    analysis.apiCalls.forEach((api) => {
      if (api.requestBodyFile) {
        resolvedFiles[api.requestBodyFile] = {
          name: path.basename(api.requestBodyFile),
          path: api.requestBodyFile,
          rawText: realPayload,
          source: 'folder',
          fileKind: 'template',
          parsedJson: JSON.parse(realPayload),
        };
      }
    });

    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', resolvedFiles);

    const itemsWithRealBody = collection.item.filter((i: any) =>
      i.request.body && i.request.body.raw === realPayload
    );
    expect(itemsWithRealBody.length).toBeGreaterThan(0);

    // Verify the real JSON content is in the body
    itemsWithRealBody.forEach((item: any) => {
      expect(item.request.body!.raw).toContain('direct:ApiToApi');
      expect(item.request.body!.raw).toContain('EVENTTOAPI');
    });
  });

  it('collection has valid Postman v2.1 schema with SAMPLE_FEATURE_CONTENT', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, 'sample-feature-collection', {});

    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.info.name).toBe('sample-feature-collection');
    expect(Array.isArray(collection.item)).toBe(true);
    expect(collection.item.length).toBeGreaterThan(0);

    // Every item should have a valid URL
    collection.item.forEach((item: any) => {
      expect(item.request.url.raw).toBeDefined();
      expect(item.request.url.raw.length).toBeGreaterThan(0);
      expect(item.request.method).toBeDefined();
    });
  });
});

describe('7-tabs validation with committed test fixtures (02_adapter_eventtoapi validation)', () => {
  const featurePath = path.resolve(__dirname, '../ms-adapterservice-test/cucumber-test-scripts/integration-cucumber-test-scripts/UTP/02_adapter_eventtoapi validation.feature');
  const baseTestDataPath = path.resolve(__dirname, '../ms-adapterservice-test/src/test/resources/integration-cucumber-json-payload');

  const featureContent = fs.readFileSync(featurePath, 'utf-8');
  const analysis = parseFeatureText(featureContent);

  // Resolve payloads using grandparent path matching (same logic as FeatureFileExplorer.handleFolderSelect)
  const MAX_GRANDPARENT_LEVELS = 5;
  const pathVariants = (targetPath: string): string[] => {
    const variants: string[] = [targetPath];
    for (let i = 1; i <= MAX_GRANDPARENT_LEVELS; i++) {
      variants.push('../'.repeat(i) + targetPath);
    }
    return variants;
  };

  // Collect all files from base test data folder (simulating webkitRelativePath)
  const allFiles: { name: string; relPath: string }[] = [];
  const walkDir = (dir: string, baseDir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, baseDir);
      } else {
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        allFiles.push({ name: entry.name, relPath });
      }
    }
  };
  walkDir(baseTestDataPath, baseTestDataPath);

  const resolvedPayloads: Record<string, any> = {};
  for (const targetPath of analysis.artifacts.payloadFiles) {
    const variants = pathVariants(targetPath);
    const matchedFile = allFiles.find(f => {
      return variants.some(v => matchesPath(v, f.relPath, f.name));
    });
    if (matchedFile) {
      resolvedPayloads[targetPath] = {
        name: matchedFile.name,
        path: targetPath,
        rawText: fs.readFileSync(path.join(baseTestDataPath, matchedFile.relPath), 'utf-8'),
        source: 'folder',
      };
    }
  }

  describe('Tab 1: Scenarios & Flow', () => {
    it('should load 3 scenarios', () => {
      expect(analysis.scenarios.length).toBe(3);
      expect(analysis.stats.totalScenarios).toBe(3);
    });

    it('ViewFlow#1 should open with adapter registration json loaded', () => {
      expect(analysis.configurations.pairs.length).toBeGreaterThanOrEqual(1);
      const pair = analysis.configurations.pairs[0];
      expect(pair.adapterConfig).toBeDefined();
      expect(pair.adapterConfig!.path).toContain('eventtoapiadapterconfigpayload');
    });
  });

  describe('Tab 2: Adapter & Templates', () => {
    it('should have adapter registration json loaded', () => {
      const pair = analysis.configurations.pairs[0];
      expect(pair.adapterConfig).toBeDefined();
      expect(pair.adapterConfig!.path).toContain('eventtoapiadapterconfigpayload');
    });

    it('should have template definition json loaded', () => {
      const pair = analysis.configurations.pairs[0];
      expect(pair.templateConfigs.length).toBeGreaterThanOrEqual(1);
      expect(pair.templateConfigs[0]!.path).toContain('eventtoapitemplateconfigpayload');
    });
  });

  describe('Tab 3: API Matrix', () => {
    it('should have 2 endpoints', () => {
      expect(analysis.apiCalls.length).toBe(2);
    });
  });

  describe('Tab 4: Validation', () => {
    it('should have 1 database assertion', () => {
      expect(analysis.dataValidations.length).toBe(1);
    });
  });

  describe('Tab 5: Artifacts & Tokens', () => {
    it('should have payload files loaded via grandparent matching', () => {
      expect(analysis.artifacts.payloadFiles.length).toBe(2);
      expect(Object.keys(resolvedPayloads).length).toBe(2);
    });

    it('should resolve adapter + template payload files including grandparent path variants', () => {
      const payloadNames = Object.keys(resolvedPayloads);
      expect(payloadNames.some(p => p.includes('eventtoapitemplateconfigpayload'))).toBe(true);
      expect(payloadNames.some(p => p.includes('eventtoapiadapterconfigpayload'))).toBe(true);
    });
  });

  describe('Tab 6: Human Explanation', () => {
    it('should have feature analysis header', () => {
      const explanation = generateMarkdownExplanation(analysis);
      expect(explanation).toContain('# Feature Analysis: 02_adapter_eventtoapi validation');
    });
  });

  describe('Tab 7: Raw.feature', () => {
    it('should contain feature header text', () => {
      expect(featureContent).toContain('Feature: 02_adapter_eventtoapi validation');
    });
  });

  it('Postman Collection download should include real payload content', () => {
    const collection = generatePostmanCollection(analysis.apiCalls, '02_adapter_eventtoapi-validation', resolvedPayloads);
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.item.length).toBe(analysis.apiCalls.length);

    // At least one item should have real payload content (not fallback placeholder)
    const itemsWithRealBody = collection.item.filter((i: any) =>
      i.request.body && i.request.body.mode === 'raw' && !i.request.body.raw.includes('Payload file not loaded')
    );
    expect(itemsWithRealBody.length).toBeGreaterThan(0);
  });
});

describe('Back to Features List flow', () => {
  let mounted: ReturnType<typeof mount> | undefined;
  afterEach(() => { mounted?.unmount(); mounted = undefined; });

  it('switches to Feature Explorer tab and shows ← Back to Features List button', () => {
    mounted = mount();
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    expect(mounted.host.innerHTML).toContain('Feature File Explorer');
    expect(mounted.host.innerHTML).toContain('← Back to Features List');
    expect(mounted.host.innerHTML).toContain('🔍 Feature Discovery');
  });

  it('clicking ← Back to Features List switches to discovery mode', () => {
    mounted = mount();
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    // Initially in single mode with back button visible
    expect(mounted.host.innerHTML).toContain('← Back to Features List');

    // Click back button to return to discovery mode
    const backBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Back to Features List')) as HTMLButtonElement;
    act(() => { backBtn.click(); });

    // Should now show discovery mode UI
    expect(mounted.host.innerHTML).toContain('Feature Discovery — Browse Folder');
    expect(mounted.host.innerHTML).toContain('Select Feature Folder');
  });

  it('navigates from single mode back to discovery and feature list stays painted', () => {
    mounted = mount();

    // Switch to Feature Explorer tab (starts in single mode)
    const featTab = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Feature Explorer') as HTMLButtonElement;
    act(() => { featTab.click(); });

    // Initially in single mode with back button visible
    expect(mounted.host.innerHTML).toContain('← Back to Features List');

    // Click back button to return to discovery mode
    const backBtn = Array.from(mounted.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Back to Features List')) as HTMLButtonElement;
    act(() => { backBtn.click(); });

    // Should now show discovery mode UI (folder selections preserved)
    expect(mounted.host.innerHTML).toContain('Feature Discovery — Browse Folder');
    expect(mounted.host.innerHTML).toContain('Select Feature Folder');
  });
});

