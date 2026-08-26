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

- **Nothing is published yet**, but everything except the act of publishing is in place — see *Releasing*
  below. The `retinue` npm organisation exists and is
  ours (confirmed by an authenticated `npm org ls`, not by a 404 on the registry, which proves nothing: a scope
  can be held by an org with nothing published), the licence is chosen, and both shipping packages are
  publishable with a guard in front of them. What remains is a **decision about repository visibility**, below.
- **No provenance, and no published `next` tag.** Both need a registry and a CI publishing identity, which is
  #193. The *policy* for prereleases is below, because it is needed by a decision already taken (the platform
  consumes this package as a published dependency — [21-platform](21-platform.md)) and it does not need a
  registry to be written down.

## The licence

**MIT**, for `@retinue/agentkit` and `@retinue/react`, held jointly by
[Azeem Sarwar](https://github.com/azeem-sarwar) and [Rise Experts](https://github.com/Rise-Experts).

Chosen for the reason a runtime is licensed at all: installing it should need no conversation. MIT is the
shortest permissive licence and the one every reviewer already recognises, which for a package whose whole
purpose is to be adopted is the property that matters.

**What it gives up, stated because it is the only real difference:** Apache-2.0 carries an *explicit* patent
grant and MIT does not — MIT grants patent rights only by implication. Some enterprise reviews ask for the
explicit grant; most do not. That trade was made deliberately, and it is the one thing to revisit if a large
customer's counsel ever objects.

A source-available licence (BUSL, Elastic) was the other alternative and was rejected on the reasoning of
REQ-035 itself: it would protect the platform's revenue by dampening adoption of the runtime, which is the thing
that REQ exists to increase.

**It obliges nothing of what is built on top.** The platform ([21-platform](21-platform.md)) lives in its own
repository, consumes this package as a published dependency, and is proprietary. That is what any permissive
licence permits, and it is a further reason the boundary in that document is worth *enforcing* rather than
merely stating: a proprietary product built on a permissive dependency is ordinary; one built by vendoring the
dependency's internals is a licensing question nobody wants to answer later.

The decision is not reversible in the direction that matters. A future version may change licence, but the
licence a consumer already received cannot be withdrawn from the version they have — so this had to be settled
before the first publish, and it was.

`LICENSE` carries the canonical MIT body verbatim (identical, excluding the copyright lines, to the text shipped
by `zod`, `graphql` and `pg`) with **two** copyright lines rather than one, because a joint holder who is not in
the notice is not a holder, and the notice is what every consumer is obliged to reproduce. It sits in the
repository root and in each shipping package: `npm pack` includes a `LICENSE` from the package directory and
knows nothing about the root, and `npm run check:consumer` asserts the tarball carries one — a manifest claiming
a licence over a tarball with no licence text fails somebody else's compliance review rather than one of ours.

## Releasing

A release is a **tag**, and the tag names its package:

```
agentkit@0.1.0          the runtime, to `latest`
react@0.1.0             the client, to `latest`
agentkit@0.2.0-next.1   a prerelease, to `next`
```

Per-package rather than one `v0.1.0`, because the versions are independent: a client-only fix must not bump the
runtime, and a shared version teaches consumers that every release affects them. The first release is therefore
two tags — the runtime first, since `@retinue/react` depends on `@retinue/agentkit@^0.1.0` and a client
published against an absent runtime is uninstallable.

`.github/workflows/release.yml` does the rest: resolve the tag, run the whole gate, publish with provenance,
then install the *published* package into a scratch project and check the exported surface against it.

### A publish from a workstation is refused

`scripts/publish-guard.mjs` is wired as `prepublishOnly` on both packages, so npm itself refuses unless GitHub
Actions is running it, the ref is a `<package>@<version>` tag, and the workflow is `Release`. A dry run is
allowed anywhere — refusing it would mean the only way to inspect what would ship is to ship it.

This replaced `private: true`, which used to be what stopped an accidental publish and which also stopped the
real one. `release-check.mjs` fails a publishable package whose `prepublishOnly` is not the guard, so the two
cannot be separated: whoever removes the guard has to remove that check as well, and then they have written down
that they meant to.

The reasoning is about *evidence*, not discipline. A tarball built on a workstation is a tarball nobody can
reproduce: the version is permanent, the artefact is what consumers install forever, and the only record of what
went into it is one person's shell history.

### What blocks the first release, and it is a decision

*(Resolved: the repository is public as of 2026-08-26, and CI moved to hosted runners with it. The constraint
below is kept because it is the reasoning that forced the decision, and because it recurs for anyone forking
this into a private repository.)*

**npm cannot generate provenance for a publish from a private source repository** — GitHub withdrew that in July 2023, for public packages too. npm's trusted publishing (short-lived
OIDC credentials instead of a long-lived token) additionally does not support self-hosted runners, which is the
only kind of runner this project has. So there is no configuration of the release workflow that produces a
provenance-carrying release while the repository is private.

Two ways forward, and they are a choice rather than a fix:

1. **Make the repository public.** Provenance works, trusted publishing works, and hosted Actions minutes cost
   nothing — which is also what has had CI switched off. The cost is that the whole git history becomes public,
   so **every credential ever committed must be rotated first**, and the `pull_request` trigger in `ci.yml` has
   to stop running on a self-hosted runner (a fork's pull request would then execute arbitrary code on our
   hardware — the file already says so).
2. **Publish without provenance.** Delete the preflight step and the `--provenance` flag. Everything else works,
   and #193 AC-3 is then met in the "CI-only, from a tag" half and not in the provenance half.

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
