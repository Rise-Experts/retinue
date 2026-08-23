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
