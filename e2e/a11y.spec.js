'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { path, signIn } = require('./helpers');

// WCAG 2.1 A and AA rules, in light and dark mode. A violation fails the test and lists the rule,
// the impact and the element, so it can be fixed (not waved through).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page, label) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map((v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

const PUBLIC_PAGES = ['/login.html', '/register.html', '/signup.html', '/forgot-password.html', '/terms.html', '/privacy.html', '/support.html', '/status.html'];

for (const scheme of ['light', 'dark']) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    for (const p of PUBLIC_PAGES) {
      test(`public page ${p}`, async ({ page }) => {
        await page.goto(path(p));
        await page.waitForLoadState('networkidle');
        await scan(page, p);
      });
    }

    const SIGNED_IN = [
      ['student', '/student/'],
      ['student', '/account.html'],
      ['student', '/notifications.html'],
      ['clerk', '/clerk/'],
      ['hod', '/hod/'],
      ['admin', '/admin/'],
      ['admin', '/admin/settings.html'],
      ['admin', '/admin/audit.html'],
      ['admin', '/admin/integrations.html'],
      ['admin', '/admin/notifications.html'],
      ['admin', '/analytics.html'],
    ];
    for (const [who, p] of SIGNED_IN) {
      test(`${who} page ${p}`, async ({ browser }) => {
        const { context, page } = await signIn(browser, who);
        await page.goto(path(p));
        await page.waitForLoadState('networkidle');
        await page.locator('#content:not(.hidden), main').first().waitFor();
        await scan(page, `${who} ${p}`);
        await context.close();
      });
    }
  });
}
