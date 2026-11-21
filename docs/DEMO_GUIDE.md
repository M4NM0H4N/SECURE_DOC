# DocFlow: Complete Demo Guide

A step-by-step guide to presenting the project: what to prepare, exactly what to click, what to say, and what to do when something goes wrong. Total live time: about **18 minutes**, plus questions.

> This guide replaces the older [DEMO.md](DEMO.md) (kept for reference). The screens described here are the redesigned, dark-first interface on the `ui-redesign` branch.

---

## 1. Choose what you will show

| Option | What it is | Use it for |
|---|---|---|
| **A. Local demo (recommended)** | Run the app on your laptop from the `ui-redesign` branch with seeded demo data | The main live demo. Fully under your control, newest design, no internet needed |
| **B. Deployed demo** | The version on Render + MongoDB Atlas (the `saas` branch) | Proof that it is deployed. Free hosting sleeps and forgets uploaded files, so it is a backup, not the main demo |
| **C. Offline fallback** | Screenshots in `docs/screenshots/`, the project report PDF, the CI evidence | If the laptop or network fails on the day |

**Say it honestly:** the new look is on the `ui-redesign` branch and has not been merged into the deployed branch. If someone asks, say so.

---

## 2. One day before: preparation checklist

Run through this the day before, then again 30 minutes before you present.

- [ ] Laptop charged, charger packed, notifications and chat apps closed (do-not-disturb on)
- [ ] Docker Desktop running (`docker ps` works)
- [ ] On the right branch with a clean state
- [ ] The three keys added to `.env` and the server restarted (section 3), or the QR step will not appear
- [ ] Demo data seeded (section 3)
- [ ] `npm test` green (about 2.5 minutes) so you can say the numbers truthfully
- [ ] Sample files ready: `docs/demo-assets/sample-bonafide-certificate.pdf` (good) and `docs/demo-assets/fake-certificate.pdf` (text pretending to be a PDF)
- [ ] Four browser sessions logged in (section 4)
- [ ] Browser zoom at 110–125% so the back row can read it; window maximised; bookmarks bar hidden
- [ ] Open in tabs, ready to show: GitHub Actions page (green), Jenkins build screenshot, the report PDF, `docs/UML.md` diagrams
- [ ] Phone ready if you want to scan the QR code live (any QR scanner app)
- [ ] The deployed site opened once, 5 minutes before (Render free instances sleep)
- [ ] A recording of the full demo saved on the laptop as the last-resort fallback

---

## 3. Setup commands (Windows, cmd)

Open **Command Prompt** in the project folder (`D:\KLE\3rdsem\webtech`).

```bat
git checkout ui-redesign
docker compose up -d
npm install
npm run seed:demo
npm start
```

Then open **http://localhost:3000/t/demo/**.

Notes:
- `npm run seed:demo` needs `DEMO_PASSWORD` in your local `.env` file. That value is the password for every demo account. Do not show your `.env` on screen.
- If Docker was stopped, `docker compose up -d` starts MongoDB again. Never use `docker compose down -v`: it deletes your data.
- To reset the demo data after a rehearsal: `npm run seed:demo:clean`, then `npm run seed:demo`.

### Keys the full demo needs in your local `.env`

A few demo features are switched off unless their key exists. Your `.env` currently has none of these three, so **add them before the demo**:

| Add this line to `.env` | Without it |
|---|---|
| `VERIFY_SIGNING_KEY=<random 32+ characters>` | **No verification code or QR on issued documents, so the whole verify step disappears** |
| `MFA_ENCRYPTION_KEY=<random 32+ characters>` | Two-step sign-in cannot be shown |
| `WEBHOOK_ENCRYPTION_KEY=<random 32+ characters>` | Webhooks on the Integrations page are unavailable |

Generate each value in cmd (run it once per key, and do not show the output on screen):

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Restart `npm start` after editing `.env`.

To scan the QR code with your phone, the phone must reach your laptop: set `PUBLIC_URL=http://<your-laptop-IP>:3000` in `.env` (find the IP with `ipconfig`) and put both on the same Wi-Fi. If that is awkward, use **Copy link** instead; it shows the same verification page.

