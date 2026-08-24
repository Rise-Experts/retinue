# Usage, Token Counting and Accounting

Every run consumes tokens and money. This specification defines how the platform counts
that consumption, persists it, enforces ceilings and surfaces it to clients. It builds on
the `Usage event` durable record, the `UsageStore` port and the model pricing metadata
already defined in docs 02 and 03.

## What is counted

Per run, and attributable to each step and tool call:

- Input, output and cached-input tokens.
- Reasoning tokens where the provider reports them separately.
- Cost, derived from the model's input/output/cache pricing at execution time.
- Step count, tool-call count and provider request count.
- Time to first token, wall-clock latency and retries.

Token counts come from two sources: an **estimate** before send (the same tokenizer the
context budget in doc 03 uses) and **actuals** reconciled from the provider response.
Actuals are authoritative; estimates drive budgeting and pre-flight ceiling checks.

## Usage event

```ts
type UsageEvent = {
  id: string;
  tenantId: string;
  conversationId?: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens?: number;
  costMinorUnits: number;      // integer, in the tenant's accounting currency
  currency: string;
  occurredAt: string;
};
```

Events are written in the run's completion transaction alongside final state and audit
records, so usage can never diverge from what actually executed. Events are append-only;
corrections are new compensating events, never edits.

## Recorder and ceilings

```ts
interface UsageRecorder {
  record(context: ExecutionContext, event: UsageEventInput): Promise<void>;
  reserve(context: ExecutionContext, estimate: CostEstimate): Promise<Reservation>;
}
```

- Runtime cost/token ceilings (doc 04) are checked against `reserve()` before a provider
  call. A run that would exceed its ceiling fails clearly rather than overspending.
- Tenant-level quotas (period budget, hard cap) are enforced the same way; an exhausted
  quota blocks new runs with an actionable error.

## Aggregation and reporting

- The `UsageStore` supports cursor-paginated queries and pre-aggregated rollups by tenant,
  principal, conversation, agent, model and time window.
- Rollups are derived from events, never a second source of truth.
- Rollup jobs run through the same `JobDispatcher` as runs.

## Surfacing to clients

- **GraphQL** (doc 06): the usage query returns live per-run and aggregated figures;
  a usage-updated subscription event carries running totals during a run.
- **UI** (doc 06): a token/cost usage component displays per-message token counts, a
  running conversation total and remaining quota, using the headless state — no product
  styling in the generic package.

## Interfaces

- `UsageRecorder` — reservation and recording.
- `UsageStore` — persistence, pagination and rollups.
- `TokenCounter` — provider-aware estimate before send.
- `PricingResolver` — resolves cost from model pricing at execution time.

## Acceptance criteria

- Recorded usage reconciles to provider-reported actuals within a defined tolerance.
- A run cannot exceed its configured cost or token ceiling.
- An exhausted tenant quota blocks new runs with an actionable message.
- Rollups equal the sum of their underlying events.
- Usage is queryable and live-updating without reading provider internals.
- Cost is stored as integer minor units with an explicit currency.

## Rollups and quota enforcement (#139)

The recording hook existed and #100 made it durable. Nothing aggregated it and nothing enforced a limit, so one
customer's consumption was unbounded.

### Rollups are recomputed, not accumulated

`rebuild` reads a bucket's raw events and **replaces** the row. That makes idempotency structural rather than
bookkept: re-running a bucket produces the same numbers, and two workers racing one bucket write the same
value. The alternative — accumulating deltas against a set of applied event keys — needs that set to be
durable, unbounded and exactly right forever, and any gap in it is silent double counting or silent loss.

The cost is one scan per bucket in the *job*. That is what a rollup job is for; the requirement is about the
read path, and a read never touches raw records.

The aggregation and the write are **one statement**, so an event arriving cannot fall between a read and a
write and be dropped from the rollup while sitting in the ledger.

### Staleness is a sequence, not a clock

`usage_records` carries a `bigserial record_seq` and a rollup records the `covers_seq` it aggregated up to. A
bucket is stale when it holds a record with a higher sequence, or has never been rolled up.

