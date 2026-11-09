# Continuous Integration (Jenkins)

The pipeline is defined in the root `Jenkinsfile` (declarative). It never deploys automatically.

## Stages

| Stage | Command | What it proves |
|---|---|---|
| Checkout | `checkout scm`, version printout | Source and tools are available |
| Install dependencies | `npm ci` | Lock file is consistent, clean install works |
| Lint | `npm run lint` | ESLint passes on `server/` and `scripts/` |
| Start MongoDB (replica set) | `docker compose -f docker-compose.ci.yml -p sdw-ci up -d --wait` | A real replica set is ready (its healthcheck initiates and waits for PRIMARY) |
| Unit tests | `npm run test:unit` | The pure-logic tests (49, tagged "(unit)") pass |
| Integration, security and end-to-end tests | `npm run test:ci` | The full suite (274 tests) passes and a JUnit report is written to `reports/junit.xml` |
| Build verification | `npm run build` | The app loads, required files exist, and a real HTTP server answers 7 checks (no database needed) |
| Deploy (optional) | placeholder, only if parameter `DEPLOY` is ticked | Nothing is deployed until a target is configured |

After every run (pass or fail) the JUnit results are published and the CI database is removed (`docker compose ... down`; the CI database lives in RAM, so no volumes remain).

## Jenkins prerequisites
- A Linux agent with Node.js 20 or newer, npm, Docker and the Docker Compose plugin
- Jenkins plugins: Pipeline, JUnit
- The job should be a Pipeline (or Multibranch) job pointing at this repository, triggered by a push webhook or SCM polling
- Port 27018 free on the agent (the pipeline disables concurrent builds for this reason). The CI database is published on `127.0.0.1:27018` only, so the tests must run on the same host as Docker. If Jenkins itself runs inside a container, attach it to a shared Docker network instead of publishing the port.
- No secrets are needed by the tests. They use a test-only JWT secret and a throwaway database. Real deployment secrets (`JWT_SECRET`, `MONGODB_URI`) belong in Jenkins credentials, never in the repository.

## What was verified, and what was not
Verified locally, using the same commands as the pipeline:
- `npm ci --dry-run`, `npm run lint`, `npm run build`: pass
- The CI MongoDB container from `docker-compose.ci.yml` started and reported healthy
- `npm run test:unit`: 49 passed (225 skipped by the filter)
- `npm run test:ci`: 274 passed against the local development replica set (the CI container itself was not started for S1), `reports/junit.xml` created
- The CI container was removed afterwards

**Not verified:** the `Jenkinsfile` itself has not been executed by a Jenkins server, so Groovy syntax and plugin availability are untested. Run it once on your Jenkins and fix any environment-specific issue (for example, a Windows agent would need `bat` instead of `sh`).

## Running the same checks by hand

```bash
npm ci
npm run lint
docker compose -f docker-compose.ci.yml -p sdw-ci up -d --wait
MONGODB_URI_TEST='mongodb://127.0.0.1:27018/secure_doc_workflow_test?replicaSet=rs0&directConnection=true' npm run test:ci
npm run build
docker compose -f docker-compose.ci.yml -p sdw-ci down
```
