/**
 * In-memory runtime adapters — `docs/04-durable-runtime-and-hitl.md`.
 *
 * Reference `RunStore`, `CheckpointStore`, `JobDispatcher` and `DistributedLockStore` for tests and
 * dev. The `RunStore` models real lease semantics (atomic claim, expiry, guarded transitions) so the
 * durable-worker guarantees can be proven without Redis/Postgres. Verified by `runStoreConformance`.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { TenantScope } from "../../core/context.js";
import type { RunId, TenantId } from "../../core/ids.js";
import type { RunEvent, RunEventLog } from "../../core/events.js";
import type { CheckpointStore, NewRun, RunStore } from "../../persistence/index.js";
import {
  canTransition,
  isTerminal,
  type DistributedLockStore,
  type JobDispatcher,
  type Run,
  type RunCheckpoint,
} from "../../runtime/index.js";

const conflict = (message: string) =>
  new AgentPlatformError({ code: "conflict", message, retryable: false });
const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Run ${id} not found`, retryable: false });

const leaseAlive = (run: Run, workerId: string, nowIso: string): boolean =>
  run.claimedBy !== undefined &&
  run.claimedBy !== workerId &&
  run.leaseExpiresAt !== undefined &&
  run.leaseExpiresAt > nowIso;

/**
 * How many of a tenant's runs hold a live lease — the concurrency count, in one place.
 *
 * `except` is the run being claimed, which must never count against itself: a worker recovering its own
 * expired lease would otherwise be refused by the very limit the recovery exists to restore.
 */
const liveLeases = (rows: Map<string, Run>, nowIso: string, except?: string): number => {
  let live = 0;
  for (const run of rows.values()) {
    if (run.id === except) continue;
    if (run.status === "running" && run.leaseExpiresAt !== undefined && run.leaseExpiresAt > nowIso) live += 1;
  }
  return live;
};

export const createMemoryRunStore = (): RunStore => {
  const byTenant = new Map<string, Map<string, Run>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };

  return {
    async create({
      tenantId,
      id,
      conversationId,
      agentId,
      agentVersion,
      principalId,
      roleIds,
      input,
      limits,
      model,
      effort,
      memoryScopes,
    }: TenantScope & NewRun) {
      const rows = tenant(tenantId);
      if (rows.has(id)) throw conflict(`Run ${id} already exists`);
      const run: Run = {
        id,
        tenantId,
        // Omitted when absent rather than set to undefined — the reference adapter cannot be more forgiving
        // than the SQL one, or the conformance suite stops meaning anything (#198).
        ...(conversationId === undefined ? {} : { conversationId }),
        agentId,
        agentVersion,
        // Omitted when absent, like `conversationId`: the reference adapter cannot be more forgiving than the
        // SQL one, or the conformance suite stops meaning anything (#202).
        ...(input === undefined ? {} : { input }),
        ...(limits === undefined ? {} : { limits }),
        status: "queued",
        createdAt: new Date().toISOString(),
        // #166. Omitted rather than defaulted when absent, so "not recorded" stays distinguishable from a
        // caller with no roles — the reference adapter cannot be more forgiving than the SQL one here, or the
        // conformance suite stops meaning anything.
        ...(principalId === undefined ? {} : { principalId }),
        ...(roleIds === undefined ? {} : { roleIds }),
        // #286, #285 — omitted when absent, the same rule as every field above.
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(memoryScopes === undefined ? {} : { memoryScopes: [...memoryScopes] }),
      };
      rows.set(id, run);
      return run;
    },

    async findById({ tenantId, id }) {
      return tenant(tenantId).get(id) ?? null;
    },

    async claim({ tenantId, id, workerId, leaseMs, now, maxConcurrent }) {
      const rows = tenant(tenantId);
      const run = rows.get(id);
      if (!run || isTerminal(run.status)) return null;
      if (leaseAlive(run, workerId, now)) return null;
      // Claimable when queued (cold start) or running with an expired lease (recovery).
      if (run.status !== "queued" && run.status !== "running") return null;
      /**
       * The per-tenant concurrency cap — #265.
       *
       * Counted here rather than by the caller, because the count and the claim must be one operation. This
       * adapter gets that for free: there is no await between the count and the write, so nothing can
       * interleave. The SQL adapter has to say the same thing in one statement.
       *
       * Live leases only, and never this run against itself — so a crashed worker's slot returns on expiry,
       * and recovering an expired lease is not blocked by the limit it is trying to satisfy.
       */
      if (maxConcurrent !== undefined && maxConcurrent > 0 && liveLeases(rows, now, id) >= maxConcurrent) return null;
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
      const next: Run = {
        ...run,
        status: "running",
        claimedBy: workerId,
        keepaliveAt: now,
        leaseExpiresAt,
        startedAt: run.startedAt ?? now,
      };
      rows.set(id, next);
      return next;
    },

    async keepalive({ tenantId, id, workerId, leaseMs, now }) {
      const rows = tenant(tenantId);
      const run = rows.get(id);
      if (!run || run.claimedBy !== workerId || isTerminal(run.status)) return false;
      rows.set(id, {
        ...run,
        keepaliveAt: now,
        leaseExpiresAt: new Date(new Date(now).getTime() + leaseMs).toISOString(),
      });
      return true;
    },

    async transition({ tenantId, id, workerId, to, now, error }) {
      const rows = tenant(tenantId);
      const run = rows.get(id);
      if (!run) throw notFound(id);
      if (run.claimedBy !== undefined && run.claimedBy !== workerId)
        throw conflict(`Run ${id} is held by another worker`);
      if (run.status !== to && !canTransition(run.status, to))
        throw conflict(`Illegal run transition ${run.status} -> ${to}`);
      // Terminal or paused-for-interaction: release the claim/lease so a continuation can re-claim.
      const releases = isTerminal(to) || to === "waiting-for-question" || to === "waiting-for-approval";
      const next: Run = {
        ...run,
        status: to,
        ...(error === undefined ? {} : { error }),
        ...(isTerminal(to) ? { finishedAt: now } : {}),
        ...(releases ? { claimedBy: undefined, leaseExpiresAt: undefined } : {}),
      };
      rows.set(id, next);
      return next;
    },

    async requestCancel({ tenantId, id, now }) {
      const rows = tenant(tenantId);
      const run = rows.get(id);
      if (!run || isTerminal(run.status)) return run ?? null;
      const next: Run = { ...run, cancelRequestedAt: run.cancelRequestedAt ?? now };
      rows.set(id, next);
      return next;
    },

    async countLive({ tenantId, now }) {
      return liveLeases(tenant(tenantId), now);
    },

    async reapExpired({ now, limit }) {
      const expired: Run[] = [];
      for (const rows of byTenant.values()) {
        for (const run of rows.values()) {
          if (run.status === "running" && run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= now) {
            expired.push(run);
            if (expired.length >= limit) return expired;
          }
        }
      }
      return expired;
    },
  } satisfies RunStore;
};

