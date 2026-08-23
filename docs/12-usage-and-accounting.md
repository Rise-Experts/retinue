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
