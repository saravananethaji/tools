/**
 * Playwright E2E Tests for Maven Project Graph
 * Tests the web UI functionality for Maven dependency graph analysis
 */

const { test, expect } = require('@playwright/test');

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
    const matchCount = await page.locator('.node.match').count();
    console.log(`Found ${matchCount} matching modules`);
    expect(matchCount).toBeGreaterThan(0);
    // Clear search
    await page.fill('input#search', '');
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
    // Click expand all
    await page.click('button:text("Expand All")');
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
});
