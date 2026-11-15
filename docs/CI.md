# Continuous Integration (Jenkins)

The pipeline is defined in the root `Jenkinsfile` (declarative). It never deploys automatically.

## Stages

| Stage | Command | What it proves |
|---|---|---|
| Checkout | `checkout scm`, version printout | Source and tools are available |
| Install dependencies | `npm ci` | Lock file is consistent, clean install works |
| Lint | `npm run lint` | ESLint passes on `server/` and `scripts/` |
| Start MongoDB (replica set) | `docker compose -f docker-compose.ci.yml -p sdw-ci up -d --wait` | A real replica set is ready (its healthcheck initiates and waits for PRIMARY) |
| Unit tests | `npm run test:unit` | The pure-logic tests (tagged "(unit)") pass |
| Integration, security and end-to-end tests | `npm run test:ci` | The full Jest suite passes and a JUnit report is written to `reports/junit.xml` |
| Build verification | `npm run build` | The app loads, required files exist, and a real HTTP server answers 7 checks (no database needed) |
| Deploy (optional) | placeholder, only if parameter `DEPLOY` is ticked | Nothing is deployed until a target is configured |

After every run (pass or fail) the JUnit results are published and the CI database is removed (`docker compose ... down`; the CI database lives in RAM, so no volumes remain).

## Jenkins prerequisites
(Windows: see [JENKINS_LOCAL.md](JENKINS_LOCAL.md); Git's `bin` folder must come first in `PATH`, or `npm` hits the WSL launcher.)
- A Linux agent with Node.js 20 or newer, npm, Docker and the Docker Compose plugin
- Jenkins plugins: Pipeline, JUnit
- The job should be a Pipeline (or Multibranch) job pointing at this repository, triggered by a push webhook or SCM polling
- Port 27018 free on the agent (the pipeline disables concurrent builds for this reason). The CI database is published on `127.0.0.1:27018` only, so the tests must run on the same host as Docker. If Jenkins itself runs inside a container, attach it to a shared Docker network instead of publishing the port.
- No secrets are needed by the tests. They use a test-only JWT secret and a throwaway database. Real deployment secrets (`JWT_SECRET`, `MONGODB_URI`) belong in Jenkins credentials, never in the repository.

## What was verified, and what was not

**Confirmed on real CI servers**
- **GitHub Actions** (`.github/workflows/ci.yml`): green on branch `saas`, commit `c9c37ed`. The `test` job passes lint, unit tests, the full suite, build verification and the production dependency audit; the `e2e` job (Playwright browser tests) passes too (confirmed by the owner).
- **Jenkins**: the `Jenkinsfile` ran to `Finished: SUCCESS` on a Jenkins server (local Windows controller) from branch `saas`, commit `c9c37ed`. The exact test count is on that build's Test Result page. Setup and the problems met are in [JENKINS_LOCAL.md](JENKINS_LOCAL.md).

**Two real defects were found only because CI ran, and fixed**
1. `npm run test:unit` used an unquoted pattern with parentheses: fine on Windows `cmd`, a shell syntax error on Linux `sh`. Every GitHub Actions run failed at that step until it was quoted (commit `2de1179`).
2. The browser-test seed step relied on a local `.env` for `JWT_SECRET`; CI has none, so seeding crashed. The throwaway test keys are now passed explicitly (commit `c9c37ed`).

**Also verified locally**, with the same commands as the pipeline: `npm ci`, `npm run lint`, `npm run build`, the CI MongoDB container from `docker-compose.ci.yml` (healthy, then removed), `npm run test:unit` and `npm run test:ci` (683 tests in 30 suites).

**Not verified**
- A shared or Linux Jenkins server, and a webhook or SCM-polling trigger (the Jenkins run was started by hand on one Windows machine).
- Any deployment. The Jenkinsfile's deploy stage is a placeholder.
- The Playwright browser tests are not part of the Jenkinsfile; they run only in GitHub Actions.

## Running the same checks by hand

```bash
npm ci
npm run lint
docker compose -f docker-compose.ci.yml -p sdw-ci up -d --wait
MONGODB_URI_TEST='mongodb://127.0.0.1:27018/secure_doc_workflow_test?replicaSet=rs0&directConnection=true' npm run test:ci
npm run build
docker compose -f docker-compose.ci.yml -p sdw-ci down
```
