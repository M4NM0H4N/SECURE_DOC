# Deployment: MongoDB Atlas + Render

**Status: prepared, NOT deployed.** Nothing in this repository has been deployed to Render, and no production seed script has been run. This guide lists exactly what to configure and what was and was not verified.

## 1. Three separate databases

| Environment | Database | Configured by | Notes |
|---|---|---|---|
| Local development | Docker MongoDB replica set `rs0`, database `secure_doc_workflow` | `MONGODB_URI` in your local `.env` | Port published on `127.0.0.1` only (no authentication, so it must never be exposed) |
| Automated tests | Same Docker replica set, database `secure_doc_workflow_test` | `MONGODB_URI_TEST` | Tests create and **drop** this database, so they refuse to run unless the URI points to a local MongoDB (`server/tests/helpers.js`). Tests can never reach Atlas. |
| Production | MongoDB Atlas | `MONGODB_URI` set in the **Render dashboard** | `server/config/env.js` refuses to start in production if the URI is missing, contains whitespace, or points to a local MongoDB |

`MONGODB_ATLAS_URI` exists only in your local `.env` so `npm run check:atlas` can test the cluster from your computer. The application itself never reads it.

## 2. What was verified (and what was not)

Verified on 2026-11-09 from the development computer, with the Atlas connection string never printed:

- Atlas accepts the login, the deployment is a **replica set with a writable primary**, and a **multi-document transaction starts and commits** (read-only, nothing written). Transactions therefore work with Atlas, and `server/config/transactions.js` will detect `replica` mode.
- This check passed only after three stray whitespace characters were removed from the connection string **in memory**. As stored in `.env` the string contains spaces around the username/password, which causes `bad auth`. Fix the `.env` line (delete the spaces) and `npm run check:atlas` should pass; it now reports this problem explicitly.
- The production start-up guards, `/healthz`, reverse-proxy rate-limit handling and upload-folder preparation are covered by `server/tests/deployment.test.js`.

**Not verified:** a real Render deployment; that Atlas accepts Render's outbound addresses; that a Render persistent disk works with the upload folder; HTTPS/`Secure` cookie behaviour on the public URL.

## 3. Render service settings

| Setting | Value |
|---|---|
| Service type | **Web Service** (Node) |
| Root directory | repository root (leave blank). The Express server also serves the `client/` pages. |
| Build command | `npm ci` |
| Start command | `npm start` (runs `node server/server.js`) |
| Health check path | `/healthz` (HTTP 200 when the database is connected, 503 otherwise; public, no data) |
| Node version | 20 or newer (`engines` in `package.json`); set the `NODE_VERSION` environment variable if Render defaults to something older |
| Instance type | Free instances have no persistent disk (see section 5). Use a paid instance if documents must survive restarts. |

Render injects `PORT` (10000 by default). The app listens on it and binds `0.0.0.0` when `NODE_ENV=production`. Render's health check passes on any 2xx/3xx response within five seconds.

