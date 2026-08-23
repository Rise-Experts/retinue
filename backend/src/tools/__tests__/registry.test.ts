import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId, ToolCallId } from "../../core/ids.js";
import { createAuthorizationPolicy } from "../../authorization/index.js";
import { createMemoryBlobStore, createMemoryIdempotencyStore } from "../../adapters/memory/index.js";
import { createToolRegistry } from "../registry.js";
import type { Tool, ToolDescriptor, ToolProvider } from "../index.js";

const T = asId<TenantId>("t1");

const ctx = (roleIds: string[]): ExecutionContext => ({
  tenantId: T,
  principalId: asId("p1"),
  roleIds: roleIds.map((r) => asId(r)),
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: asId<RunId>("run1"),
});

const descriptor = (over: Partial<ToolDescriptor> & { name: string }): ToolDescriptor => ({
  label: over.name,
  description: `the ${over.name} tool`,
  category: "general",
  inputSchema: {},
  outputSchema: {},
  effect: "read",
  approvalPolicy: "never",
  requiresIdempotencyKey: false,
  ...over,
});

const tool = (d: ToolDescriptor, execute: Tool["execute"]): Tool => ({ descriptor: d, execute });

// A search tool (read), a publish tool (external-write, needs idempotency), a secret tool (unlisted).
const publishState = { count: 0 };
const makeProvider = (): ToolProvider => ({
  id: "test",
  async listTools() {
    return [
      tool(descriptor({ name: "search", inputSchema: z.object({ q: z.string() }) }), async ({ input }) => ({
        ok: true,
        data: { hits: [`result for ${(input as { q: string }).q}`] },
      })),
      tool(
        // External write that is idempotent but does not itself require approval.
        descriptor({ name: "publish", category: "publishing", effect: "external-write", requiresIdempotencyKey: true }),
        async () => {
          publishState.count += 1;
          return { ok: true, data: { published: true, at: publishState.count } };
        },
      ),
      tool(descriptor({ name: "secret", effect: "destructive" }), async () => ({ ok: true, data: "secret" })),
      tool(descriptor({ name: "bigread" }), async () => ({ ok: true, data: { blob: "x".repeat(50_000) } })),
      tool(descriptor({ name: "danger", effect: "destructive", approvalPolicy: "always" }), async () => ({ ok: true, data: "boom" })),
    ];
  },
});

const policy = createAuthorizationPolicy({
  roles: [{ roleId: "editor", permissions: [], tools: ["search", "publish", "bigread", "danger"] }],
});

const registry = () =>
  createToolRegistry({
    providers: [makeProvider()],
    authorization: policy,
    idempotency: createMemoryIdempotencyStore(),
    blobs: createMemoryBlobStore(),
    maxInlineOutputBytes: 1024,
  });

describe("tool catalog — only task-relevant schemas, only authorized tools", () => {
  it("preloads named tools with schemas, keeps the rest compact, hides unauthorized tools", async () => {
    const cat = await registry().catalog(ctx(["editor"]), { preloaded: ["search"], categories: [], excluded: [] });
    expect(cat.preloaded.map((d) => d.name)).toEqual(["search"]);
    expect(cat.preloaded[0]).toHaveProperty("inputSchema"); // preloaded carry schemas
    const discoverable = cat.discoverable.map((e) => e.name).sort();
    expect(discoverable).toEqual(["bigread", "danger", "publish"]);
    expect(cat.discoverable[0]).not.toHaveProperty("inputSchema"); // compact — no schema in context
    // 'secret' is not in the role allow-list → absent from discovery entirely.
    expect([...cat.preloaded, ...cat.discoverable].some((e) => e.name === "secret")).toBe(false);
    expect(cat.meta.map((m) => m.name)).toContain("execute_tool");
  });

  it("excludes tools the policy removes", async () => {
    const cat = await registry().catalog(ctx(["editor"]), { preloaded: [], categories: [], excluded: ["publish"] });
    expect(cat.discoverable.map((e) => e.name)).not.toContain("publish");
  });
});

describe("learn_tools — unauthorized tools are unlearnable", () => {
  it("returns schemas for authorized names and omits the rest", async () => {
    const learned = await registry().learn(ctx(["editor"]), ["publish", "secret"]);
    expect(learned.map((d) => d.name)).toEqual(["publish"]); // secret omitted
    expect(learned[0]).toHaveProperty("inputSchema");
  });
});

