/**
 * The logic-function tool envelope (#113).
 *
 * Every assertion here is about something the envelope guarantees **so a capability author cannot
 * forget it**. The delegate in each case is a counter — what matters is whether it was called, how
 * often, and what ran before it.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId, TenantId, ToolCallId } from "../../core/ids.js";
import type { ExecutionContext } from "../../core/context.js";
import type { AuthorizationPolicy, Decision } from "../../authorization/index.js";
import { createMemoryApprovalGrantStore, createMemoryIdempotencyStore } from "../../adapters/memory/index.js";
import { createApprovalGate } from "../../hitl/service.js";
import { deriveIdempotencyKey } from "../../idempotency/index.js";
import { defineDelegatingTool, fallbackIdempotencyKey } from "../delegating.js";

const T1 = asId<TenantId>("env-t1");
const CONVO = asId<ConversationId>("env-c1");
const RUN = asId<RunId>("env-r1");

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext =>
  ({
    tenantId: T1,
    principalId: asId("env-p1"),
    conversationId: CONVO,
    runId: RUN,
    roleIds: ["member"],
    ...over,
  }) as unknown as ExecutionContext;

/** A policy that records what it was asked and answers as told. */
const policy = (allow: boolean) => {
  const asked: { action: string; type: string; id?: string }[] = [];
  const authorization: AuthorizationPolicy = {
    async can(_context, action, resource): Promise<Decision> {
      asked.push({ action, type: resource.type, ...(resource.id === undefined ? {} : { id: resource.id }) });
      return allow ? { allow: true } : { allow: false, reason: "not your tool" };
    },
    async filterTools(_context, tools) {
      return tools;
    },
    async scope(context) {
      return { tenantId: context.tenantId, roleIds: [] };
    },
  };
  return { authorization, asked };
};

/** A capability plus the order in which its stages ran. */
const capability = (options: {
  readonly allow?: boolean;
  readonly effect?: "read" | "external-write";
  readonly withApprovals?: boolean;
  readonly withIdempotency?: boolean;
  readonly granted?: boolean;
  readonly delegate?: (input: { draftId: string }) => unknown;
} = {}) => {
  const trace: string[] = [];
  const { authorization, asked } = policy(options.allow ?? true);
  let delegateCalls = 0;

  const grants = createMemoryApprovalGrantStore();
  const approvals = createApprovalGate({ grants });
  const idempotency = createMemoryIdempotencyStore();

  const traced: AuthorizationPolicy = {
    ...authorization,
    async can(context, action, resource) {
      trace.push("authorize");
      return authorization.can(context, action, resource);
    },
  };
  const tracedApprovals = {
    async isAllowed(...args: Parameters<typeof approvals.isAllowed>) {
      trace.push("approval");
      // A standing grant is what `isAllowed` looks for; `granted` decides whether one exists.
      return options.granted === true ? true : approvals.isAllowed(...args);
    },
  };
  const tracedIdempotency = {
    async get<T>(input: { tenantId: string; key: never }) {
      trace.push("idempotency-get");
      return idempotency.get<T>(input);
    },
    async put<T>(input: { tenantId: string; key: never; result: T }) {
      trace.push("idempotency-put");
      return idempotency.put<T>(input);
    },
  };

  const tool = defineDelegatingTool<{ draftId: string }, { published: string }>(
    {
      authorization: traced,
      ...(options.withApprovals === false ? {} : { approvals: tracedApprovals as never }),
      ...(options.withIdempotency === false ? {} : { idempotency: tracedIdempotency as never }),
    },
    {
      name: "publish_post",
      description: "Publish a draft",
      category: "publishing",
      effect: options.effect ?? "external-write",
      delegatesTo: "twenty-sdk:publishPost",
      delegate: (input) => {
        trace.push("delegate");
        delegateCalls += 1;
        return (options.delegate?.(input) ?? { published: input.draftId }) as { published: string };
      },
    },
  );

  return { tool, trace, asked, delegateCalls: () => delegateCalls, grants };
};

