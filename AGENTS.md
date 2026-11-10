# AGENTS.md — Secure Document Request and Approval Workflow

All agents must read this file, `CLAUDE.md` and `.context.md` before changing anything.
Full plan: `docs/FINAL_IMPLEMENTATION_BLUEPRINT.md`. Backlog: `docs/BACKLOG.md`.

## Objective
Web app where Students request official documents, Clerks review/fulfil, HODs approve/reject, Admin manages staff and views audit logs. SDG 16.

**Branches:** `main` + tag `mvp-v1.0` = the frozen academic MVP submission. `saas` = the multi-institution SaaS upgrade (`docs/SAAS_PLAN.md`, phases S0–S8). Merge to `main` only after a phase gate passes and the owner approves.

## Stack
HTML/CSS/vanilla JS · Node.js + Express · MongoDB + Mongoose · JWT (HttpOnly cookie) + bcryptjs · express-validator · Helmet · express-rate-limit · express-mongo-sanitize · Multer (own PDF/JPG/PNG signature check) · Jest + Supertest (tests use the local Docker replica set) · Jenkins · production on Render + MongoDB Atlas (see `docs/DEPLOYMENT.md`).

## Architecture
`client/` static frontend, served by Express (same origin) → `server/` (routes → controllers → services → models) → MongoDB + private `server/uploads/`. Business rules (authorization scope, state transitions, audit) live in `server/services/`, not in controllers or the frontend.

## Coding conventions
- CommonJS, async/await, one responsibility per module.
- Controllers thin; services hold logic; validators in `server/validators/`.
- Constants (roles, statuses, default seed lists) only in `server/config/constants.js`. Departments, document types and the approval chain are per-institution data (S2); allowed transitions are derived from the workflow definition by `server/services/workflowEngine.js`, never hard-coded.
- Response shape: `{ success, data?, message?, errors? }`.
- Never `innerHTML` with untrusted data in the frontend.

## Security requirements (non-negotiable)
- No hardcoded secrets; `.env` never committed.
- Passwords are only ever chosen by their owner (invite acceptance, reset, change). Tokens (invite, reset, verification) are random, single use, expiring and stored hashed; links are returned once and never logged or audited. Sessions are revocable on the server (`tokenVersion`).
- Public registration creates `STUDENT` only; role/department never trusted from client for privilege.
- Backend enforces RBAC + ownership (Student) + department scope (Clerk, HOD). Out-of-scope → 404.
- `authenticate` re-loads user and checks `isActive` on every request.
- Status changes only through the atomic transition service; invalid → 409.
- Rejection requires a reason.
- Notifications: written in the same transaction as the event (exactly once), delivered by the worker with retries; security mail (secret links) is never stored or logged; nothing is reassigned or decided automatically by an SLA.
- Uploads: PDF/JPG/PNG, ≤ 5 MB, magic-byte check, malware scan before storing (fails closed in production), random tenant-prefixed key through the storage interface (local or private S3/R2), never inside `client/`, downloads streamed through an authenticated endpoint. No public or presigned URLs. Replaced/revoked documents keep their record.
- Audit log is application-level append-only; never claim immutability; no update/delete API; no secrets in details.
- Do not assume transactions on standalone MongoDB; document actual mode.
- CSRF: custom header required on state-changing requests.
- The local Docker MongoDB has no authentication: its port stays bound to `127.0.0.1` only. Never publish it on all interfaces.
- Tests may only use a local MongoDB (they drop their database). Production uses MongoDB Atlas through `MONGODB_URI` set in the Render dashboard. Never commit connection strings, passwords or `.env`; never print them.

## Testing requirements
Jest + Supertest, ≥ 30 meaningful tests including the 20 security scenarios in the blueprint §19. Never claim tests passed unless actually run; report real counts.

## Scope restrictions
- `main` (MVP): no AI approval, QR verify, SMS/email, payments, ERP, analytics, multi-tenant, SLA automation, blockchain.
- `saas` branch: the scope is `docs/SAAS_PLAN.md`. Build only the current phase; never add features from a later phase. No blockchain, no AI approval, no ERP.
- SaaS rules: every query tenant-scoped through the shared layer (from S1); a cross-tenant test for every new route; keep the 238 MVP tests green (adapt, never delete); no secrets in code, logs or audit details.

## Phase-gate rules
Work one phase at a time (MVP phases 0–6, done; SaaS phases S0–S8). Inspect before changing. State planned changes before major work. Implement only the approved phase. Run relevant tests. Report changed files and real results. Update `.context.md` after milestones. **Stop at each gate and wait for approval.**

## File ownership
One editor at a time. The implementation owner edits project files. Claude Code is a read-only reviewer unless specific files/folders are handed over in writing by the project owner; during a handover the owner pauses edits to those files, then reviews the diff and runs tests before taking ownership back.

## Skills
Four skills belong in both `.agent/skills/` and `.claude/skills/`: `context-keeper`, `responsive-mobile-first`, `ui-ux-pro-max`, `security-first` (each a folder with `SKILL.md`). Use the project owner's exact definitions; do not invent placeholders. Status: see `.context.md`.

## S7/S8 conventions
- Log only through `server/utils/logger.js` (JSON, redacted). No `console.*` in server code, never log bodies, query strings, e-mail addresses, tokens or connection strings.
- A new tenant route is automatically swept by `server/tests/hardening.test.js` (anonymous, role, cross-institution, CSRF). A deliberately public route must be added to its `PUBLIC` list.
- A new tenant-scoped model needs the `tenantScope` plugin; export and institution deletion find it automatically (`dataLifecycleService.tenantModels`). Fields holding secrets must be `select: false`.
- Anything destructive (restore, deletion) refuses unless explicitly confirmed and is tested on a throw-away database only. Never run `docker compose down -v`.
- Browser tests: `npm run test:e2e` (throw-away local `*e2e*` database). Deployment is the owner's action; do not claim a deployment, Jenkins or GitHub Actions result that has not happened.
