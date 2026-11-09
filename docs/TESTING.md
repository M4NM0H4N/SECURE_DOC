# Testing Report

All numbers below come from a real run (`npm test`) on 2026-11-09 against the Docker MongoDB replica set. Nothing here is estimated.

## How to run

```bash
docker compose up -d          # MongoDB replica set (tests use the *_test database)
npm test                      # jest --runInBand
npm run lint                  # eslint server scripts
npm audit --omit=dev          # production dependency check
```

`server/tests/helpers.js` refuses to run unless `MONGODB_URI_TEST` points at a database whose name contains `test`, drops that database afterwards, and writes uploads to a temp folder (never `server/uploads/`).

## Results

| Check | Result |
|---|---|
| Test suites | 10 passed, 0 failed |
| Tests | **274 passed, 0 failed** in 12 suites (requirement: at least 30). 238 are the MVP tests, adapted to the tenant paths; 36 are new (tenancy 31, migration 5) |
| ESLint (`server`, `scripts`) | 0 errors, 0 warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |

| Suite | Tests | Focus |
|---|---|---|
| `auth.test.js` | 23 | hashing, registration, login/logout, cookie flags, JWT handling, CSRF header, inactive users |
| `admin.test.js` | 13 | staff creation, listing, activate/deactivate, RBAC on admin routes, rate limit |
| `requests.test.js` | 30 | scope rules, creation, validation, listing, ownership, department scope, hidden storage path |
| `workflow.test.js` | 38 | transition rules, review/approve/reject, mandatory reason, RBAC, department limits, invalid transitions, concurrency |
| `documents.test.js` | 36 | upload validation (signatures, extension, size), fulfilment, cleanup on failure, download access, path tampering |
| `audit.test.js` | 15 | lifecycle trail, user events, no secrets in logs, admin-only access, append-only behaviour |
| `transactions.test.js` | 8 | replica-set rollback and commit, standalone fallback and its known limitation |
| `security.test.js` | 22 | static file exposure, headers, error leakage, rate limiting, frontend XSS/CSP source rules |
| `e2e.test.js` | 17 | the full demonstration flow (blueprint section 24) plus the security verification step |
| `deployment.test.js` | 36 | production config guards (local-URI refusal, whitespace, trust-proxy parsing), health check, per-client rate limiting behind a proxy, upload-folder preparation, local-URI detection |

## Required security scenarios (blueprint section 19)

| # | Scenario | Evidence |
|---|---|---|
| 1 | Student cannot access another student's request | `requests`: "student cannot read another student's request (404)"; `e2e` Step 7 |
| 2 | Student cannot approve | `workflow`: "student cannot review, approve or reject"; `e2e` |
| 3 | Student cannot register as Admin | `auth`: "student cannot register as ADMIN (role ignored)"; `e2e` |
| 4 | Student cannot update their role | There is no self-service profile endpoint. Students get 403 on every admin route (`admin`: "%s gets 403 on admin routes"), and the admin PATCH rejects `role` (`admin`: "role cannot be changed through PATCH") |
| 5 | Clerk cannot approve | `workflow`: "clerk cannot approve or reject"; `e2e` |
| 6 | HOD cannot access another department | `workflow`, `requests`, `documents`, `e2e` |
| 7 | HOD cannot upload a fulfilment document | `documents`: "student, HOD and admin cannot upload"; `e2e` |
| 8 | Admin cannot bypass the approval workflow | `workflow`: "admin cannot bypass the workflow"; `e2e` |
| 9 | Inactive users cannot perform protected operations | `auth` (valid token, then deactivated), `workflow`, `documents`, `requests`, `e2e` |
| 10 | Invalid JWT rejected | `auth`: garbage token, wrong secret, deleted user |
| 11 | Expired JWT rejected | `auth`: "expired JWT -> 401" |
| 12 | Rejection without a reason rejected | `workflow`: 7 bad-reason cases, status unchanged |
| 13 | Invalid status transitions rejected | `workflow`: 12 invalid-transition cases (409); `e2e` |
| 14 | Oversized upload rejected | `documents`: "oversized upload (> 5 MB) -> 413, nothing stored" |
| 15 | Unauthorized downloads blocked | `documents`, `e2e`: other student, other department, admin, anonymous, deactivated |

Extra scenarios beyond the required list: NoSQL operator injection in login and request fields, missing CSRF header on every state-changing route, path traversal through a tampered stored path, encoded traversal against the static server, concurrent approve/reject races, secrets never present in audit records.

