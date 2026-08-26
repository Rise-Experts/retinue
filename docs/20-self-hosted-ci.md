# CI, and Jenkins on our own server

## Where CI runs

**GitHub-hosted runners** (`ubuntu-latest`), for every job in `ci.yml`. That is free because the repository is
public, and it is the package's gate: nothing merges or releases without it.

The history matters because it explains the shape of everything else here. Hosted minutes were exhausted on a
private repository, and every job failed in two seconds without being assigned a machine — no steps, no logs,
just a red cross on every push. CI moved to a self-hosted runner, which is not metered. Going public reversed
both facts on the same day: minutes became free, and a self-hosted runner became a liability rather than a
workaround (below). So the runner is gone, and this document is now mostly about Jenkins.

## Jenkins: what it is for

**Not the package's gate.** GitHub Actions is, and it costs nothing. Jenkins is here for two things:

| | |
|---|---|
| **Test trends** — "this test has failed 3 of the last 20 builds" | The real gain. Nothing in the Actions UI gives you this, and it is the single most useful thing to know about a flaky suite. |
| **Learning declarative pipelines against a real project** | A pipeline with service containers, a readiness wait, JUnit publishing, artifact archiving and a cleanup contract — rather than a tutorial's `echo hello`. |

Both are real, and neither is load-bearing. If Jenkins is down, the package is unaffected. Keep that in mind
when reading the rest: this is a system you can break while learning, which is exactly what makes it a good one
to learn on.

So the JUnit wiring is what makes a second CI system pay for itself. `vitest.shared.ts` adds a `junit` reporter
**only** when `RETINUE_JUNIT_DIR` is set, so the suites run **once** and emit both reporters — collecting trend
data by running the slowest part of the build a second time would cost more than the data is worth. Nothing
changes on a workstation, where the variable is unset.

`junit` is published with `allowEmptyResults: false` deliberately: a build whose suite crashed before writing XML
would otherwise publish nothing and leave the trend line green, which is the worst available outcome when the
trend is the thing being trusted.


## Setting it up on the server

Debian/Ubuntu, from Jenkins' own repository — the distro package lags badly:

```bash
sudo apt-get install -y fontconfig openjdk-21-jre
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key \
  | sudo tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null
echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" \
  | sudo tee /etc/apt/sources.list.d/jenkins.list > /dev/null
sudo apt-get update && sudo apt-get install -y jenkins
```

It listens on **:8080**. The first-run password is printed once and also written to disk:

```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

Then, in order of how much trouble skipping them causes:

1. **Do not expose :8080 to the internet.** Put it behind a reverse proxy with TLS, or reach it over a VPN or an
   SSH tunnel (`ssh -L 8080:localhost:8080 server`). A Jenkins on a public port is a remote code execution
   service with a login form in front of it — it runs shell commands for a living, which is the whole point of it.
2. **Security → disable signup.** "Anyone can do anything" is a setting, and it is the default on some install
   paths.
3. **Plugins.** Suggested-plugins covers most of it. The ones this `Jenkinsfile` actually needs: **Pipeline**
   (`workflow-aggregator`), **Git**, **JUnit** (the `junit` step), **Timestamper** (`timestamps()`), and
   **Workspace Cleanup**. `timestamps()` failing with "no such DSL method" is a missing plugin, not a syntax
   error — the commonest first-day confusion.
4. **Docker, usable as the `jenkins` user.** `sudo usermod -aG docker jenkins && sudo systemctl restart jenkins`,
   then check `sudo -u jenkins docker run --rm hello-world`. Being in the group is not the same as `docker` being
   on `PATH`, and neither is the same as the *service* having picked up the new group — the restart is the part
   people skip. Note what this grants: membership of `docker` is effectively root on that host.
5. **Back up `/var/lib/jenkins`.** Job config, credentials and build history all live there. Jenkins has no
   database; that directory *is* the database.

## Pointing it at the repository

The repository is public, so **no credentials are needed to clone it** — a real simplification, and one of the
few things that got easier today.

- **Job type:** a *Pipeline* job with "Pipeline script from SCM", pointing at
  `https://github.com/Rise-Experts/retinue.git`, branch `main`, script path `Jenkinsfile`. A *Multibranch
  Pipeline* builds every branch and PR automatically — more useful, and it is where the fork hazard below
  applies.
