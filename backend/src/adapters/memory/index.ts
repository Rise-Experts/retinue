/**
 * In-memory reference adapters — `docs/02-core-and-persistence.md`.
 *
 * The reference implementation used for tests and dev. It implements the storage ports (never
 * the other way round) and is verified by the shared conformance harness, so a Postgres/Supabase
 * adapter can be checked against the exact same behavior.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { Conversation, ConversationStore } from "../../persistence/index.js";

const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Conversation ${id} not found`, retryable: false });
const conflict = (message: string) =>
  new AgentPlatformError({ code: "conflict", message, retryable: false });

/** Monotonic ISO clock, injectable for deterministic tests. */
const defaultClock = (): (() => string) => {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1, 0, 0, 0, ++n)).toISOString();
};

export const createMemoryConversationStore = (
  clock: () => string = defaultClock(),
): ConversationStore => {
  // tenantId → (id → row). Partitioning by tenant makes cross-tenant reads structurally impossible.
  const byTenant = new Map<string, Map<string, Conversation>>();
  const tenant = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  const visible = (c: Conversation) => c.deletedAt === undefined;

  return {
    async create({ tenantId, id, title }) {
      const rows = tenant(tenantId);
      if (rows.has(id)) throw conflict(`Conversation ${id} already exists`);
      const now = clock();
      const row: Conversation = { id, tenantId, title, version: 1, createdAt: now, updatedAt: now };
      rows.set(id, row);
      return row;
    },

    async findById({ tenantId, id }) {
      const row = tenant(tenantId).get(id);
      return row && visible(row) ? row : null;
    },

    async list({ tenantId, limit, cursor }) {
      const all = [...tenant(tenantId).values()]
        .filter(visible)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      const start = cursor ? all.findIndex((c) => c.id === cursor) + 1 : 0;
      const items = all.slice(start, start + limit);
      const nextCursor = start + limit < all.length ? items[items.length - 1]?.id : undefined;
      const page: Page<Conversation> = nextCursor === undefined ? { items } : { items, nextCursor };
      return page;
    },

    async update({ tenantId, id, expectedVersion, patch }) {
      const rows = tenant(tenantId);
      const row = rows.get(id);
      if (!row || !visible(row)) throw notFound(id);
      if (row.version !== expectedVersion)
        throw conflict(`Conversation ${id} version ${expectedVersion} is stale (current ${row.version})`);
      const next: Conversation = {
        ...row,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.archivedAt === undefined
          ? {}
          : { archivedAt: patch.archivedAt === null ? undefined : patch.archivedAt }),
        version: row.version + 1,
        updatedAt: clock(),
      };
      rows.set(id, next);
      return next;
    },

    async softDelete({ tenantId, id }) {
      const rows = tenant(tenantId);
      const row = rows.get(id);
      if (!row || !visible(row)) throw notFound(id);
      rows.set(id, { ...row, deletedAt: clock(), version: row.version + 1, updatedAt: clock() });
    },
  } satisfies ConversationStore;
};

/** Durable-runtime reference adapters (RunStore, CheckpointStore, JobDispatcher, locks). */
export * from "./runtime.js";

/** Session/thread reference adapters (SessionStateStore, run coordinator, binding, unit of work). */
export * from "./sessions.js";

/** Append-only usage ledger reference adapter. */
export * from "./usage.js";

/** Blob store reference adapter (spilled tool output). */
export * from "./blobs.js";

/** Idempotency store reference adapter. */
export * from "./idempotency.js";

/** Skill store reference adapter. */
export * from "./skills.js";
