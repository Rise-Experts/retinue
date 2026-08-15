# Durable Runtime, Streaming and HITL

## Run lifecycle

```mermaid
stateDiagram-v2
  [*] --> Queued
  Queued --> Running
  Running --> WaitingForQuestion
  Running --> WaitingForApproval
  WaitingForQuestion --> Queued
  WaitingForApproval --> Queued
  Running --> RetryPending
  RetryPending --> Queued
  Running --> Completed
  Running --> Failed
  Running --> Cancelled
```

## Durable execution

1. API stores the user message and creates a queued run.
2. Job dispatcher enqueues the run.
3. Worker atomically claims it under a distributed lock.
4. Runtime streams provider and tool events into typed message parts.
5. Worker checkpoints parts and publishes realtime diffs.
6. Completion transaction stores final state, usage and audit information.

Required behavior:

- Atomic claim prevents duplicate workers.
- Periodic checkpointing allows page refresh and worker recovery.
- Keepalive identifies live streams.
- Stale streams are reaped and retried safely.
- Cancellation propagates to provider and tools.
- Reconnect returns persisted state plus missing events.
- Dangling tool calls are finalized as interrupted/errors.
- A conversation may queue another user message while a run is active.

## Runtime limits

Per agent/run:

- Maximum steps and tool calls.
- Wall-clock timeout.
- Input, output and cost ceiling.
- Retry count and backoff.
- Maximum inline tool-output size.

## Retry policy

Transient failures are retried with a Claude/Anthropic-SDK-style policy rather than a naive
fixed loop:

- **Exponential backoff with jitter** between attempts, up to a bounded maximum attempt count.
- **Honor server timing**: when the provider returns a `retry-after` / `retry-after-ms` header,
  wait at least that long before the next attempt.
- **Retry only transient classes**: `429` rate limits, `408`/`409`, `5xx`, and `529` overloaded.
  Deterministic `4xx` validation errors are not retried — they fail fast.
- **Retries are safe because writes are idempotent**: every external/destructive call carries an
  idempotency key (see Idempotency below), so a retried publish/send/schedule returns the original
  result instead of firing the side effect twice.
- The run surfaces `RetryPending` between attempts; exhausting the attempt budget moves it to
  `Failed` with the last error preserved.

## Questions

`ask_questions` is used for consequential ambiguity that cannot be resolved from context or tools. Questions persist as typed message parts. The run moves to `WaitingForQuestion`; an answer mutation records the answer and queues a continuation.

## Approvals

`request_approval` is required before policy-classified actions such as publishing, scheduling, sending replies, deleting, external sharing and paid marketing changes.

Decisions:

- Allow once.
- Allow for this conversation.
- Always allow for principal/tenant/category, when tenant policy permits.
- Deny.

The pending approval stores the exact normalized tool name/input, risk category, summary, estimated cost, expiry and idempotency key. Resumption executes the stored input—not a model-regenerated version.

## Idempotency

Every external/destructive tool requires an idempotency key derived from tenant, run and tool-call identity. A resumed or retried call returns the original result instead of repeating the side effect.

## Transport events

Stable events include:

- Run queued/started/checkpointed/completed/failed/cancelled.
- Content part added/updated.
- Tool started/completed/failed.
- Question requested/answered.
- Approval requested/decided.
- Usage updated.
- Context compacted.

Transports map these events to GraphQL subscriptions, SSE or another channel without changing runtime semantics.

## Acceptance criteria

- Client refresh loses no persisted output.
- Worker termination produces safe recovery without duplicate external actions.
- Pending interactions survive deployment/restart.
- Approval cannot be bypassed through direct tool execution.
- Cancellation and retry states are observable and tested.
- Retries use backoff with jitter, honor `retry-after`, retry only transient classes, and never double-fire an idempotent external write.

