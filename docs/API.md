# API Reference

Base path: `/api`. JSON in, JSON out (uploads use `multipart/form-data`).

**Institutions (SaaS S1).** Every institution endpoint in this document is served under the institution's address: `/api/auth/login` below means `POST /api/t/<slug>/auth/login`, `/api/requests` means `/api/t/<slug>/requests`, and so on. An unknown, malformed or suspended `<slug>` answers `404 Institution not found`. The un-prefixed paths do not exist. A session works only for the institution it was issued by (the token carries the tenant and the cookie is scoped to `/api/t/<slug>`); anything else is `401`. Platform-level endpoints are described in "Platform" below. See [TENANCY.md](TENANCY.md).

## Conventions

**Authentication.** Login sets an HttpOnly, `SameSite=Strict` cookie (`sdw_token`, `Secure` in production). There is no token in the response body and nothing for scripts to store. Every protected call reloads the user from the database, so deactivation takes effect immediately.

**CSRF.** Every non-GET request must send `X-Requested-With: XMLHttpRequest`, otherwise the API answers `403 Missing CSRF header`.

**Response envelope.**

```json
{ "success": true,  "data": { }, "message": "optional" }
{ "success": false, "message": "what went wrong", "errors": [ { "field": "email", "message": "Enter a valid email address" } ] }
```

**Status codes.**

| Code | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | Validation failed, malformed JSON, or bad upload |
| 401 | Not signed in, or invalid/expired session |
| 403 | Signed in but not allowed (role, deactivated account, missing CSRF header) |
| 404 | Not found **or outside your scope** (existence is never revealed) |
| 409 | Invalid status transition or duplicate value (for example, email already registered) |
| 413 | Body or file too large (JSON 10 KB, file 5 MB) |
| 429 | Rate limit hit |
| 500 | Unexpected server error (generic message, details only in server logs) |

**Rate limits (per IP, 15-minute window).** Login 20 failed attempts (successful logins are not counted), registration 20, uploads 30, whole API 1000.

**Enumerations.** Roles: `STUDENT CLERK HOD PRINCIPAL ADMIN` (plus the tenantless `SUPER_ADMIN`, platform routes only). Statuses: `PENDING UNDER_REVIEW NEEDS_INFO APPROVED REJECTED FULFILLED`. Departments and document types are **per institution** (S2): read them from `GET /meta/departments` and `GET /meta/options`. New institutions start with `CSE ME CIVIL ECE EEE` and `Bonafide Certificate`, `Fee Receipt`, `Transcript`, `Transfer Certificate`, `Character Certificate`, `Other`. The approval chain is per institution too; see [WORKFLOW.md](WORKFLOW.md).

## Access summary

| Endpoint | Student | Clerk | HOD | Admin |
|---|---|---|---|---|
| `POST /auth/register`, `POST /auth/login` | public | public | public | public |
| `POST /auth/logout`, `GET /auth/me` | yes | yes | yes | yes |
| `POST /requests` | yes | - | - | - |
| `GET /requests`, `GET /requests/:id` | own | own department | own department | all |
| `PATCH /requests/:id/advance` (also `/review`, `/approve`) | - | the step's role | the step's role | - |
| `PATCH /requests/:id/reject`, `/needs-info` | - | the step's role | the step's role | - |
| `PATCH /requests/:id/resubmit` | own | - | - | - |
| `GET /meta/departments` | public | public | public | public |
| `GET /meta/options` | yes | yes | yes | yes |
| `POST /requests/:id/document` | - | own department | - | - |
| `GET /requests/:id/document` | own | own department | own department | - (403) |
| `GET/POST/PATCH /admin/users` | - | - | - | yes |
| `GET /admin/audit-logs` | - | - | - | yes |
| `/admin/departments`, `/admin/document-types`, `/admin/workflow` | - | - | - | yes |

Which staff role may act on a request is decided by the request's workflow step, not by the route: a Principal (institution-wide, no department) acts on Principal steps; Clerk and HOD steps are limited to the request's department. Principal columns are omitted above for width: a Principal reads all requests of the institution, acts on its own steps, and has no document access.