- **Triggering:** a GitHub webhook to `http://<jenkins>/github-webhook/` is the responsive option and needs
  Jenkins reachable from GitHub. If it is not — and behind a VPN it should not be — use **Poll SCM** with
  `H/5 * * * *`. `H` spreads the load rather than having every job fire at :00, which matters once there is more
  than one.
- **The label trap.** `Jenkinsfile` says `agent { label 'linux' }`. A fresh install has one node called
  *Built-In Node*, labelled `built-in`. Until you add `linux` to its labels (**Manage Jenkins → Nodes →
  Built-In Node → Configure → Labels**), every build sits in the queue **forever with no error** — the honest
  state, and an unnerving one the first time. `agent any` would have avoided it and would also schedule the
  build onto a machine without Docker, which fails three stages in with a message about a missing binary rather
  than about scheduling.
- Running builds on the controller is discouraged for good reasons — a build script can read
  `/var/lib/jenkins`, which holds the credentials. For one server that you own and are learning on, it is the
  normal starting point; the upgrade path is a second machine as an agent with the controller's executors set
  to 0.

## The `Jenkinsfile`, stage by stage

This is the part worth reading as a tutorial, because every stage in it exists because of a specific failure.

| Stage | What it teaches |
|---|---|
| `agent { label 'linux' }` | Where the build runs. A label rather than `any` so a machine without Docker fails at scheduling rather than three stages in. |
| `options { … }` | `disableConcurrentBuilds()` — the host ports are fixed, so two builds collide on `EADDRINUSE` and it reads as a broken test. `timeout(45, MINUTES)` — a wedged container must not hold the agent overnight. `buildDiscarder(logRotator(numToKeepStr: '30'))` — build history is disk, and it grows without this. `timestamps()` — a log without times cannot answer "what was slow". |
| `environment { … }` | Values every stage sees. `npm_config_cache` is redirected into the workspace because a Jenkins agent's `$HOME` is not always writable by the build user — an error that reads as an npm bug. `RETINUE_JUNIT_DIR` is what switches the JUnit reporter on. |
| `Checkout` → `sh 'git log -1 --oneline'` | A build log that does not say what it built cannot answer "was that fixed before or after". One line, disproportionate value. |
| `Preflight` | Fail with a sentence, not a stack trace three stages later. It checks Node, Docker, **and Docker usable as this user** — the third is the one people miss, because `docker` on `PATH` says nothing about group membership. |
| `Services` | What Jenkins has no `services:` block for: `docker run`, then **wait for readiness**, then clean up in `post`. |
| `Install` → `Test` | `npm ci` rather than `npm install`, so a build cannot pass against a dependency tree nobody committed. |
| `post { always { junit … } }` | Publishing happens *even when the stage failed* — a failed suite is exactly when you want the report. `always` vs `success` is the single most important thing to understand about `post`. |
| `Image` + `post { always { docker rmi … } }` | Cleanup that runs whatever happened, so a failed build does not leave the disk a little fuller each time. |

### Concepts you will meet in it

- **Declarative vs scripted.** This file is declarative (`pipeline { … }`): a fixed structure Jenkins can
  validate and visualise. Scripted (`node { … }`) is Groovy with more freedom and no structure. Start declarative;
  reach for `script { }` inside a step only when you genuinely need a loop.
- **Stage vs step.** A stage is a box in the UI and a unit of "where did it fail". A step (`sh`, `junit`,
  `archiveArtifacts`) is one action. Stages are for humans; steps do the work.
- **`post` conditions:** `always`, `success`, `failure`, `unstable`, `changed`, `aborted`, `cleanup`, `fixed`,
  `regression`. Cleanup belongs in `always`; notifications usually in `changed` or `regression`, because a message
  on every single build is a message nobody reads.
- **UNSTABLE is not FAILED.** The `junit` step marks a build **UNSTABLE** (yellow) when tests fail, while a
  non-zero `sh` marks it **FAILED** (red). So "tests failed" and "the build broke" are different colours on
  purpose — and a pipeline that only checks for red will happily ignore a suite going yellow.
