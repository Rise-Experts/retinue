---
sidebar_position: 6
---

# Human-in-the-Loop

## What is it?

Two durable interaction types that pause a run for a human: **questions** (resolve ambiguity)
and **approvals** (authorize an external action). Both survive restarts and deployments.

## Why would I use it?

Because some actions shouldn't happen without a human — publishing, sending, deleting, paying —
and some ambiguities shouldn't be guessed. HITL makes those pauses **durable and idempotent**:
the run resumes exactly where it stopped, and an approved action executes the *stored* input, not
a model-regenerated one.

## Questions

`ask_questions` is used for consequential ambiguity that context and tools can't resolve. The
question persists as a typed part, the run moves to `WaitingForQuestion`, and an answer queues a
safe continuation.

## Approvals

`request_approval` gates policy-classified actions (publish, schedule, send, delete, external
share, paid changes). The pending approval stores the exact normalized tool + input, risk, cost,
and an idempotency key.

```
Decisions:  allow once · allow for this conversation · always (if policy permits) · deny
```

Resumption executes the **stored input** — so approval can't be bypassed by direct execution,
and a retried publish never double-fires.

## Retry & idempotency

Transient failures retry Claude-style — exponential backoff with jitter, honoring `retry-after`,
only for transient error classes, bounded attempts. Retries are safe because every external write
carries an **idempotency key**. The frontend can show a live retry indicator (attempt / countdown
/ reason).

## What the client sees

Stable transport events — `question.requested`, `approval.requested`, `run.retry-pending`, … —
drive the UI. A page refresh loses no persisted output.

Next: **[Retrieval (RAG)](retrieval)**.
