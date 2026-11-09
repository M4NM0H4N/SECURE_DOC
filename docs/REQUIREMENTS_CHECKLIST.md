# What you need before / during development

## Accounts and external APIs
No paid third-party API is required. The app is self-contained.

| Item | Needed? | Notes |
|---|---|---|
| MongoDB | Yes | Development and tests: Docker (`docker compose up -d`), port bound to `127.0.0.1` only. Production: MongoDB Atlas (a replica set, so transactions work; checked with a read-only probe on 2026-11-09). |
| Render (web hosting) | Production only | Web Service; see [DEPLOYMENT.md](DEPLOYMENT.md). Persistent disks are paid-only. |
| GitHub account/repo | Yes | Version control; needed for Jenkins checkout |
| Jenkins | Phase 6 | Local install or Docker; can be a simple lint+test pipeline |
| Email/SMS/Payment/Cloud storage APIs | No | Excluded from MVP |

## Software on your machine
| Tool | Status here |
|---|---|
| Node.js (LTS 20+) | Installed (v24.14.1) |
| npm | Installed (11.11.0) |
| Git | Installed (2.54.0) |
| Docker | Installed (29.9.2) → used for the local MongoDB (loopback-only port) |
| MongoDB / mongosh locally | Not installed (not needed if using Docker) |

## npm packages (installed in Phase 1)
Runtime: `express@4 mongoose jsonwebtoken bcryptjs express-validator helmet express-rate-limit express-mongo-sanitize multer cookie-parser dotenv` (no `cors`: the pages and API share one origin)
Dev: `jest jest-junit supertest eslint@8 nodemon` (mongodb-memory-server was dropped; tests use the Docker MongoDB via `MONGODB_URI_TEST`)
(No `file-type` package: the upload check reads the PDF/PNG/JPEG magic bytes directly. file-type 16 has a known parser DoS advisory and v22 is ESM-only.)

## Secrets / environment values you must generate
- `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` (choose a strong password; remove after seeding)
- `MONGODB_URI` (the default in `.env.example` works with the Docker replica set; in production set it in Render to your Atlas connection string)

## Decisions only you can make
1. **Department list** (e.g. CSE, ECE, ME, CIV, EEE) — used as an enum everywhere.
2. **Seed HOD/Clerk accounts per department** for the demo (created via Admin UI/API).
3. **Skill files:** supply your exact `SKILL.md` for context-keeper, responsive-mobile-first, ui-ux-pro-max, security-first. I did not invent them.
4. **Who implements:** Antigravity vs. Claude Code. This Phase 0 was done by Claude Code at your request; AGENTS.md ownership rule applies from here.
5. Transaction mode: Docker replica set (recommended) or documented fallback.

## First-run commands (once approved)
```bash
docker compose up -d
docker exec sdw-mongo mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
cp .env.example .env   # then edit secrets
```
