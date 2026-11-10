'use strict';

const { test, expect } = require('@playwright/test');
const { path, signIn } = require('./helpers');

// The whole journey, as real people in a real browser: student asks, clerk reviews, HOD approves,
// clerk issues the document, student sees it. Each step has its own browser context.
const PURPOSE = `Needed for an internship application ${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('article.req-card', { hasText: PURPOSE });

test('student submits a request and sees it as pending', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'student');
  await expect(page.locator('#welcome')).toContainText('Welcome, Asha Rao');
  await page.selectOption('#documentType', { label: 'Transcript' });
  await page.fill('#purpose', PURPOSE);
  await page.click('#submit');
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('Pending');
  await context.close();
});

test('a short purpose is refused with a clear message and nothing is created', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'student');
  await page.selectOption('#documentType', { label: 'Transcript' });
  await page.fill('#purpose', 'short');
  await page.click('#submit');
  await expect(page.locator('#form-alert, .field-error').filter({ hasText: /10|least|short/i }).first()).toBeVisible();
  await expect(page.locator('article.req-card', { hasText: 'short' })).toHaveCount(0);
  await context.close();
});

test('a clerk of another department cannot see the request', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'clerkMe');
  await expect(page.locator('#welcome')).toContainText('ME');
  // The ME clerk has requests of its own, so an empty result below is a real filter and not a slow page.
  await expect(page.locator('article.req-card').first()).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await context.close();
});

test('the clerk completes the first step', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'clerk');
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: /Complete: Clerk review/ }).click();
  // It has left the clerk's queue; the next test proves it arrived at the HOD.
  await expect(card(page)).toHaveCount(0);
  await context.close();
});

test('the HOD approves', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'hod');
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: /Complete: HOD decision/ }).click();
  await expect(card(page)).toHaveCount(0);
  await context.close();
});

test('the clerk uploads the official document and the request is fulfilled', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'clerk');
  await page.selectOption('#status-filter', ''); // the clerk's default view shows only requests waiting on the clerk's review
  await expect(card(page)).toBeVisible();
  await card(page).locator('input[type=file]').setInputFiles({ name: 'transcript.pdf', mimeType: 'application/pdf', buffer: PDF });
  await card(page).getByRole('button', { name: 'Upload and fulfil' }).click();
  await expect(card(page)).toContainText('Fulfilled');
  await context.close();
});

test('the student sees the issued document and its public verification works', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'student');
  await expect(card(page)).toContainText('Fulfilled');
  await card(page).getByRole('link', { name: 'Details' }).click();
  await expect(page.locator('#document-list')).toContainText(/\.pdf|Download/i);
  await expect(page.getByRole('link', { name: 'Download' }).first()).toBeVisible();
  // The verification link is public (no sign-in) and says the document is genuine.
  const link = await page.locator('#document-list input').first().inputValue();
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  await pub.goto(link);
  await expect(pub.locator('body')).toContainText(/genuine|valid|verified|issued/i);
  await anon.close();
  await context.close();
});

test('another student cannot open that request by its address', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'student');
  const href = await card(page).getByRole('link', { name: 'Details' }).getAttribute('href');
  await context.close();
  const other = await signIn(browser, 'student2');
  await other.page.goto(href);
  await other.page.waitForLoadState('networkidle');
  await expect(other.page.locator('body')).not.toContainText(PURPOSE);
  await other.context.close();
});

test('wrong password shows an error and stays on the sign-in page', async ({ page }) => {
  await page.goto(path('/login.html'));
  await page.fill('#email', 'asha.demo@example.com');
  await page.fill('#password', 'NotTheRightOne1');
  await page.click('#submit');
  await expect(page.locator('#form-alert')).toBeVisible();
  await expect(page).toHaveURL(/login\.html/);
});

test('signing out ends the session', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'student');
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.waitForURL(/login\.html/);
  await page.goto(path('/student/'));
  await page.waitForURL(/login\.html/);
  await context.close();
});

test('the admin sees users, filters them, and reaches analytics', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'admin');
  await expect(page.locator('#user-rows tr').first()).toBeVisible();
  await page.getByLabel('Search users').fill('asha');
  await expect(page.locator('#user-rows tr')).toHaveCount(1);
  await page.goto(path('/analytics.html'));
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Requests submitted');
  await context.close();
});
