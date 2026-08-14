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