---

## Platform (no tenant in the path)

### POST /api/platform/signup
Creates an institution and its first Admin in one transaction and audits `TENANT_CREATED`. Closed (`403`) unless the server has `SIGNUP_KEY`; a wrong key is `403`. Needs the CSRF header; rate limited like registration.

| Field | Rule |
|---|---|
| `institutionName` | 2-120 characters |
| `slug` | 3-30 characters: lowercase letters, digits, hyphens; not a reserved word. Becomes `/t/<slug>/` |
| `adminName`, `adminEmail`, `adminPassword` | same rules as registration |
| `signupKey` | the owner-issued key |

Success `201 { tenant: { name, slug } }`. Taken slug: `409`.

### POST /api/platform/auth/login, POST /api/platform/auth/logout
SUPER_ADMIN only. Separate cookie (`sdw_token_platform`, `Path=/api/platform`) and token claim, so a tenant session does not work here and a platform session does not work on tenant routes. Sign-in is audited as `PLATFORM_LOGIN` (no tenant, invisible to tenant admins).

### GET /api/platform/tenants
SUPER_ADMIN only. Lists institutions (`name`, `slug`, `status`). No tenant data is reachable from the platform area.

---

## Health check

### GET /healthz
Public, outside `/api`, not rate limited and not cached. Returns `200 {"status":"ok"}` while the database connection is up and `503 {"status":"unavailable"}` otherwise. It exposes no data. Used as the Render health check path.

---

## Auth

### POST /api/auth/register
Public. Always creates a `STUDENT`; any `role` in the body is ignored.

| Field | Rule |
|---|---|
| `name` | string, 2-100 characters |
| `email` | valid email, max 254, stored lowercase |
| `password` | string, 8-72 characters, at least one letter and one number |
| `department` | one of the departments |

`201` `{ "data": { "user": { "_id", "name", "email", "role": "STUDENT", "department", "isActive", "createdAt", "updatedAt" } } }`
Errors: `400` validation, `409` email already registered, `429`.

### POST /api/auth/login
Body `{ "email", "password" }`. `200` with the user and the auth cookie. Wrong email and wrong password return the same `401` message. `403` if the account is deactivated.

### POST /api/auth/login/mfa
Second step for accounts with two-step sign-in: `{ challenge, code }`. The login response for such accounts is `{ mfaRequired: true, challenge }` with **no cookie**; the challenge lasts 5 minutes and is not a session. `code` is an authenticator code or a backup code. `401` for anything wrong (and wrong codes count towards the lockout).

### POST /api/auth/logout
Clears the cookie. `200`.

### Account lifecycle (S3, details in [ACCOUNTS.md](ACCOUNTS.md))

| Route | Notes |
|---|---|
| `POST /auth/change-password` | session; `{ currentPassword, newPassword }`; ends other devices |
| `POST /auth/forgot-password` | `{ email }`; same response for every address; rate limited |
| `POST /auth/reset-password` | `{ token, password }`; single use, 1 hour; ends all sessions; `400` for any bad link |
| `POST /auth/verify-email`, `POST /auth/resend-verification` | `{ token }` / session |
| `GET /auth/invite?token=` | what the invitation page shows (email, role, department, institution) |
| `POST /auth/accept-invite` | `{ token, name, password }`; creates the account; `201` |
| `POST /auth/mfa/setup`, `/enable`, `/disable` | session; staff only; `503` if the server has no MFA key; enable returns ten backup codes once |

Login, `/auth/me`: failures that look the same on purpose (wrong password, unknown account, locked account) all return `401 Invalid email or password`. `/auth/me` also returns `mfaAvailable` and `verificationRequired`.

### GET /api/auth/me
`200` `{ "data": { "user": { ... } } }`.

---

## Requests

### POST /api/requests (Student)
Body: `documentType` (enumeration) and `purpose` (10-500 characters after trimming). Everything else (department, status, student) is set by the server. `201` with the new request in status `PENDING`.

