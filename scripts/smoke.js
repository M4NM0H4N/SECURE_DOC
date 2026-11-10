'use strict';

// Post-deploy smoke test: read-only HTTP checks against a running instance. No credentials, no writes.
//   node scripts/smoke.js https://staging.example.com [--tenant my-college] [--require-worker]
// Exit code 0 = all passed. Prints check names and results only.
const REQUIRED_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options'];

async function get(base, path, init = {}) {
  const res = await fetch(new URL(path, base), { redirect: 'manual', ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function smoke(base, { tenant, requireWorker = false } = {}) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  await check('liveness /healthz is 200', async () => {
    const r = await get(base, '/healthz');
    expect(r.status === 200, `status ${r.status}`);
  });
  await check('readiness /readyz is 200 and exposes only booleans', async () => {
    const r = await get(base, '/readyz');
    expect(r.status === 200, `status ${r.status}`);
    const body = JSON.parse(r.text);
    expect(Object.keys(body).sort().join() === 'checks,status', 'unexpected fields');
    expect(Object.values(body.checks).every((v) => typeof v === 'boolean'), 'non-boolean check');
    if (requireWorker) expect(body.checks.worker === true, 'worker heartbeat is missing or stale');
  });
  await check('security headers are present', async () => {
    const r = await get(base, '/login.html');
    expect(r.status === 200, `status ${r.status}`);
    for (const h of REQUIRED_HEADERS) expect(r.headers.get(h), `missing ${h}`);
    expect(!r.headers.get('x-powered-by'), 'x-powered-by is exposed');
  });
  await check('legal and status pages are served', async () => {
    for (const p of ['/terms.html', '/privacy.html', '/support.html', '/status.html']) {
      const r = await get(base, p);
      expect(r.status === 200, `${p} -> ${r.status}`);
    }
  });
  await check('unknown API route answers JSON 404, not an error page', async () => {
    const r = await get(base, '/api/definitely-not-a-route', { headers: { accept: 'application/json' } });
    expect(r.status === 404, `status ${r.status}`);
    expect(JSON.parse(r.text).success === false, 'not the JSON error shape');
  });
  await check('a protected API route refuses anonymous callers', async () => {
    const r = await get(base, `/api/t/${tenant || 'smoke-check'}/requests`, { headers: { accept: 'application/json' } });
    expect([401, 404].includes(r.status), `status ${r.status}`);
    expect(!/stack|at\s.+\(.+:\d+:\d+\)/i.test(r.text), 'response looks like a stack trace');
  });
  if (tenant) {
    await check(`institution "${tenant}" is served`, async () => {
      const r = await get(base, `/api/t/${tenant}/meta/departments`);
      expect(r.status === 200, `status ${r.status}`);
      const r2 = await get(base, `/t/${tenant}/login.html`);
      expect(r2.status === 200, `login page ${r2.status}`);
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { smoke };

if (require.main === module) {
  const base = process.argv[2];
  const flag = (n) => process.argv.indexOf(`--${n}`);
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('Usage: node scripts/smoke.js <https://base-url> [--tenant slug] [--require-worker]');
    process.exit(2);
  }
  smoke(base, { tenant: flag('tenant') > -1 ? process.argv[flag('tenant') + 1] : undefined, requireWorker: flag('require-worker') > -1 })
    .then(({ ok, results }) => {
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` (${r.detail})`}`);
      console.log(ok ? 'Smoke test passed.' : 'Smoke test FAILED.');
      process.exit(ok ? 0 : 1);
    })
    .catch((e) => {
      console.error('Smoke test could not run:', e.message);
      process.exit(1);
    });
}
