# Demo deployment: Render (free web service) + MongoDB Atlas

A minimal, honest deployment for a student demo. It needs only two accounts (Render, Atlas), no Cloudflare R2, no ClamAV, no e-mail provider. Choices made: Atlas is opened to **Render's outbound ranges** (not `0.0.0.0/0`), and uploaded documents use **local disk**.

**Status: Atlas verified (`npm run check:atlas` passes: replica set, writable primary, transaction OK). Render deployment not yet done.** Never commit secrets; type them into the Render dashboard.

## What the demo mode means
| Topic | Demo behaviour |
|---|---|
| Database | Atlas (persistent). All users, requests and the audit trail survive restarts |
| Uploaded documents | Local disk on Render's free plan: **lost on restart/redeploy** (Render free has no persistent disk). After a restart, previously issued documents cannot be downloaded; upload a new one to demo |
| Virus scan | `SCAN_MODE=off` (chosen knowingly; production needs ClamAV) |
| E-mail | `MAIL_PROVIDER=none`: nothing is e-mailed. The Admin sees invitation and reset links on screen and passes them on |
| Sleep | Free web services sleep after inactivity; the first request after a break takes up to about a minute |
| Worker | Runs inside the web process (`WORKER_INLINE=true`) |

## Step 1: Atlas (one-off)
1. **Database user:** Database Access > Add New Database User > password authentication. Under *Database User Privileges* do **not** use "Read and write to any database" (too broad): choose *Specific Privileges* and add the role `readWrite` on the database `docflow_demo` only. Use a password with letters and digits only (avoids %-encoding).
2. **Connection string:** Connect > Drivers > copy the `mongodb+srv://...` string, put the database name before the `?`: `...mongodb.net/docflow_demo?retryWrites=true&w=majority`. **No spaces anywhere.**
3. Keep your own IP allowed (needed only for `npm run check:atlas`).

## Step 2: Generate the secrets (on your computer; do not paste them into chat)
In cmd, run each line once and keep the outputs in a private note:
```bat
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
You need five different values: `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `VERIFY_SIGNING_KEY`, `WEBHOOK_ENCRYPTION_KEY`, and `SIGNUP_KEY` (any 16+ characters; this is the password for creating the first institution).

## Step 3: Render web service
1. render.com > sign up (use GitHub) > **New > Web Service** > connect repository `M4NM0H4N/SECURE_DOC`.
2. Settings:
   - Name: choose one, e.g. `docflow-demo` (the URL becomes `https://docflow-demo.onrender.com`; if the name is taken Render adds a suffix: use the URL Render actually shows)
   - Branch: **`saas`**
   - Runtime: Node. Build command: `npm ci --omit=dev`. Start command: `npm start`
   - Instance type: **Free**
   - Advanced > Health Check Path: `/healthz`
3. Environment variables (Add each; mark secrets as secret):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `MONGODB_URI` | your Atlas string from Step 1 (paste it in the dashboard only) |
| `JWT_SECRET` | generated value |
| `MFA_ENCRYPTION_KEY` | generated value |
| `VERIFY_SIGNING_KEY` | generated value |
| `WEBHOOK_ENCRYPTION_KEY` | generated value |
| `SIGNUP_KEY` | your chosen 16+ character key |
| `PUBLIC_URL` | `https://<your-render-url>` (origin only: no trailing slash or path). Set it after the service exists, then redeploy |
| `TRUST_PROXY` | `1` |
| `STORAGE_DRIVER` | `local` |
| `UPLOAD_DIR` | `/tmp/sdw-uploads` |
| `SCAN_MODE` | `off` |
| `MAIL_PROVIDER` | `none` |
| `WORKER_INLINE` | `true` |
| `LOG_LEVEL` | `info` |

4. **Create Web Service.** The first deploy fails if `PUBLIC_URL` is missing (the app refuses to start without it). That is expected: after the service is created, copy its real URL, add `PUBLIC_URL`, and use **Manual Deploy > Deploy latest commit**.

## Step 4: Let Atlas accept Render (the safe way)
1. Render dashboard > your service > **Connect** > **Outbound** tab: copy the listed IP ranges for the service's region.
2. Atlas > Security > **Network Access** > Add IP Address: add **each** range. **Do not** add `0.0.0.0/0`.
3. Wait until each shows **Active**, then redeploy once (Manual Deploy). Watch the **Logs**: you want `database ready`, `server listening`.

## Step 5: First institution and accounts
1. Open `https://<your-render-url>/signup.html`. Enter the institution name, a short address (slug, for example `demo`), the first Admin's details, and the `SIGNUP_KEY`. This creates the institution and its Admin.
2. Sign in at `https://<your-render-url>/t/<slug>/login.html` as that Admin.
3. **Users page:** create invitations for a Clerk and an HOD (department CSE). Because e-mail is off, the page shows each link: open it in a private window to set that person's password.
4. A student registers at `/t/<slug>/register.html` (public).
5. Run the demo flow from [DEMO.md](DEMO.md).

The one-off demo-data seeding script (`npm run seed:demo`) **refuses to run in production**, and no production seed is run without the owner's explicit approval. Create the few accounts by hand as above.

## Step 6: Smoke test (read-only)
```bat
node scripts\smoke.js https://<your-render-url> --tenant <slug>
```
All lines should say `PASS`.

## Step 7: After the demo
- Remove the Atlas Network Access entries for Render if you stop using the deployment.
- Suspend or delete the Render service (Settings > Suspend). Delete the database user if the cluster is shared.
- Never use `0.0.0.0/0` for this demo.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Deploy fails: `PUBLIC_URL (https://...) is required` | Add `PUBLIC_URL` (Step 3.4) and redeploy |
| `MONGODB_URI contains whitespace` | Remove spaces in the dashboard value; %-encode special characters |
| `Could not connect to any servers` in logs | Atlas does not yet allow Render's ranges (Step 4); wait until Active |
| `bad auth` | Wrong database user or password; recreate the user with a letters-and-digits password |
| Site very slow at first | Free instance was asleep; wait about a minute |
| Documents missing after a restart | Expected with local disk on the free plan (see table above) |
