'use strict';

// Small load test with no extra dependencies. Run it against YOUR OWN staging or local instance, never
// against a service you do not operate.
//   node scripts/loadTest.js http://127.0.0.1:3000 --tenant demo [--seconds 15] [--concurrency 20]
//        [--max-p95-ms 500] [--max-error-rate 0.01]
// To include signed-in traffic, set LOAD_EMAIL and LOAD_PASSWORD (a test account) in the environment.
// Note: the app's own rate limiter answers 429 when the load is higher than a real user could produce;
// 429s are counted separately (they prove the limiter works) and are not errors.
// Output: counts and timings only.
const { performance } = require('perf_hooks');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function login(base, tenant, email, password) {
  const res = await fetch(`${base}/api/t/${tenant}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`load-test login failed (${res.status})`);
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie returned');
  return cookie;
}

async function run(base, { tenant = 'demo', seconds = 15, concurrency = 20, email, password } = {}) {
  const paths = [
    { p: '/healthz' },
    { p: '/readyz' },
    { p: `/t/${tenant}/login.html` },
    { p: `/api/t/${tenant}/meta/departments` },
    { p: `/api/t/${tenant}/branding` },
  ];
  if (email && password) {
    const cookie = await login(base, tenant, email, password);
    paths.push({ p: `/api/t/${tenant}/requests?limit=20`, headers: { cookie } });
    paths.push({ p: `/api/t/${tenant}/auth/me`, headers: { cookie } });
  }
  const timings = [];
  const status = {};
  let errors = 0;
  const end = performance.now() + seconds * 1000;
  let i = 0;
  const worker = async () => {
    while (performance.now() < end) {
      const target = paths[i++ % paths.length];
      const t0 = performance.now();
      try {
        const res = await fetch(base + target.p, { headers: target.headers });
        await res.arrayBuffer();
        timings.push(performance.now() - t0);
        status[res.status] = (status[res.status] || 0) + 1;
        if (res.status >= 500) errors += 1;
      } catch (_e) {
        errors += 1;
        status.network = (status.network || 0) + 1;
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  const sorted = timings.sort((a, b) => a - b);
  const total = timings.length + (status.network || 0);
  return {
    seconds: Math.round(elapsed * 10) / 10,
    concurrency,
    requests: total,
    requestsPerSecond: Math.round(total / elapsed),
    status,
    rateLimited: status[429] || 0,
    serverErrors: errors,
    errorRate: total ? errors / total : 0,
    latencyMs: {
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      max: Math.round(sorted[sorted.length - 1] || 0),
    },
    signedIn: Boolean(email && password),
  };
}

module.exports = { run, percentile };

if (require.main === module) {
  const base = process.argv[2];
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('Usage: node scripts/loadTest.js <base-url> --tenant <slug> [--seconds n] [--concurrency n]');
    process.exit(2);
  }
  run(base.replace(/\/$/, ''), {
    tenant: arg('tenant', 'demo'),
    seconds: Number(arg('seconds', 15)),
    concurrency: Number(arg('concurrency', 20)),
    email: process.env.LOAD_EMAIL,
    password: process.env.LOAD_PASSWORD,
  })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      const p95 = Number(arg('max-p95-ms', 0));
      const maxErr = Number(arg('max-error-rate', 0.01));
      const failed = r.errorRate > maxErr || (p95 > 0 && r.latencyMs.p95 > p95);
      console.log(failed ? 'Load test FAILED its thresholds.' : 'Load test within thresholds.');
      process.exit(failed ? 1 : 0);
    })
    .catch((e) => {
      console.error('Load test could not run:', e.message);
      process.exit(1);
    });
}
