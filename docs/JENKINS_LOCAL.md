# Running the Jenkins pipeline on a Windows machine

This is the exact setup that ran the project's `Jenkinsfile` to a green result on the owner's Windows PC (Docker Desktop, Node 24, Git for Windows). It needs no administrator rights and installs nothing system-wide: everything lives in one folder that can be deleted afterwards.

Evidence: the pipeline ran from branch `saas` at commit `c9c37ed` and finished successfully; the same commit is green on GitHub Actions. The pipeline runs `npm run test:ci` (the full Jest suite). The Jenkins build page shows the exact test count; this document does not quote one.

## What you need
| Item | Notes |
|---|---|
| Docker Desktop, running | The pipeline starts a throwaway MongoDB replica set (`docker-compose.ci.yml`, port `127.0.0.1:27018`, data in RAM) |
| Node.js 20 or newer, Git for Windows | Git provides `sh` and `bash`, which the `Jenkinsfile` needs (`sh` steps) |
| Java **21** (portable zip) | Current Jenkins refuses Java 17. Use the Temurin 21 zip from adoptium.net and check its SHA-256; unzip to `C:\jenkins\jdk21` |
| `jenkins.war` | From get.jenkins.io (`war-stable/latest`); compare its SHA-256 with `jenkins.war.sha256` |

## Start script (`C:\jenkins\start-jenkins.cmd`)
```bat
@echo off
set "JAVA_HOME=C:\jenkins\jdk21"
set "JENKINS_HOME=C:\jenkins\home"
set "PATH=C:\Program Files\Git\bin;%JAVA_HOME%\bin;%PATH%;<Docker Desktop>\resources\bin;C:\Program Files\Git\usr\bin"
cd /d C:\jenkins
java -version
java -jar jenkins.war --httpPort=8080
```
Replace `<Docker Desktop>` with your Docker Desktop folder (for example `C:\Users\<you>\AppData\Local\Programs\DockerDesktop`). Leave the window open while Jenkins runs; `Ctrl+C` stops it.

## The three problems we hit (and the fixes)
1. **"Java 17 is older than the minimum (Java 21)".** Use Java 21, not 17.
2. **`WSL (10 - Relay) ERROR: execvpe(/bin/bash) failed` on the first `npm` call.** Windows finds `C:\Windows\System32\bash.exe` (the WSL launcher) before Git's `bash`. `npm` is a shell script starting with `#!/usr/bin/env bash`, so it launched WSL, which has no Linux distro. Fix: put `C:\Program Files\Git\bin` **first** in `PATH` (as in the start script). Check with `sh -c "npm --version"`.
3. **`test:unit` failed on Linux (GitHub Actions) with a shell syntax error.** The script used an unquoted pattern containing parentheses. It is now `--testNamePattern="\(unit\)"`, valid on both Windows `cmd` and Linux `sh`. (Fixed in commit `2de1179`.)

## One-time Jenkins setup
1. Open http://localhost:8080 and unlock with `C:\jenkins\home\secrets\initialAdminPassword` (never share it). Install the suggested plugins and create an admin user.
2. **New Item** → name `secure-doc` → **Pipeline**.
3. Pipeline → Definition **Pipeline script from SCM** → SCM **Git** → Repository URL `https://github.com/M4NM0H4N/SECURE_DOC.git` → Branch `*/saas` → Script Path `Jenkinsfile` → Save.
4. **Build Now**, then open **Console Output**.

Expected stages: Checkout, Install dependencies, Lint, Start MongoDB (replica set), Unit tests, Integration/security/end-to-end tests, Build verification, then the optional Deploy stage is skipped. The run ends with `Finished: SUCCESS`, the JUnit results are published (**Test Result** on the build page), and the CI database container is removed.

## If a build fails
| Symptom | Fix |
|---|---|
| `sh: not found` | Jenkins was not started with the start script |
| WSL / `execvpe(/bin/bash)` error | Git's `bin` folder is not first in `PATH` (problem 2) |
| `docker: not found` or cannot connect | Start Docker Desktop; check the Docker folder is in `PATH` |
| `port is already allocated` (27018) | `docker compose -f docker-compose.ci.yml -p sdw-ci down` (never `down -v`) |
| Checkout fails | Check the URL and that the branch is exactly `*/saas` |

## Cleaning up
Stop Jenkins with `Ctrl+C`, then delete the folder: `rmdir /s /q C:\jenkins`. Nothing else was installed.

## What this does and does not prove
It proves the `Jenkinsfile` is valid and the pipeline passes on a real Jenkins server (a single local Windows controller, built-in agent). It does **not** prove a shared Linux Jenkins, a webhook trigger, or any deployment. The browser (Playwright) tests are not part of the Jenkinsfile; they run in the GitHub Actions `e2e` job.
