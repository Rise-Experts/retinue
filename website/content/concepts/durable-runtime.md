---
sidebar_position: 8
---

# Durable runtime

## What is it?

The machinery that turns a request into a **durable run**: a worker claims the run, streams the
model's output into typed parts, checkpoints as it goes, and finishes inside a terminal transition.
It's what lets a page refresh, a worker crash, or a provider hiccup happen without losing work or
firing a side effect twice.

## Why would I use it?

In the embedded profile you don't touch it — `createAgent().run()` drives it for you. In the server
profile it's the core: many runs execute concurrently across workers, survive deploys, and stream to
a live UI.

## The guarantees

- **Atomic claim** — a lease-based claim means two workers never process one run.
- **Refresh loses nothing** — each event is checkpointed and appended to a durable event log, so a
  reconnecting client catches up from its cursor with no gap.
- **Safe crash recovery** — a re-claimed run reloads its checkpoint (reconciled against the event
  log) and *finalizes* any tool call that was mid-flight as interrupted — it is never re-run, so no
  external action fires twice.
- **Cooperative cancellation** — a durable cancel request stops the engine and finalizes cleanly.
- **Per-conversation serialization** — at most one run is active per conversation; the rest queue
  FIFO, so message and session-state order are deterministic.

## Retry (Claude-style)

Transient provider failures (`429`, `408`/`409`, `5xx`, `529`) are retried with exponential backoff
+ jitter, honoring any `retry-after`, up to a bounded attempt count; deterministic `4xx` errors fail
fast. A retry only happens **before any output has streamed**, so it never duplicates a partial
answer — and external writes stay safe under retry via idempotency keys. Each retry surfaces a
`run.retry-pending` event carrying `attempt` / `maxAttempts` / `nextAttemptAt`, so the UI can show a
live "attempt 2 of 5" indicator.

## Streaming & reconnect

The runtime emits a stable set of `domain.event` transport events (run lifecycle, `part.added` /
`part.updated`, tool started/completed, `usage.updated`, `context.compacted`, …). Any transport maps
them without changing semantics: `openRunEventStream` (used by the GraphQL subscription) and
`openRunEventSse` both replay the durable log after a cursor, then follow live, de-duplicated by
sequence — so reconnect produces no missing or duplicated parts.

## Usage

Token/cost usage is recorded as each step is realized (append-only, idempotent on `(runId, stepId)`),
so a later failure never loses the usage already consumed. A pre-flight `reserve()` refuses a call
that would exceed the run's cost or token ceiling.

See **[Sessions](sessions)** and **[Human-in-the-loop](human-in-the-loop)**.

## Where this is specified

This page is the shape of the thing. The specification is where the decisions and their reasons live — read it
when you need to know *why* something behaves the way it does, or what was considered and rejected.

- [Durable runtime and HITL](/specifications/durable-runtime-and-hitl)
- [Load and resilience](/specifications/load-and-resilience)