### Demo accounts (password = your `DEMO_PASSWORD`)

| Who | Email | Role | Department | Use in the demo |
|---|---|---|---|---|
| Ravi Kumar | `ravi.demo@example.com` | Student | CSE | Submits the live request |
| Asha Rao | `asha.demo@example.com` | Student | CSE | Has a request in every status (shows the dashboard full) |
| Meera Nair | `meera.demo@example.com` | Student | ME | Shows another department's student |
| Demo Clerk (CSE) | `clerk.cse.demo@example.com` | Clerk | CSE | Reviews and uploads |
| Demo HOD (CSE) | `hod.cse.demo@example.com` | HOD | CSE | Approves or rejects |
| Demo Clerk (ME) | `clerk.me.demo@example.com` | Clerk | ME | Proves the department boundary |
| Demo HOD (ME) | `hod.me.demo@example.com` | HOD | ME | Proves the department boundary |
| Demo Admin | `admin.demo@example.com` | Admin | none | Users, audit, analytics, settings |

---

## 4. Set up four people at once

The workflow involves four people, and you should not log in and out during the demo. Use **four separate browser sessions** that do not share cookies:

| Window | How to open it | Signed in as |
|---|---|---|
| 1. Student | Normal Chrome window, address `http://localhost:3000/t/demo/` | `ravi.demo@example.com` |
| 2. Clerk | Normal Chrome window, address `http://127.0.0.1:3000/t/demo/` | `clerk.cse.demo@example.com` |
| 3. HOD | Incognito window, address `http://localhost:3000/t/demo/` | `hod.cse.demo@example.com` |
| 4. Admin | Incognito window, address `http://127.0.0.1:3000/t/demo/` | `admin.demo@example.com` |

Why this works: `localhost` and `127.0.0.1` are different addresses to the browser, so each keeps its own login. Normal and incognito windows keep separate cookies too.

Arrange the windows so you can switch quickly (`Alt+Tab`), and sign all four in **before** you start.

---

## 5. Run of show (about 18 minutes)

### Minute 0–2: The problem and the idea (landing page)
Open a **fresh private window** at `http://localhost:3000/t/demo/` (signed out) to show the landing page.

**Say:** "Institutions still handle certificate requests on paper: students can't see where a request is, approvals are informal, and nobody can prove who approved what. DocFlow digitises this under SDG 16, accountable institutions."

**Show:**
1. The headline **Request. Approve. Prove.**
2. The **three layers** in the stack: Identity (who is acting), Validation (is it allowed), Proof (can it be verified).
3. Scroll to **"See a request move"** and click the four steps; point out the three layer chips lighting up.
4. The live **status pill** ("All systems operational") and the department chips: "these come from the real server."

### Minute 2–4: Student submits a request (Window 1)
1. The student dashboard: welcome card, quick actions, live counts.
2. In **Request a document**, choose **Bonafide Certificate**. First type a short purpose such as `test` and press **Submit request**: **show the validation error** (the purpose is too short).
3. Type a real purpose (`Needed for an education loan application at the bank`) and submit.
4. The new request appears as **Pending**, with the progress track (Submitted, Review, Approved, Issued). Counts update.

**Say:** "Validation happens on the server, not just in the page."

### Minute 4–6: Clerk reviews (Window 2)
1. The clerk dashboard shows only **CSE** requests. The **Pending** tile is highlighted.
2. Find Ravi's request. **Click the green "Complete: Clerk review" button.** It moves to Under review.
3. Optionally show **Ask for information**: the student would get a question and can answer and resubmit.

**Say:** "The clerk only sees their own department. That's enforced by the server."

### Minute 6–8: HOD decides (Window 3)
1. The HOD sees the request in **Under review**.
2. Press **Reject**, leave the reason empty, and try to confirm: **it refuses.** "A rejection must carry a reason the student can read." Cancel.
3. Press **Complete: HOD decision**. The request becomes **Approved**.

**Say:** "Every decision is recorded with the person's name and the time."

