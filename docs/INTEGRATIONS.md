# S7: product polish and integrations

All of this is per institution (tenant). Every query goes through the tenant-scoped layer; every new route has a cross-tenant test.

## Lists, search, export
- Shared helpers: `server/utils/listQuery.js` (escaped search, whitelisted sort with a stable tie-break, date ranges) and `server/utils/csv.js`.
- Requests (`GET /requests`, `/requests/export.csv`) and users (`/admin/users`, `/admin/users/export.csv`): `q`, `status`, `from`, `to`, `sort`, `order`, `page`, `limit`. The caller's own scope (student ownership, clerk/HOD department) always applies; filters can only narrow it.
- CSV: every cell is quoted; cells starting with `= + - @ TAB CR` get a leading `'` (spreadsheet formula injection). At most 5000 rows. Each export writes a `DATA_EXPORTED` audit entry.

## Audit hash chain
- Each audit entry stores `seq`, `prevHash`, `hash` (SHA-256 over a canonical form). The per-institution head lives in `AuditChain` and is advanced by compare-and-swap inside the same transaction as the entry.
- `GET /admin/audit-logs/verify` re-reads the chain and reports the first break. This is **tamper-evident, not tamper-proof**: someone with full database write access who rewrites the whole chain and the head cannot be detected from inside the database. Record the head hash somewhere outside (printout, e-mail) to close that gap.
- `npm run migrate:tenants -- --apply` back-fills older entries.

## Branding
Colour (must reach 4.5:1 contrast on white), tagline, PNG/JPEG logo up to 100 KB (type checked by magic bytes). Public `GET /branding` (cached 60 s). Applied in light mode only so dark mode contrast is never broken.

## Analytics
`GET /analytics/summary` (Admin and Principal): totals, by status/department/type/month, turnaround (average, median, p90), backlog per step, rejection rate, SLA escalations. Counts and times only. Screen: `analytics.html` (print stylesheet and CSV).

## API keys and the v1 API
- Admin creates read-only keys (`dfk_<prefix>_<secret>`, shown once, stored hashed). Scopes: `requests:read`, `analytics:read`. Revocable.
- `/api/t/<slug>/v1/...` (requests, one request with history, analytics summary). Per-key rate limit (`API_RATE_LIMIT_MAX`). Responses carry **no names, purposes, staff identities, notes or documents**.
- Contract: `server/openapi.js` -> `docs/openapi.json` (`npm run openapi`). `contract.test.js` validates real responses against it and fails if the file is stale.

## Webhooks
- Events: `request.submitted`, `request.status_changed`, `document.issued`, `ping`. Written to a delivery table in the same transaction as the change.
- Signed `X-DocFlow-Signature: t=<unix>,v1=<hmac-sha256("<t>.<body>")>`; secret shown once, stored AES-GCM encrypted under `WEBHOOK_ENCRYPTION_KEY` (required in production).
- Retries with backoff, 8 attempts, auto-disable after repeated failure.
- SSRF guard: https only in production, private/loopback/link-local/metadata ranges refused, DNS result vetted at connect time. `WEBHOOK_ALLOW_PRIVATE` is for tests and is refused in production.

## Not done / limits
- No write API, no OAuth for third parties.
- Webhook delivery is tested against a local fake receiver, not a third-party service.
- Frontend stays vanilla JS (ADR 0004).