export const createMemoryCheckpointStore = (): CheckpointStore => {
  const byTenant = new Map<string, Map<string, RunCheckpoint>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  return {
    async latest({ tenantId, runId }) {
      return tenant(tenantId).get(runId) ?? null;
    },
    async save({ tenantId, checkpoint }) {
      const rows = tenant(tenantId);
      const prev = rows.get(checkpoint.runId);
      // Monotonic: never let a late write regress the persisted sequence.
      if (prev && prev.sequence > checkpoint.sequence) return;
      rows.set(checkpoint.runId, checkpoint);
    },
  } satisfies CheckpointStore;
};

/** Append-only in-memory `RunEventLog` — the durable catch-up half of reconnect, for tests/dev. */
export const createMemoryRunEventLog = (): RunEventLog => {
  const byTenant = new Map<string, Map<string, RunEvent[]>>();
  const runLog = (tenantId: string, runId: string) => {
    let tenant = byTenant.get(tenantId);
    if (!tenant) byTenant.set(tenantId, (tenant = new Map()));
    let log = tenant.get(runId);
    if (!log) tenant.set(runId, (log = []));
    return log;
  };
  /** Sequences already stored per run — the O(1) duplicate check `append` relies on. */
  const sequences = new Map<string, Set<number>>();
  const seenSequences = (tenantId: string, runId: string) => {
    const key = `${tenantId} ${runId}`;
    let set = sequences.get(key);
    if (!set) sequences.set(key, (set = new Set()));
    return set;
  };
  return {
    async append({ tenantId, event }) {
      const log = runLog(tenantId, event.runId);
      const seen = seenSequences(tenantId, event.runId);
      // Idempotent: never store a sequence twice (a retried append is a no-op). Checked against the
      // whole run, not just the tail — gating on `log[last].sequence >= event.sequence` let a
      // duplicate through whenever an earlier out-of-order append had lowered the tail, storing the
      // same sequence twice and handing a replaying client a duplicated event (#94). The Set keeps
      // this O(1), since append is hit once per streamed part.
      if (seen.has(event.sequence)) return;
      seen.add(event.sequence);
      log.push(event);
    },
    async listAfter({ tenantId, runId, after, limit }) {
      const log = runLog(tenantId, runId).filter((e) => e.sequence > after);
      log.sort((a, b) => a.sequence - b.sequence);
      return limit === undefined ? log : log.slice(0, limit);
    },
    async latestSequence({ tenantId, runId }) {
      const log = runLog(tenantId, runId);
      return log.reduce((max, e) => Math.max(max, e.sequence), 0);
    },
  } satisfies RunEventLog;
};

/**
 * Synchronous in-memory job dispatcher. Enqueue records the job; `drain` runs each pending job
 * through the provided processor. Mirrors Twenty's `SyncDriver` — inline execution for tests.
 */
export const createMemoryJobDispatcher = (
  process: (job: { tenantId: TenantId; runId: RunId }) => Promise<unknown>,
): JobDispatcher & { pending: () => number; drain: () => Promise<void> } => {
  const queue: Array<{ tenantId: TenantId; runId: RunId }> = [];
  return {
    async enqueueRun(input) {
      queue.push(input);
    },
    pending: () => queue.length,
    async drain() {
      while (queue.length > 0) {
        const job = queue.shift()!;
        await process(job);
      }
    },
  };
};

/** In-memory lock with TTL expiry. `now` is injectable for deterministic tests. */
export const createMemoryLockStore = (now: () => number = Date.now): DistributedLockStore => {
  const held = new Map<string, number>();
  return {
    async acquire(key, ttlMs) {
      const t = now();
      const expiresAt = held.get(key);
      if (expiresAt !== undefined && expiresAt > t) return null;
      held.set(key, t + ttlMs);
      return {
        released: async () => {
          held.delete(key);
        },
      };
    },
  };
};
