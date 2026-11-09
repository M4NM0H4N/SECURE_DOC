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
| `JWT_SECRET` | yes | a new production-only secret, at least 32 characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `UPLOAD_DIR` | yes for persistent documents | an absolute path inside the mounted disk, for example `/var/data/uploads` |
| `PORT` | provided by Render | do not set |
| `TRUST_PROXY` | optional | defaults to `1` in production, which matches Render's single proxy hop. Whole numbers only. |
| `JWT_EXPIRES_IN`, `COOKIE_NAME`, `MAX_UPLOAD_MB`, `HOST` | optional | defaults are fine |

Do **not** set in production: `MONGODB_URI_TEST`, `MONGODB_ATLAS_URI`, `DEMO_PASSWORD`. Set `INITIAL_ADMIN_*` only for the moment you run the seed (section 7), then delete them.

Production cookies are `HttpOnly`, `SameSite=Strict` and `Secure`; HSTS and the CSP `upgrade-insecure-requests` directive are enabled only when `NODE_ENV=production`. There is no CORS middleware on purpose: the pages and the API share one origin.

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

The production database starts empty. After the first successful deploy, create the first Admin once, from the Render **Shell** tab, with `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` temporarily set in the dashboard:

```bash
npm run seed
```

Then remove those two variables. Never run `npm run seed:demo` in production (it refuses when `NODE_ENV=production`).

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
- [ ] Persistent disk mounted at `/var/data` (if chosen) with `UPLOAD_DIR=/var/data/uploads`

After the first deploy:

- [ ] Logs show `MongoDB transaction mode: replica` and no upload-storage warning
- [ ] `https://<your-service>.onrender.com/healthz` returns `{"status":"ok"}`
- [ ] Run the seed once (section 7), then remove the seed variables
- [ ] Register a test student over HTTPS; the `sdw_token` cookie is `HttpOnly`, `Secure`, `SameSite=Strict`
- [ ] Run the demonstration flow (`docs/DEMO.md`), upload a document, **restart the service**, and confirm the document still downloads (proves the disk)
- [ ] Remove any temporary Atlas `0.0.0.0/0` entry

## 9. Local development and CI (loopback-only database)

```bash
docker compose up -d     # MongoDB replica set on 127.0.0.1:27017, data in ./mongo-data
```

The published port is `127.0.0.1:27017` (CI: `127.0.0.1:27018`). The database has no authentication, so never change this to `27017:27017`. Never run `docker compose down -v` in this project; `./mongo-data` holds your development data.