### Minute 8–10: Clerk issues the document (Window 2)
1. Click the **Approved** tile (it filters the list). Ravi's request appears.
2. In the card, **choose `sample-bonafide-certificate.pdf`** and press **Upload and fulfil**.
3. Status becomes **Fulfilled**.

**Say:** "The file type is checked by its real content, not its name. The status change and the audit record are saved together or not at all."

### Minute 10–12: Student gets and verifies the document (Window 1)
1. Refresh: the request shows **Fulfilled**. Press **View details**.
2. Show the **progress track** and the **history timeline** (who did what, when), and the **Documents** card.
3. Press **Download** and open the PDF.
4. Show the **verification QR code and link**. Either scan the QR with your phone, or press **Copy link** and open it in the private window: the page shows the large green **shield: genuine and currently valid**.
5. In the same page's code box (or by changing one character of the code), show an unknown code: **"No document matches this code."**

**Say:** "Anyone, even without an account, can confirm a document is genuine. The code is signed, so it cannot be forged."

### Minute 12–15: Security demonstrations (about 3 minutes, pick 4)

| Demonstration | How to do it | Expected result |
|---|---|---|
| **Another student's request** | Copy the URL of Ravi's request detail page, open it as Meera (log in as `meera.demo` in a spare window) | "Request not found". It doesn't reveal that it exists |
| **Department boundary** | Log in as `clerk.me.demo` (or `hod.me.demo`) | The CSE request is nowhere in their lists |
| **Fake file** | As the CSE clerk, on another Approved request, upload `fake-certificate.pdf` | Refused: "not a real PDF" |
| **Double action** | Open the same request in two tabs as HOD; approve in one, then approve in the other | The second gets a conflict message and the list refreshes |
| **Deactivate** | As Admin, deactivate a signed-in test account (not one you still need) | That person's next click sends them to sign-in |
| **Role limits** | Try opening `/t/demo/admin/` while signed in as the student | Redirected away. The server also answers 403 |

**Say:** "Hiding a button isn't security. Every rule is enforced on the server and checked by automated tests, including a sweep that tries every route as an anonymous user, the wrong role and another institution."

### Minute 15–17: Admin (Window 4)
1. **User management**: the user list with search and CSV download. In **Invite staff**, create an invitation for a Clerk in CSE. Because e-mail is off in the demo, the page shows the one-time link. "It works once and expires."
2. **Audit trail** (sidebar): filter by event, then press **Verify integrity**. It reports the chain is intact and shows the head hash.
3. **Analytics**: counts by status, department and month, turnaround and backlog. "Counts only, never personal data."
4. **Institution settings**: the approval chain, departments, document types, branding. Mention the "Your data" download.
5. Optionally **Integrations**: read-only API keys and signed webhooks.

**Say:** "The Admin can see who did what but cannot approve anything or read documents."

### Minute 17–18: Engineering evidence and close
Show, in this order:
1. **GitHub Actions**: the latest run is green (lint, unit tests, full tests, build, audit, browser tests).
2. **Jenkins**: the screenshot of the green pipeline.
3. **Numbers:** 683 automated tests in 30 suites, 100 browser tests (on the redesign branch), WCAG accessibility scans in both themes.
4. The **report PDF** and the UML/ER/DFD diagrams.

**Close with honest limits:** the audit log detects tampering but cannot prevent it by a database administrator; the demo hosting is free-tier and forgets uploaded files; e-mail, cloud storage and virus scanning were tested against local stand-ins; the legal pages are templates.

---

## 6. If they ask: likely questions and short answers

