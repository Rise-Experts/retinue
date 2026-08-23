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

`AGENTKIT_GATE_OVERRIDE_ACTOR` and `AGENTKIT_GATE_OVERRIDE_REASON`, both required and both trimmed. In CI they
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

`npm run build` now runs **before** `npm test` in CI, because the gate CLI imports the built `@agentkit/backend`.
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
