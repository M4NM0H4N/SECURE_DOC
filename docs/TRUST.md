# Document storage and trust (SaaS phase S4)

Status: implemented on the `saas` branch. What is described is what the code does and what the tests check ([TESTING.md](TESTING.md)). Decisions: [ADR 0002](adr/0002-storage.md).

## Storage interface

All file access goes through one interface (`server/storage/`): `put`, `get` (a stream), `exists`, `delete`, `list`, `check`. `STORAGE_DRIVER` chooses the adapter:

| Driver | Use | Notes |
|---|---|---|
| `local` (default) | development, tests, a single server with a persistent disk | files under `UPLOAD_DIR`, written once (`wx`), mode 0600, never served statically |
| `s3` | production on Render, anything without a persistent disk | any S3-compatible **private** bucket; Cloudflare R2 is the recommended target |

- **Keys** are always `<tenantId>/<requestId>/<random-uuid>.<pdf|png|jpg>`: tenant-prefixed, unguessable, containing no user input. Every adapter checks a key against this exact pattern before touching the disk or the network, so a tampered database value (`../../.env`, an absolute path, another institution's prefix) is refused. The download service additionally requires the key to start with the request's own `<tenantId>/<requestId>/`.
- **Downloads** are streamed through the API after the usual authorisation (student: own, clerk/HOD: own department, Admin/Principal: none). There are no public URLs and no presigned links, so there is nothing to leak or to expire.
- **Start-up check:** the server tests the store before it listens (for S3: credentials and bucket via a one-item listing). A bad setting stops the start, not the first upload.
- **S3 requests are signed with AWS Signature V4**, implemented in `server/storage/sigv4.js` on Node's crypto (no AWS SDK, no dependency). It is verified against the three examples published in the AWS documentation (GET with a header, PUT with a special character in the key, a listing with query parameters): all three signatures match exactly. R2 uses path-style URLs and region `auto`, which this adapter does by default.
- Provider error bodies are never copied into messages or logs.

Configuration (all in `.env.example`): `STORAGE_DRIVER`, `S3_ENDPOINT` (an https origin such as `https://<account>.r2.cloudflarestorage.com`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` (default `auto`). The app refuses to start with an incomplete or malformed S3 setting, and in production with a non-https endpoint. Use an API token limited to this one bucket with read/write/delete rights (least privilege), and keep the bucket private.

## Malware scanning (ClamAV)

Every upload (first document, extra document, replacement) is checked after the file-type check and **before** anything is stored: `server/services/scanner.js` speaks the clamd `INSTREAM` protocol over TCP to a ClamAV daemon.

| `SCAN_MODE` | Behaviour |
|---|---|
| `off` | no scanning (the development and test default) |
| `optional` | scan; if the daemon cannot be reached the upload is allowed |
| `required` | scan; if the daemon cannot be reached, times out or answers nonsense the upload is **refused (503)**. The **production default** |

An infected file is rejected with 422, never stored and never recorded; the attempt is audited as `DOCUMENT_REJECTED_INFECTED` (signature name only). Refused uploads (bad file, wrong status, wrong role, wrong institution) never reach the scanner. `SCAN_MODE` other than `off` needs `CLAMD_HOST` (`CLAMD_PORT` default 3310, `CLAMD_TIMEOUT_MS` default 15000). **In production the app will not start without `CLAMD_HOST` unless you set `SCAN_MODE=off` explicitly**, so running unscanned is always a deliberate choice.

Render cannot run ClamAV inside the web service. Run `clamd` on a separate private service or small VM and point `CLAMD_HOST` at it; that host is not part of this repository and was not tested here (see "What was and was not verified").

## Several documents, replacement and revocation

A request can hold several documents (a `Document` record per stored file, at most ten active). The first upload fulfils the request exactly as before; the status change, the Document record and the audit entries commit together, and the file is deleted if that fails.

| Action | Route (Clerk of the request's department) | Result |
|---|---|---|
| Fulfil | `POST /requests/:id/document` | `APPROVED` to `FULFILLED`, first document (race-safe: one winner) |
| Add another | `POST /requests/:id/documents` | on a `FULFILLED` request, `201` |
| Replace | `POST /requests/:id/documents/:docId/replace` | new version, old becomes `REPLACED` (conditional update: two clerks cannot both replace) |
| Revoke | `DELETE /requests/:id/documents/:docId` with `{ reason }` | `REVOKED`, reason kept for staff, not shown to the student, not in the audit entry |
| List | `GET /requests/:id/documents` | students see active documents; staff also see the history |
| Download | `GET /requests/:id/documents/:docId/file`, `GET /requests/:id/document` (newest active) | active documents only |

Replaced and revoked records are never deleted, so the history stays; their files are kept for the retention period and then removed by the cleanup job. Revoking the last active document leaves the request `FULFILLED` with nothing to download (documented, deliberate: a wrongly issued document can be withdrawn).

## Cleanup job

`npm run storage:cleanup` (dry run) and `npm run storage:cleanup -- --apply [--grace-hours=24] [--retention-days=30]`. It deletes only: **orphans** (stored files no record points to, older than the grace period so an upload still being saved is never touched, and never a file a legacy `request.documentPath` still references) and **expired versions** (files of replaced/revoked documents past `DOCUMENT_RETENTION_DAYS`, default 30; the record stays and is marked purged). Active documents are never deleted; active documents whose file is missing are reported, not "fixed". It prints counts only. It is a script, not a scheduler: run it from cron, a Render cron job or by hand (scheduled infrastructure is S5/S8).

## Public verification and the QR code

Each active document has a verification link, shown with a QR code to staff and the student on the request page. The code is `<documentId>-<signature>` where the signature is HMAC-SHA-256 (key `VERIFY_SIGNING_KEY`, 32+ characters, separate from `JWT_SECRET`) over the institution, request, document and the SHA-256 of the exact file bytes. Because the hash is signed, changing a stored hash in the database makes the code stop verifying (tested).

- `GET /api/t/<slug>/verify/:code` is public (rate limited, 60 per 15 minutes per address) and returns only: institution name, document type, issue date, version and status (`VALID`, `SUPERSEDED` after a replacement, `REVOKED`). No file, no name, no department, no hash.
- `POST /api/t/<slug>/verify/:code/check` takes `{ sha256 }` and answers whether it matches. The verify page (`/t/<slug>/verify.html?code=...`) lets someone choose the file they hold; **the browser hashes it locally and sends only the hash**, so the file never leaves their device and the stored hash is never revealed.
- Forged, truncated, wrong-document, other-institution and unknown codes all give the same `404`. A code only works under its own institution's address.
- Without `VERIFY_SIGNING_KEY` no codes are issued and verification answers 503.

**QR encoder.** The QR is drawn in the browser with the open-source `qrcode-generator` 1.4.4 (MIT, copied unchanged to `client/js/vendor/qrcode.js`, not an npm dependency), so no QR service is called and nothing leaves the page. Hand-writing a QR encoder correctly is easy to get wrong, so it was checked: verification-style URLs were encoded at two error-correction levels and decoded back with an independent decoder (jsQR), all exact.

## Migration

`npm run migrate:tenants -- --apply` also turns every request that still has a pre-S4 `documentPath` (one flat file in `UPLOAD_DIR`) into a `Document` (version 1, active, uploader and date taken from the request history) and copies the file to its tenant-prefixed key in the configured store, so it can move from local disk to R2. The old flat file is left for the cleanup job. Names that do not look like our UUID names are never followed; missing files are counted, not fatal; running it again changes nothing.

## What was and was not verified

Verified by automated tests (both adapters): everything above except the items below. The S3 adapter was tested against an in-process fake S3 that recomputes and checks every signature, the clock, the credentials and the payload hash; the scanner client against a fake `clamd` that implements the protocol (including a 200 KB multi-chunk file, hangs and garbage replies), using the standard EICAR test string built at run time.

**Not verified:** a real Cloudflare R2 or AWS bucket (no account or credentials were available: the signer matches AWS's published examples, but R2 itself is untested); a real ClamAV daemon; behaviour at scale. Please run the first real upload against R2 and a real `clamd` before relying on them.

## Limitations

- Documents are not encrypted by the application (R2 and S3 encrypt at rest on their side); there is no per-file key.
- Revoking cannot recall a copy someone already downloaded; verification shows `REVOKED` when it is checked.
- The cleanup job is not scheduled automatically.
- Scanning loads the whole file (at most 5 MB) into memory; there is no queue or retry for a busy scanner.
- A stored-file quota per institution arrives with plans (S6).