A clock cannot answer this question, and the attempts are instructive:

- `now()` is the *transaction* timestamp and constant within one, so a rebuild and an append in the same
  transaction stamp the identical instant.
- `clock_timestamp()` ties under load.
- Either way, equality has to be read as "stale" to stay safe — which makes a bucket that genuinely drained
  indistinguishable from one that did not, and the drain property untestable.

A sequence has no ties and no skew, and it is exactly the fact being compared. It also closes a read anomaly:
a row committed *during* a rebuild gets a higher sequence, so the bucket is correctly still stale, where its
`recorded_at` could plausibly have been earlier than the rollup's stamp.

It matters because the alternative is a silent undercount. An event recorded late — a delayed provider report,
a recovered run replaying its steps — carries an `occurredAt` in the past; judged by that, its bucket looks
already computed and the event is never rolled up.

### Buckets are UTC

Truncation in UTC, deliberately. A tenant-local day makes a bucket's identity depend on a timezone setting that
can change: a rollup written under the old offset belongs to a different day than one written after, so
"yesterday" double-counts an hour or loses one. Presenting totals in local time is a display concern; *storing*
them in one is a correctness bug.

Hour and day, and nothing finer. A minute bucket multiplies the row count sixty-fold to answer a question
nobody asks; anything coarser than a day cannot answer "what did today cost", which is what a quota is about.

### The quota check is at admission

Before the conversation is claimed and before anything is enqueued, so a refused run leaves no slot held, no
job on the queue and no partial answer. A limit enforced mid-run leaves a half-written response, a partial
charge, and a user who has to guess whether to retry.

`QuotaDecision` is a union, so a refusal has no `admitted` shape to hide in — a caller cannot read one as a
permissive default, which for a spend limit is the failure that costs money. The refusal message names the
dimension, the figure, the limit and when it resets; *"quota exceeded"* leaves a user with nothing to do. It is
`retryable` because the limit **resets** — a caller treating it as permanent would give up on a workspace that
is fine again in an hour.

**An absent limit is unbounded, not zero.** A misconfigured quota that blocks everything is an outage; one that
blocks nothing is a bill, and the bill is visible in these very rollups. Token dimensions exist separately from
cost because a model with no pricing costs zero, so a cost limit alone bounds nothing for it.

### Every applicable limit binds, not the most specific one (#182)

A person can be under a personal five-hour cap, a workspace monthly cap and a workspace cap on one model at the
same time. All three are checked, and the first refusal wins.

This resolved a **single** limit until 2026-08-24, choosing the most specific — and a workspace-wide cap on an
expensive model was therefore ignored for anybody who also had a personal overall limit. Configured, readable
through the API, never enforced. They are not competing answers to one question; they are separate allowances.

The rule is **override within a scope, coexist across scopes**: one limit per `(window, model)`, a principal's
row replacing the tenant's for that same scope and touching no other. It lives in `UsageLimitStore.applicable`
so it has one implementation per adapter, held to one behaviour by conformance.

Limits are ordered **shortest span first**, so the one somebody is refused by is the one stopping them soonest —
which is also the one whose reset is nearest, and therefore the only useful thing to quote.

### Two kinds of window (#181)

| | Calendar | Rolling |
|---|---|---|
| Shape | `hour`, `day`, `week`, `month` | `rolling:<minutes>` — "no more than X in any five hours" |
| Read from | The rollup for the bucket | The ledger, over `[now − length, now)` |
| Resets | At a true boundary | **Never** — it slides |

`QuotaWindow` is a discriminated union rather than an optional `minutes` beside `period`, because the two are
read from different places and a shape permitting both would need something to decide which one meant it.

A rolling window **slides**; it is not an anchored session that starts on first use and hard-resets. That was a
choice: an anchored boundary is *state* — knowing which session a spend belongs to means knowing when the
current one began, which cannot be derived without walking history forward from the first run ever. Stored, it
becomes a row that can be stale or missing, and the refusal message quotes it to people. Sliding needs no state,
cannot drift, and cannot be gamed by waiting out a boundary to spend twice the allowance across it.

