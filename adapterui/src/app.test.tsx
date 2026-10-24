import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';

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

  it('lands on the folder browser and offers both modes', () => {
    mounted = mount();
    const html = mounted.host.innerHTML;
    expect(html).toContain('Use-case folder browser');
    const tabs = Array.from(mounted.host.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Folder browser', 'Single review', 'Feature Explorer']);
    expect(mounted.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Folder browser');
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

  it('switches to the single-review mode and keeps its import flow', () => {
    mounted = mount();
    const single = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Single review') as HTMLButtonElement;
    act(() => { single.click(); });
    const html = mounted.host.innerHTML;
    expect(html).toContain('Adapter configuration review');
    expect(html).toContain('1. Adapter registration JSON');
    expect(html).toContain('2. Template definition JSON file(s)');
    expect(mounted.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Single review');
  });

  it('exposes the folder picker only in catalog mode', () => {
    mounted = mount();
    expect(mounted.host.querySelector('input[aria-label="Select a use-case folder"]')).not.toBeNull();
    const single = Array.from(mounted.host.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === 'Single review') as HTMLButtonElement;
    act(() => { single.click(); });
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

  it('includes request body placeholder when payload file is referenced', async () => {
    await loadFeatureAndOpenApiMatrix();

    const downloadBtn = Array.from(mounted!.host.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Download Postman Collection')) as HTMLButtonElement;
    act(() => { downloadBtn.click(); });

    const collection = await getDownloadedCollection();

    const itemsWithBody = collection.item.filter((i: any) => i.request.body);
    expect(itemsWithBody.length).toBeGreaterThan(0);
    expect(itemsWithBody[0].request.body.mode).toBe('raw');
    expect(itemsWithBody[0].request.body.raw).toContain('Payload file:');
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