## 4. Environment variables (set in the Render dashboard; never commit values)

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `MONGODB_URI` | yes | your Atlas connection string (`mongodb+srv://...`, no spaces, password %-encoded) |
| `PUBLIC_URL` | yes | the https origin of the service (for example `https://docflow.onrender.com`). The app refuses to start without it: it is the base of every invitation and reset link |
| `MFA_ENCRYPTION_KEY` | optional | 32+ characters; enables two-step sign-in. Never reuse `JWT_SECRET`. Losing it makes enrolled authenticator secrets unreadable |
| `JWT_SECRET` | yes | a new production-only secret, at least 32 characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `MAIL_PROVIDER` (+ `MAIL_FROM`, `RESEND_API_KEY`) | `resend` to send e-mail | default in production is `none` (nothing is sent; people still see in-app notifications). `outbox` is refused in production. Verify the sender domain with your provider first |
| `WORKER_INLINE` | `true`, or a second process | the notification worker (e-mail delivery and SLA reminders) must run somewhere: either set `WORKER_INLINE=true` on the web service, or add a Render **Background Worker** running `npm run worker` with the same environment. Without it nothing is delivered and no SLA fires |
| `STORAGE_DRIVER` | recommended `s3` | with `s3`, documents live in a private bucket (Cloudflare R2) instead of the server disk, so no persistent disk is needed and several instances can run. Also set `S3_ENDPOINT` (https), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (a token limited to that one bucket). See [TRUST.md](TRUST.md) |
| `CLAMD_HOST` (+ `CLAMD_PORT`) | yes, or `SCAN_MODE=off` | a ClamAV daemon on a separate private host. In production the app **refuses to start** without it unless you set `SCAN_MODE=off` on purpose |
| `VERIFY_SIGNING_KEY` | optional | 32+ characters; enables document verification QR codes |
| `DOCUMENT_RETENTION_DAYS` | optional | default 30 |
| `UPLOAD_DIR` | only with `STORAGE_DRIVER=local` (default) | an absolute path inside the mounted disk, for example `/var/data/uploads` |
| `PORT` | provided by Render | do not set |
| `TRUST_PROXY` | optional | defaults to `1` in production, which matches Render's single proxy hop. Whole numbers only. |
| `JWT_EXPIRES_IN`, `COOKIE_NAME`, `MAX_UPLOAD_MB`, `HOST` | optional | defaults are fine |

New in S3: staff join by invitation (the link is shown once to the Admin), and e-mail is not delivered yet, so for now hand out invitation and reset links yourself. `REQUIRE_EMAIL_VERIFICATION` stays off until mail works. See [ACCOUNTS.md](ACCOUNTS.md).

Do **not** set in production: `MONGODB_URI_TEST`, `MONGODB_ATLAS_URI`, `DEMO_PASSWORD`. Set `SUPER_ADMIN_*` only for the moment you run the seed (section 7), then delete them. Set `SIGNUP_KEY` only while institutions are being created.

Production cookies are `HttpOnly`, `SameSite=Strict` and `Secure`; HSTS and the CSP `upgrade-insecure-requests` directive are enabled only when `NODE_ENV=production`. There is no CORS middleware on purpose: the pages and the API share one origin.

> **S4:** with `STORAGE_DRIVER=s3` the persistent-disk discussion below no longer applies: documents are in R2, and `UPLOAD_DIR` is unused. The rest of this section describes the local driver.

## 5. File storage (important limitation)

Uploaded documents are written to `UPLOAD_DIR` on the server's filesystem. According to Render's documentation:

- The ordinary filesystem is **ephemeral**: everything outside a persistent disk's mount path is lost on every redeploy and restart.
- Persistent disks are available on **paid** service types only, are limited to **one instance** (no horizontal scaling), and disable zero-downtime deploys.

What this means for the project:

| Option | Effect |
|---|---|
| Free instance, no disk | The app works, but every issued document disappears on restart/redeploy. Requests would still show FULFILLED while downloads return "Document file is missing". Acceptable for a short demo only. The app logs a warning at start-up when `UPLOAD_DIR` is not set in production. |
| **Paid instance + persistent disk (recommended)** | Create a disk, mount it at an absolute path such as `/var/data`, and set `UPLOAD_DIR=/var/data/uploads`. Documents then survive restarts and deploys. The app checks at start-up that the folder exists and is writable and fails fast if not. |
| Object storage (S3-compatible) | The proper long-term answer and the only one that scales past one instance, but it needs a code change to `documentService` and is outside this task. |

Database backups (Atlas) do **not** include these files; back up the disk separately if the documents matter.

## 6. MongoDB Atlas settings

1. **Database user:** a dedicated user with `readWrite` on the application database only (least privilege), not an Atlas admin account.
2. **Connection string:** copy it from Atlas (Connect > Drivers), put the database name in the path, and keep `retryWrites=true&w=majority`. A password with special characters must be percent-encoded. No spaces anywhere.
3. **Network Access:** Render's outbound addresses are **ranges that are shared by all services in a region and are not static**, so a single IP cannot be allowlisted. Choose one:
   - add Render's outbound ranges for your service's region (Render dashboard > the service > **Connect** > **Outbound** tab) to Atlas Network Access; or
   - buy Render's dedicated outbound IP addresses and allowlist those; or
   - as a last resort for a short-lived student demo, allow `0.0.0.0/0` (anywhere). This makes the database reachable by anyone who has the credentials. Never do it silently, and remove it afterwards.
   Your own computer's IP is a separate entry and is only needed for `npm run check:atlas`.
