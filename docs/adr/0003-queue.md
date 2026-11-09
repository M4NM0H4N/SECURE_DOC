# ADR 0003: Job queue and notifications

- **Status:** Accepted 2026-11-09 (owner)
- **Context:** S5 needs e-mail on every status change, retries and SLA timers. Redis adds infrastructure to run, pay for and secure.
- **Decision:** Start with a Mongo-backed outbox: a `Notification` record is written in the same transaction as the status change, and a worker sends it and records delivery. Move to BullMQ + Redis only when volume justifies it; keep the worker behind a small interface so the swap is local.
- **Why:** The transactional write gives exactly-once enqueue without new services; MongoDB is already a requirement.
- **Consequences:** Delivery is at-least-once, so sends must be idempotent (dedupe key per event and recipient). SLA reminders use the same outbox with a `notBefore` time.
