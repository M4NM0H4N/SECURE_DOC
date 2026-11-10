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
| Tests | **487 passed, 0 failed** in 20 suites (requirement: at least 30). 238 are the MVP tests, adapted (tenant paths, configurable workflow, invitations, document store, mail config); 249 are new (tenancy 31, migration 5, configurable institution 26, accounts 40, 1 for the retired staff route, storage 32, trust 36, storage jobs 14, mail 28, notifications 20, SLA 16) |
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

## Configurable institution and workflow (S2, checked 2026-11-09)

- `configurable.test.js` (26): the engine as pure functions (3), departments (4), document types (1), workflow configuration incl. pinned versions and cross-institution isolation (5), a custom Clerk > HOD > Principal chain end to end with audit and history (1) plus rejection, department scope, concurrency, one-step chain and 409/403 semantics (5), NEEDS_INFO and resubmission (4), the Principal role and a cross-tenant Principal test (3). Every new route has a cross-tenant check (A's session at B's address is 401; A's admin, Principal or student against B's ids is 404).
- Adaptations of existing tests (none deleted): the "exactly four transitions" test now derives them from the default definition; audit assertions use `toMatchObject` because details gained `step` fields; two tests that created requests directly now use the helper that pins a workflow.
- Mutation check: disabling the department scope in the engine made 3 tests fail (restored).
- Browser smoke test on a throwaway database: the settings page loaded the default chain, a Principal step was added and saved through the UI (version 2), a request moved through Clerk and HOD by API, and the Principal dashboard showed it with "Complete: Principal sign-off", Reject and Ask for information; completing it from the UI moved the request on. The scratch database was dropped.
- `npm run test:unit`: 52 passed.

## Account lifecycle and session security (S3, checked 2026-11-10)

- `accounts.test.js` (40): TOTP against the RFC 6238 test vectors and window/replay rules, encryption round trip and tamper detection, configuration guards; invitations (hash-only storage, single use, expiry, revocation, resend, replacement, department rules, rollback on failure, cross-tenant); password change; forgot/reset (identical responses, hash-only, single use, expiry, supersede, deactivated users, rate limit, cross-tenant, admin-issued link); e-mail verification and the gate; lockout (generic responses, unlock, expiry, scattered mistakes, per account and per institution); session revocation (logout replay, other devices, deactivate then reactivate, admin sign-out, stale/missing token version, cross-tenant); MFA (encrypted secret, backup codes hashed, challenge is not a session, replay refused, backup codes single use, wrong codes lock, forged/expired/other-tenant/outdated challenges, disabling, missing key fails closed, cross-tenant).
- Adaptations of existing tests (none deleted): staff creation now goes through the invite and accept flow (`addStaff` helper), the audit tests assert invitation events and that the invitation token never appears in the audit trail, the "reactivated user is back" test now expects the old session to stay dead, and the production-config tests set `PUBLIC_URL`.
- Mutation checks: ignoring the token version made 6 tests fail; disabling the lockout check made 3 fail (both restored).
- Browser smoke test on a throwaway database: invitation link opened (the token was removed from the address bar), the Clerk accepted it and signed in, enabled two-step sign-in on the Account page (secret, ten backup codes), signed out, and signed in again through the password step and the code step. The Admin page showed the invitation as accepted and the new tools (sign out everywhere, reset link). The scratch database was dropped.
- `npm run test:unit`: 57 passed.

## Document storage and trust (S4, checked 2026-11-10)

