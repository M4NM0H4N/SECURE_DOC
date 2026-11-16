'use strict';
/* global document, window -- these run inside the browser page via page.evaluate */

const { test, expect } = require('@playwright/test');
const { path } = require('./helpers');

// The public landing page: it is dynamic (institution name and departments from the server, live status,
// an interactive example, role tabs, a verify box), so its behaviour is tested, not just its looks.
test.describe('landing page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(path('/'));
    await expect(page.locator('#landing')).toBeVisible();
  });

  test('shows the institution name and its real departments', async ({ page }) => {
    await expect(page.locator('.land-nav .brand')).toContainText('Demo Institution');
    const chips = page.locator('#dept-list .chip');
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#dept-list')).toContainText('CSE');
  });

  test('the live status pill reflects the real health check', async ({ page }) => {
    await expect(page.locator('#status-pill.ok')).toBeVisible();
    await expect(page.locator('#status-text')).toContainText('operational');
  });

  test('the example request follows the step the visitor chooses and stays put', async ({ page }) => {
    await page.locator('.demo-step[data-i="1"]').click();
    await expect(page.locator('#demo-badge')).toHaveText('Under review');
    await expect(page.locator('#chip-2')).toHaveClass(/lit/);
    await expect(page.locator('#chip-3')).not.toHaveClass(/lit/);
    await page.locator('.demo-step[data-i="3"]').click();
    await expect(page.locator('#demo-badge')).toHaveText('Fulfilled');
    await expect(page.locator('#chip-3')).toHaveClass(/lit/);
    await page.waitForTimeout(5200); // longer than the auto-play interval: it must not move on by itself
    await expect(page.locator('#demo-badge')).toHaveText('Fulfilled');
  });

  test('role tabs switch panels and work with the keyboard', async ({ page }) => {
    await expect(page.locator('#panel-student')).toBeVisible();
    await page.locator('#tab-hod').click();
    await expect(page.locator('#panel-hod')).toBeVisible();
    await expect(page.locator('#panel-student')).toBeHidden();
    await page.locator('#tab-hod').press('ArrowRight');
    await expect(page.locator('#tab-principal')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-principal')).toBeVisible();
    await page.locator('#tab-principal').press('End');
    await expect(page.locator('#panel-admin')).toBeVisible();
  });

  test('the verify box sends the code to the verify page', async ({ page }) => {
    await page.fill('#hero-code', 'SAMPLE-CODE-123');
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.waitForURL(/verify\.html\?code=SAMPLE-CODE-123/);
    // An unknown code is reported plainly, not as a crash.
    await expect(page.locator('#result')).toContainText(/No document matches|not available/);
  });

  test('FAQ answers open and close', async ({ page }) => {
    const first = page.locator('.faq details').first();
    await first.locator('summary').click();
    await expect(first).toHaveAttribute('open', '');
    await first.locator('summary').click();
    await expect(first).not.toHaveAttribute('open', '');
  });

  test('the theme toggle switches and is remembered', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#theme-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('signed-in visitors are sent to their dashboard instead', async ({ browser }) => {
    const { signIn } = require('./helpers');
    const { context, page } = await signIn(browser, 'student');
    await page.goto(path('/'));
    await page.waitForURL(/\/student\//);
    await context.close();
  });
});

test.describe('landing page on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } });
  test('has no sideways scroll and keeps the key actions reachable', async ({ page }) => {
    await page.goto(path('/'));
    await expect(page.locator('#landing')).toBeVisible();
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(w.doc).toBeLessThanOrEqual(w.view + 1);
    await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
    await expect(page.locator('#hero-code')).toBeVisible();
  });
});
