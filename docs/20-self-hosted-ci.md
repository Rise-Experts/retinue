# CI on our own runner

The org's GitHub-hosted minutes are exhausted. Self-hosted runners are **not metered**, including on private
repositories, so `ci.yml` runs on our hardware unchanged — same five jobs, same commands, same gate.

Chosen over Jenkins deliberately. Jenkins would mean a second CI definition mirroring these five jobs, and two
descriptions of one thing with nothing keeping them equal is the shape that has produced several defects in this
repository. It also brings a JVM, plugin CVEs, `$JENKINS_HOME` backups and hardening — for `npm ci && npm test`.

## Safe here because the repository is private

On a **public** repository a self-hosted runner executes a fork's pull request on your machine. That is arbitrary
code execution by design, not a misconfiguration. This repo is private, so `pull_request` is safe.

**If this repository is ever made public, that changes the same day**: remove the `pull_request` trigger, or move
to ephemeral runners in throwaway containers. It is written here because the decision will be made by someone who
was not in this conversation.

## What the machine needs

| | Why |
|---|---|
| Linux x64, ~10 GB free | The workspace is wiped and re-cloned each run; `node_modules` is rebuilt |
| **Docker**, with the runner's user in the `docker` group | The `build` and `conformance-matrix` jobs use **service containers** (Redis, Postgres), and the `image` job builds the Dockerfile. Without Docker those three jobs fail on setup, before any step |
| Outbound HTTPS to `github.com` | How the runner is polled. **No inbound ports** — nothing needs to be exposed |
| Node is *not* required | `actions/setup-node@v4` installs Node 20 into the runner's tool cache |

Ports: the service containers bind **6479** (Redis) and **5442** (Postgres) on the host, not 6379 and 5432. A
hosted runner is a fresh machine where the defaults are free by definition; a server is not, and a service
container binding an occupied port fails the job with a message about Docker rather than about the clash.

## Registering it

From **Settings → Actions → Runners → New self-hosted runner** on the repository, which shows a token valid for
one hour. Then on the server:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf runner.tar.gz

# --labels must include `linux`: ci.yml asks for [self-hosted, linux], and a runner without both
# labels leaves every job queued forever rather than failing with a reason.
./config.sh --url https://github.com/Rise-Experts/retinue --token <TOKEN> --labels self-hosted,linux --unattended

sudo ./svc.sh install     # survives reboots
sudo ./svc.sh start
sudo ./svc.sh status
```

Then check Docker is usable **as the runner's user**, which is the step people skip:

```bash
docker run --rm hello-world
```

If that needs `sudo`, the service containers will fail: `sudo usermod -aG docker $USER`, then restart the service.

## When something is wrong

| Symptom | Cause |
|---|---|
| Jobs sit in **queued** forever | No runner with both `self-hosted` and `linux` labels. Queued is the honest state — it means nothing has claimed the job, which is different from a failure |
| Jobs fail in ~2s with no steps | What the hosted runners were doing: no machine was assigned. On self-hosted it means the service is stopped |
| Only the three Docker jobs fail | Docker is missing, or the runner's user is not in the `docker` group |
| `EADDRINUSE` on a service container | Something else holds 6479 or 5442 |

## Jenkins, alongside it

`Jenkinsfile` runs the same pipeline on a Jenkins agent. It exists because of **monitoring**, and that deserves
precision, because most of what people want from it is already available:

| | Where you already have it | What Jenkins adds |
|---|---|---|
| Live logs while a build runs | The GitHub Actions UI — unchanged by the self-hosted runner; logs still stream to github.com | A stage-by-stage view (Blue Ocean) |
| Which step failed | Actions UI, per job | The same, plus the pipeline graph |
| **Test trends** — "this test failed 3 of the last 20 builds" | *nothing* | **The real gain**, via JUnit XML |
| Working while GitHub is unavailable | — | Independent of GitHub |

So the JUnit wiring is what makes a second CI system pay for itself. `vitest.shared.ts` adds a `junit` reporter
**only** when `RETINUE_JUNIT_DIR` is set, so the suites run **once** and emit both reporters — collecting trend
data by running the slowest part of the build a second time would cost more than the data is worth. Nothing
changes on a workstation, where the variable is unset.

`junit` is published with `allowEmptyResults: false` deliberately: a build whose suite crashed before writing XML
would otherwise publish nothing and leave the trend line green, which is the worst available outcome when the
trend is the thing being trusted.

### What the agent needs

The same as the runner — Linux, Docker usable as the build user, and Node, which the pipeline's own preflight
stage checks for rather than assuming — plus the **JUnit plugin**. The agent must carry the label `linux`.

Jenkins has no equivalent of the workflow's `services:` block, so the `Services` stage starts Redis and Postgres
with `docker run`, **waits for them to answer** (`redis-cli ping`, `pg_isready`) rather than sleeping, and removes
them in `post { always }`. The wait is the part that matters: `docker run` returns when the container starts,
which is before the server inside it accepts connections, and a suite that connects a second early fails in a way
that looks like a flaky test.

`disableConcurrentBuilds()` is set because the host ports are fixed at 6479 and 5442. Two builds at once would
collide on `EADDRINUSE` and read as a broken test. Serialising is the honest fix; dynamic ports would mean
threading a port through every stage, for a pipeline that is not busy enough to need it.

### Three definitions cannot drift

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

## The local equivalent

`npm run ci:local` runs the same commands on a developer machine, and `node scripts/ci-local.mjs --verify` — part
of `npm test` — fails if `ci.yml` gains a command the local runner does not have. So the two cannot drift, which
matters most exactly when CI is unavailable and the local gate is all there is.
