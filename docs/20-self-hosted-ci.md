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

## The local equivalent

`npm run ci:local` runs the same commands on a developer machine, and `node scripts/ci-local.mjs --verify` — part
of `npm test` — fails if `ci.yml` gains a command the local runner does not have. So the two cannot drift, which
matters most exactly when CI is unavailable and the local gate is all there is.
