# Agile Sprint Plan

The project followed the five-sprint plan, delivered as gated phases. Each phase ended with a review gate before the next one started. Sprint and phase boundaries line up as shown.

| Sprint | Phase | Goal | Delivered | Gate evidence |
|---|---|---|---|---|
| 1 | 0 | Requirements, setup | Repository structure, agent rules (`AGENTS.md`, `CLAUDE.md`), `.context.md`, patched plan, backlog, skills installed | Phase 0 approved |
| 1 | 1 | Foundation, authentication, basic UI | Express + MongoDB, registration/login/logout, RBAC middleware, admin seed, staff creation, CSS design tokens and responsive pages | 36 tests |
| 2 | 2 | Request management | Request model, submission, scoped listing and detail, student dashboard | 66 tests |
| 3 | 3 | Approval workflow and RBAC | Atomic transition service, review/approve/reject, department limits, Clerk and HOD dashboards, concurrency tests | 104 tests |
| 4 | 4 | Documents, audit, security | Private uploads and downloads, audit log with admin page, transactions with rollback tests, rate limits | 163 tests |
| 5 | 5 | Integration, testing | Defect fixes (session expiry, limiter, 404, paging, accessibility), security and end-to-end suites, responsive checks, test report | 202 tests |
| 5 | 6 | CI/CD and documentation | Jenkinsfile, CI scripts, SRS, UML, API reference, limitations, demo guide, demo data script, README | this document set |

## Product backlog

The full backlog with priorities and completion status is [BACKLOG.md](BACKLOG.md). Items marked done there were completed in the phase listed above. The remaining open items are the ones that cannot be done from a development machine: running the pipeline on a Jenkins server, and the final presentation.

## User stories (examples, with acceptance)

| Story | Acceptance |
|---|---|
| As a student I want to request a certificate so that I do not need to queue at the office | Submitted request appears as Pending with a history entry |
| As a clerk I want a queue for my department so that I only handle relevant requests | Another department's requests are never visible (404) |
| As an HOD I want to reject with a reason so that the student knows what to fix | Reject without a reason is refused; reason shown to the student |
| As an admin I want to deactivate a user so that a leaver loses access at once | The user's next request fails; audit event recorded |
| As an auditor I want to see who did what so that decisions are accountable | Audit log lists actor, action, request and time, with no secrets |
