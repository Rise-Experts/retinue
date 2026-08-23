/**
 * Data retention — REQ-034 (#151).
 *
 * The first retention mechanism in the platform, scoped deliberately to `run_events` alone. That table takes one
 * row per streamed part, so a single long assistant turn writes hundreds and it grows faster than every other
 * table combined. It is append-only by design and nothing has ever deleted from it, so storage and index size
 * grow monotonically with usage and never come back.
 *
 * **Why this is not a method on `RunEventLog`.** The port is append-only *on purpose* — a run's event log is the
 * record crash recovery reconciles against, and a `delete` on the port would put deletion within reach of
 * ordinary run code. A separate maintenance surface makes that impossible by construction rather than by
 * convention, and AC-8 asserts the port is unchanged.
 *
 * Doing one table properly establishes the pattern the rest reuse. Two things here are the pattern rather than
 * this table's specifics: retention is **configuration with a documented default**, and a sweep is **bounded and
 * reports what it removed** so a caller drains a backlog instead of holding one long lock.
 */

import type { SqlExecutor } from "../adapters/postgres/sql.js";

/**
 * How long a run's events are kept.
 *
 * **Provisional, and marked as such.** #151 asks the product owner which it should be — 30 days, 90 days, or
 * indefinite-until-configured — and that is a compliance answer, not a technical one. 90 days is the level the
 * table's own purpose implies: long enough that a customer investigating last quarter's run still has its log,
 * short enough that the largest table in the schema does not grow without bound. Nobody has agreed to it.
 *
 * A deployment overrides it. The default exists so an unconfigured deployment prunes *something* rather than
 * nothing — the failure direction being "an old log was removed" rather than "the disk filled".
 */
export const DEFAULT_RUN_EVENT_RETENTION_DAYS = 90;

/**
 * The statuses whose events may be pruned.
 *
 * Terminal only, and this is the safety property AC-2 names. A `running`, `queued`, `waiting-for-*` or
 * `retry-pending` run can still be reconciled against its log — that is precisely what #93/#94 exist to provide
 * — so deleting its events breaks crash recovery for a run that is still alive. Age is irrelevant to that: a
 * run waiting on a human approval for four months is old *and* still needs its log.
 *
 * Written here rather than inlined in SQL so the list has one home, and so a new non-terminal status cannot
 * silently become prunable by not being mentioned.
 */
export const PRUNABLE_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

export type PruneRequest = {
  /** Delete events created strictly before this instant. ISO-8601. */
  readonly olderThan: string;
  /**
   * Rows per call. Bounded, because an unbounded `DELETE` over this table takes a long-lived lock and blocks the
   * live appends that are the reason the table exists.
   */
  readonly limit: number;
};

export type PruneResult = {
  /**
   * Rows actually removed.
   *
   * The caller's loop condition. Returning it rather than a boolean is what lets `drain` know whether a full
   * batch means "more to do" — and it is the number an operator needs to see that retention is running at all.
   */
  readonly deleted: number;
};

/**
 * The maintenance surface. Narrow on purpose: one operation, and nothing that reads or writes a run.
 */
export interface RunEventPruner {
  prune(input: PruneRequest): Promise<PruneResult>;
}

/** The cutoff for a retention period, from a clock. Exported so a caller does not recompute the arithmetic. */
export const cutoffFor = (input: { readonly now: number; readonly retentionDays: number }): string =>
  new Date(input.now - input.retentionDays * 86_400_000).toISOString();

/**
 * Drain a backlog by calling `prune` until it stops removing rows.
 *
 * A helper rather than a loop inside `prune`, because the two have different failure modes: one long call that
 * dies halfway leaves an operator with no idea how far it got, whereas a loop over bounded calls has made
 * durable progress after every iteration.
 *
 * `maxBatches` is a required ceiling, not an optional one. A loop whose termination depends on the database
 * eventually returning zero is a loop that runs forever the day a bug makes `prune` return a positive count
 * without deleting anything — and it would run forever *inside a maintenance job*, where nobody is watching.
 */
export const drain = async (
  pruner: RunEventPruner,
  input: PruneRequest & { readonly maxBatches: number },
): Promise<{ readonly deleted: number; readonly batches: number; readonly drained: boolean }> => {
  let deleted = 0;
  let batches = 0;
  for (; batches < input.maxBatches; batches += 1) {
    const result = await pruner.prune({ olderThan: input.olderThan, limit: input.limit });
    deleted += result.deleted;
    // A short batch means the backlog is exhausted. Checking the count rather than issuing one more empty call
    // saves a full index scan per drain, which on this table is not free.
    if (result.deleted < input.limit) return { deleted, batches: batches + 1, drained: true };
  }
  // `drained: false` says the ceiling was hit, so a caller can log that there is more to do rather than assuming
  // the table is clean. Silence here would look identical to a finished sweep.
  return { deleted, batches, drained: false };
};
