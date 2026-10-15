import { describe, expect, it, afterEach } from 'vitest';
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
});