### GET /api/requests
Scoped to the caller (see the access summary). Query: `status` (optional enumeration), `page` (default 1), `limit` (1-100, default 20). Newest first.
`200` `{ "data": { "items": [ request ], "total", "page", "limit" } }`. Each item includes the student's `name`, `email`, `department` under `studentId`.

### GET /api/requests/:id
One request with `statusHistory` (who moved it, when, optional note). `404` if it does not exist or is outside your scope.

A request looks like:

```json
{
  "_id": "…", "studentId": { "_id": "…", "name": "Asha Rao", "email": "…", "department": "CSE" },
  "department": "CSE", "documentType": "Bonafide Certificate", "purpose": "…",
  "status": "FULFILLED", "reviewedBy": "…", "decidedBy": "…", "rejectionReason": null,
  "statusHistory": [ { "from": null, "to": "PENDING", "by": { "name": "…", "role": "STUDENT" }, "at": "…", "note": "Request submitted" } ],
  "createdAt": "…", "updatedAt": "…"
}
```

The stored file name (`documentPath`) is never included.

### PATCH /api/requests/:id/advance (staff)
Completes the approval step the request is waiting on (the generic action). The target status follows from the step: `UNDER_REVIEW`, or `APPROVED` after the last step. `403` if your role cannot complete any step that leads to that status, `404` if the request is outside your institution or (for department-scoped steps) your department, `409` if your role owns such a step but the request is not at it. `/review` and `/approve` below are the same action under their MVP names.

### PATCH /api/requests/:id/needs-info (staff)
Body `{ "note": "5-500 characters" }`. Asks the student for information; status `NEEDS_INFO`, step unchanged. Only the staff role that owns the current step may do this.

### PATCH /api/requests/:id/resubmit (Student)
Body `{ "purpose": "optional, 10-500 characters" }`. Only the owning student, only while `NEEDS_INFO`. Returns the request to the step that asked (`PENDING` for step 1, otherwise `UNDER_REVIEW`).

**Request fields added in S2:** `workflowDefinitionId`, `currentStepIndex`, and on every response `currentStep` (label of the step it waits on, or null) and `actions` (what the signed-in user may do now: `advance`, `reject`, `needs_info`, `fulfil`, `resubmit`). `actions` is a UI convenience; the server re-checks every action.

### PATCH /api/requests/:id/review (Clerk)
`PENDING` -> `UNDER_REVIEW`. No body.

### PATCH /api/requests/:id/approve (HOD)
`UNDER_REVIEW` -> `APPROVED`. No body.

### PATCH /api/requests/:id/reject (HOD)
`UNDER_REVIEW` -> `REJECTED`. Body `{ "reason": "…" }`, required, 5-500 characters after trimming.

For all three: `404` if the request is in another department or does not exist, `409` if the request is not in the required current status. Each is a single atomic conditional update, so concurrent callers get exactly one success.

### Documents (S4)
A request can hold several documents; see [TRUST.md](TRUST.md) for storage, scanning, retention and verification.

| Route | Who | Notes |
|---|---|---|
| `POST /requests/:id/documents` | Clerk, own department | add another document to a `FULFILLED` request; `201` |
| `GET /requests/:id/documents` | Student (active only), Clerk, HOD | `{ items: [{ _id, version, fileType, sizeBytes, status, createdAt, supersedes, verifyUrl? }] }`; staff also get `revokedAt`, `revokedReason`; never a key or hash; Admin/Principal `403` |
| `GET /requests/:id/documents/:docId/file` | as above | one active document, streamed |
| `POST /requests/:id/documents/:docId/replace` | Clerk | new version; old becomes `REPLACED`; `409` if it is not active or someone else changed it |
| `DELETE /requests/:id/documents/:docId` | Clerk | body `{ reason }` (5-500); `REVOKED` |
| `GET /verify/:code`, `POST /verify/:code/check` | **public** (under `/api/t/<slug>`) | verification; see below |

An infected file is rejected with `422`; if scanning is required and the scanner is unavailable, `503`; if the document store is unavailable, `502`. Request list items now include `documentCount` (active documents).

