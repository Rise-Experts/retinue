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

- **Nothing is published.** Every package is `private: true`, and the npm scope is not claimed yet — see #192's
  AC-1. The publish itself is #193.
- **The licence is `UNLICENSED`**, which is a real value meaning "not licensed for public use" and the correct
  one until somebody chooses otherwise. **Choosing it is a business decision, not an engineering one**, and it
  has to be made before the first publish: after that, the licence a consumer received cannot be withdrawn from
  the version they have.
- **No provenance, no `next` tag.** Both need a registry and a CI publishing identity, which is #193.

## What the release path does do

`npm run release:check` runs the whole gate and refuses on any failure: typecheck, every workspace's tests,
boundaries, reachability, script imports, documented imports, the conformance matrix, and the security review's
revisit dates. A release that has not passed it is not a release, and the check is a command rather than a
checklist so "I thought it passed" is not available.
