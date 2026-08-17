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

export const createMemoryRunStore = (): RunStore => {
  const byTenant = new Map<string, Map<string, Run>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };

  return {
    async create({ tenantId, id, conversationId, agentId, agentVersion }: TenantScope & NewRun) {
      const rows = tenant(tenantId);
      if (rows.has(id)) throw conflict(`Run ${id} already exists`);
      const run: Run = {
        id,
        tenantId,
        conversationId,
        agentId,
        agentVersion,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      rows.set(id, run);
      return run;
    },

    async findById({ tenantId, id }) {
      return tenant(tenantId).get(id) ?? null;
    },

    async claim({ tenantId, id, workerId, leaseMs, now }) {
      const rows = tenant(tenantId);
      const run = rows.get(id);
      if (!run || isTerminal(run.status)) return null;
      if (leaseAlive(run, workerId, now)) return null;
      // Claimable when queued (cold start) or running with an expired lease (recovery).
      if (run.status !== "queued" && run.status !== "running") return null;
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
      const next: Run = {
        ...run,
        status: to,
        ...(error === undefined ? {} : { error }),
        ...(isTerminal(to)
          ? { finishedAt: now, claimedBy: undefined, leaseExpiresAt: undefined }
          : {}),
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
