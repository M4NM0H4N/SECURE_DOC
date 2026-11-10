# Configurable institution and workflow (SaaS phase S2)

Status: implemented on the `saas` branch.

## What an institution can configure

| Setting | Where | Rules |
|---|---|---|
| Departments | Admin > Institution settings, `/api/admin/departments` | Code (2-10 letters or digits) is permanent and unique per institution; the name can be edited; departments are deactivated, never deleted |
| Document types | `/api/admin/document-types` | Names are unique ignoring case; renamed or deactivated types do not change existing requests |
| Approval chain | `/api/admin/workflow` | 1 to 6 ordered steps, each owned by a Clerk, HOD or Principal; at least one step must be allowed to reject |

A new institution (signup, migration or the demo seed) starts with the MVP's five departments, six document types and the chain **Clerk review, then HOD decision**, so nothing changes until the Admin edits it. The fixed lists in the MVP code are gone: departments and types are data, validated against the institution's own active entries (registration, staff creation, department changes, new requests).

## The engine

A definition is only an ordered list of steps. Everything the engine allows is derived from it (`server/services/workflowEngine.js`, pure functions):

| Event | Result |
|---|---|
| Step 1 completed | `PENDING` to `UNDER_REVIEW` |
| Step n completed (not last) | stays `UNDER_REVIEW`, now waiting on step n+1 |
| Last step completed | `APPROVED` |
| A step with "may reject" | `REJECTED`, reason required (5-500 characters) |
| Any step, "ask for information" | `NEEDS_INFO`, note required; the student resubmits and the request returns to the same step |
| Clerk of the request's department uploads the file | `APPROVED` to `FULFILLED` |

With the default chain this produces exactly the MVP's four transitions (checked by a unit test).

`server/services/transitionService.js` keeps the MVP guarantees:
- The status, the current step and (for department-scoped steps) the department are part of the update filter, so check and write are one atomic operation. Two simultaneous approvals: exactly one wins, the other gets 409 (tested on a custom chain).
- The status change and its audit record commit together in a transaction.
- Errors keep their meaning: 403 this role can never do that, 404 not found or outside your department or institution, 409 right role but wrong moment.

**Roles and scope.** Clerk and HOD steps are department-scoped (only staff of the request's department see and act on it; others get 404). `PRINCIPAL` is a new institution-wide role without a department, for steps that are not department-specific. A Principal can read every request of the institution and act on Principal steps, but cannot download documents (like the Admin) or administer anything. The step's scope is derived from its role on the server, never taken from input.

## Pinned versions

A definition is immutable. Saving the chain creates the next version, and each request stores the version it started with (`workflowDefinitionId`) and its current step (`currentStepIndex`). Requests in progress therefore finish under the chain they began with, and only new requests use the new chain. The workflow screen shows how many requests are still on an earlier version, and warns when a role in the chain (or the Clerk who fulfils) has no active staff.

## NEEDS_INFO and resubmission

A reviewer at the current step can ask for information (`PATCH /requests/:id/needs-info`, body `note`). The request is frozen: no step, rejection or upload works on it. Only the owning student can answer (`PATCH /requests/:id/resubmit`, optional corrected `purpose`); it goes back to the step that asked, so the same reviewer sees it again. The history keeps every question and answer in order. (Resubmission is in place on the same request, not a new linked request.)

## API additions

See [API.md](API.md): `PATCH /requests/:id/advance`, `/needs-info`, `/resubmit`; `GET /meta/departments` (public), `GET /meta/options`; admin routes for departments, document types and the workflow. Request responses now include `actions` (what the signed-in user may do now) and `currentStep`; the UI uses these only to show the right buttons, and the server re-checks every action. `/review` and `/approve` remain as shortcuts.

## Migration

`npm run migrate:tenants -- --apply` also seeds the defaults for every institution that has none and pins existing requests (PENDING and NEEDS_INFO to step 1, everything else to the last step of the default chain). A dry run against the local development database reported 1 request to pin and 1 institution to seed (nothing written).

## SLAs (added in S5)

A step can also carry `slaHours` and `escalateTo`; they are part of the immutable version like everything else here. See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Deliberately not in S2

Per-document-type chains (`documentTypeId` on a definition), department-specific chains, a configurable fulfilment role, and (until S5) e-mail notifications. Fulfilment is always done by a Clerk of the request's department.
