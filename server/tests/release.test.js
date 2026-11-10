'use strict';

process.env.NODE_ENV = 'test';
const fs = require('fs');
const http = require('http');
const path = require('path');
const yaml = require('js-yaml');
const { startDb, stopDb, clearDb, makeApp } = require('./helpers');
const { smoke } = require('../../scripts/smoke');

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let server;
let base;
beforeAll(async () => {
  await startDb();
  const app = makeApp({ authRateLimitMax: 1000 });
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await stopDb();
});
beforeEach(clearDb);

describe('post-deploy smoke test', () => {
  test('passes against a healthy instance', async () => {
    const r = await smoke(base, { tenant: 'default' });
    expect(r.results.filter((x) => !x.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(7);
  });

  test('fails when the worker is required but has never reported', async () => {
    const r = await smoke(base, { requireWorker: true });
    expect(r.ok).toBe(false);
    expect(r.results.find((x) => !x.ok).name).toMatch(/readiness/);
  });

  test('fails for an institution that does not exist', async () => {
    const r = await smoke(base, { tenant: 'no-such-college' });
    expect(r.ok).toBe(false);
  });

  test('fails when the service is down', async () => {
    const dead = await smoke('http://127.0.0.1:9', {});
    expect(dead.ok).toBe(false);
    expect(dead.results.every((x) => !x.ok)).toBe(true);
  });

  test('is read-only: it only issues GET requests', () => {
    const src = read('scripts/smoke.js');
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  });
});

describe('deployment files', () => {
  const render = yaml.load(read('render.yaml'));
  const vars = (svc) => Object.fromEntries(svc.envVars.map((v) => [v.key, v]));

  test('render.yaml has staging and production web services and a production worker', () => {
    const names = render.services.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['docflow-staging', 'docflow-production', 'docflow-production-worker']));
    for (const s of render.services) expect(s.autoDeploy).toBe(false);
  });

  test('no secret value is committed: every sensitive variable is generated or entered by the owner', () => {
    const SENSITIVE = /URI|SECRET|KEY|PASSWORD|TOKEN|S3_ENDPOINT|S3_BUCKET|MAIL_FROM|PUBLIC_URL/;
    for (const s of render.services) {
      for (const v of s.envVars) {
        if (SENSITIVE.test(v.key)) expect(v.value).toBeUndefined();
      }
    }
    expect(read('render.yaml')).not.toMatch(/mongodb(\+srv)?:\/\/|sk_live|re_[A-Za-z0-9]{10,}/);
  });

  test('production runs in production mode with a separate worker and the worker check on', () => {
    const prod = render.services.find((s) => s.name === 'docflow-production');
    const v = vars(prod);
    expect(v.NODE_ENV.value).toBe('production');
    expect(v.WORKER_INLINE).toBeUndefined();
    expect(Number(v.WORKER_MAX_AGE_SECONDS.value)).toBeGreaterThan(0);
    expect(prod.healthCheckPath).toBe('/readyz');
    expect(render.services.find((s) => s.type === 'worker').startCommand).toBe('npm run worker');
  });

  test('staging and production never share a database or secret definition', () => {
    const [stg, prod] = ['docflow-staging', 'docflow-production'].map((n) => vars(render.services.find((s) => s.name === n)));
    // Both are owner-entered separately; neither carries a literal that could be shared.
    expect(stg.MONGODB_URI.sync).toBe(false);
    expect(prod.MONGODB_URI.sync).toBe(false);
    expect(stg.JWT_SECRET.generateValue).toBe(true); // staging gets its own generated secret
  });

  test('every variable the production start-up guards need is declared for the web service', () => {
    const v = vars(render.services.find((s) => s.name === 'docflow-production'));
    for (const k of ['MONGODB_URI', 'JWT_SECRET', 'PUBLIC_URL', 'STORAGE_DRIVER', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CLAMD_HOST', 'MAIL_PROVIDER', 'RESEND_API_KEY', 'MAIL_FROM', 'WEBHOOK_ENCRYPTION_KEY']) {
      expect(v[k]).toBeDefined();
    }
  });

  test('the deploy workflow runs only after CI, never auto-deploys production, and holds no secrets', () => {
    const wf = yaml.load(read('.github/workflows/deploy.yml'));
    const triggers = wf.on || wf[true];
    expect(triggers.workflow_run.workflows).toEqual(['CI']);
    expect(triggers.workflow_run.branches).toEqual(['saas']);
    expect(triggers.workflow_dispatch.inputs.target.options).toEqual(['staging', 'production']);
    const text = read('.github/workflows/deploy.yml');
    expect(text).toMatch(/workflow_run\.conclusion == 'success'/);
    expect(text).not.toMatch(/https:\/\/api\.render\.com\/deploy\/srv-/);
    expect(wf.permissions).toEqual({ contents: 'read' });
    // production environment only for the manual target
    expect(text).toMatch(/inputs\.target == 'production' && 'production'/);
  });

  test('the CI workflow still runs lint, tests, build and the audit', () => {
    const text = read('.github/workflows/ci.yml');
    for (const step of ['npm run lint', 'npm run test:ci', 'npm run build', 'npm audit --omit=dev']) expect(text).toContain(step);
  });
});

describe('legal and status pages', () => {
  const pages = ['terms', 'privacy', 'support', 'status'];
  test.each(pages)('%s.html is served and has a title, language and viewport', async (p) => {
    const res = await fetch(`${base}/${p}.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<meta name="viewport"/);
    expect(html).toMatch(/<title>[^<]+ \| DocFlow<\/title>/);
    expect(html).toMatch(/<h1>/);
  });

  test('legal templates are clearly marked as templates until the operator fills them in', () => {
    for (const p of ['terms', 'privacy']) {
      const html = read(`client/${p}.html`);
      expect(html).toMatch(/template/i);
      expect(html).toMatch(/\[[^\]]+\]/);
    }
  });

  test('every page that is not a legal page links to them', () => {
    for (const p of ['login', 'register', 'signup', 'forgot-password']) {
      expect(read(`client/${p}.html`)).toMatch(/href="privacy\.html"/);
    }
    expect(read('client/js/layout.js')).toMatch(/renderFooter/);
  });

  test('pages work under the strict CSP: no inline script or inline handlers', () => {
    for (const p of pages) {
      const html = read(`client/${p}.html`);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
    }
  });
});