## Additional tests (blueprint section 21.4)

| Item | Covered by |
|---|---|
| Invalid email, weak password, duplicate registration, missing fields | `auth` registration table |
| Unsupported document type | `requests` validation table |
| Incorrect file signature | `documents`: text/exe renamed `.pdf`/`.png`, PNG named `.pdf` |
| Missing document | `documents`: no file, wrong field name, JSON body; missing file on disk -> 404 |
| Upload failure | `documents`: "if the DB/audit step fails, request is NOT fulfilled and the file is removed" |
| Database failure during workflow updates | `transactions`: rollback tests for review, submit, staff creation, deactivation |
| Audit event failure | same tests (audit failure aborts the whole transaction) |
| Concurrent status changes | `workflow`: 3 races; `documents`: 2 clerks uploading at once; `transactions`: race with transactions off |

## Transaction behaviour that was actually tested

- The test database is a real replica set; a test asserts `mode === 'replica'`.
- With a replica set, a failed audit write rolls back the status change (tested).
- Without one, status changes remain race-safe but an audit failure after the write is **not** rolled back; the API still returns 500. This is recorded in a test so the limitation cannot be forgotten. Details: `docs/TRANSACTIONS.md`.

## Manual verification (real browser, not automated)

Done in the built-in browser during development, with throwaway demo data that was removed afterwards:

- Phase 1-2: student registration -> login -> request submission -> detail page and history.
- Phase 3: Clerk "Start review" -> HOD Approve and Reject (with reason); database state checked.
- Phase 4: Clerk upload (PDF) -> FULFILLED; Student download (PDF, attachment, nosniff, no-store); Admin audit page.
- Phase 6: a deactivated user's next action redirects to the login page with an explanatory message (no redirect loop); the audit and user tables keep their column widths and scroll inside their card (a latent 7 px page overflow caused by a visually-hidden table label was found and fixed); 12 screenshots captured (docs/screenshots).
- Phase 5: layout at 375 px (phone), 768 px (tablet) and desktop on Student, Clerk, Admin and Audit pages. Measured: no horizontal page overflow, no interactive element smaller than 44 px, skip link is the first focusable element, wide tables scroll inside their own container. Expired-session redirect to the login page confirmed.

## Deployment preparation (checked 2026-11-09)

- Local Docker MongoDB is published on `127.0.0.1:27017` only: the only listening socket is loopback, and connections to all five other local IPv4 addresses (including the Wi-Fi address) were refused. This proves the host side only, not that another machine on the network cannot reach it.
- The CI database (`docker-compose.ci.yml`) behaves the same on `127.0.0.1:27018`; `npm run test:ci` passed against it (238 tests, JUnit report written).
- `NODE_ENV=production` with the local database URI refuses to start, as designed.
- The Atlas connection and a read-only transaction work from the development computer once whitespace is removed from the connection string (see [DEPLOYMENT.md](DEPLOYMENT.md)). The string stored in `.env` still fails with `bad auth` until that is fixed.
- A real Render deployment has not been performed.

## Multi-tenancy (S1, checked 2026-11-09)

- `tenancy.test.js` (31) and `migration.test.js` (5), described in [TENANCY.md](TENANCY.md). The MVP suites now call `/api/t/default/...` through a helper that adds the tenant segment, so the real routing runs in every test.
- Mutation check: removing the query-scoping line from the plugin made 11 tenancy tests fail (restored afterwards).
- A browser smoke test on a throwaway database: signup at `/signup.html` redirected to `/t/smoke-college/login.html`, the Admin dashboard loaded under the tenant path with only that tenant's user, relative links resolved inside the tenant, and logout returned to the tenant sign-in. The scratch database was dropped.
- The bad-slug, suspended and unknown institution responses are identical (404).
- The test-only default-tenant fallback exists only when `NODE_ENV=test`; the tenancy and migration suites switch it off.

## Not covered (be honest in the report)

- No automated browser/UI tests. Frontend behaviour was checked by hand (above); only source-level rules (no `innerHTML`, no inline scripts/handlers/styles) are enforced by tests.
- No load or performance testing.
- Contrast ratios were designed for, not measured with a tool.
- The Jenkins pipeline has not run on a Jenkins server. Its stages were run by hand against a throwaway CI database (see CI.md): 10 unit tests, 202 total, build check passed.
- The rejected-request view on the Student dashboard was verified through the API, not visually.
- HSTS/`Secure` cookies only apply in production mode and were not exercised over HTTPS.