4. Never point Render at the local Docker database, and never use `localhost` in the production URI (the app refuses to start).

## 7. First admin account (needs explicit owner approval)

The production database starts empty. There is no single global Admin any more: each institution is created through signup (`POST /api/platform/signup`, page `/signup.html`), which creates the institution and its first Admin. Signup is closed unless you set `SIGNUP_KEY` (16+ characters) in the Render dashboard; set it only while you are creating institutions and share it only with people you invite.

If you want a platform owner (SUPER_ADMIN, lists institutions only), run once from the Render **Shell** tab with `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` (12+ characters) temporarily set:

```bash
npm run seed:superadmin
```

Then remove those two variables. If production already holds single-tenant MVP data, run `npm run migrate:tenants` (dry run) and then `-- --apply` once, on a copy first. The same command also gives every institution its default departments, document types and approval chain and pins existing requests to it (S2, see [WORKFLOW.md](WORKFLOW.md)). Institutions created through signup get these automatically. See [TENANCY.md](TENANCY.md). Never run `npm run seed:demo` in production (it refuses when `NODE_ENV=production`).

## 8. Deployment checklist

Before deploying:

- [ ] Fix the spaces in `MONGODB_ATLAS_URI` in your local `.env`, then run `npm run check:atlas` and confirm exit code 0
- [ ] Create a least-privilege Atlas database user for the application
- [ ] Decide the file-storage option (section 5) and choose the Render instance type accordingly
- [ ] Decide the Atlas Network Access approach for Render (section 6)
- [ ] Generate a new production `JWT_SECRET` (do not reuse the development one)
- [ ] Push the repository to GitHub (done separately) and connect it to Render

Render configuration:

- [ ] Web Service, build `npm ci`, start `npm start`, health check `/healthz`
- [ ] Environment variables from section 4
- [ ] Document storage chosen: either `STORAGE_DRIVER=s3` with the R2 bucket settings (preferred), or a persistent disk at `/var/data` with `UPLOAD_DIR=/var/data/uploads`
- [ ] Notification worker running (`WORKER_INLINE=true` or a Background Worker with `npm run worker`)
- [ ] Mail provider configured, one real test message received (`MAIL_PROVIDER=resend`), or e-mail knowingly left off
- [ ] ClamAV daemon reachable (`CLAMD_HOST`), or `SCAN_MODE=off` chosen knowingly
- [ ] First real upload, download, replace and verification link tried against the real bucket (the R2 adapter has only been tested against a fake)
- [ ] `npm run storage:cleanup` scheduled (dry run first)

After the first deploy:

- [ ] Logs show `MongoDB transaction mode: replica` and no upload-storage warning
- [ ] `https://<your-service>.onrender.com/healthz` returns `{"status":"ok"}`
- [ ] Create the first institution through signup (section 7) and remove `SIGNUP_KEY` afterwards if no more are expected
- [ ] Register a test student over HTTPS; the `sdw_token` cookie is `HttpOnly`, `Secure`, `SameSite=Strict`
- [ ] Run the demonstration flow (`docs/DEMO.md`), upload a document, **restart the service**, and confirm the document still downloads (proves the disk)
- [ ] Remove any temporary Atlas `0.0.0.0/0` entry

## 9. Local development and CI (loopback-only database)

```bash
docker compose up -d     # MongoDB replica set on 127.0.0.1:27017, data in ./mongo-data
```

The published port is `127.0.0.1:27017` (CI: `127.0.0.1:27018`). The database has no authentication, so never change this to `27017:27017`. Never run `docker compose down -v` in this project; `./mongo-data` holds your development data.
