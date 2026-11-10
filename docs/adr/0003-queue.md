# ADR 0003: Job queue and notifications

- **Status:** Accepted 2026-11-09 (owner)
- **Context:** S5 needs e-mail on every status change, retries and SLA timers. Redis adds infrastructure to run, pay for and secure.
- **Decision:** Start with a Mongo-backed outbox: a `Notification` record is written in the same transaction as the status change, and a worker sends it and records delivery. Move to BullMQ + Redis only when volume justifies it; keep the worker behind a small interface so the swap is local.
- **Why:** The transactional write gives exactly-once enqueue without new services; MongoDB is already a requirement.
- **Implemented in S5** (see docs/NOTIFICATIONS.md). Two refinements: SLA reminders are not outbox rows with a `notBefore`; each request carries its own timers, a scanner claims a due timer atomically in the same transaction that writes the notifications, and those notifications then use the normal outbox. Security mail (secret links) is sent directly and recorded without its link instead of being queued, so no secret is stored.
- **Consequences:** Delivery is at-least-once, so sends must be idempotent (dedupe key per event and recipient). SLA reminders use the same outbox with a `notBefore` time.
