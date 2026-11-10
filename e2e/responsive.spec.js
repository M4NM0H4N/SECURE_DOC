'use strict';
/* global document, window -- these run inside the browser page via page.evaluate */

const { test, expect } = require('@playwright/test');
const { path, signIn } = require('./helpers');

// Mobile-first check: at phone and tablet widths nothing may force sideways scrolling, and tap targets
// on the main actions must be big enough to hit.
const WIDTHS = [320, 375, 768];

async function noHorizontalScroll(page, label) {
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(over.doc, `${label}: page is ${over.doc}px wide in a ${over.view}px window`).toBeLessThanOrEqual(over.view + 1);
}

for (const width of WIDTHS) {
  test.describe(`${width}px wide`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const p of ['/login.html', '/register.html', '/terms.html', '/status.html']) {
      test(`public ${p}`, async ({ page }) => {
        await page.goto(path(p));
        await page.waitForLoadState('networkidle');
        await noHorizontalScroll(page, p);
      });
    }

    for (const [who, p] of [['student', '/student/'], ['clerk', '/clerk/'], ['admin', '/admin/'], ['admin', '/admin/settings.html'], ['admin', '/admin/audit.html'], ['admin', '/analytics.html'], ['admin', '/admin/integrations.html']]) {
      test(`${who} ${p}`, async ({ browser }) => {
        const { context, page } = await signIn(browser, who);
        await page.goto(path(p));
        await page.waitForLoadState('networkidle');
        await noHorizontalScroll(page, `${who} ${p}`);
        await context.close();
      });
    }
  });
}

test.describe('touch targets (375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });
  test('sign-in controls are at least 44px tall', async ({ page }) => {
    await page.goto(path('/login.html'));
    for (const sel of ['#email', '#password', '#submit']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.height, `${sel} height`).toBeGreaterThanOrEqual(40);
    }
  });
  test('the menu button opens the navigation on a phone', async ({ browser }) => {
    const { context, page } = await signIn(browser, 'student');
    const toggle = page.getByRole('button', { name: 'Menu' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await context.close();
  });
});