### GET /api/t/<slug>/verify/:code (public)
Returns `{ institution, status: VALID|SUPERSEDED|REVOKED, valid, documentType, issuedAt, version }` and nothing about the holder. Any bad, forged or other-institution code is `404 No document matches this code`; `503` if the installation has no verification key; rate limited (60 per 15 minutes).

### POST /api/t/<slug>/verify/:code/check (public)
Body `{ sha256 }` (64 hex). Returns `{ institution, matches, status, valid }`. The browser hashes the file locally; the stored hash is never revealed.

### POST /api/requests/:id/document (Clerk)
`multipart/form-data` with exactly one file in the field `document`.

- Types: PDF, JPG/JPEG, PNG. The real file signature is checked, and the extension must match the content.
- Maximum 5 MB (`413` above that).
- Allowed only while the request is `APPROVED` (`409` otherwise).
- Success: scanned, then stored under a tenant-prefixed random key in the configured store; request becomes `FULFILLED`; `200` with `{ request, document }`.
- Any failure after the file is written deletes the file and leaves the request `APPROVED`.
- Only for `APPROVED` requests: further documents use `POST /requests/:id/documents`.

### GET /api/requests/:id/document (Student, Clerk, HOD)
Streams the newest active document as an attachment (other documents: `/documents/:docId/file`) (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`). `409` until the request is `FULFILLED` or when it has no active document, `404` if out of scope or the file is missing, `403` for Admin and Principal.

---

## Admin (all require the Admin role)

### GET /api/admin/users
Query: `role`, `page`, `limit` (max 100). `200` `{ items, total, page, limit }`.

### Invitations and account tools (Admin, S3)

| Route | Notes |
|---|---|
| `GET /admin/invites` | status `PENDING`, `ACCEPTED`, `REVOKED`, `EXPIRED`; never any token |
| `POST /admin/invites` | `{ email, role: CLERK\|HOD\|PRINCIPAL, department?, name? }`; `201 { invite, link }`, the link shown **once**; `409` if the address already has an account |
| `POST /admin/invites/:id/resend` | new link, old one dies |
| `DELETE /admin/invites/:id` | revoke |
| `POST /admin/users/:id/unlock`, `/sign-out`, `/verify-email`, `/reset-link` | unlock, end all sessions, mark verified, issue a one-time reset link (returned once) |

`POST /admin/users` (create a staff account with a password chosen by the Admin) **no longer exists** (`404`).

### POST /api/admin/users (removed)
Body: `name`, `email`, `password`, `role` (`CLERK` or `HOD` only), `department`. `201` with the user. `ADMIN` and `STUDENT` cannot be created here.

### PATCH /api/admin/users/:id
Body may contain `name`, `isActive`, `department`. Including `role`, `email` or `password` returns `400`. An admin cannot deactivate their own account.

### Notifications (S5, details in [NOTIFICATIONS.md](NOTIFICATIONS.md))

| Route | Notes |
|---|---|
| `GET /notifications` | the signed-in user's own in-app notifications; query `unread`, `page`, `limit` (max 100); `{ items, total, unreadCount, page, limit }`; `Cache-Control: no-store` |
| `POST /notifications/:id/read`, `POST /notifications/read-all` | mark read; someone else's id is `404` |
| `GET /notifications/preferences`, `PATCH /notifications/preferences` | `{ email: boolean }` for ordinary e-mail; `mailAvailable` says whether the server sends mail at all |
| `GET /admin/notifications` | Admin: e-mail delivery log (`status`, `type`, `page`, `limit`): type, status, attempts, last problem, recipient name and role. Never content, address or link |
| `POST /admin/notifications/:id/retry` | Admin: send a `FAILED` message again (`409` if it is not failed or was security mail); audited |

Workflow steps (`PUT /admin/workflow`) accept `slaHours` (integer 1-720) and `escalateTo` (`CLERK`, `HOD` or `PRINCIPAL`, not the step's own role, needs `slaHours`); `400` otherwise.

### Institution configuration (Admin, S2)

| Route | Purpose |
|---|---|
| `GET /api/admin/departments` | all departments (including inactive) |
| `POST /api/admin/departments` | `{ code, name }`; code 2-10 letters or digits, stored upper case, unique per institution (`409`) |
| `PATCH /api/admin/departments/:id` | `{ name?, isActive? }`; the code cannot be changed (`400`) |
| `GET/POST /api/admin/document-types`, `PATCH /api/admin/document-types/:id` | `{ name }` (2-80, unique ignoring case), `{ name?, isActive? }` |
| `GET /api/admin/workflow` | current version, steps, `rolesWithoutActiveStaff`, `requestsOnOlderVersions` |
| `PUT /api/admin/workflow` | `{ steps: [{ label, role: CLERK\|HOD\|PRINCIPAL, canReject? }] }`, 1-6 steps, at least one that can reject. Creates the next version; `400` on any invalid chain |

Creating staff: `role` is `CLERK`, `HOD` or `PRINCIPAL`; `department` (an active code of the institution) is required except for `PRINCIPAL`, where it is ignored. Registration and staff creation reject unknown or inactive departments with `400`.

### GET /api/meta/departments, GET /api/meta/options
`/meta/departments` is public (registration needs it before sign-in): `{ items: [{ _id, code, name }] }`, active only. `/meta/options` needs a session: `{ departments, documentTypes: [name], steps: [{ label, role }] }`.

### GET /api/admin/audit-logs
Query: `action` (one of the audit actions), `requestId`, `actorId`, `page`, `limit` (max 100). Newest first. Read-only: there is no create, update or delete route.

Audit actions: `USER_REGISTERED`, `USER_LOGIN`, `USER_CREATED_BY_ADMIN`, `USER_ACTIVATED`, `USER_DEACTIVATED`, `REQUEST_SUBMITTED`, `REQUEST_REVIEWED`, `REQUEST_APPROVED`, `REQUEST_REJECTED`, `DOCUMENT_UPLOADED`, `REQUEST_FULFILLED`, `DOCUMENT_DOWNLOADED`.

```json
{ "actorId": { "name": "Demo Clerk", "role": "CLERK" }, "action": "REQUEST_REVIEWED",
  "requestId": "…", "details": { "previousStatus": "PENDING", "newStatus": "UNDER_REVIEW" }, "timestamp": "…" }
```

## S7 additions
See `docs/INTEGRATIONS.md` for the full description.
- `GET /requests`, `/admin/users`, `/admin/audit-logs`: `q`, `from`, `to`, `sort`, `order` (plus existing filters). `GET /requests/export.csv`, `/admin/users/export.csv`, `/admin/audit-logs/export.csv`.
- `GET /admin/audit-logs/verify`: hash-chain check `{ ok, checked, head, brokenAt }`.
- `GET /branding` (public), `PUT /admin/branding`, `POST|DELETE /admin/branding/logo`.
- `GET /analytics/summary` (Admin, Principal).
- `GET|POST|DELETE /admin/api-keys`; `GET|POST|PATCH|DELETE /admin/webhooks`, `POST /admin/webhooks/:id/test`, `GET /admin/webhooks/:id/deliveries`.
- Integration API `/api/t/<slug>/v1/*` authenticated by API key; contract in `docs/openapi.json`.

## S8 additions
- `GET /readyz` (no tenant, public): `{ status, checks: { database, worker? } }`, 200 or 503. `GET /healthz` unchanged.
- Every response has `X-Request-Id` (a sane incoming value is echoed). All `/api` answers are `Cache-Control: no-store` except public branding.
- `GET /admin/data-export` (Admin): the institution's data as one JSON download, no credentials; audited as `DATA_EXPORTED` (`kind: institution`).
- Platform (`SUPER_ADMIN`): `POST /api/platform/tenants/:slug/suspend`, `POST .../resume`, `DELETE /api/platform/tenants/:slug` with body `{ "confirm": "<slug>" }` (only for a suspended institution; irreversible). Audit actions `TENANT_SUSPENDED`, `TENANT_RESUMED`, `TENANT_DELETED`.
