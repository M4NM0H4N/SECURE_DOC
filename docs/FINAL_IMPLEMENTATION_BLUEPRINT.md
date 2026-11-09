# Secure Document Request and Approval Workflow — Implementation Blueprint (v2, patched)

**SDG 16 – Peace, Justice and Strong Institutions** (targets 16.6 effective, accountable, transparent institutions; 16.10 access to information)

## 0. Changes from v1

| # | Change | Reason |
|---|---|---|
| 1 | Clerk is **department-scoped** (User.department used for Clerk too) | v1 "permitted institutional scope" was undefined |
| 2 | `department` is a **central enum**, not free text | Typos would silently break HOD/Clerk matching |
| 3 | Added `GET /api/requests` (role-scoped, `?status=`), removed ambiguity of `/pending`; Admin gets read-only metadata list; Clerk/HOD audit access dropped from MVP | v1 API could not show Clerk the APPROVED queue; Admin "view all" had no endpoint |
| 4 | Transitions use **atomic conditional updates** (`findOneAndUpdate` with expected status + scope in the filter) | Fixes concurrent changes without needing transactions |
| 5 | `authenticate` loads user from DB each request and checks `isActive` | Deactivation must take effect immediately, not at token expiry |
| 6 | Single-node replica set via Docker (`docker-compose.yml`); tests use the same Docker replica set through `MONGODB_URI_TEST` (an in-memory replica set did not work in this environment); state change + audit write in one transaction | Makes transaction/rollback tests real |
| 7 | CSRF: HttpOnly cookie + `SameSite=Strict` + required custom header (`X-Requested-With`) on state-changing calls; frontend served same-origin by Express | `csurf` is deprecated; simplest sound option |
| 8 | Upload: Multer memory storage → magic-byte check (own signature check for PDF/PNG/JPEG; no `file-type` package) → write UUID file → DB update → delete file if DB fails | Defines ordering for orphan cleanup |
| 9 | Added `express-mongo-sanitize` and strict string-type validation | NoSQL operator injection |
| 10 | Request has `statusHistory[]` | Cheap request timeline without querying audit logs |
| 11 | Process trimmed: one-editor-at-a-time rule kept, handover ceremony simplified; dark mode and Jenkins extras optional | Reduce overhead |

## 1. Overview

**Objective.** Students request official institutional documents; Clerks review and fulfil; HODs approve/reject; Admin manages staff and audits activity. All permissions are enforced on the backend; every important action is logged.

**Stack.** HTML/CSS/vanilla JS · Node.js + Express · MongoDB + Mongoose · JWT (HttpOnly cookie) + bcryptjs · express-validator · Helmet, express-rate-limit, express-mongo-sanitize · Multer · Jest + Supertest · Git/GitHub · Jenkins (lint + tests only).

## 2. Scope

**MVP:** registration/login, 4 roles, request submission, Clerk review, HOD approve/reject, Clerk upload & fulfil, status tracking, RBAC, private document storage/download, audit log, Admin user management, validation/security, automated tests, responsive UI.

**Excluded:** AI approval, QR verification, SMS/email, payments, ERP, analytics/NAAC, multi-tenant SaaS, SLA automation, blockchain audit.

## 3. Roles and permissions

| Operation | Student | Clerk | HOD | Admin |
|---|---|---|---|---|
| Register (public) | Yes | No | No | No |
| Submit request | Yes | No | No | No |
| View own requests | Yes | No | No | No |
| List requests | Own only | Own department | Own department | All (read-only metadata) |
| Move PENDING → UNDER_REVIEW | No | Yes (own dept) | No | No |
| Approve / reject | No | No | Yes (own dept) | No |
| Upload document / fulfil | No | Yes (own dept, APPROVED only) | No | No |
| Download document | Own, FULFILLED | Own dept, FULFILLED | Own dept, FULFILLED | No |
| Manage users | No | No | No | Yes |
| View audit logs | No | No | No | Yes |

Rules: public registration always creates `STUDENT`; role is never read from public input; staff are created by Admin or seed; Admin cannot approve; inactive users blocked on every call; users cannot change own role or department.

## 4. Requirements

**Functional:** FR-01 register/login · FR-02 secure auth · FR-03 RBAC · FR-04 submit requests · FR-05 view own history · FR-06 Clerk review/forward · FR-07 HOD approve/reject · FR-08 rejection reason mandatory · FR-09 Clerk uploads document · FR-10 Student downloads document · FR-11 audit records · FR-12 Admin manages users.

**Non-functional:** security (no privilege escalation), reliability (consistent status), usability, performance, maintainability (modular), scalability (future-ready), responsiveness (mobile/tablet/desktop).

## 5. Methodology

