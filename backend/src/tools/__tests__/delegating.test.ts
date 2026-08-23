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
import { AgentPlatformError } from "../../core/errors.js";
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
  /** Replaces the gate's verdict outright, so a test can assert on what the envelope handed it. */
  readonly approvalCheck?: (
    context: ExecutionContext,
    tool: { readonly name: string; readonly category: string; readonly approvalPolicy: string },
    oneTime?: { readonly interactionId: string },
  ) => Promise<boolean>;
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
      if (options.approvalCheck) return options.approvalCheck(...(args as Parameters<NonNullable<typeof options.approvalCheck>>));
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

  /**
   * The resumption side of the approval loop. The envelope runs its own gate, so an approved call arriving from the
   * resumed run has to be able to satisfy *that* gate — otherwise the registry lets the call through
   * and the envelope refuses it one layer down, which looks exactly like the loop this closed.
   */
  it("passes the call's one-time approval to the gate, and proceeds when it satisfies it", async () => {
    const seen: unknown[] = [];
    const c = capability({
      approvalCheck: async (_context, _tool, oneTime) => {
        seen.push(oneTime);
        return oneTime?.interactionId === "int-1";
      },
    });
    const result = await c.tool.execute({
      context: ctx(),
      input: { draftId: "d1" },
      approval: { interactionId: "int-1" },
    });
    expect(result).toMatchObject({ ok: true });
    expect(c.delegateCalls()).toBe(1);
    expect(seen).toEqual([{ interactionId: "int-1" }]);
  });

  it("refuses a one-time approval the gate rejects, without reaching the delegate", async () => {
    const c = capability({ approvalCheck: async () => false });
    const result = await c.tool.execute({
      context: ctx(),
      input: { draftId: "d1" },
      approval: { interactionId: "int-forged" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
    expect(c.delegateCalls()).toBe(0);
  });

  it("refuses a one-time approval when the gate is not wired at all", async () => {
    const c = capability({ withApprovals: false });
    const result = await c.tool.execute({
      context: ctx(),
      input: { draftId: "d1" },
      approval: { interactionId: "int-1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_unavailable");
    expect(c.delegateCalls()).toBe(0);
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

/**
 * Input validation in the envelope (#115 AC-5).
 *
 * The registry already re-validates at execution, which covers the production path. Putting it here
 * covers *every* path — a tool executed directly, from a test, or by a future caller that is not the
 * registry. The envelope exists precisely so a guarantee cannot be reached around.
 */
describe("input validation", () => {
  /** A zod-shaped schema, hand-rolled so this file does not need zod to assert the seam works. */
  const schema = (parse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } }) => ({
    safeParse: parse,
  });

  const tool = (options: {
    readonly inputSchema: unknown;
    readonly allow?: boolean;
    readonly onDelegate?: (input: unknown, key: string) => void;
  }) => {
    const { authorization } = policy(options.allow ?? true);
    let calls = 0;
    const built = defineDelegatingTool(
      { authorization, idempotency: createMemoryIdempotencyStore() },
      {
        name: "publish_draft",
        description: "publishes a draft",
        category: "posts",
        inputSchema: options.inputSchema,
        delegatesTo: "ContentService.publish",
        delegate: (input, _context, details) => {
          calls += 1;
          options.onDelegate?.(input, details.idempotencyKey);
          return { published: true };
        },
      },
    );
    return { built, calls: () => calls };
  };

  it("rejects invalid input before the delegate is reached", async () => {
    const { built, calls } = tool({
      inputSchema: schema(() => ({ success: false, error: { message: "draftId is required" } })),
    });
    const result = await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect((result as { error: { message: string } }).error.message).toContain("draftId is required");
    // The observable effect, not the flag: the delegate never ran.
    expect(calls()).toBe(0);
  });

  it("validates after authorisation, so an unauthorised caller learns nothing about the schema", async () => {
    const { built } = tool({
      allow: false,
      inputSchema: schema(() => ({ success: false, error: { message: "draftId is required" } })),
    });
    const result = await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    // `forbidden`, not `invalid_input`: the schema's complaint would otherwise describe a capability
    // the caller may not use.
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("hands the delegate the normalised value, not the raw input", async () => {
    let seen: unknown;
    const { built } = tool({
      inputSchema: schema((v) => ({
        success: true,
        data: { platform: String((v as { platform: string }).platform).toLowerCase() },
      })),
      onDelegate: (input) => {
        seen = input;
      },
    });
    await built.execute({ context: ctx(), input: { platform: "LinkedIn" }, idempotencyKey: "k" });
    expect(seen).toEqual({ platform: "linkedin" });
  });

  it("derives the fallback key from the normalised value, so capitalisation is not a second call", async () => {
    // This is why validation has to precede key derivation. Without it, "LinkedIn" and "linkedin" are
    // one logical call with two different keys, and the second would re-run the side effect.
    let calls = 0;
    const { authorization } = policy(true);
    const built = defineDelegatingTool(
      { authorization, idempotency: createMemoryIdempotencyStore() },
      {
        name: "publish_draft",
        description: "publishes a draft",
        category: "posts",
        inputSchema: {
          safeParse: (v: unknown) => ({
            success: true,
            data: { platform: String((v as { platform: string }).platform).toLowerCase() },
          }),
        },
        delegatesTo: "ContentService.publish",
        delegate: () => {
          calls += 1;
          return { published: true };
        },
      },
    );
    // No caller-supplied key, so the fallback is used — which is the path this affects.
    await built.execute({ context: ctx(), input: { platform: "LinkedIn" } });
    await built.execute({ context: ctx(), input: { platform: "linkedin" } });
    expect(calls).toBe(1);
  });

  it("passes through a schema it cannot validate, so an existing tool is unchanged", async () => {
    // `inputSchema` defaults to `{}` and `zodishValidator` passes anything without `safeParse`. This is
    // what makes adding validation additive rather than a change in behaviour for every tool.
    const { built, calls } = tool({ inputSchema: {} });
    expect(await built.execute({ context: ctx(), input: { anything: true }, idempotencyKey: "k" })).toMatchObject({
      ok: true,
    });
    expect(calls()).toBe(1);
  });
});

/**
 * The key reaches the delegate (#115).
 *
 * #113 deliberately withheld it, on the reasoning that a delegate should know nothing about
 * idempotency. The first capability that performs a write showed that to be wrong: the downstream
 * service needs the key so a *re-delivered job* is deduplicated, which is a different guarantee from
 * the one the store here provides.
 */
describe("the delegate's view of the call", () => {
  it("receives the caller's key when one was supplied", async () => {
    const { authorization } = policy(true);
    let seen: string | undefined;
    const built = defineDelegatingTool(
      { authorization, idempotency: createMemoryIdempotencyStore() },
      {
        name: "save_draft",
        description: "saves a draft",
        category: "posts",
        delegatesTo: "ContentService.createDraft",
        delegate: (_input, _context, details) => {
          seen = details.idempotencyKey;
          return { saved: true };
        },
      },
    );
    await built.execute({ context: ctx(), input: {}, idempotencyKey: "caller-key" });
    expect(seen).toBe("caller-key");
  });

  it("receives the fallback key when the caller supplied none", async () => {
    const { authorization } = policy(true);
    let seen: string | undefined;
    const built = defineDelegatingTool(
      { authorization, idempotency: createMemoryIdempotencyStore() },
      {
        name: "save_draft",
        description: "saves a draft",
        category: "posts",
        delegatesTo: "ContentService.createDraft",
        delegate: (_input, _context, details) => {
          seen = details.idempotencyKey;
          return { saved: true };
        },
      },
    );
    await built.execute({ context: ctx(), input: { caption: "hi" } });
    // Not merely "defined": the same key the envelope stored under, so a delegate that forwards it
    // downstream forwards the one that identifies this call.
    expect(seen).toBe(
      fallbackIdempotencyKey({ context: ctx(), toolName: "save_draft", args: { caption: "hi" } }),
    );
  });
});

/**
 * The preflight stage (#119 AC-4).
 *
 * The general property it exists for: *do not ask a person to authorise something that cannot succeed*.
 * Content validation placed inside the delegate runs after the gate, so a human would already have
 * approved something that then fails — which teaches them their approval does not mean much.
 */
describe("preflight", () => {
  const gated = (options: {
    readonly preflight: () => void;
    readonly granted?: boolean;
  }) => {
    const { authorization } = policy(true);
    const grants = createMemoryApprovalGrantStore();
    const trace: string[] = [];
    let delegateCalls = 0;

    const approvals = {
      async isAllowed() {
        trace.push("gate");
        return options.granted ?? false;
      },
    };

    const built = defineDelegatingTool(
      { authorization, approvals: approvals as never, idempotency: createMemoryIdempotencyStore() },
      {
        name: "publish_post",
        description: "publishes a post",
        category: "publishing",
        effect: "external-write",
        delegatesTo: "PublishingService.schedule",
        preflight: () => {
          trace.push("preflight");
          options.preflight();
        },
        delegate: () => {
          delegateCalls += 1;
          return { published: true };
        },
      },
    );
    void grants;
    return { built, trace, calls: () => delegateCalls };
  };

  it("runs before the approval gate", async () => {
    const { built, trace } = gated({ preflight: () => {}, granted: true });
    await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    // The ordering *is* the guarantee, so it is asserted as an ordering rather than inferred from an
    // outcome.
    expect(trace).toEqual(["preflight", "gate"]);
  });

  it("refuses without reaching the gate when it throws", async () => {
    const { built, trace, calls } = gated({
      preflight: () => {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "cannot publish",
          retryable: false,
          details: { issues: [{ code: "media-too-large" }] },
        });
      },
    });
    const result = await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    // `invalid_input` with the findings, not `approval_required`: nobody was asked.
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { issues: [{ code: "media-too-large" }] } },
    });
    expect(trace).toEqual(["preflight"]);
    expect(calls()).toBe(0);
  });

  it("does not run for a replayed call whose result is already stored", async () => {
    // After the idempotency lookup deliberately: a call whose result is stored has already happened, so
    // re-validating it could refuse a legitimate replay on content that has since changed underneath.
    const { authorization } = policy(true);
    const idempotency = createMemoryIdempotencyStore();
    let preflights = 0;
    const built = defineDelegatingTool(
      { authorization, idempotency },
      {
        name: "save_draft",
        description: "saves a draft",
        category: "posts",
        delegatesTo: "ContentService.createDraft",
        preflight: () => {
          preflights += 1;
        },
        delegate: () => ({ saved: true }),
      },
    );
    await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" });
    expect(preflights).toBe(1);
  });

  it("is absent by default, so an existing tool is unchanged", async () => {
    const { authorization } = policy(true);
    let calls = 0;
    const built = defineDelegatingTool(
      { authorization, idempotency: createMemoryIdempotencyStore() },
      {
        name: "read_draft",
        description: "reads a draft",
        category: "posts",
        delegatesTo: "ContentService.getDraft",
        delegate: () => {
          calls += 1;
          return { id: "d1" };
        },
      },
    );
    expect(await built.execute({ context: ctx(), input: {}, idempotencyKey: "k" })).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });
});
