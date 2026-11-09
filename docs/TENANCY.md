# Multi-tenancy (SaaS phase S1)

Status: implemented on the `saas` branch. Decisions: [ADR 0001](adr/0001-tenancy.md).

## Model

- One shared MongoDB database. `Tenant` = `{ name, slug, status }`. Users, Requests and AuditLog each carry a `tenantId`.
- Users are unique on `(tenantId, email)`: the same email may exist in two institutions, never twice in one.
- `SUPER_ADMIN` is the only tenantless role (platform operator). It has its own login, cookie and routes and can list institutions (name, slug, status). It has no route to any tenant's users, requests, documents or audit entries.
- Departments, document types and the approval chain are per-institution data (S2, see [WORKFLOW.md](WORKFLOW.md)); each has its own `tenantId` and the same query scoping.

## Addresses

| Path | What |
|---|---|
| `/` | institution chooser, link to signup |
| `/signup.html` | institution signup (needs the owner's signup key) |
| `/t/<slug>/` | the institution's own sign-in and dashboards (same static client for every institution) |
| `/api/t/<slug>/...` | every institution API (auth, requests, admin) |
| `/api/platform/...` | institution signup and the SUPER_ADMIN (no tenant in the path) |

The old un-prefixed `/api/auth`, `/api/requests` and `/api/admin` paths no longer exist (404). Slugs are 3-30 lowercase letters, digits and hyphens, and a few words are reserved (`api`, `admin`, `platform`, ...). A subdomain per tenant can be added later in the same middleware (path slug chosen first so it works on localhost and Render without wildcard DNS).

## How isolation is enforced (defence in depth)

1. **One resolver.** `server/middleware/resolveTenant.js` reads the slug, loads the ACTIVE tenant and runs the rest of the request inside a tenant context (AsyncLocalStorage, `server/utils/tenantContext.js`). Unknown, malformed and suspended slugs all return the same 404.
2. **JWT cross-check.** Tokens carry `tid`. `authenticate` rejects a token whose `tid` is not the tenant in the URL, and rejects tokens without one. A session from institution A therefore never works at institution B. The session cookie is also scoped to `Path=/api/t/<slug>`, so the browser does not even send it to another institution.
3. **Query layer.** `server/models/plugins/tenantScope.js` is applied to User, Request and AuditLog. It adds `tenantId` to every find/count/distinct/update/delete/replace and aggregate, overrides any tenantId a caller puts in a filter, stamps new records, refuses to move a record between tenants, and refuses `insertMany`/`bulkWrite` in tenant mode. **A query with no tenant context throws** instead of returning data.
4. **Existing rules unchanged.** Role, ownership and department scope still apply inside the tenant; out-of-scope requests still return 404.
5. **Audit.** Tenant admins see only their own tenant's audit entries. Platform events (`PLATFORM_LOGIN`) have `tenantId = null` and are invisible to tenants.

Known limits, stated plainly:
- Raw driver access (`Model.collection.*`) and `runUnscoped()` bypass the plugin. `runUnscoped` is reserved for platform code (signup, SUPER_ADMIN, migration, scripts) and is easy to grep for. Reviewers should check every new use.
- `tenantId` is not yet part of stored document file names. File storage is still one local folder with random names; tenant-prefixed keys arrive with the storage interface in S4. Downloads are authorised through a tenant-scoped request lookup, so another tenant cannot reach a file even if it guessed a name.
- A Principal (S2) is an institution-wide role inside one tenant; it is not a platform role.
- A SUPER_ADMIN is created only by `npm run seed:superadmin` run by the owner.

## Institution signup (closed by default)

`POST /api/platform/signup` creates the institution and its first Admin in one transaction and writes a `TENANT_CREATED` audit entry. It works only when the server has `SIGNUP_KEY` (16+ characters) and the request carries the same key (constant-time comparison). With no key configured it answers 403. E-mail verification and CAPTCHA do not exist yet (S3/S5), so the key is the abuse protection until then. It is rate limited, needs the CSRF header, and never returns or logs the password.

## Migration of MVP data

`npm run migrate:tenants` (dry run, counts only) then `npm run migrate:tenants -- --apply [--slug=... --name=...]`. It creates one institution (default slug `default`), back-fills `tenantId` on legacy users, requests and audit entries (SUPER_ADMIN stays tenantless), and swaps the old global `email_1` unique index for `(tenantId, email)`. It is idempotent (second run changes nothing). Run it on a copy of the data first. Existing MVP sessions stop working (old tokens have no tenant claim); users sign in again at `/t/<slug>/`.

Evidence: a dry run against the local development database reported 2 users and 1 request to migrate (nothing was written). `server/tests/migration.test.js` covers dry run, apply, idempotency, SUPER_ADMIN, sign-in after migration and the index swap.

## Tests that prove it

`server/tests/tenancy.test.js` (31 tests) runs with the test-only default-tenant fallback switched off, so every model call names its tenant. It covers the plugin, tenant resolution, session separation, a two-institution matrix (users, requests, documents, audit, admin changes, list contents, body tampering, same departments in both), signup and SUPER_ADMIN. As a mutation check, removing the query-scoping line made 11 of these tests fail; it was restored afterwards.
