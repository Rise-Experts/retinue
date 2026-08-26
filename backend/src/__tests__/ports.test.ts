import { describe, expect, it } from "vitest";
import { deriveCallIdempotencyKey, deriveIdempotencyKey } from "../idempotency/index.js";
import { type AuthorizationPolicy, type RunId, type SessionStateStore, type TenantId, type ToolCallId, type UsageRecorder } from "../index.js";

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

  /**
   * The key an approval carries. A resumed run has no provider tool-call id to derive from —
   * the call it executes came off a stored interaction, not out of a model stream — so the call's own
   * identity has to be its arguments. Run-scoped, because a key that collided across runs would make
   * "publish this" next week return last week's result and never publish.
   */
  it("deriveCallIdempotencyKey is stable per (tenant, run, tool, arguments)", () => {
    const base = { tenantId: "t1" as TenantId, runId: "r1" as RunId, toolName: "publish_post" };
    const key = deriveCallIdempotencyKey({ ...base, args: { a: 1, b: 2 } });

    expect(key).toContain("r1"); // run-scoped
    // Argument order is not part of the call's identity, so it must not be part of the key.
    expect(deriveCallIdempotencyKey({ ...base, args: { b: 2, a: 1 } })).toBe(key);
    expect(deriveCallIdempotencyKey({ ...base, args: { a: 2, b: 2 } })).not.toBe(key);
    expect(deriveCallIdempotencyKey({ ...base, toolName: "delete_post", args: { a: 1, b: 2 } })).not.toBe(key);
    expect(deriveCallIdempotencyKey({ ...base, runId: "r2" as RunId, args: { a: 1, b: 2 } })).not.toBe(key);
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