| Question | Answer |
|---|---|
| How does it meet the problem statement? | It manages document requests, approval stages and access permissions, using HTML/CSS/JS, Express.js and MongoDB, with RBAC, request status, audit events and validation |
| Why is it bigger than "a mock institution"? | The MVP (tag `mvp-v1.0`) matches the statement exactly. The multi-institution work is an owner-approved extension on top of it |
| How do you stop a student seeing someone else's request? | Ownership and department scope are applied in every query on the server; an out-of-scope request returns 404, so its existence isn't revealed |
| What stops two people approving at once? | The status change is one atomic conditional update; only one can match, the other gets a conflict |
| Can the audit log be changed? | There is no create/update/delete route, and entries are hash-chained, so changes are detectable. A database administrator could still rewrite everything, so it is tamper-evident, not tamper-proof |
| Is it a blockchain? | No. It is a hash-chained log |
| How is a document verified? | Each issued document has a signed code and QR; the public page checks the signature and the document's state (valid, replaced or withdrawn) |
| What security testing did you do? | An automatic sweep of every route (anonymous, wrong role, other institution, missing CSRF header), injection tests, upload tests, plus accessibility and layout scans |
| Why Agile/Scrum? | Requirements grew in stages; short gated sprints gave a working, tested increment each time (36 to 238 tests across the MVP sprints) |
| What went wrong in CI? | Two real bugs that only a clean Linux server showed: a script quoting problem and a test relying on a local settings file. Both fixed |
| What would you improve? | Document templates and digital signatures, SMS notifications, an independent security test, persistent file storage on the demo |
| Is it deployed? | Yes, a demo on Render with MongoDB Atlas (free tier: it sleeps when idle and uploaded files don't survive a restart) |

---

## 7. If something goes wrong

| Problem | Fix |
|---|---|
| Page won't load / "cannot connect" | `docker compose up -d`, then `npm start`; check `http://localhost:3000/healthz` |
| Login says wrong password | Use the `DEMO_PASSWORD` from your `.env`; if you changed it after seeding, run `npm run seed:demo:clean` then `npm run seed:demo` |
| A request is in the wrong state after rehearsing | Reset: `npm run seed:demo:clean`, then `npm run seed:demo` (demo data only) |
| Clerk's queue looks empty | The default filter is **Pending**; click the status tile you want, or choose "All statuses" |
| Upload refused | Use `sample-bonafide-certificate.pdf` (a real PDF under 5 MB), not the fake file |
| Two windows keep logging each other out | Use the four-session setup in section 4 (localhost vs 127.0.0.1, normal vs incognito) |
| Deployed site is slow | Free hosting was asleep; the first load takes about a minute. Open it before you start |
| Documents missing on the deployed site | Expected after a restart on the free plan (no disk). Upload a new one |
| Laptop or server dies completely | Switch to Option C: the screenshots, the report PDF, the recording, and the CI evidence; explain the flow from the state diagram |

---

## 8. Do and don't

**Do**
- Narrate what you click and why it matters ("this is enforced on the server").
- Show a failure on purpose (short purpose, empty rejection reason, fake file): it proves the rules.
- Say the numbers exactly as measured: 683 tests, 100 browser tests, one demo deployment.
- Keep the Admin window for last: it ties the story together with the audit trail.

**Don't**
- Don't show `.env`, the Atlas connection string, API keys, or the Render dashboard's secret values.
- Don't claim blockchain, "unhackable" or "production-ready".
- Don't say Jenkins runs on a shared server; it ran on a local Jenkins.
- Don't log in and out between roles: use the four windows.
- Don't change code or restart the server in the middle of the demo.

---

## 9. One-page cheat sheet

| Time | Window | Action | Key line |
|---|---|---|---|
| 0:00 | Private | Landing page, "See a request move" | Request. Approve. Prove. |
| 2:00 | Student | Short purpose fails; real request submitted, Pending | Validation is on the server |
| 4:00 | Clerk | Complete: Clerk review | Only their department |
| 6:00 | HOD | Reject needs reason; Complete: HOD decision | Every decision is attributed |
| 8:00 | Clerk | Approved tile, upload sample PDF, Fulfilled | Checked by real content |
| 10:00 | Student | Details, timeline, download, scan QR, verify | Anyone can verify |
| 12:00 | Mixed | 4 security demos | Enforced on the server |
| 15:00 | Admin | Invite, audit + Verify integrity, analytics, settings | Admin can't approve or read documents |
| 17:00 | Browser | GitHub Actions, Jenkins, numbers, report | Evidence, then honest limits |