/** AC-1. */
describe("authorisation", () => {
  it("authorises before anything else, at execution time", async () => {
    const c = capability({ granted: true });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });

    expect(result.ok).toBe(true);
    // Re-authorised here even though discovery already filtered the catalog: a role can change between
    // the two, and a stale catalog must not amount to a permission.
    expect(c.trace[0]).toBe("authorize");
    expect(c.asked).toEqual([{ action: "execute", type: "tool", id: "publish_post" }]);
  });

  it("refuses an unauthorised caller without calling the delegate", async () => {
    const c = capability({ allow: false, granted: true });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
    // The whole point of the envelope: a refusal happens before the side effect, and the capability
    // author wrote nothing to make that true.
    expect(c.delegateCalls()).toBe(0);
    expect(c.trace).toEqual(["authorize"]);
  });
});

/** AC-2. */
describe("the approval gate", () => {
  it("refuses an external write with no standing grant, and never reaches the delegate", async () => {
    const c = capability();
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
    expect(c.delegateCalls()).toBe(0);
    // Ordering: authorised, looked up, gated — and stopped. The delegate is not told an approval was
    // needed, refused or granted; this envelope decides *whether*, `hitl/service.ts` decides *how*.
    expect(c.trace).toEqual(["authorize", "idempotency-get", "approval"]);
  });

  it("proceeds once a grant exists", async () => {
    const c = capability({ granted: true });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    expect(result.ok).toBe(true);
    expect(c.trace).toEqual(["authorize", "idempotency-get", "approval", "delegate", "idempotency-put"]);
  });

  it("does not gate a read", async () => {
    const c = capability({ effect: "read" });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    expect(result.ok).toBe(true);
    // No approval stage at all: gating a read would ask a human to approve looking at something.
    expect(c.trace).not.toContain("approval");
  });

  it("refuses rather than proceeding when the gate is not wired", async () => {
    const c = capability({ withApprovals: false });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_unavailable");
    // An unwired dependency must not become permission to perform an unapproved side effect.
    expect(c.delegateCalls()).toBe(0);
  });
});