Agile, 5 sprints (1: setup/auth/UI foundation · 2: request mgmt · 3: workflow + RBAC · 4: documents, audit, security · 5: integration, tests, CI, docs). Keep a backlog (`docs/BACKLOG.md`).

## 6. Architecture

Three tiers: static frontend (served by Express, same origin) → Express (auth/RBAC, requests, audit, files) → MongoDB + private file storage (`server/uploads/`, never statically served).

## 7. UML (keep consistent with code)

Use case, class, sequence, activity, state, component diagrams in `docs/diagrams/`.

## 8. Database design

**Departments (central enum, `server/config/constants.js`):** define list once (e.g. `CSE, ECE, ME, CIV, EEE`); used by registration, admin creation, validators.

**User:** `name, email (unique, lowercase), passwordHash, role (STUDENT|CLERK|HOD|ADMIN), department (enum; null allowed for ADMIN), isActive, createdAt, updatedAt`.

**Request:** `studentId, department (copied from student profile, never from input), documentType (enum), purpose, status (PENDING|UNDER_REVIEW|APPROVED|REJECTED|FULFILLED), reviewedBy, decidedBy, rejectionReason, documentPath (random UUID filename only), statusHistory[{from,to,by,at,note}], createdAt, updatedAt`.

**Document types (enum):** Bonafide Certificate, Fee Receipt, Transcript, Transfer Certificate, Character Certificate, Other.

**AuditLog:** `actorId, action, requestId, details, timestamp`. Never store passwords, tokens, or document contents. No update/delete APIs. Application-level append-only only — not absolutely immutable.

Indexes: `User.email` unique; `Request {studentId}`, `{department,status}`; `AuditLog {timestamp}`, `{requestId}`.

## 9. Folder structure

See repository root: `client/`, `server/{config,controllers,middleware,models,routes,services,validators,utils,tests,uploads}`, `scripts/seedAdmin.js`, `docs/`, `.agent/skills/`, `.claude/skills/`, `AGENTS.md`, `CLAUDE.md`, `.context.md`, `.env.example`, `docker-compose.yml`, `Jenkinsfile`.

## 10. Authentication

- Registration fields: name, email, password, department (enum). Backend sets `role: "STUDENT"`.
- Password policy: min 8 chars, letter + number; bcryptjs cost ≥ 10.
- **Seed:** `scripts/seedAdmin.js` reads `INITIAL_ADMIN_*` from env, hashes, creates only if absent, never logs password. Rotate/remove bootstrap password afterwards.
- Login: validate → check `isActive` → bcrypt compare (use constant-time dummy compare for unknown email) → sign JWT → set HttpOnly cookie (`Secure` in production, `SameSite=Strict`) → audit `USER_LOGIN`.
- No long-lived tokens in localStorage. CSRF: require `X-Requested-With` header on POST/PATCH/PUT/DELETE; reject otherwise.
- `authenticate` middleware: verify JWT → load user by id → reject if missing/inactive → set `req.user`.

## 11. Authorization

`authorize(...roles)` middleware **plus** per-resource checks in a service layer:
- Student: `request.studentId === req.user.id`.
- Clerk/HOD: `request.department === req.user.department`.
- Admin: account management and audit view only.
Return 404 (not 403) for out-of-scope resources to avoid revealing existence.

## 12. Workflow and state machine

```
PENDING --Clerk--> UNDER_REVIEW --HOD--> APPROVED --Clerk upload--> FULFILLED
                        \--HOD (reason required)--> REJECTED
```

| From | To | Role |
|---|---|---|
| PENDING | UNDER_REVIEW | Clerk |
| UNDER_REVIEW | APPROVED | HOD |
| UNDER_REVIEW | REJECTED | HOD |
| APPROVED | FULFILLED | Clerk |

Implementation: a single `transition(requestId, actor, from, to, extra)` service using
`Request.findOneAndUpdate({_id, status: from, department: actor.department}, {...}, {new:true})`; null result ⇒ 409/404. Append to `statusHistory`; write audit in the same transaction when a replica set is available. Known limitation: REJECTED is terminal (student submits a new request); Clerk cannot reject.

