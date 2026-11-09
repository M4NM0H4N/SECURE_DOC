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

**Enumerations.** Roles: `STUDENT CLERK HOD ADMIN` (plus the tenantless `SUPER_ADMIN`, platform routes only). Departments: `CSE ME CIVIL ECE EEE`. Statuses: `PENDING UNDER_REVIEW APPROVED REJECTED FULFILLED`. Document types: `Bonafide Certificate`, `Fee Receipt`, `Transcript`, `Transfer Certificate`, `Character Certificate`, `Other`.

## Access summary

| Endpoint | Student | Clerk | HOD | Admin |
|---|---|---|---|---|
| `POST /auth/register`, `POST /auth/login` | public | public | public | public |
| `POST /auth/logout`, `GET /auth/me` | yes | yes | yes | yes |
| `POST /requests` | yes | - | - | - |
| `GET /requests`, `GET /requests/:id` | own | own department | own department | all |
| `PATCH /requests/:id/review` | - | own department | - | - |
| `PATCH /requests/:id/approve`, `/reject` | - | - | own department | - |
| `POST /requests/:id/document` | - | own department | - | - |
| `GET /requests/:id/document` | own | own department | own department | - (403) |
| `GET/POST/PATCH /admin/users` | - | - | - | yes |
| `GET /admin/audit-logs` | - | - | - | yes |

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

### POST /api/auth/logout
Clears the cookie. `200`.

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

### PATCH /api/requests/:id/review (Clerk)
`PENDING` -> `UNDER_REVIEW`. No body.

### PATCH /api/requests/:id/approve (HOD)
`UNDER_REVIEW` -> `APPROVED`. No body.

### PATCH /api/requests/:id/reject (HOD)
`UNDER_REVIEW` -> `REJECTED`. Body `{ "reason": "…" }`, required, 5-500 characters after trimming.

For all three: `404` if the request is in another department or does not exist, `409` if the request is not in the required current status. Each is a single atomic conditional update, so concurrent callers get exactly one success.

### POST /api/requests/:id/document (Clerk)
`multipart/form-data` with exactly one file in the field `document`.

- Types: PDF, JPG/JPEG, PNG. The real file signature is checked, and the extension must match the content.
- Maximum 5 MB (`413` above that).
- Allowed only while the request is `APPROVED` (`409` otherwise).
- Success: stored under a random UUID name outside the web root; request becomes `FULFILLED`; `200` with the request.
- Any failure after the file is written deletes the file and leaves the request `APPROVED`.

### GET /api/requests/:id/document (Student, Clerk, HOD)
Returns the file as an attachment (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`). `409` until the request is `FULFILLED`, `404` if out of scope or the file is missing, `403` for Admin.

---

## Admin (all require the Admin role)

### GET /api/admin/users
Query: `role`, `page`, `limit` (max 100). `200` `{ items, total, page, limit }`.

### POST /api/admin/users
Body: `name`, `email`, `password`, `role` (`CLERK` or `HOD` only), `department`. `201` with the user. `ADMIN` and `STUDENT` cannot be created here.

### PATCH /api/admin/users/:id
Body may contain `name`, `isActive`, `department`. Including `role`, `email` or `password` returns `400`. An admin cannot deactivate their own account.

### GET /api/admin/audit-logs
Query: `action` (one of the audit actions), `requestId`, `actorId`, `page`, `limit` (max 100). Newest first. Read-only: there is no create, update or delete route.

Audit actions: `USER_REGISTERED`, `USER_LOGIN`, `USER_CREATED_BY_ADMIN`, `USER_ACTIVATED`, `USER_DEACTIVATED`, `REQUEST_SUBMITTED`, `REQUEST_REVIEWED`, `REQUEST_APPROVED`, `REQUEST_REJECTED`, `DOCUMENT_UPLOADED`, `REQUEST_FULFILLED`, `DOCUMENT_DOWNLOADED`.

```json
{ "actorId": { "name": "Demo Clerk", "role": "CLERK" }, "action": "REQUEST_REVIEWED",
  "requestId": "…", "details": { "previousStatus": "PENDING", "newStatus": "UNDER_REVIEW" }, "timestamp": "…" }
```
