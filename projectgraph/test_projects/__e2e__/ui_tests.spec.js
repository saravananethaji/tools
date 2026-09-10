/**
 * Playwright E2E Tests for Maven Project Graph
 * Tests the web UI functionality for Maven dependency graph analysis
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE_URL = process.env.PROJECTGRAPH_TEST_URL || 'http://127.0.0.1:8000';

test.describe('Maven Project Graph - UI Tests', () => {
  test('page title and load', async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for page to settle
    await page.waitForLoadState('networkidle');
    // Check title
    await expect(page).toHaveTitle(/Dependency Hierarchy/);
  });

  test('tree view loads modules', async ({ page }) => {
    await page.goto(`${BASE_URL}/tree`);
    // Wait for network to settle
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    // Wait for module cards to appear
    await page.waitForSelector('.module-card', { state: 'visible', timeout: 15000 });
    // Check that we have modules
    const moduleCount = await page.locator('.module-card').count();
    console.log(`Found ${moduleCount} module cards`);
    expect(moduleCount).toBe(11);
  });

  test('search functionality', async ({ page }) => {
    await page.goto(`${BASE_URL}/tree`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.module-card', { state: 'visible', timeout: 15000 });
    // Search for a specific module
    await page.fill('input#search', 'order-service');
    // Check that we have matching modules
    await expect(page.locator('.node.match').first()).toBeVisible();
    const matchCount = await page.locator('.node.match').count();
    console.log(`Found ${matchCount} matching modules`);
    expect(matchCount).toBeGreaterThan(0);
    // Clear search
    await page.fill('input#search', '');
  });

  test('tree starts lazy and labels dependency origin', async ({ page }) => {
    await page.goto(`${BASE_URL}/tree`);
    await page.locator('main[data-rendered="true"]').waitFor();
    // Loading the page must not build every tree in the DOM.
    await expect(page.locator('.tree-body:not(.hidden)')).toHaveCount(0);
    await expect(page.locator('#tree-0 .node')).toHaveCount(0);
    await expect(page.locator('#tree-guidance')).toContainText('one branch at a time');

    await page.locator('.module-head').first().click();
    await expect(page.locator('#tree-0 .node-kind').first()).toBeVisible();
    await expect(page.locator('#tree-0 .node-kind').first()).toHaveText(/internal|oss/);
  });

  test('version indicators display', async ({ page }) => {
    await page.goto(`${BASE_URL}/tree`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.module-card', { state: 'visible', timeout: 15000 });
    // Every module must show its version and architectural classification.
    const scopeBadges = page.locator('.scope-pill');
    const badgeCount = await scopeBadges.count();
    console.log(`Found ${badgeCount} scope pill badges`);
    // Also check version badges
    const verBadges = page.locator('.module-head .version-pill');
    const verBadgeCount = await verBadges.count();
    console.log(`Found ${verBadgeCount} version badges`);
    expect(verBadgeCount).toBe(11);
    expect(badgeCount).toBeGreaterThanOrEqual(verBadgeCount);
  });

  test('collapse/expand all', async ({ page }) => {
    await page.goto(`${BASE_URL}/tree`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.module-card', { state: 'visible', timeout: 15000 });
    // Click collapse all
    await page.click('button:text("Collapse All")');
    // Check that tree bodies are hidden - look for hidden class
    const bodies = page.locator('.tree-body');
    const bodyCount = await bodies.count();
    expect(bodyCount).toBeGreaterThan(0);
    await expect(bodies).toHaveClass(Array(bodyCount).fill(/hidden/));
    console.log(`Found ${bodyCount} tree bodies`);
    if (bodyCount > 0) {
      const firstHidden = await bodies.first().getAttribute('class');
      console.log(`First tree body class: ${firstHidden}`);
    }
    // Global expansion is intentionally bounded for large scans.
    await page.click('button:text("Expand modules")');
    // Check that tree bodies are visible
    const visibleCount = await bodies.evaluateAll(
      els => Array.from(els).filter(el => !el.classList.contains('hidden')).length
    );
    console.log(`Visible tree bodies: ${visibleCount}`);
    expect(visibleCount).toBe(bodyCount);
  });

  test('navigation links', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    // Click through main nav - Tree
    await page.click('text=Dependency Tree');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.module-card', { state: 'visible', timeout: 10000 });
    // Click Conflicts
    await page.click('text=Conflicts');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.err-box, .module-card', { state: 'visible', timeout: 10000 });
    // Click Export
    await page.click('text=Neo4j Export');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.scope-pill, pre.export', { state: 'visible', timeout: 10000 });
  });

  test('impact API answers blast radius without a graph database', async ({ page }) => {
    // Exact coordinate that exists in the scan the fixtures resolve to.
    const res = await page.request.get(
      `${BASE_URL}/api/impact?coordinate=${encodeURIComponent('org.apache.httpcomponents:httpcore')}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.query.parsed.groupId).toBe('org.apache.httpcomponents');
    expect(body.query.parsed.artifactId).toBe('httpcore');
    expect(Array.isArray(body.matches)).toBeTruthy();
    expect(['complete', 'partial']).toContain(body.completeness);
    expect(Array.isArray(body.excluded_modules)).toBeTruthy();
    // Every reported module carries bounded paths and provenance.
    for (const mod of body.modules) {
      expect(mod.pom_path).toBeTruthy();
      expect(['direct', 'transitive']).toContain(mod.relationship);
      expect(Array.isArray(mod.paths)).toBeTruthy();
      for (const p of mod.paths) {
        expect(p.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test('impact API rejects artifactId-only queries', async ({ page }) => {
    const res = await page.request.get(`${BASE_URL}/api/impact?coordinate=httpcore`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('explicit groupId');
  });

  test('routes API returns bounded routes or an explicit empty answer', async ({ page }) => {
    const url = `${BASE_URL}/api/routes`
      + `?from_coordinate=${encodeURIComponent('org.apache.httpcomponents:httpclient')}`
      + `&to_coordinate=${encodeURIComponent('org.apache.httpcomponents:httpcore')}`;
    const res = await page.request.get(url);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.route_count).toBe('number');
    expect(Array.isArray(body.routes)).toBeTruthy();
    // A zero-route answer must say so rather than being silently empty.
    if (body.route_count === 0) {
      expect(body.note).toBeTruthy();
    } else {
      for (const r of body.routes) {
        expect(r.module).toBeTruthy();
        expect(Array.isArray(r.path)).toBeTruthy();
        expect(r.path.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test('impact UI shows affected modules, paths and source POMs', async ({ page }) => {
    await page.goto(`${BASE_URL}/impact`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    // The empty state must invite an exact coordinate and reject guessing.
    await expect(page.locator('h2')).toContainText('Impact Analysis');
    await expect(page.locator('.card').first()).toContainText('exact');
    await expect(page.locator('input[name="coordinate"]')).toBeVisible();
    // No report is rendered until a query is made.
    await expect(page.locator('text=affected module(s)')).toHaveCount(0);
  });

  test('impact UI rejects an artifactId-only query with a visible error', async ({ page }) => {
    await page.goto(`${BASE_URL}/impact?coordinate=httpcore`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    await expect(page.locator('.err')).toContainText('groupId');
  });

  test('impact UI renders a resolved query end to end', async ({ page }) => {
    const coordinate = 'org.apache.httpcomponents:httpcore';
    await page.goto(`${BASE_URL}/impact?coordinate=${encodeURIComponent(coordinate)}`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    // Either an affected-modules answer or an explicit no-match note.
    const hasAnswer = await page.locator('text=affected module(s)').count();
    if (hasAnswer > 0) {
      // Evidence must include the source POM and the dependency path.
      await expect(page.locator('text=Source POM')).toBeVisible();
      await expect(page.locator('td code').first()).toBeVisible();
      await expect(page.locator('text=Dependency path(s)')).toBeVisible();
    } else {
      await expect(page.locator('main')).toContainText('No resolved artifact matches');
    }
    // The view must never present speculative fix XML.
    await expect(page.locator('pre')).toHaveCount(0);
  });

  test('conflicts view states resolved-only semantics', async ({ page }) => {
    await page.goto(`${BASE_URL}/conflicts`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    // The view must always explain that it uses resolved data only.
    await expect(page.locator('h2')).toContainText('Version Conflicts');
    await expect(page.locator('.card').first()).toContainText('resolved');
    // Either a conflict card with paths, or the explicit clean state.
    const cards = page.locator('.module-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(1);
    const clean = await page.locator('text=No version conflicts or drift').count();
    if (clean === 0) {
      // Every conflict row shows a dependency path, never a bare version.
      const rows = page.locator('table tbody tr');
      expect(await rows.count()).toBeGreaterThan(0);
      const arrows = await page.locator('table tbody tr td:last-child').count();
      expect(arrows).toBeGreaterThan(0);
    }
  });

  test('OSS inventory view renders a table with honest completeness', async ({ page }) => {
    await page.goto(`${BASE_URL}/inventory`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();
    // The table (or the empty-state card) must be present.
    const hasTable = await page.locator('table').count();
    const hasEmpty = await page.locator('text=No resolved open-source dependencies').count();
    expect(hasTable + hasEmpty).toBeGreaterThanOrEqual(1);
    // Completeness badge is always shown and is one of the two honest values.
    await expect(page.locator('main strong')).not.toHaveText(/unknown/);
    // The API returns the same shape the view consumes.
    const api = await page.request.get(`${BASE_URL}/api/inventory`);
    expect(api.ok()).toBeTruthy();
    const body = await api.json();
    expect(['complete', 'partial']).toContain(body.completeness);
    expect(Array.isArray(body.entries)).toBeTruthy();
    for (const e of body.entries) {
      expect(e.canonical_id).toBeTruthy();
      expect(e.purl).toMatch(/^pkg:maven\//);
      expect(['external', 'internal']).toContain(e.kind);
      for (const c of e.consumers) {
        expect(['direct', 'transitive']).toContain(c.relationship);
        expect(Array.isArray(c.paths)).toBeTruthy();
      }
    }
  });

  test('OSS inventory downloads an Excel workbook with a summary', async ({ page }) => {
    await page.goto(`${BASE_URL}/inventory`);
    await page.locator('main[data-rendered="true"]').waitFor();
    await expect(page.getByRole('link', { name: 'Download Excel' })).toHaveAttribute(
      'href', '/inventory/download');
    const response = await page.request.get(`${BASE_URL}/inventory/download`);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers()['content-disposition']).toContain('oss-inventory.xlsx');
    expect((await response.body()).subarray(0, 2).toString()).toBe('PK');
  });

  test('topology view separates structural from resolved relationships', async ({ page }) => {
    await page.goto(`${BASE_URL}/topology`);
    await page.waitForLoadState('networkidle');
    await page.locator('main[data-rendered="true"]').waitFor();

    await expect(page.locator('h2')).toContainText('POM Topology');
    // Each relationship class must be labelled with its own truth status, so a
    // structural edge can never be read as a dependency.
    await expect(page.locator('main')).toContainText('parent (POM inheritance)');
    await expect(page.locator('main')).toContainText('aggregates (build structure)');
    await expect(page.locator('main')).toContainText('depends on (resolved)');
    await expect(page.locator('main')).toContainText('used by (resolved)');
    await expect(page.locator('main')).toContainText('declared dependency (unverified)');
    await expect(page.locator('main')).toContainText('structural');
  });

  test('topology API reports truth status per relationship class', async ({ page }) => {
    const res = await page.request.get(`${BASE_URL}/api/topology`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Truth statuses must be distinct: resolved is not structural.
    expect(body.relations.parent.truth).toBe('structural');
    expect(body.relations.aggregates.truth).toBe('structural');
    expect(body.relations.dependsOn.truth).toBe('resolved');
    expect(body.relations.usedBy.truth).toBe('resolved');
    expect(body.relations.declaredDependency.truth).toBe('declared-unverified');

    for (const key of Object.keys(body.relations)) {
      expect(body.relations[key].label).toBeTruthy();
      expect(body.relations[key].note).toBeTruthy();
      expect(Array.isArray(body.relations[key].edges)).toBeTruthy();
    }
    expect(['complete', 'partial']).toContain(body.completeness);
    expect(Array.isArray(body.unresolved_links)).toBeTruthy();
  });

  test('topology API returns parent and aggregation for a module', async ({ page }) => {
    const module = 'com.company:order-service-code:1.5.0';
    const res = await page.request.get(
      `${BASE_URL}/api/topology?module=${encodeURIComponent(module)}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.module).toBe(module);
    // Fixture declares a parent, so it must be reported with in-scan status.
    expect(body.parent).toBeTruthy();
    expect(body.parent.coord).toBe('com.company:order-service:1.5.0');
    expect(body.parent.in_scan).toBe(true);
    expect(Array.isArray(body.used_by)).toBeTruthy();
    expect(Array.isArray(body.declared_dependencies)).toBeTruthy();
  });

  test('topology API rejects an unknown module coordinate', async ({ page }) => {
    const res = await page.request.get(
      `${BASE_URL}/api/topology?module=${encodeURIComponent('no.such:module:9.9.9')}`);
    expect(res.status()).toBe(404);
  });

  test('used by is proven from resolved edges in a shared-library reactor', async ({ page }) => {
    // This test re-scans a different root, and /api/load persists the result as
    // the retained scan. Capture the original root first and restore exactly
    // that, or later tests (and the next server boot) would see the fixture.
    const fixture = path.resolve(__dirname, '../../tests/fixtures/maven/shared-lib');
    const stateBefore = await (await page.request.get(`${BASE_URL}/api/state`)).json();
    const originalRoot = stateBefore.metadata.root;
    expect(originalRoot).toBeTruthy();

    try {
      const load = await page.request.post(`${BASE_URL}/api/load`, {
        form: { root: fixture },
      });
      expect(load.ok()).toBeTruthy();

      // Two modules resolve the same real library offline.
      const body = await (await page.request.get(`${BASE_URL}/api/topology`)).json();
      const shared = Object.keys(body.used_by).filter((k) => k.includes('commons-codec'));
      expect(shared.length).toBeGreaterThan(0);
      const users = body.used_by[shared[0]].map((u) => u.module);
      expect(users).toContain('fixture.projectgraph:consumer-a:1.0.0');
      expect(users).toContain('fixture.projectgraph:consumer-b:1.0.0');

      // A declared-only edge must never be reported as usage.
      expect(body.relations.declaredDependency.truth).toBe('declared-unverified');

      await page.goto(`${BASE_URL}/topology?module=${encodeURIComponent('fixture.projectgraph:consumer-a:1.0.0')}`);
      await page.waitForLoadState('networkidle');
      await page.locator('main[data-rendered="true"]').waitFor();
      await expect(page.locator('main')).toContainText('Used by (resolved)');
      await expect(page.locator('main')).toContainText('Parent (POM inheritance)');
      await expect(page.locator('main')).toContainText('shared-lib-parent');
    } finally {
      const restore = await page.request.post(`${BASE_URL}/api/load`, {
        form: { root: originalRoot },
      });
      expect(restore.ok()).toBeTruthy();
    }
  });

  test('Dependency Snapshot downloads, uploads, and becomes read-only', async ({ page }, testInfo) => {
    await page.goto(`${BASE_URL}/snapshot`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: 'Download Dependency Snapshot' })).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download Dependency Snapshot' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('dependency-snapshot.json');
    const snapshotPath = testInfo.outputPath('dependency-snapshot.json');
    await download.saveAs(snapshotPath);

    await page.setInputFiles('#snapshot-file', snapshotPath);
    await page.getByRole('button', { name: 'Open snapshot' }).click();
    await page.waitForURL('**/tree');
    await expect(page.locator('body')).toContainText(
      'Loaded Dependency Snapshot — historical, read-only data');

    // The imported graph cannot be mistaken for a local Maven scan.
    const reload = await page.request.post(`${BASE_URL}/api/reload`);
    expect(reload.status()).toBe(409);
  });
});
