# Operations runbook (S8)

For whoever runs the deployed service. Nothing here has been run against a real hosted deployment: the app has not been deployed by this project. Local evidence is stated where it exists.

## 1. Where to look first
| Symptom | Check |
|---|---|
| Users cannot reach the site | Render dashboard status; `GET /healthz` (200 = process up and database connected) |
| Site loads, e-mail or reminders stop | `GET /readyz`: with `WORKER_MAX_AGE_SECONDS` set, `checks.worker=false` means the worker is not reporting. Restart the worker service; read its logs |
| A user reports an error | Ask for the `X-Request-Id` response header (or the time). Search the logs for that id: one JSON line per request, with route pattern, status, duration, institution slug and user id. No bodies, no query strings, no e-mail addresses |
| Status page for users | `/status.html` (reads `/readyz`) |

Logs are JSON lines on stdout (`LOG_LEVEL` = debug/info/warn/error/silent). Passwords, tokens, keys, connection strings and e-mail addresses are redacted by a second layer even if a developer logs them by mistake (`server/utils/logger.js`, covered by `ops.test.js`).

## 2. Deploying and rolling back
- Pipeline: push to `saas` -> CI (`.github/workflows/ci.yml`: lint, unit, full tests, build, audit, browser tests) -> on success the Deploy workflow calls the staging hook and runs `scripts/smoke.js` against `STAGING_URL`. Production is **manual** (Deploy workflow, target `production`, environment protection with a reviewer).
- Setup is the owner's (docs/DEPLOYMENT.md, section "S8 launch checklist"): create the services from `render.yaml`, enter the secrets in the Render dashboard, add the deploy hooks and URLs to GitHub. Until then the workflow only prints a notice.
- After any deploy: `node scripts/smoke.js https://<host> --tenant <slug> --require-worker` (read-only).
- Roll back: Render dashboard > service > Events > the last good deploy > **Rollback**. Then run the smoke test. The database schema is additive (new indexes and fields only); a rollback never needs a database restore unless data was damaged.

## 3. Backups and restore
Tool: `npm run backup` (`scripts/backup.js`, library `server/ops/backup.js`). No external tools. A backup is a folder of NDJSON files plus `manifest.json` (counts and SHA-256 per file). `BACKUP_ENCRYPTION_KEY` (32+ chars) encrypts the files with AES-256-GCM; **an unencrypted backup holds personal data and password hashes**, so keep it only on storage you already trust, and keep the key somewhere other than the backup.

```bash
npm run backup -- --out backups/2026-11-10      # from MONGODB_URI into a NEW empty folder
npm run backup -- --verify backups/2026-11-10   # integrity check, no database needed
npm run backup -- --drill                       # restore drill (see below)
```
Atlas also keeps its own snapshots (cluster backup feature of the paid tiers); this tool is the portable, verifiable copy and works on any plan. **Uploaded documents are not in the database.** With `STORAGE_DRIVER=s3` they live in the bucket: turn on bucket versioning and a lifecycle rule at the provider (Cloudflare R2: bucket settings). With the local driver, back up `UPLOAD_DIR` separately.

Suggested schedule: daily backup, kept 14 days, weekly copy kept 8 weeks (set it up on a machine you control or a scheduled GitHub Action that uploads an encrypted folder to private storage; this repository does not do that for you).

### Restore drill (proves the backup works)
`npm run backup -- --drill` backs up the database in `MONGODB_URI`, restores it into a temporary database named `<db>_drill_<random>` on the same server, compares document counts per collection, recomputes **every institution's audit hash chain** from the restored data, and then drops only that temporary database. It refuses a non-local `MONGODB_URI` unless you add `--allow-remote` (it creates a temporary database on that cluster). Exit code 1 if anything differs.

Evidence so far: the drill passed on the local development database (7 collections, counts equal, chains valid) and is covered by `server/tests/backup.test.js` (12 tests: exact round trip with ObjectIds/dates/indexes, refusal to restore into a non-empty database, damaged/missing file detection before any write, encrypted round trip, wrong/missing key, tampered audit entry detected in the restored copy). It has **not** been run against Atlas.

### Real restore (disaster)
1. Stop writes: set the web and worker services to suspended in Render.
2. Create a NEW empty database/cluster (never restore over the damaged one: keep it for forensics).
3. `RESTORE_MONGODB_URI=<new empty target> BACKUP_ENCRYPTION_KEY=<key> npm run backup -- --restore backups/<folder>` (it refuses a non-empty target and verifies every checksum before writing).
4. Point `MONGODB_URI` at the new database, restore the document bucket if needed, deploy, run the smoke test, check `/admin/audit-logs/verify` for the larger institutions.

## 4. Data requests
- **Export** (an institution's Admin): Institution settings > Your data > "Download all data" (`GET /admin/data-export`): JSON of users, requests, settings, audit trail (no credentials). Audited.
- **Suspend / delete an institution** (platform operator, `SUPER_ADMIN` session on `/api/platform`): `POST /tenants/<slug>/suspend`, then `DELETE /tenants/<slug>` with body `{"confirm":"<slug>"}`. Deletion removes the institution's stored files first (any failure stops before the database is touched, so it can be retried), then every row of every tenant-scoped collection, then the institution. A `TENANT_DELETED` audit entry (slug and counts, no personal data) is kept on the platform's own chain. **Irreversible: take a backup and confirm the request in writing first.** Backups taken before the deletion still contain the data until they expire.
- **One person**: the institution's Admin deactivates the account; there is no per-person erase because requests and the audit trail must remain consistent for the institution. State this in the privacy notice if that is not acceptable.

## 5. Retention (enforced by the database)
| Data | Kept |
|---|---|
| One-time tokens (reset, verify) | expire 7 days after their own expiry |
| Notifications | 365 days |
| Webhook delivery records | 90 days |
| Invitations | 90 days after expiry |
| Requests, issued documents, audit trail, users | while the institution exists (no automatic expiry; tested) |
Backups: your schedule above.

## 6. Incidents
- **Suspected credential leak**: rotate `JWT_SECRET` (signs everyone out), then the exposed key; for API keys the Admin revokes them (Integrations page); webhook secrets are rotated by deleting and recreating the webhook.
- **Suspected data tampering**: `GET /admin/audit-logs/verify` (Admin) per institution; compare the head hash with the copy you recorded off-system. A break shows the first affected sequence number.
- **Worker stuck**: delivery claims expire after 5 minutes, so restarting is safe; duplicate sends are prevented by idempotency keys.
- **Database failover**: the app reconnects by itself (driver); `/readyz` reports 503 meanwhile.

## 7. What this runbook cannot promise
No uptime figure, no on-call rotation and no real alerting exist: alerts need a monitor you configure (for example an uptime check on `/readyz` that notifies the owner). Render, Atlas, R2, ClamAV and the e-mail provider have not been used by this project's tests.