- **`sh` and exit codes.** A step fails when the shell exits non-zero. `sh 'cmd || true'` swallows that, which is
  right for cleanup and wrong for everything else. This file uses `|| true` only where a leftover container must
  not fail a build that already succeeded.
- **The workspace** is a directory on the agent, reused between builds. That is why `npm ci` is safe and why
  stale files are a real failure mode; Workspace Cleanup is the plugin for it.

## Two hazards, and one of them is not checked

**A fork's pull request must not build on our own hardware.** On a public repository that is arbitrary code
execution by design, not a misconfiguration: the PR's own `Jenkinsfile` is what would run. `ci-local.mjs
--verify` enforces this for GitHub Actions — it fails if a `pull_request`-triggered workflow names a self-hosted
runner — but **it cannot see Jenkins' job configuration**, which lives in `/var/lib/jenkins`, not in this
repository. So this one is a rule you have to hold yourself: with a Multibranch Pipeline, either restrict
discovery to branches of this repository (not forks), or build fork PRs only after review. Named here rather than
left implicit, because it is the gap between what the repo can enforce and what it can only advise.

**Jenkins must never publish.** `scripts/publish-guard.mjs` runs as `prepublishOnly` and refuses unless GitHub
Actions is running a `<package>@<version>` tag in the `Release` workflow — so a Jenkins build cannot publish to
npm even holding a valid token, and that is deliberate rather than an oversight. Provenance requires GitHub's
OIDC identity; a Jenkins-published tarball could not carry one, and an artefact whose origin cannot be attested
is exactly what the release path exists to prevent.

## Service containers, by hand

Jenkins has no equivalent of the workflow's `services:` block, so the `Services` stage starts Redis and Postgres
with `docker run`, **waits for them to answer** (`redis-cli ping`, `pg_isready`) rather than sleeping, and removes
them in `post { always }`. The wait is the part that matters: `docker run` returns when the container starts,
which is before the server inside it accepts connections, and a suite that connects a second early fails in a way
that looks like a flaky test.

`disableConcurrentBuilds()` is set because the host ports are fixed at 6479 and 5442. Two builds at once would
collide on `EADDRINUSE` and read as a broken test. Serialising is the honest fix; dynamic ports would mean
threading a port through every stage, for a pipeline that is not busy enough to need it.

## Three definitions cannot drift

`ci.yml`, `Jenkinsfile` and `scripts/ci-local.mjs` all describe one pipeline. Two would have been a risk; three
reliably drift, and the failure mode is that a check lives in only one of them — and the one nobody watches is the
one that stops catching things.

So the workflow is the reference and the other two must **cover** it. `ci-local.mjs --verify` runs inside
`npm test`, reads all three, and fails naming any command the workflow runs that another definition does not.
Covering rather than equalling: Jenkins legitimately does more (JUnit, archiving), and that is not drift.

It strips comments before scanning, which is not fussiness. The first version matched only lines that *began* a
command and produced four false positives, because a `stage(...) { steps { sh '...' } }` is all on one line and a
multi-line shell block puts its commands after the opener. Both files also describe themselves in prose that names
commands, so scanning without removing comments would make each fail on its own documentation.


## Trying it without touching the server

Learn on a throwaway first. This gets you a working Jenkins in about a minute, with Docker available inside it:

```bash
docker run -d --name jenkins-learn -p 8080:8080 -p 50000:50000 \
  -v jenkins-learn:/var/jenkins_home -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" jenkins/jenkins:lts-jdk21
docker exec jenkins-learn cat /var/jenkins_home/secrets/initialAdminPassword
```

Mounting the host's Docker socket is what lets the `Services` and `Image` stages work, and it is also **root on
the host** for anything inside that container. Fine for a laptop you are experimenting on; think twice before
doing it on the server. `docker rm -f jenkins-learn && docker volume rm jenkins-learn` when you are done.

## The local equivalent

`npm run ci:local` runs the same commands on a developer machine, and `node scripts/ci-local.mjs --verify` — part
of `npm test` — fails if `ci.yml` gains a command the local runner does not have. So the two cannot drift, which
matters most exactly when CI is unavailable and the local gate is all there is.
