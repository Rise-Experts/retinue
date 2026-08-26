# Versioning, API surface and deprecation

REQ-040 ([#189](https://github.com/Rise-Experts/retinue/issues/189)). What consumers may depend on, what they
will be told before it changes, and how long a removed thing keeps working.

Written before the first publish, deliberately. After it, every mistake in here is permanent.

## What is covered by semver

**The package root's exports, and nothing else.**

`@retinue/agentkit` exports **five values** from its root — `createRuntime`, `resolveCapabilities`,
`defineAgent`, `asId`, and `AgentPlatformError` with its guard — plus every type. Those, and the documented
subpaths listed in `backend/src/entries/README.md`, are the API.

Anything reachable only by a deep import is **not** API. That is not a rule stated in prose and hoped for: the
`exports` map refuses the import, and `public-surface.test.ts` asserts the refusal by running a child `node` and
checking that `ERR_PACKAGE_PATH_NOT_EXPORTED` comes back. A consumer cannot accidentally depend on an internal,
because they cannot reach one.

`npm run check:consumer` (#195) makes the same assertion against the **packed tarball**, from a directory whose
only knowledge of the package is `node_modules` — which is the state a consumer is actually in, and the one this
repository's own tests cannot reproduce, because a workspace resolves through a symlink into `backend/` where
`src/` exists and everything is readable. It also catches an `exports` entry aimed at a file the `files` globs
dropped: the failure where every test here passes and the package is broken for everyone who installs it.

The specific error code is the guarantee, not the failure. A deep import that throws `ERR_MODULE_NOT_FOUND` was
stopped by a file being absent, and a file stops being absent the moment somebody adds one — see
[21-platform](21-platform.md), where a sabotage produced exactly that against a wide-open map.

| Covered | Not covered |
|---|---|
| The five root values | Anything under `dist/` reached directly |
| Every root type export | Internal module paths |
| The documented subpaths | Behaviour a test asserts but no doc describes |
| Adapter factory signatures | The SQL a Postgres adapter emits |
| Storage **port** interfaces, for adapter authors | Table and column names |
| Error `code` values | Error `message` text |
| GraphQL schema shape | Resolver internals |

Two entries in that right-hand column are worth their own sentence, because both look like API to somebody:

**Error messages are not API.** The `code` is — `budget_exceeded` will not become `budget-exceeded` in a minor —
but the sentence beside it is written for a person and will be reworded. Match on the code.

**Table names are not API.** A migration may rename a column; `0024` renamed `period` to `window_key` already.
Use the ports.

## Version policy

Pre-1.0, and **0.x means the minor is the breaking increment** — `0.1.0` → `0.2.0` may remove a root export, and
`0.1.0` → `0.1.1` may not. That is the npm convention for 0.x, and stating it matters because the alternative
reading (that 0.x means nothing is stable) is how a package acquires consumers who are surprised later.

At 1.0 the normal rules apply: major for a removal, minor for an addition, patch for a fix.

## Deprecation policy

A removed export keeps working for **one minor version**, and the consumer is told three ways:

1. **A runtime warning**, once per process per symbol — not once per call, which is how a warning becomes noise
   somebody filters. `core/env.ts` is the working example: it warns once per environment variable, names both
   spellings, and says which release removes the fallback.
2. **A `@deprecated` tag** with the replacement named, so an editor says so before the code is written.
3. **A changelog entry** under `### Deprecated`, with the version that removes it.

The rename in #192 is the shape: `RETINUE_*` variables fall back to their `AGENTKIT_*` spelling and warn once,
and the fallback goes in the next minor. An existing deployment keeps booting.

**Two exceptions, stated so they are not surprises.** A deprecation cycle does not apply to a **security fix**
that requires removing something, or to a value that was never reachable — if the `exports` map refused it, it
was not API and removing it is not a removal.

## The changelog

Generated from the commits, by `npm run changelog`, and not written from memory at release time. A changelog
composed afterwards records what somebody remembers mattering, which is reliably not the same set as what
changed.

Commits carry a type and the issue number. The generator groups by type and links each entry to its issue, so an
entry a reader does not believe can be checked in one click.

## What the release does not yet do

Honest gaps rather than a plan presented as a state:

- **Nothing is published.** Every package is still `private: true`. Both original reasons are gone — the
  `retinue` npm organisation exists and is ours (confirmed by an authenticated `npm org ls`, not by a 404 on the
  registry, which proves nothing: a scope can be held by an org with nothing published), and the licence is
  chosen. What remains is the publish itself, #193 — a pipeline, a provenance identity, and a decision about
  when. Flipping `private` is then a one-line change somebody should make deliberately.
- **No provenance, and no published `next` tag.** Both need a registry and a CI publishing identity, which is
  #193. The *policy* for prereleases is below, because it is needed by a decision already taken (the platform
  consumes this package as a published dependency — [21-platform](21-platform.md)) and it does not need a
  registry to be written down.

## The licence

**Apache-2.0**, for `@retinue/agentkit` and `@retinue/react`.

Chosen for the reason a runtime is licensed at all: installing it should need no conversation. Apache-2.0
carries an explicit patent grant and is the licence an enterprise security review passes without involving a
lawyer, which matters for a package whose whole purpose is to be adopted. MIT would have been shorter and
almost equivalent, minus that patent grant — and the grant is precisely what the audience this is aimed at
checks for.

**It obliges nothing of what is built on top.** The platform ([21-platform](21-platform.md)) lives in its own
repository, consumes this package as a published dependency, and is proprietary. That is exactly what a
permissive licence permits, and it is a further reason the boundary in that document is worth *enforcing*
rather than merely stating: a proprietary product built on a permissive dependency is ordinary; one built by
vendoring the dependency's internals is a licensing question nobody wants to answer later.

A source-available licence (BUSL, Elastic) was the alternative, and it was rejected on the same reasoning:
it would protect the platform's revenue by dampening adoption of the runtime, which is the thing REQ-035 exists
to increase.

The decision is not reversible in the direction that matters. A future version may change licence, but the
licence a consumer already received cannot be withdrawn from the version they have — so this had to be settled
before the first publish, and it was.

`LICENSE` is a byte-identical copy of the canonical Apache-2.0 text
(`sha256 c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`), in the repository root and in each
shipping package. In each package, because `npm pack` includes a `LICENSE` from the package directory and knows
nothing about the root — and `npm run check:consumer` asserts the tarball carries one, since a manifest claiming
a licence over a tarball with no licence text fails somebody else's compliance review rather than one of ours.

## Prereleases on `next`

The platform lives in its own repository and consumes this package as a dependency, which means every runtime
change it needs is a release. Without prereleases that is either a real version per iteration or a workspace
shortcut that dissolves the boundary — so `next` is not a convenience, it is what makes the boundary affordable.

- **Version shape:** `0.2.0-next.3` — the version being worked towards, then `-next.<n>`. Not a date and not a
  commit hash: a consumer reading a lockfile should be able to tell which release a prerelease precedes.
- **Tag:** published under `next`, never `latest`. `npm install @retinue/agentkit` must never resolve to a
  prerelease, which is the one mistake in this area that reaches people who never opted in.
- **Who may depend on one:** our own platform, pinned exactly (`0.2.0-next.3`, not `^`). A caret range over
  prereleases moves under you between installs.
- **What it promises:** the gate passed (`npm run release:check`), and nothing else. A prerelease may remove an
  export that the previous prerelease added. The stable-version rules above start applying at the release.
- **What it is not for:** shipping a fix to a customer faster. That is a patch release; using `next` for it means
  the fix arrives with whatever else was mid-flight.

## What the release path does do

`npm run release:check` runs the whole gate and refuses on any failure: typecheck, every workspace's tests,
boundaries, reachability, script imports, documented imports, the conformance matrix, and the security review's
revisit dates. A release that has not passed it is not a release, and the check is a command rather than a
checklist so "I thought it passed" is not available.
