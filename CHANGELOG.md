## agentkit 0.3.1

### Added

- **server**: `RETINUE_DATABASE_SCHEMA`, so the platform can share a database it does not own ([#190](https://github.com/Rise-Experts/retinue/issues/190)). Platform tables go in the named schema and `search_path` becomes `<schema>, public`, which is what lets one pool serve a platform schema and a product's `public` at once. `retinue migrate` creates the schema; `--status` and `--dry-run` report a missing one and change nothing.

  A patch rather than a minor, deliberately. Nothing changes for a deployment that does not set the variable — no default, no new required configuration — and #193's independent per-package versions mean a `0.4.0` here would fall outside the `^0.3.0` that all eighteen toolkits declare, forcing a release of packages this does not touch.

  Worth knowing why it is not merely a convenience: a missing schema does **not** error. `SET search_path TO retinue, public` succeeds when `retinue` does not exist, and every `CREATE TABLE` then lands in the next schema on the path. Without the provisioning step, 34 migrations would be created in `public` beside another project's tables, reporting success the whole way.

## agentkit 0.3.2

### Fixed

- **server**: the schema is set with a connection **startup parameter** rather than a per-connection `SET`, and verified once at boot ([#190](https://github.com/Rise-Experts/retinue/issues/190)).

  0.3.1 used `pool.on("connect", (c) => c.query("SET search_path …"))`, node-postgres's documented idiom for session state. It works, and pg deprecated it: *"Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0"* — printed on every boot of every process. `options: "-c search_path=…"` needs no query, so the ordering question does not arise at all. Verified that Supabase's pooler forwards it, which was the open question since PgBouncer rejects unknown startup parameters by default.

  A startup parameter fails silently if a pooler drops it — every connection on the default path, every table in the wrong schema, no error anywhere — so one `show search_path` at startup now refuses to boot unless the path is the one that was asked for. Compared as an ordered list rather than a string, since `retinue,public` and `retinue, public` are the same path.

  And a bug that only a real server found: the path carries **no space after the comma**. In libpq's option syntax a space separates options, so `-c search_path=retinue, public` arrives as `search_path` = `retinue,` plus a stray `public`, and Postgres refuses the connection: `invalid value for parameter "search_path": "retinue,"`. Every unit test passed with the spaced form.

## agentkit 0.3.3

### Added

- **agents**: `resolveModel` may return a promise, so a host can resolve a tenant's model from a store ([#279](https://github.com/Rise-Experts/retinue/issues/279)).

  The hook has always taken an `ExecutionContext`, which is what makes per-tenant model resolution expressible at all — but it was called synchronously, so that resolution could not involve I/O. A tenant's provider config lives in a database or a secrets store in every real deployment, so the parameter was passed and could not be acted on.

  ShareFlow hit it head-on ([social_share#462](https://github.com/Rise-Experts/social_share/issues/462)): a workspace that had configured its own provider was served the deployment's model on every conversational turn, silently, with the cost landing on the platform's account. It worked around the routing with a lazily-resolving model that does the lookup inside the AI SDK's own async middleware — but `modelId`, `definition` and `price` are all read off the object the hook returned, before anyone knows which provider will serve the turn. Measured in production: a turn served by `qwen3.8-max` reported `modelId: "gemini-2.5-flash"`. Awaiting fixes the whole record rather than the routing alone.

  **Additive.** `await` on a non-promise yields the value, so every existing synchronous resolver keeps working with no change — asserted by a test rather than assumed. A rejecting resolver propagates with its message intact rather than falling back to another model, which is the silent-fallback failure this exists to end.

## agentkit 0.3.4

### Added

- **memory**: scoped memory — what a group of conversations has learned, not only one person ([#285](https://github.com/Rise-Experts/retinue/issues/285)). A host names the scopes per run (`NewRun.memoryScopes`, e.g. `project:<uuid>`); `createScopedMemoryProvider` gives the turn a bounded "what this project has learned" section per scope; `commitExtractedScopedMemories` writes with the run's conversation, run and person as the source, refuses a scope the run was not given, and can store entries as `proposed` until confirmed. A new `scoped_memory` table (migration `0037`) rather than a column on `principal_memory`, because a project's memory must reach every member and that table's policy is per person. In-memory, Postgres and Supabase adapters, with a tenant-only RLS policy.

- **agents**: a model and a reasoning effort per run ([#286](https://github.com/Rise-Experts/retinue/issues/286)). `run.model` must be in the host's catalogue (`runModels`) — an unknown, retired or ineligible model is refused with a reason, never replaced. `run.effort` (`low | medium | high`) is mapped per provider by `mapReasoningEffort`: Anthropic and Google thinking budgets, OpenAI and Azure `reasoningEffort`; a provider without the concept reports "effort ignored". Usage records carry the effort only when it was applied. Migration `0036` adds `runs.model`, `runs.effort` and `usage_records.effort`.

  A patch rather than a minor, for 0.3.1's reason: both are additive — a run that names no model, effort or scope behaves exactly as before — and a `0.4.0` would fall outside the `^0.3.0` the toolkits declare.

## agentkit 0.3.5

### Fixed

- **server, adapters**: a quiet `error` listener on every queue, worker and Redis connection ([#288](https://github.com/Rise-Experts/retinue/issues/288)).

  A BullMQ `Queue`, `Worker` or ioredis client with no `error` listener prints the whole error object, and ioredis hangs the refused command's arguments off it — payload buffers included, because a queued job's payload is an argument. When production's Redis hit `maxmemory` under `noeviction` and refused every write, the retry loop wrote **55 GB** of logs from the worker alone and filled the disk. The outage was the logging, not the full Redis.

  The listener logs the **message only** (so ioredis's `args` are never reached), capped at 300 characters, and **one line per minute** with the suppressed count on the next line that gets through. The first error is immediate: a rate limit that swallows the first occurrence hides the incident it exists to report, and "once a minute" and "thirty thousand times a minute" read identically without the count.

  Attached where the objects are built rather than left to callers — `createBullMqRunQueue` covers the queue and its connection for the API host, the worker and every embedding consumer, and `cli-worker` covers its connection, each `Worker` and the realtime connection. "The caller remembers" is what produced the 55 GB.

  **Nothing to do on upgrade.** No API, configuration or behaviour changes; a deployment whose Redis is healthy will not notice. Hosts that added their own listener keep it — this one is additional, not a replacement.

- **package**: the `bin` map declared `retinue` twice. The Forge unwind renamed the `forge` entry to `retinue` beside the existing one, leaving a duplicate key that 0.3.4 shipped with. Both values were identical and JSON parsers take the last, so the installed command was always correct — but the manifest was malformed.

## Unreleased

### Changed — BREAKING

- **tools**: `CredentialResolver.resolve` returns a typed `Credential`, not a `string` ([#260](https://github.com/Rise-Experts/retinue/issues/260)). A bare string still works in `createStaticCredentialResolver` and still means a bearer token, so a single-tenant host changes nothing; a host with its own resolver wraps its return in `bearer(...)`. Migration in `docs/19-versioning.md`. **This is a `0.3.0`** — at 0.x the minor is the breaking increment.

### Added

- **knowledge**: a retrieval eval set, and two beliefs it contradicts ([#219](https://github.com/Rise-Experts/retinue/issues/219)) `85a6080b`
- **brand**: the palette as tokens, measured, and applied everywhere ([#218](https://github.com/Rise-Experts/retinue/issues/218)) `58258bfa`
- **tools**: files under a root, and a shell that needs two switches ([#215](https://github.com/Rise-Experts/retinue/issues/215)) `8525fdd5`
- **tools**: a catalogue that can be bounded, searched and switched off ([#210](https://github.com/Rise-Experts/retinue/issues/210)) `18354037`
- **tools**: three toolkits, and the check that was covering less than it claimed ([#214](https://github.com/Rise-Experts/retinue/issues/214)) `a67b473b`
- **tools**: the toolkit pattern, proven with GitHub — and the check that made it enforceable ([#214](https://github.com/Rise-Experts/retinue/issues/214)) `ae30130c`
- **guardrails**: PII and moderation in the box, and the corpus that found a defect in one ([#212](https://github.com/Rise-Experts/retinue/issues/212)) `e2dfebf6`
- **guardrails**: a port for checks we do not ship, enforced where it cannot be walked past ([#211](https://github.com/Rise-Experts/retinue/issues/211)) `c1b0164e`

### Fixed

- **image**: the container carries the toolkits, and a check that says so ([#214](https://github.com/Rise-Experts/retinue/issues/214)) `d49a022c`
- **tools**: the sandbox kills the process group, and returns when the process dies `46311ca6`
- **shareflow**: the inventory's instruction column, and two claims that were strings ([#190](https://github.com/Rise-Experts/retinue/issues/190)) `47cb7474`

### Documentation

- **knowledge**: OKF read, decision recorded, and a defect it found in our parser ([#220](https://github.com/Rise-Experts/retinue/issues/220)) `911a8d79`
- **site**: a path in, one page shape, and samples that have to compile ([#217](https://github.com/Rise-Experts/retinue/issues/217)) `4ec4adea`
- **tools**: the catalogue specification, and a check that every tool is classified ([#213](https://github.com/Rise-Experts/retinue/issues/213)) `34541f29`
- **readme**: a front door that works on npm, and a guard that keeps it that way (#216, #207) ([#216](https://github.com/Rise-Experts/retinue/issues/216)) `e9889666`

### Tests

- **evals**: tool selection does not degrade at 200 tools, and the hypothesis it disproves ([#221](https://github.com/Rise-Experts/retinue/issues/221)) `40566c88`

### Chores

- **changelog**: regenerate `7f828132`
- **changelog**: regenerate `18f22bde`
- **changelog**: regenerate `c9b1f192`
- **changelog**: regenerate `2bc05c15`
- **changelog**: regenerate `090da5c9`
- **changelog**: regenerate `78ddd97f`
- **changelog**: regenerate `cf55d7c5`
- **changelog**: regenerate `8987da3e`