## 13. API

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/logout` | Authenticated |
| GET | `/api/auth/me` | Authenticated |
| POST | `/api/requests` | Student |
| GET | `/api/requests` (`?status=`) | Student (own) / Clerk, HOD (dept) / Admin (all, metadata) |
| GET | `/api/requests/:id` | Authorized per scope |
| PATCH | `/api/requests/:id/review` | Clerk |
| PATCH | `/api/requests/:id/approve` | HOD |
| PATCH | `/api/requests/:id/reject` | HOD (body `reason` required) |
| POST | `/api/requests/:id/document` | Clerk |
| GET | `/api/requests/:id/document` | Student (own) / Clerk, HOD (dept) |
| GET | `/api/admin/users` | Admin |
| POST | `/api/admin/users` | Admin (create CLERK/HOD with department) |
| PATCH | `/api/admin/users/:id` | Admin (isActive, name, department; role not changeable except via explicit create) |
| GET | `/api/admin/audit-logs` | Admin (paginated, filter by requestId/action) |

Response format: `{ success, data?, message?, errors? }` with correct status codes (400 validation, 401, 403, 404, 409 invalid transition/conflict, 413, 429).

## 14. Document security

PDF/JPG/PNG, ≤ 5 MB. Multer memory storage → verify extension **and** magic bytes → write `UUID.ext` to `UPLOAD_DIR` (outside `client/`) → update DB (status FULFILLED) → on any failure delete file and return error. DB stores filename only. Downloads via authenticated endpoint with scope + status check, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.

## 15. Audit events

`USER_LOGIN, USER_REGISTERED, USER_CREATED_BY_ADMIN, USER_ACTIVATED, USER_DEACTIVATED, REQUEST_SUBMITTED, REQUEST_REVIEWED, REQUEST_APPROVED, REQUEST_REJECTED, DOCUMENT_UPLOADED, REQUEST_FULFILLED, DOCUMENT_DOWNLOADED`. Policy: for state changes, if audit write fails the action fails (same transaction). Login/download audit failures are logged server-side and do not block.

## 16. Transactions

- Preferred: single-node replica set (`docker compose up -d`, then `rs.initiate`). Use `session.withTransaction` for transition + audit.
- Fallback (no replica set): document which operations are non-atomic; atomic conditional updates still protect status; explicit failure handling; manual failure tests.
- Final report must state which mode was actually used.
- File write is never part of a DB transaction — handled by write-then-update-then-cleanup ordering.

## 17. Frontend

Pages: login, register, student / clerk / HOD / admin dashboards, request details (with `statusHistory`). Sprint 1: CSS tokens, typography, spacing, mobile-first layout, responsive nav, reusable form/button/card/status-badge components, tested at mobile and desktop widths. Render untrusted text with `textContent`, never `innerHTML`. 48px touch targets; accessible labels and contrast. Dark mode optional.

## 18. Security checklist

bcrypt; signed JWT in HttpOnly cookie; isActive check per request; login rate limit; Helmet; restrictive CORS (same-origin); CSRF header; mongo-sanitize; validators on all input; mass-assignment prevention (whitelist fields); generic errors with no stack traces; secrets only in env; least privilege; private files.

## 19. Testing (Jest + Supertest, ≥ 30 meaningful tests)

Unit: hashing, JWT, authorize, validators, transition rules, department matching, audit creation.
Integration: register/login, create request, review, approve, reject, upload, download, admin user mgmt, audit generation.
Required security scenarios:
1. Student cannot read another student's request. 2. Student cannot approve. 3. Cannot register as Admin. 4. Cannot change own role. 5. Clerk cannot approve. 6. HOD cannot access other department. 7. HOD cannot upload. 8. Admin cannot approve/bypass workflow. 9. Inactive user blocked (including with a still-valid token). 10. Invalid JWT rejected. 11. Expired JWT rejected. 12. Reject without reason fails. 13. Invalid transitions fail (409). 14. Oversized upload rejected. 15. Unauthorized download blocked. 16. Clerk of another department blocked. 17. NoSQL operator payload in login rejected. 18. Missing CSRF header rejected. 19. Wrong magic bytes rejected. 20. Concurrent approve/reject: exactly one succeeds.
Report actual counts and results only.

## 20. CI (Jenkins)

Checkout → install → lint → unit tests → integration tests → build/verify. No auto-deploy.

## 21. Documentation deliverables

Problem statement, objectives, SDG alignment, SRS, FR/NFR, 6 UML diagrams, architecture, DB design, API docs, testing strategy, real test results, security implementation, sprint plan, screenshots, limitations, future work, conclusion.

## 22. AI workflow

One editor at a time. Implementation owner (Antigravity, or whoever the owner designates) edits files; Claude Code reviews read-only unless the owner hands over specific files in writing. See `AGENTS.md` and `CLAUDE.md`.

## 23. Phases (stop at each gate for approval)

0. Inspect + agent setup · 1. Foundation + auth + seed + admin staff creation + CSS foundation · 2. Request management · 3. Workflow + RBAC · 4. Documents, audit, security, transactions · 5. Frontend integration + full tests · 6. CI/CD + docs + demo.

## 24. Demo script

Student submits Bonafide → Clerk reviews → HOD approves → Clerk uploads → Student downloads → Admin shows users + audit trail → security demos (cross-student access, student/clerk approve, cross-department HOD, invalid transition, unauthorized download).

## 25. Acceptance criteria

All items in v1 §31 apply, plus: department enum enforced; deactivated user blocked immediately; atomic transition test passes; transaction mode (replica set or fallback) documented and tested.
