# Testing, Security and Release Criteria

## Test layers

- Schema and serialization tests.
- Adapter conformance suites.
- Runtime state-machine tests.
- Session-state concurrency, run-ordering and thread-compaction tests.
- Provider contract tests using recorded fixtures where allowed.
- Tool authorization and input-validation tests.
- Authorization policy decision, tool-filtering and scope tests.
- Outbound MCP classification, egress-policy and catalog-drift tests.
- Usage reconciliation, ceiling and quota-enforcement tests.
- Automatic schema-provisioning and concurrent-startup tests.
- RLS and cross-tenant isolation tests.
- Queue concurrency, crash and recovery tests.
- HITL resume and idempotency tests.
- GraphQL resolver and subscription tests.
- React reducer/reconnection tests.
- RAG retrieval/citation evaluations.
- ShareFlow workflow end-to-end tests.
- **Reachability**: every declared capability is wired, and every run event has a producer (#170).
- **Test typechecking**: the test files themselves compile under the package's own settings (#276).

## Test files are typechecked (#276)

`npm run check:test-types`, and it is **its own step in `ci:local`** rather than part of `typecheck`.

### The gap it closes

Every package's `tsconfig.json` excludes `src/**/__tests__/**` and `*.test.ts`, deliberately — test output must
never reach `dist`. `npm run typecheck` is `tsc -b`, and Vitest transpiles without typechecking. The result was
that **nothing anywhere typechecked a test file**, and a type error in one was invisible until, and unless, an
assertion happened to fail at runtime.

It surfaced in #225. A test resolver was written as `{ scheme: "basic", username: "a@b.c", secret: "tok" }` —
the field on a `basic` credential is `password`. A plain type error. It compiled, ran, and produced a wrong
`Authorization` header, and was caught only because that test asserted the header's exact bytes. A test
asserting anything less specific would have passed against a credential that was silently wrong.

### Why it matters more than "some tests had type errors"

This repository's discipline is sabotage: change the code, watch the test fail. That rests entirely on the
fixture being right. **A test that constructs a subtly wrong fixture proves something other than what it
claims** — and the cost is not a broken test, it is a passing one, which is indistinguishable from working
software until somebody looks.

The first run found **385 errors across 22 packages**. They were not noise. Among them:

- `quota.test.ts` passed a `clock` to `createRollupJob`, which has no such option — six tests believed they had
  pinned time and were running on the real clock.
- `release-gate.test.ts` set `passed` on an `EvalVerdict` whose field is `pass`, and `graderId`/`graderVersion`
  on the verdict rather than the result. The real fields were never populated.
- `engine-approvals.test.ts` built history as `{ role, text }` where `TurnMessage` carries `content` — so every
  history turn reached the model **empty**, while the test asserted on what the model was asked.
- `agent-tool-policy.test.ts` returned `{ name, score }` where `ToolSearchHit` is `{ entry, score, signals }`,
  so anything reading `hit.entry.name` saw `undefined`.
- `worker.test.ts` yielded an `approval.requested` event carrying `toolCallId`/`toolName`/`requestId`; the event
  carries `interactionId`.
- `authorization.test.ts` gave every fixture tool `approvalPolicy: "required"`, which is not a value the union
  has ever had.
- The `allowAll` authorization stubs returned `{}` from `scope()`, where `PermissionScope` requires `tenantId`
  and `roleIds` — a pre-search filter with no tenant.
- Several `.catch((e) => e)` assertions read `.message` off `T | Error`. `expect(a.message).toBe(b.message)`
  passes **vacuously** when neither call rejected, because `undefined === undefined`.

All 385 were fixed rather than suppressed. Two were fixes to *source*, not tests: the Redis lock store's
`acquire` was typed as returning the port's narrow `LockHandle` while the implementation returned `token`,
`key` and `renew` — so `renew`, the whole lease-extension mechanism, was unreachable to any typed caller. The
widened type then had to be applied with `Omit` rather than an intersection, because an intersection makes the
method an overload set and a call resolves against the *port's* signature first.

### How it works, and why not `vitest --typecheck`

Each package has a `tsconfig.test.json` that `extends` its own `tsconfig.json` — identical `lib`, `jsx`,
`strict` and `noUncheckedIndexedAccess` — and overrides only `noEmit`, `composite` and `rootDir`. So the tests
are held to exactly the rules the sources are, and nothing is emitted. The build config is untouched, and a
test asserts it still excludes tests, so `dist` cannot start carrying fixtures.

`vitest --typecheck` was the alternative. It couples typechecking to the test runner: a full check means
running every test, and it checks through Vitest's transform rather than the package's real config, so what it
enforces can drift from what the build enforces. `tsc -p` is the same compiler the build uses, it is faster,
and a failure names a file and a line rather than a failing test.

The packages are discovered rather than listed — a hard-coded list is the version of this check that silently
stops covering the twenty-third package — and a test plants a deliberate type error, asserts the check fails on
it by name, and removes it.

## The reachability guard (#170)

Four features turned out to be **built, tested and unreachable**: citations (#165), questions (#163), usage
recording (#166) and thread compaction (#169). A fifth and sixth turned up the moment a guard existed —
`run.queued` and `run.checkpointed`, both in the closed event union and emitted by nothing.

That is a pattern rather than six accidents, and it has one cause: **every layer above verifies a piece in
isolation, and nothing verifies that a piece is plugged in.**

Each of them looked finished from every angle a test could see:

| What existed | What was missing |
|---|---|
| `createCitationEmitter`, `CitationPart`, its validator, the renderer, the groundedness graders | any caller |
| `question.requested` in `RUN_EVENT_TYPES`, the worker parking on it, a telemetry span, a frontend reducer case | anything that emitted one |
| `DurableWorkerDeps.usage`, documented and optional, with a conformance-backed store | a deployment that wired it |
| `compactThread` with tests, over a `ThreadSummaryStore` with three adapters | a summariser and a trigger |

A unit test calls the thing. A conformance suite calls the thing. An exhaustive `switch` over a union type is
satisfied by *handling* a case, never by producing one. So "has no caller" is invisible to every layer in the
list above — which is why it needs a layer of its own.

### What it checks

**Every declared capability has a consumer.** `CAPABILITIES` in `scripts/check-reachability.mjs` names each one,
the symbol that produces it, and the scope it must be consumed from — `platform` (wired inside `backend/src`),
`entrypoint` (wired by the shipped `server/src` commands) or `host` (wired by an application).

Most are host-facing on purpose, so "referenced from `backend/src`" would be the wrong test: the emitter is
*meant* to be called from outside. The right test is that the **reference host actually exercises it**, because a
capability the reference host cannot use is a capability no host can use. That is what makes `examples/`
load-bearing rather than decorative.

**Every run event has a producer.** `RUN_EVENT_TYPES` is a closed union that the worker, the reducer, the span map
and the frontend all switch over exhaustively, so an event nobody produces passes every type check in the
codebase. Producers are found by the `type: "…"` literal specifically — searching for the bare string would match
the switches, which is the trap.

### What it does not catch, and why that is fine

A ledger catches what it names. Sabotaging the guard against the real tree proved that twice, and both holes are
now closed with a test each:

- Deleting a wiring call while leaving its **import** in place passed. An import is not a use, and "symbol
  present, wiring gone" is exactly the state being hunted.
- Unwiring the compaction *trigger* passed, because the platform function underneath was still called — by the
  wrapper that nothing then called. One layer of unreachability had replaced another, so the wiring site is now
  named as well as the platform symbol.

Neither is a flaw to fix with cleverness; it is the shape of the tool. An unused-export scan over a library would
be almost all false positives, because every public type exists for a caller outside the repository. A declared
list is the honest shape — the same choice `REGISTERED_PORTS` makes for the conformance suite. Adding a capability
means adding a line, and forgetting to is the failure this catches.

## Evaluation dimensions

- Task completion.
- Correct workflow and tool selection.
- Authorization compliance.
- External-action safety.
- Structured-output validity.
- Groundedness and citation correctness.
- Brand/domain quality for application evaluations.
- Latency, cost and time to first token.
- Recovery after provider, tool, worker and network failures.

## Security requirements

- Explicit tenant scope on every store/tool/context call.
- Authorization before discovery and before execution.
- Secret redaction from prompts, logs and tool results.
- File type/size inspection and optional malware adapter.
- Retrieved/file content treated as untrusted.
- Remote MCP descriptions, hints, resources and prompts treated as untrusted; unclassified MCP tools require approval.
- Outbound MCP endpoints validated against an egress policy; credentials referenced, never inlined.
- Signed, expiring file references.
- Audit records for configuration, approvals and external writes.
- Data-retention and deletion propagation through RAG indexes.
- No arbitrary skill script execution by default.

## Operational requirements

- OpenTelemetry-compatible traces.
- Metrics for tokens, cache, cost, steps, tools and latency.
- Health checks for providers and adapters.
- Dead-letter handling and replay tooling.
- Migrations are versioned and reversible when feasible.
- Model/tool/skill/agent versions recorded per run.

## Package quality

- ESM-first builds with explicit exports.
- Strict TypeScript and runtime schema validation.
- Semantic versioning and changesets.
- API extraction checks for accidental breaking changes.
- Dependency and license inventory generated for releases.
- Examples compile against published package artifacts.

## ShareFlow rollout gates

Before replacing an Agno workflow:

- New workflow passes the same representative cases.
- No security or authorization regression.
- External writes are idempotent.
- Quality is equal or better by human scoring.
- Latency and cost are within the agreed envelope.
- Feature-flag rollback is verified.

## Version 1.0 definition of done

- No generic package imports Twenty or ShareFlow.
- At least two applications validate reuse.
- Memory, PostgreSQL and Supabase adapters pass the conformance suite.
- Runs survive refresh and worker restart.
- Threads carry session state across runs, and runs in one thread never execute concurrently.
- Pending interactions survive deployment.
- Unauthorized tools cannot be learned or executed, native or MCP-imported.
- Token and cost usage reconcile to provider actuals and enforce ceilings and quotas.
- A supported adapter provisions its schema on startup from an empty database.
- RAG citations resolve to exact authorized source locations.
- File and deletion isolation is proven.
- Provider switching requires no application rewrite.
- Evaluation regressions block releases.
- Public APIs, adapter guides, migrations and integration examples are documented.


## Graders and the scoring harness (#141)

#13 delivered the cases and a test that every one is *valid*. Nothing scored anything against them, so quality
was asserted rather than measured — which is what this document exists to prevent.

### Most of the gate is free, and that is earned rather than lucky

Six of the seven expectation kinds are decidable **by code**, because the runtime emits structure: a tool call is
a `tool-call` part, an approval requirement is an `approval` part, and — since #137 — a citation is a `citation`
part carrying its source and excerpt.

| Kind | Graded by | Reads |
|---|---|---|
| `contains` | code | text parts, with partial credit |
| `tool-called` / `tool-not-called` | code | `tool-call` parts |
| `requires-approval` | code | `approval` parts — the *part*, not the call |
| `cites-source` | code | `citation` parts and their fields |
| `structured-valid` | code | absence of `error` parts |
| `refuses` (structural) | code | the run's refusal flag or a `forbidden`/`approval_required` error |
| `refuses` (prose only) | **model** | the answer's text |

"Did it cite?" used to need a model reading prose for a footnote — a judgement call on every case. #137's
structure turned it into a field lookup: **the structure paid for itself in the cost of the gate.**

`requires-approval` reads the approval part, not the tool call, because a run that called the tool and asked
afterwards has not required approval — and grading on the call alone scores that as a pass.

`contains` gives **partial credit**: "mentioned two of three" is genuinely different from "mentioned none", and
collapsing them loses the signal a regression report needs.

### Reproducibility is met by construction

Three things together, and the third is the one that matters:

1. The model, the prompt and the prompt's **version** are pinned and stored **on every result**. A score that
   moved after a prompt edit is not a quality change, and without the version on the result the two are
   indistinguishable.
2. Temperature zero. Necessary, not sufficient — a provider can still vary.
3. A **cache keyed on the exact input**: case id, output text, prompt version, model id. A second run reads the
   first run's answer rather than asking again and hoping. Bumping the prompt version or the model *invalidates*
   rather than silently reusing a verdict from a different instrument.

A cached verdict reports **zero** cost, so re-running the gate does not re-charge for a judgement already paid
for.

The in-memory cache makes a single run reproducible. Reproducibility *across* runs needs a durable one, and that
is the honest boundary — stated rather than implied.

### Aggregates are computed from their evidence

`completeRun` derives the totals and the per-dimension breakdown from the recorded case rows, in one statement.
Accumulating as cases arrive would let a run's totals disagree with its own evidence after a re-record — and the
number that gates a release must be derivable from what it was derived from. Re-completing after a corrected case
recomputes rather than keeping the old figure.

`recordCase` upserts on `(run, case)`, so a resumed run cannot double-count a case it already scored. And it
*replaces* rather than ignoring: a re-scored case must take its new verdict, or a fixed grader could never
update a run.

`latest` returns only **completed** runs. An in-flight run's totals are partial, and comparing against one
reports every case it has not reached yet as a regression. Ties are broken by start then id, because two runs
can finish in the same instant and an unstable "latest" is an intermittently wrong gate.

### The report names cases, not numbers

An aggregate hides a regression offset by an unrelated gain — that is the specific failure the report exists to
prevent, and there is a test where the means are *identical* and the report still names the regressed case.

- A **new** case is not an improvement, or adding easy cases looks like progress.
- A **removed** case is not an improvement either; a dataset that shrinks quietly is a gate that weakens quietly.
- Ordered by how far a case moved, then by id — largest regression first, and stable so a report stays diffable.
- `graderVersionsDiffer` flags a comparison across a grader change: that is a comparison of two *instruments*,
  and the delta cannot be attributed to the platform. Flagged rather than refused, because sometimes it is the
  only comparison available — but never silently, since "quality dropped" and "we recalibrated" look identical
  in the numbers.

### A case the harness cannot grade is a harness failure

An expectation kind with no grader **throws**. A skipped case is a case that has silently stopped gating and
nobody finds out. A case that needs judgement with no judge configured is recorded as a non-pass with an
explicit `unscoreable` reason and counted separately — an omitted case would make the denominator lie, and
scoring it as a quality failure would fail the gate for want of a model rather than for want of quality.

## The release gate (#142)

Scoring without a gate is a dashboard nobody reads. #141 produced the scores; this is the part that stops a
regression shipping.

- Thresholds live in **`evals/thresholds.json`** — data, not code. A threshold that could be computed is one that
  can move without anyone deciding to move it.
- The decision is **`evaluateGate`**, a pure function in `src/evaluation/gate.ts`. No clock, no store, no process
  exit. `scripts/release-gate.mjs` reads files, prints, appends to the trend and sets an exit code — nothing else.
  The wrapper is thin because logic there would be logic the suite does not cover, and the gate is the one script
  whose being wrong is invisible: it fails *open*, by passing.
- The trend is **`evals/trend.json`**, committed and append-only.

### The gate fails on named cases, not only on aggregates

A dimension can sit above its threshold while a specific case that used to pass now fails. Both are checked, both
are reported by name, and every failure is collected before returning rather than short-circuiting — each re-run
of this gate costs what the gate costs, so one-failure-per-run is a real bill.

There is also an **overall mean** backstop, because many small dimension slips that each stay a hair above their
own line are a real way to degrade indefinitely. A test constructs exactly that shape: every dimension above its
threshold, the overall mean below.

`maxRegressedCases` is **zero**, and the file says why. A tolerance here is the one that erodes: with a budget of
one, every release may regress a different case and the gate never fires while quality walks downhill. A
genuinely flaky case gets fixed or removed in a reviewed commit, not bought room for here.

### The thresholds, and why they are what they are

| Dimension | Threshold | Because |
|---|---|---|
| `authorization` | **1.0** | A partial pass means a caller saw data they were not entitled to. Not a quality bar — a security one. |
| `external-action-safety` | **1.0** | One miss is one post published, one message sent, without consent. |
| `groundedness` | 0.9 | #137 made citations structural, so failures are a real missing citation. Below 1.0 only because a corpus legitimately lacks an answer. |
| `tool-selection` | 0.85 | Two defensible tool choices can differ; asserting one exact tool overstates how wrong the other is. |
| `task-completion` | 0.8 | The most subjective dimension. The lowest bar because a strict number here produces noise a team learns to ignore, which costs more than it catches. |

The two safety dimensions being 1.0 is asserted **in a test**, not left to review: that is the one threshold
change that should require deleting a test rather than editing a JSON value. A test also fails the build when a
dataset dimension has no threshold or no stated rationale — the gate warns about an ungated dimension at runtime,
but build time is when it can still be fixed cheaply.

**These numbers are provisional.** The mechanism is complete and tested; the levels have not been ratified by a
product owner. They are what the dataset's design implies, not what anyone has agreed to be held to. Ratifying
them needs a named decision-maker and a baseline from a live scoring run — the same gap #128 records for the
cutover thresholds. Written down rather than presented as agreed.

### A missing baseline is two different situations

The first release of a dataset genuinely has nothing to compare against; a later release with no baseline has
*lost* its comparison. From inside the function they are identical, so `requireBaseline` is an **input** and the
CLI sets it from whether the trend has entries.

Treating both as fatal means the gate can never be adopted. Treating both as fine means the regression check
disappears the day someone regenerates the trend, and nobody notices. Either way the thresholds still apply: a
first release is exempt from the *comparison*, not from the bar.

The baseline is the newest **recorded** release, not the newest passing one. Comparing against the last release
that passed would let a regression land once and then be compared against forever as if it were the standard.

### The override is recorded or it does not exist

`RETINUE_GATE_OVERRIDE_ACTOR` and `RETINUE_GATE_OVERRIDE_REASON`, both required and both trimmed. In CI they
come from a `workflow_dispatch` input, so the actor is `github.actor` — the person who clicked — and the reason is
text they typed. Neither can be defaulted, which is the mechanism: an override suppliable by automation is an
override nobody is accountable for.

- **Half an override is refused**, not ignored. Silently dropping it fails the build for someone who believed
  they had overridden it, and they then reach for a worse workaround. Whitespace is not a reason.
- **`overridden` is its own outcome**, not a pass with a flag. A reader counting passes must not count it, and a
  flag on a pass is a flag the next person's summary drops.
- The override **carries the failures it overrode**, or the trend says "overridden" with no way to learn what for.
- An override present on a green run leaves it a **pass**. Otherwise a CI job that sets the variable
  unconditionally would fill the trend with overrides and a real one would be invisible.
- The process exits **zero** when overridden — that is what an override is for — while the trend entry says
  `overridden`. They disagree on purpose: a green build that shipped past the gate stays discoverable.

### The trend is committed, which is the whole trick

`git log -p evals/` shows the scores, the limits they were judged against, and any override with its actor and
reason, in one place, with no service to keep running.

Each entry **stores the thresholds in force for that release**. That is where AC-2 and AC-3 meet: without it,
"quality improved" and "we moved the bar" produce identical history. A test asserts two entries with the same
scores and different recorded thresholds differ, so a diff distinguishes the two stories.

Entries are deliberately small — case *ids*, no verdicts — with a test on the serialized size. An entry carrying
every case result would make each release a thousand-line diff, and a trend nobody can read in a diff is the same
as not having one. The recording step runs under `if: always()`, because a trend containing only the releases
that passed reads as an unbroken record of quality.

### Cost and runtime

Six of seven expectation kinds are graded by **code**, so the gate's cost is the model calls for the seventh — the
prose-only half of `refuses` — and nothing else. A deterministic run costs **zero**, asserted rather than assumed.
The judge is cached on its exact input, so a re-run of an unchanged case re-charges nothing, and the gate prints
its own cost in minor units on every run: the expense is visible in the output rather than discovered on a bill.

The runtime is dominated by the same thing. The deterministic graders are pure functions over recorded parts —
128 cases score in milliseconds — so the wall clock is the judged subset, which is a small fraction of the
dataset by construction and shrinks further as more expectations become structural.

### Required for release, not for every push

The `release-gate` job runs on a `refs/tags/v*` push and on demand, not on every commit. A gate expensive enough
to matter is one people disable if it fires on every push.

`npm run build` now runs **before** `npm test` in CI, because the gate CLI imports the built `@retinue/agentkit`.
A stale dist is worse than a missing one — the tests then pass or fail against the previous build's logic — so the
CLI test fails immediately with that message rather than as a resolution error.

### The gate's live half

The gate is implemented, tested and wired. It takes a **scored run** as input, and producing one needs a deployed
runtime to score against — which lands with the ShareFlow cutover, not here. Until then the CI step fails with a
message naming why, rather than skipping: a gate that skips when its input is missing is a gate that silently
stops gating the day someone renames a variable.

It is therefore **deliberately not yet in the branch-protection required checks**, because a required check that
cannot pass blocks every release. Registering it there is the last step of the cutover. Stated here rather than
left as a green tick that implies more than it verifies.

## Telemetry (#143)

A run crosses the API host, the queue and a worker. Before this, there was no correlated view, so diagnosing a
production issue meant guessing.

- The port is `src/telemetry` — **ours**, not a vendor's. `Tracer`, `Meter`, `Logger`, and a `TelemetryContext`
  that contains nothing but ids.
- `src/adapters/otel` is the only file in the tree that knows OpenTelemetry exists, and **boundary rule R11**
  makes that a build failure rather than a convention. Exactly R3's shape, for R3's reason: one convenience
  import of `@opentelemetry/api` in a hot path acquires a vendor for the whole platform, and it is invisible in
  review because the import looks like every other import.
- `NOOP_TELEMETRY` means no call site has an `if (telemetry)`. Optional-and-checked would be checked in nineteen
  places and forgotten in the twentieth, and the forgotten one is a crash rather than a missing span.

### One request, one trace, three processes

The link is a **`traceparent` string in the job payload**, because a worker cannot hold a live span object across
a process boundary. `JobDispatcher.enqueueRun` was widened to carry it.

The first version had the wrapper remember the span it had just opened, for the adapter to read back. That is
wrong the moment two enqueues overlap, and overlapping enqueues are the normal case — a racy trace link
attributes one tenant's run to another tenant's request, which is worse than no trace at all. There is a test
with two concurrent enqueues.

The chain is `http.request → run.enqueue → run.claim`, with the enqueue as a **producer** span and the claim as a
**consumer** span: that pair is how a collector draws a queue hop, and without the kinds it renders as a nested
call where a parent ending before its child looks like corruption.

Both fields are **optional**, and have to be: jobs enqueued before this landed are already on the queue, and a
worker that required a traceparent would fail every one. A job without one starts its own trace — a missing link,
not a lost run — and the claim span records `queue.trace_continued: false` so a propagation bug is
distinguishable from an old job. Without that attribute both look like a working trace.

A malformed `traceparent` is treated as absent. `parseTraceparent` returns `null` rather than throwing, because
it sits on the hot path of every request and every job, and telemetry that can break a run is worse than no
telemetry. It is strict about the **all-zero** trace id, though: accepting one puts every caller that failed to
propagate into the same "trace 000…0", which looks like a working trace joining unrelated requests. A missing
trace is obvious; a merged one is not.

### Spans align with run events

`SPAN_FOR_RUN_EVENT` is a **total map keyed by `RunEventType`**, so adding an event type without deciding on its
span is a compile error. Names share their first word with the event, because an operator holding a trace and an
event history matches them by eye.

Three events fold into `run.step` deliberately — `part.added`, `part.updated`, `usage.updated`. A span per
streamed part is thousands per run and buries the model and tool spans someone is actually looking for. The
exceptions are **listed in the test**, not excluded from it: a documented exception and an oversight look
identical when both are simply absent.

### Metrics, and the cardinality rule

Every instrument declares its unit, its description, and **the operational question it answers** — because
"enough to answer 'is it healthy'" is the criterion, and a metric with no question behind it is one nobody looks
at. The unit is in the name as well (`_ms`, `_total`), since a graph legend shows the name and "is that seconds
or milliseconds" is the wrong question during an incident.

Two recording decisions that are easy to get backwards:

- **Claim latency is recorded before the handler runs**, so a queue backing up is visible even when the run then
  fails. A queue backlog and a failing run are different incidents, and a metric that only appeared on success
  hides the first behind the second.
- **Duration is recorded on the failure path too.** A dashboard built only on successes shows latency
  *improving* as things break, because the slow runs are the ones that time out.

A negative claim latency — clock skew between two hosts — is **dropped, not clamped**. A zero is
indistinguishable from a genuinely instant claim, and a p99 built from fabricated zeros reads healthy.

`METRIC_ATTRIBUTE_ALLOWLIST` bounds attributes **in the adapter**, not at call sites. `runId` on a latency
histogram is one line of code and one time series per run: it looks like helpful detail in review and is a
cardinality incident in production, with the bill arriving a month later. Ids belong on spans and logs, which are
sampled and indexed.

### No content in logs, structurally

Two mechanisms, and neither is a rule anyone has to remember.

**The message is a closed union of literals.** `Logger.log` takes a `LogEvent`, not a string. A caller *cannot*
put a prompt in the message because there is no string parameter to put it in. A denylist cannot help here — the
content would be in the message, which a denylist cannot inspect without pattern-matching prose. Adding a log
line means adding a name to `log-events.ts`, which is a reviewed act in a file whose purpose is visible from its
first line.

**Fields are an allowlist.** A denylist has to name every field that must not be logged, forever, including the
one a colleague adds next month. An allowlist names the fields that may be, and the failure direction becomes "an
incident is missing a field" rather than "a prompt is in a third-party index and a backup". Three properties on
top:

- **Primitives only.** An object is dropped even under an allowlisted key: `{ reason: {...} }` is one keystroke
  from being a whole tool input, and the key says nothing about what a nested value holds.
- **Strings are capped at 120 characters** and visibly truncated. An allowlisted key can still be *handed*
  content, so the cap bounds the leak to a fragment — and the truncation marker is how someone notices the bug.
- **A dropped field is reported** as its own `telemetry.fields-dropped` line, naming keys and never values.
  Silent dropping is invisible data loss: whoever needs the field finds it absent and goes looking in the wrong
  place.

Errors are recorded as a **classified code**, never as a thrown object. A stack and a cause chain routinely carry
a URL with a token in it or the argument that caused the throw — #131 found exactly that shape in this codebase,
a service-role key echoed into an error message and therefore into logs. `errorCodeOf` reads a `code` or reports
a constructor name, and refuses a "code" long enough to be a paragraph.

The redaction test seeds a prompt, a message array, an API key, a bearer token, a signed URL and an error stack,
then asserts none of them appears in **the bytes a sink would write**. Not in the call arguments — a mock
capturing those proves the caller's intent and nothing about the output, and the output is what reaches an
aggregator.

### Vendor-neutral, proven rather than claimed

`@retinue/agentkit` has **no runtime dependency on any OpenTelemetry package**. The adapter declares the OTel API
surface it needs as structural interfaces and the caller passes their own providers, so a customer already
running the OTel SDK hands us what they have and a customer running something else implements four small
interfaces.

Structural types that were merely plausible would compile fine and fail on the first real provider, so two test
files close that gap:

1. `otel.test.ts` imports the genuine `@opentelemetry/api` — real `SpanStatusCode` values, a real `Context` built
   by `trace.setSpanContext`, a real provider from the package — and drives the adapter with them.
2. `otel-pipeline.test.ts` runs the **real SDK end to end**: `BasicTracerProvider`, a real `SimpleSpanProcessor`,
   a real `PeriodicExportingMetricReader`, and an in-memory exporter in the place an OTLP exporter goes. It reads
   the trace back out of the exporter and asserts one trace id across request, enqueue and claim, with names and
   units on the metrics.

Swapping the in-memory exporter for `OTLPTraceExporter` is a one-line change in the *host's* wiring, which is
where a collector endpoint belongs — and why we never see a URL. That is the honest form of test step 4: a
running collector is not something a unit test should require, and everything between our port and the wire is
real.

One seam genuinely needs injection. Building an OTel `Context` for a remote parent requires a *function* from the
package we refuse to import, so `remoteContext` is supplied by the host in three lines. Without it the adapter
still works and a trace stops at the process boundary — degrading rather than throwing, because three missing
lines of wiring should cost a trace link and not every request.

### What is instrumented, and what is not

Wired: the enqueue, the claim, model calls, tool calls, and the approval wait. The approval wait is *not* a
wrapper, because the wait is not a function call — the run is suspended, the process may have exited, and the
decision arrives in a different request. Two timestamps is the only shape that can measure a wait spanning a
deploy, and it is often the longest span in a trace and the one that most needs to be visibly not the platform's
latency.

**Not yet wired: the GraphQL request span and the run's own execution spans.** The resolvers and the durable
worker have the seams and the helpers exist; connecting them belongs with the host that owns the GraphQL server,
which the ShareFlow cutover brings. So `http.request` and `run.execute` are declared, tested through the port,
and produced today only by the tests that construct them. Written down rather than left as a span name that
implies a call site.
