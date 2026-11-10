# Security review (S8)

Method: a code review of every area in the checklist plus executable checks. This is a self-review by the development team, **not** an independent penetration test and not a certification. Findings below were each either fixed (with a test) or accepted with a reason.

## Executable checks added in S8
`server/tests/hardening.test.js` (32 tests) enumerates the application's real routes (Express router internals) and proves, for every route that exists now or is added later:
- an anonymous caller is refused (401/403) on every route not on the explicit public list, and the public list has no stale entries;
- a Student is refused (403) on every `/admin` and `/analytics` route; a Clerk on every `/admin` route;
- an Admin session of one institution is refused on every route of another institution; the same cookie sent by hand is refused;
- every state-changing route refuses a request without the CSRF header;
- NoSQL operator objects and prototype-pollution keys do not change behaviour; role/tenant cannot be chosen at registration; login and password-reset do not reveal whether an account exists;
- no server file, `.env`, `package.json`, `.git`, `docs` or `render.yaml` is served (including encoded traversal);
- API answers are `no-store` (only public branding is cacheable); the session cookie is HttpOnly and SameSite=Strict; errors carry a request id and never a stack trace;
- no committed file contains a connection string with a password, a private key or a provider key.
Plus: `ops.test.js` (logging redaction, request ids, readiness), `lifecycle.test.js` (export without credentials, deletion safety), `backup.test.js`, `release.test.js` (deployment files hold no secrets; deploy never automatic for production), and the earlier suites (tenancy, accounts, trust, notifications, integrations).
Browser: `e2e/a11y.spec.js` (WCAG 2.1 A/AA via axe-core: 19 pages, each in light and dark = 38 scans) and `e2e/responsive.spec.js` (no sideways scroll at 320/375/768 px).

## Findings
| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | Scrollable tables were not keyboard-reachable (axe `scrollable-region-focusable` on Admin users and Integrations) | Fixed (`layout.js`: focusable, named region); e2e scan passes |
| 2 | Low | API JSON had no explicit `Cache-Control`, so a shared cache could keep per-person answers | Fixed: `no-store` on all `/api`; branding sets its own public cache |
| 3 | Low | Server logs were free-text `console` lines | Fixed: structured JSON with redaction |
| 4 | Info | `/readyz` and `/healthz` are public | Accepted: booleans only, tested to expose nothing else |
| 5 | Medium | Audit hash chain is tamper-evident, not tamper-proof (an attacker with full database write could rewrite chain and head) | Accepted and documented; mitigation: record the head hash off-system |
| 6 | Medium | Backups contain personal data and password hashes | Mitigated: optional AES-256-GCM encryption; runbook says to keep them only on trusted storage |
| 7 | Medium | Institution deletion is irreversible | Mitigated: suspend first, typed confirmation, files removed before rows (retryable), audit record; runbook says to back up first |
| 8 | Low | Legal pages are templates | Open: the operator must replace the `[bracketed]` items and have them reviewed; the pages say so |
| 9 | Medium | Scanner (ClamAV), R2, Resend, Render, Atlas are exercised only against local fakes or not at all | Open: needs the owner's accounts; first staging deploy is the real test |
| 10 | Low | No automatic alerting or uptime monitor | Open: configure an external monitor on `/readyz` |

No critical or high finding is open from this review. "No known critical findings" is not a claim of no vulnerabilities: nothing here replaces an independent test before handling real student data.

## Existing controls (re-verified by tests)
Tenant isolation through the shared query layer (S1), JWT with `ver` revocation and lockout (S3), signed verification codes (S4), SSRF guard and encrypted secrets for webhooks (S7), uploads: magic-byte type check, size limit, scan, tenant-prefixed unguessable keys (S4), rate limits on login, registration, tokens, uploads, verification and per-API-key, CSP without inline script, HSTS in production.

## Dependencies
`npm audit --omit=dev`: 0 vulnerabilities at the time of the S8 commit. New dev-only dependencies (browser tests): `@playwright/test`, `@axe-core/playwright`; they are not installed in production (`npm ci --omit=dev`).
