# Limitations and Future Enhancements

An honest list of what the MVP does not do, and what could come next.

## Limitations

### Security and accounts
- **No password change or reset.** Admin-created staff keep the initial password they were given. Students cannot change theirs. (Out of MVP scope.)
- **Logout is client-side plus cookie clearing.** Tokens are stateless, so a copied token stays valid until it expires (2 hours). Deactivating the user blocks it immediately, because every request reloads the user.
- **No account lockout or multi-factor authentication.** Login is throttled by IP rate limiting only.
- **Email enumeration on registration.** A duplicate email returns 409, which reveals that the address is registered. (Login does not leak this.)
- **HTTPS is not terminated by the app.** `Secure` cookies and HSTS apply only when `NODE_ENV=production` behind HTTPS. Behind a reverse proxy, `trust proxy` must be configured so rate limiting sees real client IPs. Neither was exercised.
- **The audit log is not absolutely immutable.** It is append-only at the application level. Anyone with direct database access can alter it.
- **Uploaded files are not virus-scanned.** They are limited to three types and checked by signature, but not scanned for malware, and are not encrypted at rest.

### Data and workflow
- **Rejected requests are final.** A student submits a new request instead of resubmitting. The Clerk cannot reject an invalid request; only the HOD decides.
- **One document per request, no replacement.** Once fulfilled, a document cannot be re-uploaded or revoked.
- **One department per user,** and the department list is fixed in code.
- **Transactions need a replica set.** Without one, an audit failure after a status change is not rolled back (the API still reports an error). See [TRANSACTIONS.md](TRANSACTIONS.md).
- **Orphan files.** A process crash between writing a file and committing the database change could leave an unreferenced file in the private upload folder. A cleanup job is not implemented.
- **Best-effort audit for login, registration and download events,** by design, so logging problems never block users.

### Product
- **No notifications** (email/SMS), **no payments**, **no analytics**, **no document generation**; all explicitly out of scope.
- **No search** and no sorting options beyond status filter and newest-first.
- **English only.**

### Multi-tenancy (S1)

- Isolation is enforced in code (resolver, token claim, query plugin) and proved by tests, but it is one shared database: raw driver access and `runUnscoped()` bypass the plugin, so reviewers must check every new use. See [TENANCY.md](TENANCY.md).
- Institution signup is gated by one owner-issued `SIGNUP_KEY` because e-mail verification does not exist yet (S3/S5). There is no CAPTCHA.
- Departments and document types are still fixed lists (S2). Staff passwords are still set by the Admin (S3). Uploaded files are still one local folder with random names, not tenant-prefixed object storage (S4).
- Existing MVP sessions end at migration; there is no suspension or billing yet (S6): a `SUSPENDED` institution simply answers 404.

## Deployment
- **Uploaded documents live on the server filesystem.** On Render the ordinary filesystem is wiped on every deploy and restart. Persistent disks are paid-only and limit the service to one instance; object storage would need a code change. See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Atlas network access for Render is unverified.** Render's outbound addresses are shared ranges that are not static; allowlisting them (or buying dedicated IPs) is a manual step.
- **Production has been prepared, not deployed.**

### Testing and delivery
- **No automated browser/UI tests.** Frontend behaviour was checked by hand; only source-level rules are tested automatically.
- **No load or performance testing.**
- **Colour contrast was designed for but not measured** with a tool.
- **The Jenkins pipeline has not run on a Jenkins server.** Its commands were run locally against a throwaway CI database. There is no deployment stage.
- **Antigravity skill discovery was not confirmed.** The skill files are installed in both agent folders.

## Future enhancements
- Password change and reset, optional multi-factor authentication
- Email and SMS notifications on status changes
- Resubmission of rejected requests; Clerk pre-check with a "needs more information" state
- Document revocation and re-issue; digitally signed documents with QR verification
- SLA timers and escalation
- Analytics and NAAC-style reporting
- Malware scanning and encryption at rest for stored files; cleanup job for orphan files
- Automated browser tests (Playwright), accessibility audit, load tests
- Multi-institution support; per-department configuration instead of a fixed list
