# Implementation Backlog

Priority: P0 must, P1 should, P2 optional. Status: [ ] todo, [x] done.

## Phase 0 — Setup
- [x] P0 Folder structure, .gitignore, .env.example, docker-compose.yml
- [x] P0 AGENTS.md, CLAUDE.md, .context.md, patched blueprint
- [x] P0 Install the 4 skills (installed; Antigravity discovery still to confirm)
- [x] P0 Start MongoDB replica set via Docker (verified connect)
- [x] P0 Departments confirmed: CSE, ME, CIVIL, ECE, EEE

## Phase 1 — Foundation and auth (Sprint 1)
- [x] P0 `npm init`, install dependencies, ESLint, Jest config
- [x] P0 `server/config/constants.js` (roles, statuses, departments, doc types, transitions)
- [x] P0 `app.js`/`server.js`, Mongo connection, Helmet, rate limit, sanitize, error handler, static client
- [x] P0 User model; register (STUDENT only); login; logout; `/me`
- [x] P0 `authenticate` (DB load + isActive) and `authorize`; CSRF header middleware
- [x] P0 `scripts/seedAdmin.js`
- [x] P0 Admin create/list/activate staff (`/api/admin/users`)
- [x] P0 CSS tokens, mobile-first layout, nav, form/button/card/badge components; login and register pages
- [x] P0 Tests: auth, role escalation, inactive user, invalid/expired JWT

## Phase 2 — Requests (Sprint 2)
- [x] P0 Request model with statusHistory; department from profile
- [x] P0 POST/GET `/api/requests`, GET `/:id`, ownership/department scope service
- [x] P0 Student dashboard + request form + detail page
- [x] P0 Tests: cross-student access, validation, unsupported doc type

## Phase 3 — Workflow (Sprint 3)
- [x] P0 Transition service (atomic conditional update)
- [x] P0 review / approve / reject endpoints; mandatory reason
- [x] P0 Clerk and HOD dashboards
- [x] P0 Tests: all transitions, invalid transitions, cross-department, concurrency

## Phase 4 — Documents, audit, security (Sprint 4)
- [x] P0 Upload (memory → magic bytes → UUID write → DB → cleanup), download endpoint
- [x] P0 Audit service + events; transaction with state change; Admin audit view
- [x] P0 Transaction mode decision documented; failure-path tests
- [x] P1 Rate limits on login/upload; security headers review

## Phase 5 — Integration and testing (Sprint 5)
- [x] P0 Admin dashboard; loading/empty/error states; responsive polish
- [x] P0 Full test suite ≥ 30 tests, 20 security scenarios; end-to-end run

## Phase 6 — CI and docs
- [x] P1 Jenkinsfile (lint, unit, integration/security/e2e, build check, optional deploy placeholder). Commands verified locally; NOT yet run on a Jenkins server
- [x] P0 SRS, 7 UML diagrams (validated with Mermaid), API reference, TESTING.md with real results, screenshots, README, limitations, demo guide, sprint plan
- [x] P2 Dark mode (follows the operating system theme)
- [x] P0 Local MongoDB (dev and CI) published on 127.0.0.1 only; tests refuse non-local databases
- [x] P1 Production configuration: Atlas via MONGODB_URI, 0.0.0.0 bind, trust proxy, /healthz, upload-folder check, guards against local/whitespace URIs
- [x] P1 Deployment guide (docs/DEPLOYMENT.md)
- [ ] P0 Fix whitespace in MONGODB_ATLAS_URI in local .env and run npm run check:atlas (owner)
- [ ] P0 Choose file storage for production (persistent disk or object storage) and Atlas network access for Render (owner)
- [ ] P0 Deploy to Render and run the checklist in docs/DEPLOYMENT.md (owner)
- [ ] P0 Run the pipeline on a Jenkins server (owner)
- [ ] P0 Final presentation and live demonstration (owner; outline in docs/DEMO.md)
