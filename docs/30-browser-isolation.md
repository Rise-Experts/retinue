# Browser isolation — the argument

REQ-055 (#237), task #239, AC-2.

This document exists because the acceptance criterion asked for an argument rather than a claim. Saying
`tools-browser` "uses the sandbox" would be false in the way that matters: the strongest guarantee in the
`Sandbox` port from #215/#216 is **no network**, and a browser cannot have it. So the isolation case has to be
rebuilt from the parts that remain, and the gap has to be named rather than papered over.

## What `Sandbox` guarantees, and which of those survive here

`backend/src/toolkit/sandbox.ts` was written for `shell_exec`, whose blast radius is not described by its
schema. Its contract:

| `Sandbox` guarantee | Available to a browser? |
|---|---|
| **No network** (`--network=none`) | **No.** A browser that cannot reach the network is not a browser |
| Read-only root, one writable scratch mount | **Yes**, with a caveat — see below |
| Memory cap | **Yes**, and enforced twice: by the container and by this package |
| Wall-clock timeout | **Yes**, as the session lifetime |
| No TTY | Yes |
| Output cap with truncation reported | Yes, as the screenshot byte cap and the page text bound |
| Exit code in the envelope | Yes |

Six of seven survive. The one that does not is the one that mattered most, and the rest of this document is
about what stands in its place.

## Why losing `--network=none` is worse than it sounds

For `shell_exec`, no-network is what makes everything else affordable. A command that cannot open a socket can
read a secret and do nothing with it; the isolation does not have to be perfect, because the *exit* is closed.

A browser inverts that. It has network by definition, it executes untrusted JavaScript from whoever wrote the
page, and both together mean a compromised renderer has an exfiltration path from the moment it starts. So the
threat model changes shape: the question is no longer "can it reach the network" but "**what can it reach, and
what can it take with it**".

Three answers, in order of how much they matter.

### 1. It must not reach the internal network

This is the same SSRF problem `tools-scrape` has, and it uses the **same implementation** — `refuseUrl` and
`resolvePublicly` from `@retinue/agentkit/tools`, which is why they live there rather than in either toolkit.
A second copy is how one of them ends up missing the IPv6-mapped forms of the metadata address.

A browser adds one vector a fetch does not have: **the page can move itself.** `location.replace`, a meta
refresh, a scripted redirect — none of which the pre-navigation check can see, because it has not run yet. So
the URL the browser actually landed on is checked again after the page settles, and a session that landed
somewhere private is **closed, with nothing from that page read**. That is AC-3's "including after an in-page
redirect", and it is tested by a driver that reports a different URL from the one it was given.

What this does *not* cover, stated plainly: a page that fetches a private address with its own JavaScript and
renders the result. The URL checks govern navigation, not `XMLHttpRequest`. Closing that requires network
controls at the container — a firewall rule or an egress proxy that denies RFC 1918 and link-local ranges —
which is a deployment's responsibility and is written into the integration page's prerequisites rather than
being silently assumed here. **This is the residual gap in this design.** It is worth stating rather than
hiding, and it is the reason `browser_navigate` is `always`-gated.

### 2. It must not reach the host

No host filesystem mount — not the working directory, not `/tmp`, not a socket. A browser profile lives in the
container's own writable layer and dies with it. Dropped capabilities, a non-root user, and no privileged
flags. Nothing about this is browser-specific; it is what the `Sandbox` port already argued for and it carries
over intact.

The caveat on "read-only root": Chromium needs a writable profile directory, a writable `/dev/shm` (or
`--disable-dev-shm-usage`, which trades stability for it), and a writable temp. Three writable mounts is more
than `shell_exec`'s one. They are `noexec` and they are discarded with the container.

### 3. It must not outlive its usefulness or eat the host

Two hard caps, enforced by this package as well as by the container, because a hosted driver has no container
this package controls:

- **A session lifetime**, five minutes by default and fifteen at most.
- **A memory ceiling**, measured across the process *group*.

They are separate because they catch different failures. A page with a runaway script hits memory in seconds
and sits comfortably inside any reasonable lifetime; a session an agent simply forgot to close hits the
lifetime and never approaches the memory cap. A design with only one of them has an unbounded failure mode it
cannot see. There is a third cap on *concurrent* sessions, because N sessions each within the memory limit can
still exhaust a host, and "each one was within limits" is no comfort to the machine that fell over.

## The process group, and the defect that already happened

#216 killed a sandboxed process, an orphan survived, and CI hung. A browser makes that **more** likely, not
less, because a browser is not a process — it is a tree. Chromium forks a zygote, a GPU process, a network
service and one renderer per tab. `kill(pid)` on the launcher leaves every renderer running, holding the
memory and the sockets, and nothing reaps them.

So the child is spawned `detached`, which makes it a process-group leader, and teardown signals the **group**
with `kill(-pgid)`. `SIGTERM` first — a browser given `SIGKILL` leaves a lock file that makes the next launch
on the same profile fail — then `SIGKILL` to whatever remains after a bounded grace period, because a hung
browser must not be able to delay teardown indefinitely.

`detached` is load-bearing in a way that is easy to get wrong: without it the child shares the runtime's
process group, and `kill(-pgid)` signals **the runtime itself**. That is not hypothetical. It is what happens
the first time somebody adds group-killing to a non-detached spawn, and the symptom is the whole worker dying
when one session times out.

The test for this spawns a real process that spawns a real grandchild, tears down the group, and asserts the
grandchild is gone by signalling it and expecting `ESRCH`.

## What is not isolation, and is doing more work than isolation here

Three controls that are not containment and matter more day to day:

- **No credential ever reaches a page.** No tool takes a `password`, `token` or `apiKey` argument, and
  `browser_type` refuses `input[type=password]` whatever the text is. Refusing the *field* is what makes this
  checkable — "does this string look like a password" has no reliable answer and `type="password"` does. An
  agent driving a login form is not a capability this grants.
- **Every interaction needs a reference from a read the model just did.** No coordinates: `click(412, 890)`
  means a different element at a different window size, after a font loads, or once a cookie banner appears,
  and clicking the wrong thing *succeeds*. An interaction invalidates the snapshot it came from, so a second
  click needs a fresh read. That is stricter than strictly necessary and deliberately so — this package cannot
  know which clicks are the harmless ones.
- **Rendered page text is untrusted content**, fenced exactly as `tools-scrape` fences a scraped page, per the
  decision recorded in `docs/23-tool-catalogue.md`.

## Why there is no default driver

`createBrowserToolkit` requires one. A default would mean this package decides how a browser is launched and
isolated on the operator's host — precisely the decision this document argues has to be made explicitly. A
toolkit that quietly spawned a browser because it found one on the `PATH` would be the "works on the machine
where it was configured" shape with an unusually large blast radius.

## Summary of the residual risk

| Risk | Controlled by | Residual |
|---|---|---|
| Navigating to internal network space | Shared post-resolution checks, re-run after the page settles | None known |
| Page-initiated requests to internal addresses | **Not controlled by this package** | Needs container-level egress rules. Stated as a prerequisite |
| Renderer escape to the host | No host mounts, dropped capabilities, non-root | Standard container residual |
| Resource exhaustion | Lifetime, memory, session-count caps; group kill | None known |
| Credential disclosure | No credential arguments; password fields refused | A person can still be phished by a page the agent shows them |
| Prompt injection from page content | Untrusted-content envelope | Not eliminated — see `docs/23`. Bounded by the package containing no external write |
