# Notifications, queue and SLAs (SaaS phase S5)

Status: implemented on the `saas` branch. Decisions: [ADR 0003](adr/0003-queue.md) (Mongo outbox, no Redis). Behaviour below is what the code does and what the tests check ([TESTING.md](TESTING.md)).

## What people are told

| Event | Who gets it |
|---|---|
| Request submitted | active staff owning step 1 in the request's department |
| A step is completed and the next waits | active staff owning the next step (department-scoped steps: that department only; a Principal step: the Principal) |
| Approved | the student; the Clerks of the department (upload needed) |
| Rejected | the student (the reason is in the e-mail, not in the short in-app line) |
| Needs information | the student, with the question |
| Student answers | the staff owning the step that asked |
| Fulfilled | the student |
| Deadline reminder / overdue | see "SLAs" |
| Invitation, password reset, e-mail verification | the invitee / the user (always sent) |

Nobody else is told: not the other department, not inactive users, not the actor, not another institution (tested).

## Two channels, one rule: exactly once

Each event writes, per person, an **in-app** notification (the bell and the Notifications page, already delivered) and, if mail is on and the person has not opted out, an **e-mail outbox entry** (`PENDING`). Both are written **in the same database transaction as the event itself** (the status change, the new request, the resubmission), so a notification exists exactly once or, if the event rolls back, not at all (tested: a failed audit write leaves no notification). Each is an upsert on a unique `dedupeKey`, so repeating the same write (a retried transaction, a repeated call) never creates a second one (tested, with a mutation check).

## The worker

A small worker delivers the outbox: `npm run worker` (its own process; `-- --once` for a cron job), or `WORKER_INLINE=true` to run it inside the web process for a small deployment. Several workers may run at once.

- **Claiming** is one atomic update (stamps `lockedAt`, counts the attempt), so two workers cannot take the same message (tested with two concurrent passes). A claim older than 5 minutes is treated as a crashed worker's and may be taken again (tested).
- **Retries:** a failed send is retried after 30 s, 2 min, 10 min, 1 h, then 6 h; after **6 attempts** it is `FAILED` and left alone. An Admin can send a failed message again (audited). Retries survive a provider outage and a recovery delivers the message once (tested).
- **At-least-once:** if a worker is slower than the lock time, a message could be sent twice by two attempts; the provider call carries the notification id as an idempotency key (Resend honours it), so a retried send cannot duplicate there.
- **Looked up at send time:** the person's current address is used; a deactivated person or one who opted out since is skipped (`CANCELLED`).
- The pass also runs the SLA scan.

## E-mail

`server/services/mailer.js` with `MAIL_PROVIDER`: `outbox` (in memory: development and tests, **refused in production**), `resend` (Resend's HTTPS API over a plain HTTPS request; needs `RESEND_API_KEY` and `MAIL_FROM`), or `none` (the production default: nothing is sent). When mail is off no e-mail rows are created, so nothing queues up to fail later; people still see the in-app notifications.

Messages are rendered from templates (`mailTemplates.js`): short plain text plus a simple HTML version, every value HTML-escaped (tested with injected markup). Ordinary notification mails link to an in-app page and contain no secret. A provider error is reduced to its status code ("Mail provider returned 503"): the provider's response text, which can echo the request, is never stored or logged.

**Security mail (invite, reset, verification) is not queued.** Its link is a secret, and a queued copy would keep it in the database in readable form (S3 stores only hashes). So it is sent immediately with one retry, and the delivery is recorded **without the link** (type `SECURITY_*`). If the provider is down the invitation still succeeds and the Admin still sees the link once on screen to pass on; the failed delivery shows in the Admin's log. Security mail ignores the e-mail preference. (This differs from the plan's idea of putting these on the outbox; the reason is the one above.)

## Preferences

Each person can turn off e-mail for ordinary notifications on the Notifications page (`PATCH /notifications/preferences`). The in-app notice always remains.

## SLAs

Each workflow step can have `slaHours` (whole hours, 1-720) and `escalateTo` (Clerk, HOD or Principal, different from the step's own role; needs an SLA). They are part of the immutable workflow version, so a request keeps the SLA of the chain it started with (tested). Each request records `stepEnteredAt`, `slaReminderAt` and `slaDueAt` for the step it is waiting at.

| Moment | Effect |
|---|---|
| Request submitted / a step completed | the clock starts for the (next) step if it has an SLA |
| 75% of the time has passed | a **reminder** goes to the owners of the current step |
| The deadline passes | an **escalation** goes to the `escalateTo` role (same department for Clerk/HOD, institution-wide for a Principal); with no target, the step's own owners are told again |
| Needs information | the clock **stops**; the answer restarts it from that moment |
| Approved, rejected, fulfilled | the clock stops |

The scan claims a timer by setting it to null in the same transaction that writes the notifications, with a conditional update, so however many scanners run each reminder and each escalation fires **exactly once** (tested with three concurrent scanners and with time moved by passing `now`). If the deadline passed before anyone looked, only the escalation is sent. **Nothing is reassigned, approved or rejected automatically**: a person still decides. Escalations are notifications, not audit entries (the audit log requires a human actor).

## Screens and routes

Bell with unread count in the top bar and a Notifications page (list, unread filter, mark read, mark all read, e-mail preference); Admin: "E-mail delivery" (status filter, retry a failed message; never message text or links) and SLA fields on each step of the chain editor. Routes are in [API.md](API.md).

## Configuration

| Variable | Purpose |
|---|---|
| `MAIL_PROVIDER` | `outbox` (dev/test), `resend`, `none` (production default) |
| `MAIL_FROM` | sender, for example `DocFlow <no-reply@example.com>` (resend) |
| `RESEND_API_KEY` | (resend) |
| `RESEND_API_URL` | default `https://api.resend.com`; https required in production |
| `WORKER_INLINE` | `true` to run the worker inside the web process |

## What was and was not verified

Verified by tests: everything above, including a provider against a fake HTTPS server (headers, body, idempotency key, error statuses) and a browser run on a throwaway database (the bell showed the unread count, the page marked it read and saved the preference, the standalone worker delivered the queued mail, the SLA fields saved through the chain editor, the delivery log listed the messages). **Not verified: a real Resend account or any real mail delivery** (no account or API key was available; the provider is tested only against a fake). Please send one real test mail before relying on it, and check the sender domain is verified with your provider.

## Limitations

- No bounce, complaint or unsubscribe handling from the provider; no per-event preferences (one switch for ordinary mail).
- The worker is a polling loop (10 s), not a push queue; there is no worker health endpoint or dead-man alert yet (S8).
- If mail is switched on after notifications were created, earlier events have no e-mail (only in-app).
- Escalation is a notice only, by design; there is no auto-reassignment.
- In-app notifications and delivery rows are removed after a year; there is no export.
