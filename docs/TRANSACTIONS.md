# Transactions and Atomicity

This document states which operations are atomic in this project and which are not. It reflects what the code and the tests actually do, not an assumption.

## How the mode is chosen

`server/config/transactions.js` asks MongoDB (`hello`) whether it is a replica set member and logs the result at startup:

- `MongoDB transaction mode: replica` - multi-document transactions are used.
- `MongoDB transaction mode: standalone` - no transactions; the limits below apply.

Local development uses the single-node replica set from `docker-compose.yml`, so the mode is `replica`. The test suite asserts this (`transactions.test.js`).

## Atomic with a replica set (the tested configuration)

Each of these runs in one transaction; if any step fails, everything is rolled back:

| Operation | Writes that commit together |
|---|---|
| Submit request | request + `REQUEST_SUBMITTED` audit |
| Review / approve / reject | status update + history entry + audit |
| Upload and fulfil | status -> FULFILLED + `documentPath` + `DOCUMENT_UPLOADED` + `REQUEST_FULFILLED` audit |
| Admin creates staff | user + `USER_CREATED_BY_ADMIN` audit |
| Admin (de)activates user | user change + `USER_ACTIVATED` / `USER_DEACTIVATED` audit |

Tests that prove rollback: `transactions.test.js` (audit failure leaves request, user and status unchanged).

## Always atomic, in any mode

Every status change is a single `findOneAndUpdate` whose filter contains the request id, the actor's department **and the required current status**. The check and the write are one operation, so two people acting at the same moment cannot both succeed. Tested with three concurrency races in `workflow.test.js`, and again with transactions switched off in `transactions.test.js`.

## Not transactional in any mode

- **File storage is outside the database.** A file write cannot join a MongoDB transaction. Order of operations: validate -> write file under a random UUID name -> run the DB transaction -> on any failure delete the file. A request is never marked FULFILLED unless the file was stored and the DB commit succeeded. If the process crashes between writing the file and the DB commit, an orphan file may remain in `server/uploads/` (harmless: private and unreferenced; a cleanup job is a future enhancement).
- **Best-effort audit events:** `USER_REGISTERED`, `USER_LOGIN` and `DOCUMENT_DOWNLOADED` are written outside any transaction. If that write fails it is logged on the server and the user's action still succeeds. This is a deliberate choice so a logging problem never blocks sign-in or a download.

## Standalone MongoDB (no replica set): known limitation

If the app is run against a standalone `mongod`:

- Status changes are still race-safe (see above).
- State change and audit record are separate writes. If the audit write fails after the state change, the state change is **not** rolled back. The API still returns an error (500), so the failure is never presented as success, but the request may have moved without an audit record.
- This exact behaviour is documented by a test: `KNOWN LIMITATION: without transactions an audit failure is NOT rolled back`.

Recommendation: always run with a replica set (Docker compose file, or MongoDB Atlas, which is a replica set by default).

## MongoDB Atlas (production)

Atlas clusters are replica sets, so the application detects `replica` mode and uses transactions exactly as it does locally. This was checked on 2026-11-09 against the project's Atlas cluster with a read-only probe (`npm run check:atlas` logic: `hello` reports a replica set and a writable primary, and a multi-document transaction started and committed; nothing was written). The probe only passed after stray whitespace was removed from the connection string in memory; see [DEPLOYMENT.md](DEPLOYMENT.md). The deployed application itself has not been run against Atlas yet, so the write transactions (status change + audit record) are verified only on the local replica set.

## Audit log guarantees

Audit records are **application-level append-only**: there is no API to update or delete them and the Mongoose model refuses update/delete operations. They are **not absolutely immutable**: anyone with direct database access can still change them.
