'use strict';

const { DEMO_PASSWORD } = require('./env');

const SLUG = 'demo';
const EMAILS = {
  admin: 'admin.demo@example.com',
  clerk: 'clerk.cse.demo@example.com',
  hod: 'hod.cse.demo@example.com',
  student: 'asha.demo@example.com',
  student2: 'ravi.demo@example.com',
  clerkMe: 'clerk.me.demo@example.com',
};
const path = (p) => `/t/${SLUG}${p}`;

// A fresh browser context per person, so cookies never mix between roles.
async function signIn(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(path('/login.html'));
  await page.fill('#email', EMAILS[who]);
  await page.fill('#password', DEMO_PASSWORD);
  await page.click('#submit');
  await page.waitForURL((u) => !u.pathname.endsWith('/login.html'));
  return { context, page };
}

module.exports = { SLUG, EMAILS, path, signIn };