describe("execute_tool — re-auth, validation, idempotency, spill", () => {
  it("runs an authorized tool and returns the shared success envelope", async () => {
    const result = await registry().execute(ctx(["editor"]), { name: "search", input: { q: "hi" } });
    expect(result).toEqual({ ok: true, data: { hits: ["result for hi"] } });
  });

  it("rejects an unauthorized tool even when named directly", async () => {
    await expect(registry().execute(ctx(["editor"]), { name: "secret", input: {} })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("validates input against the descriptor schema", async () => {
    const result = await registry().execute(ctx(["editor"]), { name: "search", input: { q: 123 } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("requires an idempotency key for external writes", async () => {
    const result = await registry().execute(ctx(["editor"]), { name: "publish", input: {} });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("replays a retried idempotent call instead of firing the side effect twice", async () => {
    publishState.count = 0;
    const reg = registry();
    const first = await reg.execute(ctx(["editor"]), { name: "publish", input: {}, idempotencyKey: "k1" });
    const second = await reg.execute(ctx(["editor"]), { name: "publish", input: {}, idempotencyKey: "k1" });
    expect(first).toEqual(second);
    expect(publishState.count).toBe(1); // executed once, replayed once
  });

  it("derives an idempotency key from the tool-call identity when none is passed", async () => {
    publishState.count = 0;
    const reg = registry();
    const call = { name: "publish", input: {}, toolCallId: asId<ToolCallId>("tc1") as unknown as string };
    const a = await reg.execute(ctx(["editor"]), call);
    const b = await reg.execute(ctx(["editor"]), call);
    expect(a).toMatchObject({ ok: true });
    expect(publishState.count).toBe(1);
  });

  it("blocks a policy-classified tool from executing directly without an approval grant", async () => {
    const reg = createToolRegistry({
      providers: [makeProvider()],
      authorization: policy,
      idempotency: createMemoryIdempotencyStore(),
      approval: { isAllowed: async () => false }, // no standing grant
    });
    // 'danger' has approvalPolicy 'always' — it must not execute without a grant.
    const result = await reg.execute(ctx(["editor"]), { name: "danger", input: {}, idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("fails closed: a policy-classified tool is refused when no approval check is wired", async () => {
    const reg = createToolRegistry({ providers: [makeProvider()], authorization: policy, idempotency: createMemoryIdempotencyStore() });
    const result = await reg.execute(ctx(["editor"]), { name: "danger", input: {}, idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  /**
   * A one-time approval travels with the call, not with the context — so the registry has to
   * hand it to the check. Without this the resumed run presents a decided approval and the gate never
   * sees it, which is the loop that used to spin: approved once, refused forever.
   */
  it("hands the call's one-time approval to the check, and executes when it satisfies it", async () => {
    const seen: unknown[] = [];
    const reg = createToolRegistry({
      providers: [makeProvider()],
      authorization: policy,
      idempotency: createMemoryIdempotencyStore(),
      approval: {
        async isAllowed(_c, _t, oneTime) {
          seen.push(oneTime);
          return oneTime?.interactionId === "int-1";
        },
      },
    });
    const allowed = await reg.execute(ctx(["editor"]), {
      name: "danger",
      input: {},
      idempotencyKey: "k1",
      approval: { interactionId: "int-1" },
    });
    expect(allowed).toMatchObject({ ok: true });
    expect(seen).toEqual([{ interactionId: "int-1" }]);
  });

  it("still refuses when the call presents a one-time approval the check rejects", async () => {
    const reg = createToolRegistry({
      providers: [makeProvider()],
      authorization: policy,
      idempotency: createMemoryIdempotencyStore(),
      approval: { isAllowed: async () => false },
    });
    const result = await reg.execute(ctx(["editor"]), {
      name: "danger",
      input: {},
      idempotencyKey: "k2",
      approval: { interactionId: "int-forged" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("fails closed even with a one-time approval when no check is wired", async () => {
    const reg = createToolRegistry({ providers: [makeProvider()], authorization: policy, idempotency: createMemoryIdempotencyStore() });
    const result = await reg.execute(ctx(["editor"]), {
      name: "danger",
      input: {},
      idempotencyKey: "k3",
      approval: { interactionId: "int-1" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("passes the one-time approval down to the tool, so a nested gate sees it too", async () => {
    const received: unknown[] = [];
    const gatedProvider: ToolProvider = {
      id: "gated",
      async listTools() {
        return [
          tool(descriptor({ name: "danger", effect: "destructive", approvalPolicy: "always" }), async (input) => {
            received.push(input.approval);
            return { ok: true, data: "ran" };
          }),
        ];
      },
    };
    const reg = createToolRegistry({
      providers: [gatedProvider],
      authorization: policy,
      idempotency: createMemoryIdempotencyStore(),
      approval: { isAllowed: async () => true },
    });
    await reg.execute(ctx(["editor"]), { name: "danger", input: {}, idempotencyKey: "k4", approval: { interactionId: "int-1" } });
    // The delegating envelope runs its own gate; a ticket the registry swallowed would leave that
    // second gate refusing an approved call.
    expect(received).toEqual([{ interactionId: "int-1" }]);
  });

  it("spills a large result and reads it back through read_tool_output", async () => {
    const reg = registry();
    const result = await reg.execute(ctx(["editor"]), { name: "bigread", input: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.spilledOutputRef).toBeDefined();
    const full = await reg.readOutput(ctx(["editor"]), result.spilledOutputRef!);
    expect(full).toMatchObject({ ok: true, data: { blob: "x".repeat(50_000) } });
  });
});
