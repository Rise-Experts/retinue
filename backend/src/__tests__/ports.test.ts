import { describe, expect, it } from "vitest";
import {
  deriveIdempotencyKey,
  type AuthorizationPolicy,
  type RunId,
  type SessionStateStore,
  type TenantId,
  type ToolCallId,
  type UsageRecorder,
} from "../index.js";

// ---- In-memory stubs proving each port is implementable with no adapter ----

const memoryAuthorizationPolicy = (): AuthorizationPolicy => ({
  async can() {
    return { allow: true };
  },
  async filterTools(_ctx, tools) {
    return tools;
  },
  async scope(ctx) {
    return { tenantId: ctx.tenantId, roleIds: ctx.roleIds };
  },
});

const memoryUsageRecorder = (): UsageRecorder => {
  const events: unknown[] = [];
  return {
    async record(_ctx, event) {
      events.push(event);
    },
    async reserve() {
      return { id: "res-1", withinCeiling: true };
    },
  };
};

const memorySessionStateStore = (): SessionStateStore => {
  const rows = new Map<string, { version: number; data: Record<string, unknown> }>();
  return {
    async get({ conversationId }) {
      const row = rows.get(conversationId);
      return row ? { conversationId, version: row.version, data: row.data, updatedAt: "t" } : null;
    },
    async put({ conversationId, expectedVersion, data }) {
      const row = rows.get(conversationId);
      const current = row?.version ?? 0;
      if (current !== expectedVersion) throw new Error("version conflict");
      const version = current + 1;
      rows.set(conversationId, { version, data: { ...data } });
      return { conversationId, version, data, updatedAt: "t" };
    },
  };
};

describe("cross-cutting ports", () => {
  it("each port has a working in-memory stub (compiles + runs)", async () => {
    expect(memoryAuthorizationPolicy()).toBeDefined();
    expect(memoryUsageRecorder()).toBeDefined();
    expect(memorySessionStateStore()).toBeDefined();
  });

  it("deriveIdempotencyKey is deterministic and unique per (tenant, run, tool-call)", () => {
    const a = { tenantId: "t1" as TenantId, runId: "r1" as RunId, toolCallId: "tc1" as ToolCallId };
    expect(deriveIdempotencyKey(a)).toBe(deriveIdempotencyKey(a)); // deterministic
    expect(deriveIdempotencyKey(a)).not.toBe(
      deriveIdempotencyKey({ ...a, toolCallId: "tc2" as ToolCallId }),
    );
  });

  it("session state enforces optimistic concurrency", async () => {
    const store = memorySessionStateStore();
    const ctx = { tenantId: "t1" } as unknown as { tenantId: TenantId };
    const first = await store.put({ ...ctx, conversationId: "c1" as never, expectedVersion: 0, data: { a: 1 } });
    expect(first.version).toBe(1);
    await expect(
      store.put({ ...ctx, conversationId: "c1" as never, expectedVersion: 0, data: { a: 2 } }),
    ).rejects.toThrow(/conflict/);
  });

  // Behavior conformance lands with the real engines (later REQs):
  it.todo("authorization: unauthorized tools are filtered from discovery");
  it.todo("usage: reserve() rejects an estimate over the run ceiling");
  it.todo("session state: read at claim, committed in the completion transaction");
});
