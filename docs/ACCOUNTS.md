# Account lifecycle and session security (SaaS phase S3)

Status: implemented on the `saas` branch. Behaviour below is what the code does and the tests check; see [TESTING.md](TESTING.md).

## Staff onboarding: invitations, not passwords

An Admin never chooses or sees anyone's password. `POST /api/admin/invites` creates an invitation (e-mail, role Clerk/HOD/Principal, department unless Principal). The old route that created staff with an admin-set password is gone.

- The token is 256 random bits. Only its SHA-256 hash is stored; the link is returned **once**, to the Admin, in the response and shown once on screen (to pass on securely until e-mail delivery exists, S5). It is never listed again and never written to the audit log.
- Valid for 7 days, single use, revocable. Resending creates a new token and the old link stops working; a new invitation for the same address replaces any earlier open one.
- The invitee opens `/t/<slug>/accept-invite.html`, sees which institution and role they are joining, and chooses their own name and password. Accepting creates the account, marks the e-mail verified (the invitation reached it) and consumes the invitation in one transaction, so a failure (for example the department was deactivated meanwhile) leaves the invitation usable.
- Unknown, malformed, used, revoked, expired and wrong-institution links all give the same answer.

## Password change, forgot and reset

- **Change** (`POST /auth/change-password`): needs the current password, refuses re-using it, signs out every other device and keeps this one.
- **Forgot** (`POST /auth/forgot-password`): always answers the same message and status, whether or not the address has an account (or the account is deactivated). Only real active accounts get a link. A new request invalidates the previous link.
- **Reset** (`POST /auth/reset-password`): link valid 1 hour, single use (the use is an atomic update, so two simultaneous attempts cannot both win), hashed at rest. A reset sets the password, **ends every session** and clears any lockout.
- An Admin can issue a reset link for a user (`POST /admin/users/:id/reset-link`, shown once) for people who cannot receive e-mail yet. This is audited.

## E-mail verification

Registration creates a verification link (valid 48 hours, single use, hashed). Students can ask for a new one. When `REQUIRE_EMAIL_VERIFICATION=true`, an unverified student cannot submit requests (403). **It is off by default**, because there is no mail delivery until S5 and a hard gate would lock every student out; until then an Admin can mark a student verified. Turn it on when e-mail works.

## Lockout

Five consecutive failed password or MFA attempts lock the account for 15 minutes. The counter resets on a successful sign-in, a reset or an Admin unlock. Wrong password, unknown account and locked account return the identical response (even a correct password is refused while locked), so an attacker learns nothing about which addresses exist or are locked. Lockout is per account within one institution, on top of the existing per-IP rate limits. Admins see a "Locked" badge and can unlock.

## Sessions and server-side revocation

Every user has a `tokenVersion`; session tokens carry it. A token whose version differs is refused, so these end sessions immediately and for good:

| Event | Effect |
|---|---|
| Logout | the user's tokens are all invalid (signs out every device) |
| Password change | other devices end, this one gets a fresh token |
| Password reset | all sessions end |
| Deactivation | all sessions end; **reactivating does not bring an old session back** |
| MFA turned off | all sessions end |
| Admin "Sign out everywhere" | all sessions end (audited) |

A deactivated user still gets the explanatory 403 on their old token (checked before the version).

## Two-step sign-in (TOTP)

Optional for Clerk, HOD, Principal and Admin (not students). Needs `MFA_ENCRYPTION_KEY` (32+ characters); without it MFA is unavailable (503) and already-enrolled accounts fail closed (the code can never validate).

- **Enrol** on the Account page: the server creates a 160-bit secret, stores it encrypted (AES-256-GCM, key derived from `MFA_ENCRYPTION_KEY`, random IV), and shows it once; the user adds it to an authenticator app and proves it with a code. Then ten single-use **backup codes** are shown once (stored hashed).
- **Sign in**: password first; if MFA is on the server answers `mfaRequired` with a 5-minute **challenge token** and sets no cookie. `POST /auth/login/mfa` with the challenge and a code completes it. The challenge is not a session (a planted challenge cookie is rejected), is bound to the institution and to the account's session version, and wrong codes count towards the lockout.
- **Codes**: standard RFC 6238 (SHA-1, 30 s, 6 digits), one step of clock drift. A code is accepted **once**: the time step must be newer than the last accepted one, so a snooped code cannot be replayed. Backup codes work once each (atomic update), with or without the dash.
- **Disable** needs the password and a current or backup code, and ends all sessions.
- TOTP is implemented in `server/utils/totp.js` with Node's crypto, and checked against the RFC's published test vectors. A library (`otplib`) was tried first and removed: its dependency chain is ESM-only, which the CommonJS test setup cannot load, and the algorithm is about forty lines.

## Mail delivery

**Update (S5):** mail is now real: `MAIL_PROVIDER=resend` sends through Resend, and security mail is sent immediately with one retry and recorded without its link; see [NOTIFICATIONS.md](NOTIFICATIONS.md). The text below describes S3 and still applies where no provider is configured.

### As it was in S3

`server/services/mailer.js` is an interface: in development and tests messages go to an in-memory outbox (tests read it); in production nothing is sent and the message (which contains a secret link) is never logged. Nothing relies on delivery succeeding. `PUBLIC_URL` (an https origin, required in production) is the base of every link; it is never taken from the request's Host header, which a visitor could forge.

## Configuration

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | origin for links, required in production, must be https |
| `MFA_ENCRYPTION_KEY` | 32+ characters; enables MFA; never reuse `JWT_SECRET` |
| `REQUIRE_EMAIL_VERIFICATION` | `true` to gate student requests on verification (off by default) |

## Limitations (honest list)

- No e-mail is actually delivered yet, so forgot-password and verification links reach nobody in production until S5; the Admin-issued links are the workaround.
- Logout ends every session of the user (a deliberate simplification: there is no per-device session list).
- There are no CAPTCHA or breached-password checks. Lockout is per account (an attacker can lock a known account for 15 minutes; admins can unlock).
- TOTP secrets are protected by one server key; there is no key rotation tooling yet.
- Backup codes can only be regenerated by turning MFA off and on again.
- Tokens still travel in a cookie; an XSS bug would still be serious (CSP and no `innerHTML` mitigate it).