What it gives up is a clean "resets at", so the message does not claim one. It says when the oldest spend leaves
the window — the first moment any headroom returns.

A rolling window cannot come from a rollup: a five-hour allowance beginning at 09:37 spans parts of six hourly
buckets, and summing them over-counts at both edges. `UsageStore.totalsBetween` answers an exact interval, and
returns the earliest record in it **from the same query** — two queries could disagree about a record that
arrived between them, and the refusal would then quote a reset derived from a different set than the total it
refused on.

### Per-model allowances read the ledger too (#182)

A limit can be scoped to a `modelId`, and then counts only that model's spend. A cap on an expensive model that
a cheap model's traffic can exhaust is the opposite of a per-model limit.

Model-scoped limits are answered from the ledger whatever their window, and the rollups deliberately gain **no**
model dimension: that would multiply their row count by a tenant's model count to answer what a bounded index
scan already answers — the same trade `breakdown` makes. The unscoped calendar path still reads the rollup,
which is the fast path admission depends on.

The refusal names the model. *"You have run out"* reads as an account-wide stop, and somebody whose Opus
allowance is gone can still work on a cheaper model.

The model is a parameter of the admission decision, not a field on `ExecutionContext`: the context is who and
where, and two runs by the same person in the same workspace can be subject to different limits. Absent, a
model-scoped limit does not apply — the direction that cannot refuse the wrong work, and the reason a host must
pass it explicitly.

### A limit nobody can see surprises people (#183)

`QuotaGuard.explain` returns every applicable limit with its allowance, its usage and its reset, computed by the
same reads the refusal path uses. Not a second implementation: a panel with its own idea of "how full is it"
eventually shows somebody a comfortable number while they are being refused.

Callers get an explicit *unbounded* rather than an empty list, because an empty list also means "the request
failed and I am rendering nothing".

One consequence worth stating plainly: a calendar limit is enforced from **whatever the rollups last said**. A
deployment runs the rollup job on a schedule. Running the two window kinds side by side made this visible twice
— once as a five-hour limit reporting 4 while a daily limit reported 2, and again as two overlapping monthly
limits reporting 19 and 23. Both numbers were right about their own source, which is not something anyone should
have to work out from a panel.

### The warning fires below the limit

A customer told at 100% is told when work is already failing. The threshold is a **fraction** so it scales with
the limit rather than being meaningless on a large plan and constantly tripping on a small one.

Refusals are evaluated across every dimension *before* any warning is emitted: warning and then refusing would
tell a customer they are approaching a limit they have already crossed.

A failed warning is logged, not thrown — a notification outage must not become a service outage. A failed
*refusal* notification is also logged, and the refusal still stands: the point of a refusal is to stop work.

The warning goes to its own sink rather than the run event stream, because a `RunEvent` carries a `runId` and
this fires *before* a run exists.

### Reconciliation reports, it does not correct

A discrepancy between our ledger and a provider's invoice has several causes — a rounding difference, an event
we never recorded, a charge for a call we did not make, a provider restatement — and they want different
responses. A job that "corrected" the ledger would erase the evidence needed to tell them apart, and the ledger
is append-only precisely so that evidence survives.

The tolerance is **both** a fraction and a floor, and both are needed: a fraction alone reports every tiny
period as broken (a one-cent difference on a two-cent hour is 50%), and a floor alone stops scaling (a €5
tolerance on a €10,000 month is noise nobody can act on).

A currency mismatch is checked *before* the arithmetic and reported as its own kind with a zero delta.
Comparing two amounts in different currencies is not a discrepancy — it is a meaningless subtraction that would
be quoted as one.

Reconciliation reads the **rollups**, so it costs the same whether a tenant has spent a euro or a million.
`under-recorded` and `over-recorded` are distinct kinds because they point at different investigations: usage
we are not billing for, versus a charge we cannot account for.
