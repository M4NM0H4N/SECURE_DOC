# SaaS Upgrade Plan (condensed copy for agents)

Owner's full plan (9 Nov 2026) turns the finished MVP (tag `mvp-v1.0`, 238 tests) into a multi-institution product in eight gated phases. This file records the phases, gates and decisions so that agents and the reviewer share one source of truth. Nothing here is implemented until its phase is approved.

## Ground rules
1. `main` + tag `mvp-v1.0` stay as the academic submission. SaaS work happens on `saas`.
2. One phase at a time. Each ends at a gate: tests pass, docs updated, `.context.md` refreshed, owner approval.
3. Evidence over claims: report only executed test results; keep the 238 MVP tests green.
4. The backend enforces tenant isolation, roles, plan limits and workflow rules.
5. One tool edits a file at a time; the reviewer stays read-only unless files are handed over in writing.

## Phases and gates
| Phase | Scope | Gate |
|---|---|---|
| S0 Preparation | Tag `mvp-v1.0`, `saas` branch, push, rotate secrets, fix Atlas URI, CI green on a real server, agent rules, ADRs | CI green on `saas`, 238 tests pass, tag exists, rules updated |
| S1 Multi-tenancy core (approved) | Tenant model, `tenantId` everywhere, `(tenantId,email)` index, tenant resolution middleware, query-layer plugin, SUPER_ADMIN, self-signup, migration script | Cross-tenant suite: tenant A never reads/changes/downloads tenant B data on every endpoint |
| S2 Configurable institution (approved) | Department and DocumentType CRUD (replace enums), workflow engine from WorkflowDefinition, extra steps, NEEDS_INFO | Existing workflow/concurrency/transaction tests pass on the default definition; custom 3-step chain tested |
| S3 Account lifecycle (approved) | Invites, password change/reset, e-mail verification, lockout, server-side session revocation, optional TOTP | Tests for token reuse/expiry, lockout, revoked sessions, enumeration-safe responses |
| S4 Storage and trust (approved) | Storage interface (local + S3/R2), tenant-prefixed keys, malware scan, multi-document requests, QR/hash verification | Upload/download/revoke/verify pass on both adapters; infected file rejected |
| S5 Notifications and SLAs (approved) | Queue or Mongo outbox, e-mail provider, in-app notifications, SLA timers and escalation | Each lifecycle event notifies once; retries survive provider failure; SLA escalation in a mocked-clock test |
| S6 Plans and billing (SKIPPED by owner 2026-11-10: no charging needed for now) | Free/Standard/Institution plans, Stripe, limits middleware, read-only suspension | Idempotent webhooks; clear limit errors; suspended tenant cannot write |
| S7 Polish and integrations (implemented, docs/INTEGRATIONS.md) | Search/filter/pagination, CSV export, audit screen and hash-chain check, branding, analytics, API keys, webhooks, OpenAPI | Contract tests pass; dashboards match seeded data |
| S8 Hardening and launch | Staging + production, CI/CD, backups and restore drill, logging, E2E, accessibility, load and security review, legal pages | Demo on production URLs; restore drill succeeds; no open critical findings |

## Decisions needed before S1 (owner)
| Decision | Options | Recommendation |
|---|---|---|
| Tenant identification | Subdomain or path slug | Subdomain; path slug first if wildcard DNS is a hurdle |
| Job queue | BullMQ + Redis, or Mongo outbox | Mongo outbox until volume justifies Redis |
| Frontend | Keep vanilla JS or React | Keep vanilla JS (ADR 0004) |
| File storage | S3 or Cloudflare R2 | R2; adapter keeps it swappable |

Owner decisions (2026-11-09): path slug first, Mongo outbox, Cloudflare R2, vanilla JS until S7. Recorded as accepted in `docs/adr/`.

## Acceptance criteria for the SaaS release
A new institution can sign up, configure departments, document types and approval chain, and invite staff · no endpoint exposes another tenant's data (proved by tests) · documents in private scanned storage, verifiable by QR · every status change e-mails once, with SLA reminders · plan limits and Stripe billing idempotent · audit log searchable, exportable, hash-verified per tenant · staging and production deployed with CI/CD, backups and restore drill · Playwright, security and load results recorded · docs updated.

## Privacy note
Student records are personal data. A qualified person must review privacy and data-processing terms against the laws that apply to customers (for example India's DPDP Act) before anyone is charged.
