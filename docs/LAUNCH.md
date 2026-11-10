# S8: production hardening and launch

Status: **implemented and verified locally. Not deployed.** Everything that needs the owner's accounts (Render, Atlas, Cloudflare R2, a ClamAV host, Resend, a domain, GitHub secrets) is listed in section 3 and has not been done. "Demo on production URLs", the S8 acceptance line, therefore cannot be met by this work alone.

## 1. What S8 added
| Area | What | Where | Evidence |
|---|---|---|---|
| Logging | JSON lines, request id, route pattern only, redaction | `server/utils/logger.js`, `middleware/requestLog.js` | `ops.test.js` |
| Health | `/healthz` (liveness), `/readyz` (database + worker heartbeat), public status page | `app.js`, `models/Heartbeat.js`, `client/status.html` | `ops.test.js`, `release.test.js`, e2e |
| Backup / restore | verified logical backup, optional AES-GCM, restore into an empty database only, restore drill incl. audit-chain re-verification | `server/ops/backup.js`, `scripts/backup.js` | `backup.test.js` (12), local drill passed |
| Data lifecycle | Admin data export; platform suspend / resume / delete with files-first deletion | `services/dataLifecycleService.js` | `lifecycle.test.js` (17) |
| Retention | database TTLs documented and tested; no expiry on requests, documents, audit | models, RUNBOOK | `lifecycle.test.js` |
| CI/CD | CI + browser job, deploy workflow (staging after CI, production manual), Render blueprint, read-only smoke test | `.github/workflows/`, `render.yaml`, `scripts/smoke.js` | `release.test.js` (19) |
| Legal pages | terms, privacy, support, status (templates) with footer links | `client/*.html` | `release.test.js` |
| Browser tests | Playwright: full journey, axe WCAG 2.1 AA light/dark, responsive | `e2e/`, `playwright.config.js` | 84 passed locally |
| Load test | dependency-free load script | `scripts/loadTest.js` | result below |
| Security review | route sweeps and hardening tests, written review | `hardening.test.js`, `docs/SECURITY_REVIEW.md` | 32 tests |
| Runbook | operations, rollback, restore, incidents | `docs/RUNBOOK.md` | n/a |

## 2. Measured results (local machine, one Node process, local MongoDB; NOT production numbers)
- Automated tests: **683 passed** in 30 suites (`npm test`); lint clean; `npm run build` passes (55 files, 8 HTTP checks); `npm audit --omit=dev`: 0 vulnerabilities.
- Browser tests: **84 passed** (`npm run test:e2e`, installed Chrome): 11 journey, 38 accessibility scans, 35 responsive checks. One real defect was found and fixed (keyboard access to scrollable tables).
- Load (`scripts/loadTest.js`, 25 concurrent clients, 20 s, mix of public pages, public API and signed-in student requests): 17,281 requests, 863 requests/s, 0 errors, p50 26 ms, p95 69 ms, p99 83 ms, max 169 ms. The app's own per-IP rate limiter was raised for this run (`RATE_LIMIT_GENERAL_MAX`), since one client address would otherwise be (correctly) throttled. A hosted instance on a small plan with a remote database will be slower; rerun against staging.
- Restore drill: passed on the local development database (`npm run backup -- --drill`).
- Jenkins and GitHub Actions: the workflows are written and their commands pass locally; **neither has run on its server for these changes** (the push will trigger GitHub Actions; check its result there).

## 3. What the owner must do (nothing below has been done)
1. Create accounts/services: MongoDB Atlas (production and staging databases, IP access list, no `0.0.0.0/0` unless knowingly temporary), Cloudflare R2 bucket(s) (+ versioning), a ClamAV host reachable as `CLAMD_HOST`, Resend (verified sending domain), Render.
2. Create the services from `render.yaml` (dashboard > New > Blueprint); type each `sync: false` value in the dashboard. Use different databases, buckets and secrets for staging and production.
3. In GitHub: secrets `RENDER_STAGING_DEPLOY_HOOK`, `RENDER_PRODUCTION_DEPLOY_HOOK`; variables `STAGING_URL`, `PRODUCTION_URL`, optional `SMOKE_TENANT`; an environment named `production` with a required reviewer.
4. Fill the `[bracketed]` items in `terms.html`, `privacy.html`, `support.html` and have a qualified person review them.
5. Run `node scripts/seedSuperAdmin.js` for the platform operator (see DEPLOYMENT) only with your explicit decision; never run `seed:demo` in production.
6. Schedule backups and a monthly restore drill; add an uptime monitor on `/readyz`.
7. First deploy to **staging**, run the checklist in `docs/DEPLOYMENT.md`, real upload/verify/e-mail tests, then decide on production.
8. Commission an independent security test before real student data is loaded.

## 4. Not done / limits
S6 (plans and billing) was skipped by the owner. No hosted deployment, so no production URLs, no real e-mail, R2, ClamAV or Atlas verification. No multi-region or autoscaling design. Background worker and web run as separate processes only if you create the worker service. The load test measures one process locally.
