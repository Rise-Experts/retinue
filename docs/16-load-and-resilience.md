# Load, Soak and Failure Injection

REQ-033 (#144). Nobody had observed the platform under sustained load or partial failure, so its behaviour when
a provider is slow, the queue backs up or the database goes away was unknown. The first customer to hit real load
should not be the experiment.

Everything below is **measured**, not estimated. The harness is `src/loadtest`, the runner is
`scripts/loadtest.mjs`, and every number here came out of a JSON report the runner wrote.

```bash
npm run loadtest -- --pg <url> --mode staircase
npm run loadtest -- --pg <url> --mode soak --minutes 480
npm run loadtest -- --pg <url> --mode inject [--stop-container <name>]
```

## What is real, and what is not

Real: a real PostgreSQL server, a real migrated schema, several real `WorkerRuntime` instances competing for one
queue, real atomic lease claims, real checkpoints, a real durable event log, real approval suspension and resume.

Synthetic: **the agent engine**. A load test cannot drive a paid model provider — the cost scales with the load,
the provider's own rate limits become the thing under test, and a provider outage looks like a platform bug.
Nobody load-tests through a third party. What is under test is the platform, and the engine's job is to be a
believable source of latency, failure and external side effects.

Not reached: **a deployed HTTP instance.** #144 asks for one and there is none yet, so the GraphQL layer and the
genuine process boundary between host and worker are not exercised. Everything below them is. This is stated in
every report the runner writes, so a number cannot be quoted without it.

Also not reached: **`redis-unavailable`.** The harness deliberately substitutes a bounded in-process queue for
BullMQ, so the backpressure bound is *ours* rather than a Redis memory setting — which means Redis is not on the
harness's path at all. Running it would prove nothing, so it is declared with its runbook and left unrun.

## The measured envelope — AC-1, AC-6

Measured on 14 cores / 24 GiB, Node 25, darwin-arm64, against PostgreSQL 16 in a local container. Traffic: 3
steps per run, 40 ms of simulated model latency per step, 30% of runs performing an external side effect, 10%
suspending for a human approval. 3 worker runtimes × concurrency 4, queue bound 200.

| Offered | p50 | p99 | Completed | Refused | Peak queue | Peak RSS |
|--:|--:|--:|--:|--:|--:|--:|
| 5/s | 153 ms | 178 ms | 4.9/s | 0 | 0 | 139 MiB |
| 10/s | 146 ms | 165 ms | 9.7/s | 0 | 0 | 135 MiB |
| 20/s | 137 ms | 186 ms | 19.3/s | 0 | 0 | 121 MiB |
| 40/s | 133 ms | 142 ms | 38.0/s | 0 | 0 | 132 MiB |
| **80/s** | **129 ms** | **207 ms** | **76.1/s** | 0 | 6 | 136 MiB |
| 160/s | 2180 ms | 2306 ms | 88.8/s | **301** | **200** (bound) | 130 MiB |

**Sustainable: 80/s. Degrades at 160/s. Manner: honest refusal.**

Read it this way: throughput tracks offered load linearly to 80/s with p99 flat around 200 ms, then at 160/s the
queue fills to its bound, 301 admissions are **refused with a typed error**, and *nothing fails and nothing is
lost*. Memory is flat across the whole range — 121 to 139 MiB, with no trend.

Scale the number by the model latency: this configuration spends 120 ms per run inside a synthetic provider, so
real capacity is bounded by `workers × concurrency / provider latency`. Twelve slots at 130 ms is ~92/s, and 76/s
measured is that minus overhead. **The lever is worker count, not database tuning** — which is worth knowing
before someone spends a week on indexes.

### Latency excludes runs that waited for a human

Deliberately. Their end-to-end time is dominated by how fast the approver answered, which here is the harness's
poll interval and in production is a person. Mixing them in put p99 at ~7 s at *every* step and made the envelope
read "sustainable 0/s" while the platform's real latency was 130 ms. Approval wait is measured separately, for
exactly the reason #143 keeps it a distinct metric: it must be visibly not the platform's latency.

### Two measurement bugs worth recording

Both flattered the system, which is the direction that matters.

**The first measured admission latency, not end-to-end.** `admit()` is a create plus an enqueue — a few
milliseconds however deep the backlog is. The staircase reported "p99 5 ms, sustainable 20/s" for a step whose
queue reached 101 jobs and whose real throughput was 6.9/s. A load test that flatters the system is worse than no
load test, because it converts an unknown into a false belief. Latency now comes from the store's own
`created_at → finished_at`.

**Latency alone is not enough either.** A step can post an excellent p99 while completing a third of what was
offered, because the work that never got picked up contributes no sample at all — the fast runs are measured and
the queued ones are invisible. The envelope now requires completions to stay within 10% of offered load, and
reports `backlog` as a distinct degradation mode from `graceful-queueing`.

## Soak — AC-2

`--mode soak` samples RSS every second and fits growth over the run, discarding the first quarter as warm-up.

**Threshold: 32 MiB/hour.** Above JIT warm-up, heap fragmentation and a pool filling to its configured size;
below anything that survives a night. A process leaking at that rate grows 768 MiB a day.

The detector **refuses to conclude** below 12 samples or 5 minutes, and says which. That arm matters more than
the others: a short run reporting "no leak" is the single most misleading output this harness could produce,
because it looks exactly like a passing result. AC-2 asks for a multi-hour soak *because* a short burst hides
slow growth.

### What was actually measured

A **six-minute** soak, 359 samples:

| | |
|---|---|
| Runs admitted | 15,082 |
| Refused at admission | 0 |
| Completed | **15,082** |
| Failed | **0** |
| Still non-terminal | **0** |
| Server-side DB connections at the end | 14 |
| RSS range | 41 – 153 MiB |
| RSS first quartile → last | 109.7 → 87.2 MiB |
| Growth (post-warm-up fit) | **−325 MiB/h** |
| Verdict | **stable** |
| Admission latency p50 / p99 | 1 ms / 34 ms |

Every admitted run reached a terminal state — including the tenth that suspended for a human and was resumed.
Memory *fell* over the run rather than rising, and the connection count is flat at 14 against a pool of 32, so
neither memory nor connections were being leaked. Admission latency is the enqueue only, and it is quoted as such:
the end-to-end figures are in the envelope table.

**But this is minutes, not hours.** The multi-hour soak AC-2 asks for has **not** been performed. The harness
supports it (`--minutes 480`) and six minutes shows no growth at all, but "no leak over six minutes" is not the
claim AC-2 wants and is not being presented as one — the criterion exists precisely because a short burst hides
slow growth.

Growth is judged by a least-squares fit **and** a quartile comparison, both on the post-warm-up window. Each
catches what the other misses: a fit is robust to a spike but dragged by a ramp, a quartile comparison ignores a
ramp but is fooled by one outlier. The warm-up exclusion was missing at first and the test for it failed — a
20-second ramp to 500 MiB followed by a flat hour fit at ~420 MiB/h and was reported as a leak. The comment
claimed the quartile check handled it; it did not, because the first quartile *was* the ramp. Two checks sharing a
blind spot are one check.

## Failure injection — AC-3

Each mode declares what recovery *means* for it, so "recovered" is not a judgement call made per run. Verdicts
require: no lost work, no duplicated external action, and **recovery without a human**.

| Mode | Result | Evidence |
|---|---|---|
| `worker-kill` | ✅ | Killed 1 of 3 workers holding a lease, mid-run. 40/40 admitted runs terminal; **10 external effects for 10 distinct keys**. |
| `overload` | ✅ | 800 offered against a bound of 25: 771 refused, peak depth exactly 25, 29/29 admitted terminal, 8 effects for 8 keys, RSS 123 → 143 MiB. |
| `provider-rate-limit` | ✅ | 30% of steps rejected. 60/60 terminal, 3 effects for 3 keys. |
| `provider-timeout` | ✅ | 30% of steps timed out. 60/60 terminal, 1 effect for 1 key. |
| `database-unavailable` | ⚠️ **partial** | Real container stopped ~3 s with runs mid-step. 40/40 terminal, 16 effects for 16 keys — **but all 40 needed a manual re-drive.** |
| `redis-unavailable` | not run | Not on this harness's path; see above. |
| `database-failover` | not run | Needs a replica to promote. A single container has none. |
| `slow-consumer` | not run | Declared with its runbook; the harness has no subscriber yet. |

**No duplicated external action, in every mode that ran.** Effects equal distinct idempotency keys every time,
including after a worker was killed mid-run holding a lease. That is the assertion a load test is uniquely able
to make, and it is the one that matters most.

### The finding: a run whose claim fails has no recovery path

`database-unavailable` passes "no data loss" and "no duplicate", and **fails "recovers unattended"** — all forty
runs had to be re-driven. I first assumed that was a harness artifact, because the harness's queue drops a failed
job. It is not: `QUEUE_ATTEMPTS` is **1**, so the production BullMQ queue does not retry either.

So recovery rests entirely on the lease reaper, and the reaper finds runs in `running` with an expired lease. A
run whose **claim itself failed** — the job was consumed, the claim hit a dead database, the run stayed `queued` —
is on no queue and holds no lease. Nothing will ever pick it up.

Recorded rather than fixed here. The queue's retry policy is a #105/#107 decision with consequences beyond this
harness (a retried job that is genuinely poisonous, an attempt budget interacting with the run's own retries),
and choosing it inside a load-test issue would be the wrong place. The verdict is left **failing** so it cannot
be forgotten.

## Backpressure — AC-4

Offered 800 against a queue bound of 25:

- **771 refused** with a typed `resource-exhausted` error reaching the caller.
- **Peak depth exactly 25** — the bound held.
- **29 admitted, 29 terminal.** No admitted work lost.
- **RSS 123 → 143 MiB** across 800 attempts. Bounded, not growing.

A refusal is thrown, not dropped: a silent drop is data loss dressed as backpressure. And a refused admission is
**cancelled**, not left behind — the first version left a `queued` row per refusal, and the overload step then
reported 236 refused *and* 236 stuck, the same runs counted twice.

The single most important operational instruction here is in the `overload` runbook: **do not raise
`maxQueueDepth` to stop the refusals.** That converts an honest "no" into an unbounded backlog, and the queue then
fails by exhausting memory instead of by saying no.

## Per-tenant rate limiting — task #248

Backpressure above is a **deployment-wide** bound: a queue depth that protects the process regardless of who is
filling it. It says nothing about *whose* work is filling it, so one tenant can consume the whole envelope and
every other tenant sees the refusals.

Cost quotas (`docs/12`) are per tenant and do not close that gap either, because they bound **spend over a
period** rather than **capacity right now**. A thousand runs a second, each costing a fraction of a cent, passes
every quota check.

So there is a third control, enforced at admission before the quota check:

| Control | Scope | Bounds | Answered from |
|---|---|---|---|
| Queue depth | Deployment | Work in flight | The queue |
| Cost quota | Tenant | Spend per period | A usage rollup |
| **Rate limit** | **Tenant** | **Admissions per window** | **An atomic counter** |

Rate is checked **first**, because it is one counter increment and a quota check reads a rollup — a tenant
hammering the platform should be turned away by the cheaper check, or the defence is itself proportional to how
hard the client is running.

### Fixed window, and what it costs

The window is identified by its start, truncated to the period — the same decision `bucketStartFor` makes for
rollups, and for the same reason: every process must derive the same window for the same instant without
coordinating. The cost is a boundary burst, so the true worst case over a *sliding* window is 2×`max`. A
sliding-log implementation would fix it and costs a sorted set with one member per request; not worth it, because
the point is to stop a runaway client saturating a fleet and 2× for one boundary does not.

### Absent means unlimited

No policy, or `max: 0`, admits everything. A deployment upgrading into this feature having configured nothing
must keep working — an outage caused by *adding* a safety feature is how safety features get removed.

### The refusal is its own error

`admission_rate_limited`, deliberately not `rate_limited`. That one means a *provider* throttled us and
`decideRetry` treats it as retryable inside the run, which is right there and wrong here: this refusal happens
before a run exists, so there is nothing to retry and no run event to carry it. The refusal goes to a
`RateLimitObserver` for the same reason `QuotaObserver` exists — a `RunEvent` carries a `runId`, and inventing
one for an event about *not* starting a run would be worse than a separate sink.

### Two axes deliberately not implemented

**Concurrent runs per tenant** is a real gap and is not closed here.
`startOrEnqueueRun` serialises runs *within* a conversation, and `serialization.ts` says a conversation-less
run's concurrency is "bounded where it should be: the worker's own limits, and quotas" — a per-process setting
and a spend limit, neither of which stops one tenant occupying every slot in a fleet. It is left out because a
correct implementation must be crash-safe: a counter incremented at admission and decremented at completion
leaks a permanent unit every time a worker dies mid-run. The right home is the existing run **lease**, which
already has a TTL and a heartbeat, so this belongs *with* the lease rather than beside it. Tracked as
[#265](https://github.com/Rise-Experts/retinue/issues/265) rather than shipped leaky.

**Tool executions per run per interval** is not implemented because `ExecutionLimits.maxToolCalls` already bounds
the count and `wallClockTimeoutMs` bounds a tight loop, so a rate would need a clock threaded through the tool
path to constrain something already constrained twice.

## Runbooks — AC-5

`src/loadtest/runbooks.ts`, one per failure mode, kept as data next to the failure matrix so a test asserts the
two agree. A runbook in a wiki drifts from the code silently, and the drift is discovered during the incident it
was written for.

Each has symptoms in the order an operator sees them, how to confirm it is this and not something that looks like
it, what to do, the expected recovery time — and **what not to do**. That last section is the one usually
missing, and most of the damage in an incident comes from a well-intentioned action that fights the recovery
mechanism. A test requires it to be non-empty.

The four sentences most worth having written down in advance:

- **worker-kill**: *"Do not re-drive the runs by hand before the lease expires. The claim is still held, so the
  manual attempt is rejected — and if it were not, it would be the duplicate-external-action bug this platform is
  built to prevent."*
- **provider-rate-limit**: *"Do not add workers. More workers means more concurrent calls against the same
  quota, so throughput falls as the rejection rate rises."*
- **worker-kill**: *"Do not shorten the lease to speed recovery. A lease shorter than a slow step causes a live
  worker to lose its claim mid-run, which is a much worse failure."*
- **slow-consumer**: *"Do not raise a buffer size to give it room. A producer-side buffer is precisely what turns
  one slow client into the platform's memory problem."*

## The same bug, twice, in two different codebases

The platform bug below — a run left in a status nothing will ever pick up — I then **reintroduced in the harness
myself**, within the hour, by copying the fix's ordering without noticing the difference in context.

The fix is "transition to `queued`, *then* enqueue", because the other order lets a worker take the job while the
run is still paused. That is right for the platform, whose queue does not refuse. The harness's queue is
**bounded** and does refuse — so approving every waiting run at once transitioned all of them and had most of the
enqueues rejected, leaving each one in `queued` with no job. 1,293 orphans in a single soak, and the settle loop
spun to its timeout hunting `waiting-for-approval` rows that no longer existed.

**Transition-then-enqueue is only safe when the enqueue cannot fail.** The harness now sizes each approval batch
to `bound - depth()`, and `settle` re-drives anything found in `queued` as a backstop. The soak above is the
evidence it worked: 15,082 admitted, 15,082 completed, **0 still non-terminal**, where the same run before the fix
left 1,293 behind.

What makes this shape survive in both places is that it is *invisible*: a run in `queued` looks exactly like a run
waiting its turn. There is no error, no failed status, nothing in a log. The only way either was found was
counting terminal runs against admitted runs and finding the totals disagree.

## Three harness bugs, because they are the reason to distrust a first run

All three made the platform look worse or better than it is, and none was visible in the output.

**The queue was the bottleneck.** `createBoundedQueue` kept a single `handler` and every `start()` overwrote it,
so three "competing" worker runtimes were one worker — and it awaited each job sequentially, so the queue
processed one job at a time whatever the workers' concurrency was. It reported ~6/s and looked entirely plausible.
A wrong capacity number is indistinguishable from a real one without something to compare it against.

**Killing one worker stopped all of them.** `JobConsumer.stop()` has no handle to say *which* worker is stopping,
so a shared consumer had to clear every registration. The worker-kill injection hung forever waiting for a drain
that could never happen, produced no output at all, and it took a process listing to find. Each worker now gets
its own consumer view.

**`drained()` deadlocked with no workers.** A queue with jobs waiting and no worker to serve them can never
drain, so a caller that stopped its workers and then awaited a drain waited forever — the stuck-run test failed
with a 30-second timeout instead of an assertion. Returning lets the caller discover the runs are stuck, which is
the fact it was trying to establish; blocking hides it behind a hang.

**The traffic mix was biased.** Run fate came from a shared PRNG, so a resumed run drew *different* values than
its first attempt — a run that had performed its external action could come back deciding it never does one.
Replacing it with a hash of the run id fixed the stability and introduced a second bug: plain FNV-1a with two
offset bases gave a 0.03 external-action rate for one id prefix and 0.50 for another, against a configured 0.30.
A biased mix is a load test measuring a different workload than the one it reports, and nothing in the output
would have said so.

## A platform bug the harness found

`createApprovalService.decide` and `createQuestionService.answer` recorded the decision and enqueued the run — and
nothing else. But `RunStore.claim` accepts only `queued`, or `running` with an expired lease, and pausing a run
for a human leaves it in `waiting-for-approval`. So the job was handed to a worker, the claim matched no row, the
run was skipped, and it waited forever.

**Sixty-five of one hundred and sixty runs in a single load step**, silently. It survived because the unit tests
assert `resumed: true` and that a job was enqueued, both of which were exactly true and neither of which is the
run resuming. Only driving a real worker against a real store showed it.

Both services now transition the run to `queued` **before** enqueueing. That order matters: enqueueing first lets
a worker pick the job up while the run is still paused, fail the claim, and drop the only job that would have
resumed it.
