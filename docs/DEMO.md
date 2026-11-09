# Demonstration Guide

A step-by-step script for the final demonstration, plus talking points for the presentation.

## Before the demo

```bash
docker compose up -d
npm install
npm run seed:demo       # demo institution (/t/demo/) with accounts and requests in every status
npm start               # http://localhost:3000, then open /t/demo/
```

`npm run seed:demo` needs `DEMO_PASSWORD` in `.env` (see `.env.example`). It creates an institution with the address `demo` and eight accounts, all ending in `.demo@example.com`, and nine requests through the real workflow (so the audit trail is genuine). It refuses to run in production. When finished: `npm run seed:demo:clean`.

| Account | Role | Department |
|---|---|---|
| asha.demo@example.com | Student | CSE (has a request in every status) |
| ravi.demo@example.com | Student | CSE |
| meera.demo@example.com | Student | ME |
| clerk.cse.demo@example.com | Clerk | CSE |
| hod.cse.demo@example.com | HOD | CSE |
| clerk.me.demo@example.com | Clerk | ME |
| hod.me.demo@example.com | HOD | ME |
| admin.demo@example.com | Admin | none |

The password for all of them is the `DEMO_PASSWORD` value in your `.env`.

## Live workflow (about 8 minutes)

1. **Student** (`ravi.demo`): submit a *Bonafide Certificate* request. It appears as **Pending**.
2. **Clerk** (`clerk.cse.demo`): open the Pending queue, press **Start review**. It becomes **Under review**.
3. **HOD** (`hod.cse.demo`): press **Approve**. (Show **Reject** too: it will not submit without a reason.)
4. **Clerk**: filter to **Approved**, choose a small PDF, press **Upload and fulfil**. Status becomes **Fulfilled**.
5. **Student**: the request is now Fulfilled; press **Download document**. Open **View details** to show the history timeline with who did what.
6. **Admin** (`admin.demo`): show **User management** (create a Clerk, deactivate a user), then **View audit log** and filter by event.

## Security demonstrations (about 4 minutes)

Do these in the browser where possible, otherwise with the API or `npm test`.

| Demonstration | Expected result |
|---|---|
| Student B opens Student A's request link (`/request.html?id=...`) | "Request not found" (404, existence is not revealed) |
| A Student or Clerk calls approve | 403 (RBAC) |
| `meera.demo` / `hod.me.demo` try to open a CSE request | 404 (department boundary) |
| Press Approve on an already approved request (second tab) | 409 invalid transition, list refreshes |
| Upload a text file renamed `.pdf` | Rejected: content is not a real PDF |
| Upload a file over 5 MB | Rejected (413) |
| Open a document URL as another student, or signed out | 404 / 401 |
| Admin deactivates a signed-in student | Their very next click returns them to login |

For a rehearsed, repeatable version of all of this, run `npm test`: the `e2e.test.js` suite performs the whole flow and the security checks (17 tests).

## Talking points (SDG 16 and software engineering)

- **Accountability:** every action has a named actor in the audit trail; rejections must carry a reason the student can read.
- **Least privilege:** four roles; the Admin cannot approve anything; Clerks and HODs only see their own department.
- **Server-side enforcement:** hiding a button is not security; every rule is checked on the backend and tested.
- **Integrity:** status changes are atomic; the status change and its audit record commit together in a transaction; files are written first and removed if anything fails.
- **Honest limits:** audit log is append-only at application level, not immutable; transactions need a replica set; see [LIMITATIONS.md](LIMITATIONS.md).
- **Process:** built in six reviewed phases; 274 automated tests; CI pipeline defined (not yet run on a Jenkins server).

## Suggested slide outline
1. Problem and SDG 16 link
2. Roles and workflow (state diagram)
3. Architecture (component diagram)
4. Security design (RBAC, scope, atomic transitions, private files, audit)
5. Live demo
6. Testing evidence (274 tests, required security scenarios)
7. Limitations and future work