- `storage.test.js` (32): AWS SigV4 against the three published AWS examples; the same behavioural contract run on the local and the S3 adapter (round trip, missing object, 12 malformed keys on four operations, listing across pages, start-up check, raw delete); the S3 adapter against a fake S3 that verifies signature, clock, credential and payload hash (wrong secret or key refused, provider errors become generic messages, unreachable store); the clamd client against a fake daemon (clean, infected EICAR, a 200 KB multi-chunk file received byte for byte, down/hang/error/garbage under `required` and `optional`); configuration guards.
- `trust.test.js` (36): every document flow on BOTH adapters (tenant-prefixed key and hash recorded, byte-exact download, extra documents, replacement history, revocation with a reason hidden from the student and the audit trail, concurrent replacement with exactly one winner and the loser file removed, database failure rollbacks, the ten-document cap, missing file, tampered keys, a store outage as 502); malware scanning on every upload path (nothing stored or recorded, attempt audited, scanner never consulted for refused uploads); public verification (only six fields returned, superseded and revoked states, forged/tampered/other-document codes, hash check without revealing the hash, 503 without a key, rate limit); tenant isolation of every document route, keys and verification codes.
- `storageJobs.test.js` (14): the cleanup job on both adapters (dry run, grace period, retention, purged marker, active files never deleted, missing files reported, legacy references), the migration of pre-S4 files, and codes whose signature contains `-` or `_`.
- **A bug the tests caught:** verification codes were split on every dash, but a signature can itself contain one (about 40% of codes). A unit test now forces such codes.
- Adaptations of existing tests (none deleted): the document tests look at tenant-prefixed keys and `Document` records instead of one flat `documentPath`; the tampered-path test now tampers the Document key.
- Mutation checks: skipping the scan made 6 tests fail; removing the key-prefix check 2; making replacement unconditional 2; skipping the signature comparison 1 (all restored).
- QR encoder (`qrcode-generator` 1.4.4, vendored): codes for verification-style URLs decoded back exactly with an independent decoder (jsQR) at two error-correction levels. In the browser: the request page showed the document, its QR and link; the public verify page reported the document valid, accepted the genuine file and rejected an altered one.
- `npm run test:unit`: 66 passed.
- **Not verified:** a real R2 or S3 bucket, a real ClamAV daemon (see [TRUST.md](TRUST.md)).

## Notifications, queue and SLAs (S5, checked 2026-11-10)

- `mail.test.js` (28): every template renders with its link and no "undefined", HTML escaping against injected markup, the Resend provider against a fake HTTPS API (method, path, bearer key, JSON body, idempotency key; 400/401/422/429/500/503 and an unreachable host give only a status, never provider text), the in-memory outbox, and the mail/worker configuration guards.
- `notifications.test.js` (20): a full lifecycle (submitted, step, approved, fulfilled) notifies exactly the right people (not the other department, an inactive clerk, the Principal, the Admin) with every (person, type, channel) exactly once and every e-mail sent once; rejection reason, questions and answers; two simultaneous approvals notify once; rollback leaves nothing queued; idempotent writes; opt-out and mail switched off; retry with the exact backoff (30 s, 2 min, 10 min, 1 h, 6 h), six attempts then FAILED, recovery sends once with the notification id as idempotency key, crash recovery after the lock time, two concurrent workers send each message once, address changes and deactivation respected, no addresses or links in stored errors; the in-app API; the Admin log (no content, filters, retry rules, audit); security mail recorded without its link and the token absent from the database; and a two-institution run (own recipients, own name and links, nothing readable or retryable across, sessions refused).
- `sla.test.js` (16): timer arithmetic, validation, the clock starting/restarting/stopping with the workflow (including NEEDS_INFO pause and resume), reminder at 75% and escalation at the deadline each exactly once (three concurrent scanners), escalation targets and department scope, only the escalation when both are overdue, finished requests ignored, a request keeping the SLA of its chain version, the worker pass, and a scan across two institutions.
- Mutation checks: not claiming the escalation timer made 2 tests fail; removing the worker's lock check 2; removing notification dedupe 1 (all restored).
- Browser smoke test (throwaway database, dropped afterwards): the bell showed 1 unread for the Clerk, the page listed it, "Mark all as read" and the e-mail preference worked, the standalone worker delivered the mail (`{"sent":1,...}`), the SLA fields saved through the chain editor (version 2), and the delivery log listed the messages.
- `npm run test:unit`: 86 passed.
- Adaptations of existing tests (none deleted): the configuration-guard tests clear `MAIL_PROVIDER`, because the in-memory outbox is refused in production.
- **Not verified:** a real mail provider (Resend) or real delivery.

## Not covered (be honest in the report)

- No automated browser/UI tests. Frontend behaviour was checked by hand (above); only source-level rules (no `innerHTML`, no inline scripts/handlers/styles) are enforced by tests.
- No load or performance testing.
- Contrast ratios were designed for, not measured with a tool.
- The Jenkins pipeline has not run on a Jenkins server. Its stages were run by hand against a throwaway CI database (see CI.md): 10 unit tests, 202 total, build check passed.
- The rejected-request view on the Student dashboard was verified through the API, not visually.
- HSTS/`Secure` cookies only apply in production mode and were not exercised over HTTPS.
