# Data Retention

REQ-034 (#151). The first retention mechanism in the platform, scoped deliberately to **`run_events`** alone.

## Why this table first

`run_events` takes **one row per streamed part**, so a single long assistant turn writes hundreds. It grows
faster than every other table combined, it is append-only by design — the port has no delete — and nothing has
ever removed a row from it. Storage and index size grew monotonically with usage and never came back.

Doing one table properly establishes the pattern the rest reuse, rather than inventing a general retention
framework before there is a second case to generalise from. Two things here are the pattern and not this table's
specifics:

- **Retention is configuration with a documented default**, never a constant.
- **A sweep is bounded and reports what it removed**, so a caller drains a backlog instead of holding one lock.

## The retention period

**Default: 90 days.** `DEFAULT_RUN_EVENT_RETENTION_DAYS` in `backend/src/retention/index.ts`.

**It is provisional.** #151 asks the product owner which it should be — 30 days, 90, or
indefinite-until-configured — and that is a compliance answer, not a technical one. 90 days is the level the
table's own purpose implies: long enough that a customer investigating last quarter's run still has its log,
short enough that the largest table in the schema does not grow without bound. Nobody has agreed to it, and the
constant says so.

A default exists at all so that an unconfigured deployment prunes *something* rather than nothing. The failure
direction should be "an old log was removed" rather than "the disk filled".

```ts
import { createPostgresRunEventPruner } from "@retinue/agentkit/adapters/postgres";
import { cutoffFor, drain, DEFAULT_RUN_EVENT_RETENTION_DAYS } from "@retinue/agentkit/observability";

const pruner = createPostgresRunEventPruner(sql);
const result = await drain(pruner, {
  olderThan: cutoffFor({ now: Date.now(), retentionDays: DEFAULT_RUN_EVENT_RETENTION_DAYS }),
  limit: 5_000,
  maxBatches: 200,
});
// result.drained === false means the ceiling was hit and there is more to do.
```

## The safety predicate — never prune a live run

**Events belonging to a non-terminal run are never deleted, whatever their age.** A `running`, `queued`,
`waiting-for-*` or `retry-pending` run can still be reconciled against its log — that is precisely what #93/#94
exist to provide — so deleting its events breaks crash recovery for a run that is still alive.

Age is irrelevant to that, and the case that makes it obvious: **a run waiting on a human approval for four
months is old *and* still needs its log.**

`PRUNABLE_RUN_STATUSES` is `('completed', 'failed', 'cancelled')`, exported so the SQL and the documented rule
cannot drift. A test enumerates every status *not* in that list and asserts none is prunable — derived from
`RUN_STATUSES` rather than hand-written, so a new non-terminal status is covered the day it is added.

The join lives **inside the candidate subquery**, so a non-terminal run's rows are never even *selected*. They
cannot be deleted by a later mistake in the outer statement.

## The sweep

```sql
DELETE FROM run_events
 WHERE ctid IN (
   SELECT e.ctid FROM run_events e
     JOIN runs r ON r.tenant_id = e.tenant_id AND r.id = e.run_id
    WHERE e.created_at < $1 AND r.status IN ('completed','failed','cancelled')
    ORDER BY e.created_at
    LIMIT $2
 )
 RETURNING ctid
```

**`ctid IN (SELECT … LIMIT n)`.** The bound has to be on the rows *selected*, and Postgres has no
`DELETE … LIMIT`. Selecting `ctid` — the physical row locator — lets the subquery do a bounded, index-driven
scan and the delete touch exactly those rows. A correlated tuple list on `(tenant_id, run_id, sequence)` is a
much larger comparison per row for no benefit.

**`ORDER BY created_at`.** Oldest first, so a bounded sweep makes progress at the end of the table that will
never come back. Without it the sweep nibbles wherever the scan happened to reach, and genuinely ancient rows can
survive arbitrarily many bounded runs.

**No row locking, deliberately.** `FOR UPDATE SKIP LOCKED` is absent: two concurrent sweeps selecting overlapping
`ctid`s is harmless, because the second `DELETE` matches no row for the ones already gone and simply reports a
smaller count. Adding locks would serialise the sweeps and hold them across the join — exactly the blocking the
batching exists to avoid. **Idempotency comes from a delete being a no-op on an absent row, not from exclusion.**

**A non-positive limit is answered without touching the database.** A maintenance loop with a misconfigured batch
size should not generate load.

## The index

Migration `0021_run_events_retention` adds `run_events (created_at, tenant_id, run_id)`.

The primary key is `(tenant_id, run_id, sequence)`, and `created_at` is not a prefix of it — so an age-based sweep
without this index is a **sequential scan over the largest table in the schema**.

The two trailing columns are the join key the safety predicate needs, so the candidate scan can be **index-only**
with no heap fetch per row. On a table where the interesting case is "millions of rows, most of them prunable",
that is the difference between a sweep that finishes and one that thrashes the buffer cache.

**Verified with `EXPLAIN` against a real server, by name** — not asserted as "not a Seq Scan", which would pass on
any other index the planner happened to pick. The test inserts 20,000 rows and runs `ANALYZE` first, because on a
small table a sequential scan genuinely *is* cheaper and the planner is right to choose it; asserting otherwise
would be asserting the planner is wrong.

## `RunEventLog` gains nothing

The port is append-only **on purpose**. A run's event log is the record crash recovery reconciles against, and a
`delete` on the port would put deletion within reach of ordinary run code. Pruning lives on a separate
maintenance surface — `RunEventPruner` — so that is impossible by construction rather than by convention.

A test asserts the interface declaration contains no `delete`, `remove`, `prune`, `truncate` or `purge`, and also
that it still contains `append`, `listAfter` and `latestSequence` — so it cannot pass by the interface having
been renamed away.

## Not in this SPEC

- **No scheduler.** Pruning is a callable operation. Wiring it to a cron or the worker's maintenance loop belongs
  with the worker entrypoint (#107), and coupling them here would have blocked this on that.
- **No audit record of what was removed.** #151 raises it as an open product question: should a customer be shown
  that deletion happened? Left unanswered rather than guessed, because the answer determines whether the sweep
  needs a durable write of its own.
- **Only `run_events`.** Every other table still grows without bound. This is the pattern, not the coverage.

## Two coincidental passes, from sabotage

Both worth recording, because a test that passes for the wrong reason is worse than a missing one.

**The ordering test.** It seeded the older run first, and PGlite's scan returned rows in insertion order — so
"oldest first" held by accident and the assertion was about the fixture rather than the query. Removing
`ORDER BY` left every test green. The fixture now inserts the *newer* run first, so insertion order is the
opposite of age order.

**The down-migration test.** It called `rollback()`, which reverses every migration and drops the `run_events`
table, taking the index with it. Replacing the down statement with `SELECT 1` left the test green: it was
asserting that dropping a table removes its indexes, which Postgres guarantees and nobody doubted. It now runs
**this migration's own down statements** and asserts the table survives.