/** AC-3. */
describe("idempotency", () => {
  it("calls the delegate once for a retried call and returns the stored result", async () => {
    const c = capability({ granted: true });
    const key = deriveIdempotencyKey({ tenantId: T1, runId: RUN, toolCallId: asId<ToolCallId>("call-1") });

    const first = await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: key });
    const second = await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: key });

    expect(first).toEqual(second);
    // The guarantee, stated as a number: the external side effect happened once.
    expect(c.delegateCalls()).toBe(1);
  });

  it("prefers the caller's key over the argument-derived fallback", async () => {
    const c = capability({ granted: true });
    const keyA = deriveIdempotencyKey({ tenantId: T1, runId: RUN, toolCallId: asId<ToolCallId>("call-a") });
    const keyB = deriveIdempotencyKey({ tenantId: T1, runId: RUN, toolCallId: asId<ToolCallId>("call-b") });

    await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: keyA });
    await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: keyB });

    // Two distinct tool calls with identical arguments are two actions, and both must happen. The
    // argument-derived fallback would have collapsed them into one — which for "publish this post"
    // means the second publish silently never happens.
    expect(c.delegateCalls()).toBe(2);
  });

  it("falls back to an argument-derived key when the caller supplies none", async () => {
    const c = capability({ granted: true });
    await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    // Without a key the envelope still protects the call, at the cost of the broader collision
    // documented on `fallbackIdempotencyKey` — better than no protection for an external write.
    expect(c.delegateCalls()).toBe(1);
  });

  it("treats reordered arguments as the same call", async () => {
    // `{a, b}` and `{b, a}` are the same arguments. Two keys for one call would defeat the guarantee.
    const first = fallbackIdempotencyKey({ context: ctx(), toolName: "t", args: { a: 1, b: 2 } });
    const second = fallbackIdempotencyKey({ context: ctx(), toolName: "t", args: { b: 2, a: 1 } });
    expect(first).toBe(second);
    // ...and genuinely different arguments must not collide.
    expect(fallbackIdempotencyKey({ context: ctx(), toolName: "t", args: { a: 2 } })).not.toBe(first);
  });

  it("does not cache a failure, so a transient error can be retried", async () => {
    let attempts = 0;
    const c = capability({
      granted: true,
      delegate: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider hiccup");
        return { published: "d1" };
      },
    });
    const key = deriveIdempotencyKey({ tenantId: T1, runId: RUN, toolCallId: asId<ToolCallId>("call-1") });

    const failed = await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: key });
    expect(failed.ok).toBe(false);

    const retried = await c.tool.execute({ context: ctx(), input: { draftId: "d1" }, idempotencyKey: key });
    // Asserting the delegate *ran again* and produced the real answer, not merely that the call
    // succeeded. An earlier version checked only `ok`, and passed against an implementation that
    // cached the failure as a null result — the retry then "succeeded" while returning nothing and
    // never touching the provider. Stored only after success is what makes a transient error transient.
    expect(attempts).toBe(2);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.data).toEqual({ published: "d1" });
  });

  it("refuses a gated effect with no store rather than performing it unprotected", async () => {
    const c = capability({ withIdempotency: false, granted: true });
    const result = await c.tool.execute({ context: ctx(), input: { draftId: "d1" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_unavailable");
    expect(c.delegateCalls()).toBe(0);
  });
});

/** AC-5 and AC-6. */
describe("descriptor and envelope", () => {
  it("names the function it delegates to, on the descriptor", async () => {
    const c = capability();
    // On the descriptor rather than only at the definition site, so "which existing function does this
    // wrap" is answerable from a catalog dump or a log line — which is the question the bridge exists
    // to make answerable.
    expect(c.tool.descriptor.delegatesTo).toBe("twenty-sdk:publishPost");
  });

  it("classifies effects exactly as a plain tool does", async () => {
    const c = capability();
    // Defaults come from `defineTool`, so a delegating tool and a plain one cannot disagree about what
    // an external write requires.
    expect(c.tool.descriptor.approvalPolicy).toBe("always");
    expect(c.tool.descriptor.requiresIdempotencyKey).toBe(true);
    expect(capability({ effect: "read" }).tool.descriptor.requiresIdempotencyKey).toBe(false);
  });

  it("returns the existing ToolResult shape on both paths", async () => {
    const ok = await capability({ granted: true }).tool.execute({ context: ctx(), input: { draftId: "d1" } });
    expect(Object.keys(ok).sort()).toEqual(["data", "ok"]);

    const failed = await capability({ allow: false }).tool.execute({ context: ctx(), input: { draftId: "d1" } });
    // Same envelope as any other tool, so no frontend reducer needs to change (AC-5).
    expect(Object.keys(failed).sort()).toEqual(["error", "ok"]);
  });
});

/** AC-4 — enforced by the build, so this asserts the rule exists and fires. */
describe("the envelope performs no I/O of its own", () => {
  it("is caught by the boundary checker when it would", async () => {
    const { scan } = await import("../../../../scripts/check-boundaries.mjs");
    const { writeFile, rm } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // An absolute root: the checker resolves roots against the process cwd, which under vitest is the
    // backend workspace rather than the repository, so the literal "backend" finds nothing.
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const planted = new URL("../planted-violation.ts", import.meta.url);

    await writeFile(
      planted,
      `import { request } from "node:http";\nexport const nope = () => request;\n`,
      "utf8",
    );
    try {
      const violations = (scan as (roots: string[]) => { file: string; rule: string }[])([root]);
      // The rule has to fail the build, not sit in a review checklist — "the envelope must delegate"
      // is a guarantee only while something checks it.
      const r7 = violations.filter((v) => v.rule.startsWith("R7"));
      expect(r7.length).toBeGreaterThan(0);
      expect(r7.some((v) => v.file.includes("planted-violation"))).toBe(true);
    } finally {
      await rm(planted, { force: true });
    }
  });

  it("passes with the real tools layer", async () => {
    const { scan } = await import("../../../../scripts/check-boundaries.mjs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const violations = (scan as (roots: string[]) => { rule: string }[])([root]);
    expect(violations.filter((v) => v.rule.startsWith("R7"))).toEqual([]);
  });
});
