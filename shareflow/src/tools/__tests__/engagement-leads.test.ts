/**
 * Engagement and Leads (#120).
 *
 * The two guarantees worth reading the assertions for: a reply is keyed on the **comment**, so a second
 * distinct call cannot send a second reply; and a suppressed lead has **no success shape to be reported
 * in**, so an assistant cannot tell the user it captured someone who opted out.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type ApprovalGate, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createApprovalGate } from "@retinue/agentkit/hitl";
import { createMemoryApprovalGrantStore, createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  ENGAGEMENT_TOOL_FACTORIES,
  ENGAGEMENT_TOOL_NAMES,
  LEAD_TOOL_FACTORIES,
  LEAD_TOOL_NAMES,
  commentReplyIdempotencyKey,
  createLeadTool,
  createShareFlowToolProvider,
  dismissCommentTool,
  listCommentsTool,
  listLeadsTool,
  replyToCommentTool,
  serviceFailure,
  updateLeadTool,
  type EngagementService,
  type InboxComment,
  type InboxCommentId,
  type Lead,
  type LeadCreateResult,
  type LeadId,
  type LeadService,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = {
  tenantId: T1,
  principalId: asId<PrincipalId>("p1"),
  conversationId: asId("c1"),
} as unknown as ExecutionContext;
const C1 = asId<InboxCommentId>("cm1");

const comment = (over: Partial<InboxComment> = {}): InboxComment => ({
  id: C1,
  platformId: "linkedin",
  authorName: "Dana Reed",
  content: "Does this integrate with our CRM?",
  replyState: "needs-review",
  createdAt: "2026-08-23T11:00:00.000Z",
  ...over,
});

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: asId<LeadId>("l1"),
  name: "Dana Reed",
  email: "dana@acme.test",
  status: "new",
  valueMinorUnits: 250_000,
  attribution: { postDraftId: asId("d1"), platformId: "linkedin" },
  createdAt: "2026-08-23T11:05:00.000Z",
  ...over,
});

type Recorder = { readonly calls: { method: string; args: unknown }[] };
type Producer = () => unknown;

/** Overrides supply the result; every method records regardless — the #119 lesson. */
const stub = <T>(
  recorder: Recorder,
  defaults: Record<string, Producer>,
  overrides: Record<string, Producer> = {},
): T => {
  const built: Record<string, unknown> = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const produce = overrides[name] ?? fallback;
    built[name] = async (_c: ExecutionContext, args?: unknown) => {
      recorder.calls.push({ method: name, args });
      return produce();
    };
  }
  return built as T;
};

const engagementDefaults = (): Record<string, Producer> => ({
  listComments: () => ({ items: [comment()], nextCursor: "cur1" }),
  reply: () => ({ commentId: C1, platformId: "linkedin", sentAt: "2026-08-23T11:10:00.000Z" }),
  dismiss: () => comment({ replyState: "dismissed" }),
});

const leadDefaults = (): Record<string, Producer> => ({
  listLeads: () => ({ items: [lead()] }),
  createLead: () => ({ outcome: "created", lead: lead() }) as LeadCreateResult,
  updateLead: () => lead({ status: "qualified" }),
});

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

const grantedGate = async (toolNameOrCategory: string): Promise<ApprovalGate> => {
  const grants = createMemoryApprovalGrantStore();
  await grants.grant({
    tenantId: T1,
    grant: {
      id: asId("g1"),
      tenantId: T1,
      scope: "tenant",
      toolNameOrCategory,
      grantedAt: "2026-08-23T00:00:00.000Z",
    },
  });
  return createApprovalGate({ grants });
};

const ungrantedGate = (): ApprovalGate => createApprovalGate({ grants: createMemoryApprovalGrantStore() });

let recorder: Recorder;
let idempotency: IdempotencyStore;

const build = (
  factory: ShareFlowToolFactory,
  options: {
    engagement?: Record<string, Producer>;
    leads?: Record<string, Producer>;
    approvals?: ApprovalGate;
  } = {},
): Tool =>
  factory({
    services: {
      engagement: stub<EngagementService>(recorder, engagementDefaults(), options.engagement),
      leads: stub<LeadService>(recorder, leadDefaults(), options.leads),
    } as unknown as ShareFlowServices,
    deps: {
      authorization: allowAll,
      idempotency,
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    },
  });

const run = (tool: Tool, input: unknown, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

beforeEach(() => {
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("reading the inbox", () => {
  it("returns comments with their reply state", async () => {
    const result = await run(build(listCommentsTool), { replyState: "needs-review" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        comments: [{ commentId: "cm1", authorName: "Dana Reed", replyState: "needs-review" }],
        nextCursor: "cur1",
      },
    });
    expect(recorder.calls[0]?.args).toEqual({ limit: 20, replyState: "needs-review" });
  });

  it("surfaces a reply already drafted and waiting for a person", async () => {
    // Knowing a draft exists is what stops the assistant writing a second one. It is read-only —
    // approving it is the human's, and `approve_comment` is deliberately not a capability.
    const result = await run(
      build(listCommentsTool, {
        engagement: { listComments: () => ({ items: [comment({ draftedReply: "Yes — here are the docs." })] }) },
      }),
      {},
    );
    expect(result).toMatchObject({
      ok: true,
      data: { comments: [{ draftedReply: "Yes — here are the docs." }] },
    });
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = listCommentsTool({
      services: {
        engagement: stub<EngagementService>(recorder, engagementDefaults()),
      } as unknown as ShareFlowServices,
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    expect(await run(tool, {})).toMatchObject({ ok: false });
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-2 and AC-6. */
describe("sending a reply", () => {
  it("requires approval, and sends nothing without it", async () => {
    const tool = build(replyToCommentTool, { approvals: ungrantedGate() });
    expect(await run(tool, { commentId: "cm1", text: "Yes, it does." })).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(recorder.calls).toEqual([]);
  });

  it("is refused outright when no approval gate is wired", async () => {
    const tool = build(replyToCommentTool);
    expect(await run(tool, { commentId: "cm1", text: "Yes, it does." })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" },
    });
    expect(recorder.calls).toEqual([]);
  });

  it("keys idempotency on the comment, not the call", () => {
    // The half that matters: two distinct calls to answer one comment must produce the same key, or the
    // second sends a second public reply.
    expect(commentReplyIdempotencyKey(C1)).toBe(commentReplyIdempotencyKey(C1));
    expect(commentReplyIdempotencyKey(asId<InboxCommentId>("cm2"))).not.toBe(commentReplyIdempotencyKey(C1));
    // And the separator cannot be forged into a collision.
    expect(commentReplyIdempotencyKey(asId<InboxCommentId>("a:b"))).not.toBe(
      commentReplyIdempotencyKey(asId<InboxCommentId>("a%3Ab")),
    );
  });

  it("hands the service the comment's key, whatever the call's key is", async () => {
    const gate = await grantedGate("engagement");
    await run(build(replyToCommentTool, { approvals: gate }), { commentId: "cm1", text: "one" }, "call-one");
    await run(build(replyToCommentTool, { approvals: gate }), { commentId: "cm1", text: "two" }, "call-two");
    const keys = recorder.calls
      .filter((c) => c.method === "reply")
      .map((c) => (c.args as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([commentReplyIdempotencyKey(C1), commentReplyIdempotencyKey(C1)]);
  });

  it("does not send twice on a replayed call", async () => {
    const tool = build(replyToCommentTool, { approvals: await grantedGate("engagement") });
    const input = { commentId: "cm1", text: "Yes, it does." };
    await run(tool, input, "same");
    await run(tool, input, "same");
    expect(recorder.calls.filter((c) => c.method === "reply")).toHaveLength(1);
  });

  it("reports an already-answered comment as a conflict, not as a failed send", async () => {
    // ShareFlow refuses on `sent` or `auto_sent`. "Already replied" is an outcome the assistant should
    // relay, not an error to retry — and certainly not something to report as sent.
    const result = await run(
      build(replyToCommentTool, {
        approvals: await grantedGate("engagement"),
        engagement: {
          reply: () => {
            throw serviceFailure("conflict", "That comment has already been replied to");
          },
        },
      }),
      { commentId: "cm1", text: "Yes, it does." },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "conflict", retryable: false } });
  });

  it("reports a platform that cannot reply as unavailable, with the guidance", async () => {
    const result = await run(
      build(replyToCommentTool, {
        approvals: await grantedGate("engagement"),
        engagement: {
          reply: () => {
            throw serviceFailure(
              "capability_unavailable",
              "Replying is not supported on pinterest yet — reply in the Pinterest app instead",
            );
          },
        },
      }),
      { commentId: "cm1", text: "Thanks!" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect((result as { error: { message: string } }).error.message).toContain("app instead");
  });

  it("dismissal needs no approval; the reply always does", async () => {
    const byName = new Map(
      ENGAGEMENT_TOOL_FACTORIES.map((f) => {
        const { descriptor } = build(f);
        return [descriptor.name, descriptor] as const;
      }),
    );
    expect(byName.get("dismiss_comment")?.effect).toBe("internal-write");
    expect(byName.get("dismiss_comment")?.approvalPolicy).toBe("never");
    expect(byName.get("reply_to_comment")?.effect).toBe("external-write");
    expect(byName.get("reply_to_comment")?.approvalPolicy).toBe("always");
    expect(byName.get("list_comments")?.effect).toBe("read");
  });

  it("dismisses with no approval gate wired at all", async () => {
    const result = await run(build(dismissCommentTool), { commentId: "cm1" });
    expect(result).toMatchObject({ ok: true, data: { replyState: "dismissed" } });
  });
});

/** AC-3. */
describe("a reply is grounded in the comment it answers", () => {
  it("cannot be sent without naming a comment", async () => {
    const tool = build(replyToCommentTool, { approvals: await grantedGate("engagement") });
    for (const input of [{ text: "hello" }, { commentId: "", text: "hello" }, { commentId: "cm1" }, { commentId: "cm1", text: "   " }]) {
      expect(await run(tool, input), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("records the linkage in the result", async () => {
    const result = await run(build(replyToCommentTool, { approvals: await grantedGate("engagement") }), {
      commentId: "cm1",
      text: "Yes, it does.",
    });
    expect(result).toEqual({
      ok: true,
      data: { commentId: "cm1", platformId: "linkedin", sentAt: "2026-08-23T11:10:00.000Z" },
    });
    // And the id the service was given is the one the caller named — the audit row is written from it.
    expect(recorder.calls.find((c) => c.method === "reply")?.args).toMatchObject({ commentId: "cm1" });
  });
});

/** AC-4. */
describe("a suppressed lead", () => {
  it("is never reported as created", async () => {
    const result = await run(
      build(createLeadTool, {
        leads: { createLead: () => ({ outcome: "suppressed", reason: "opt-out" }) as LeadCreateResult },
      }),
      { name: "Dana Reed", email: "dana@acme.test", attribution: { postDraftId: "d1" } },
    );
    expect(result).toEqual({
      ok: true,
      data: { outcome: "suppressed", suppressionReason: "opt-out" },
    });
    // The structural point: no lead id, no name, nothing that could be read as a captured lead.
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("leadId");
    expect(data).not.toHaveProperty("name");
  });

  it("distinguishes why, because the reasons mean different things to a person", async () => {
    for (const reason of ["opt-out", "complaint", "existing-customer", "manual"] as const) {
      const result = await run(
        build(createLeadTool, {
          leads: { createLead: () => ({ outcome: "suppressed", reason }) as LeadCreateResult },
        }),
        { name: "Dana Reed", attribution: { platformId: "linkedin" } },
        // A distinct key per iteration. The first version of this loop reused one, and the store
        // correctly returned the cached first result for all four — the envelope working, my test wrong.
        `key-${reason}`,
      );
      expect(result, reason).toMatchObject({ ok: true, data: { suppressionReason: reason } });
    }
  });

  it("does not check suppression itself", async () => {
    // AC-4 is "honouring the existing rules rather than reimplementing them". The tool sends the lead and
    // reports what comes back — it has no list, no normaliser and no opinion about who is suppressed.
    await run(build(createLeadTool), { name: "Dana Reed", email: "DANA@Acme.TEST ", attribution: { platformId: "x" } });
    // The email reaches the service as the caller gave it (bar the schema's trim): normalising here would
    // be a second normaliser, and for an opt-out a disagreement means contacting someone who asked not to be.
    expect(recorder.calls[0]?.args).toMatchObject({ email: "DANA@Acme.TEST" });
  });

  it("reports a dedupe match as existing, not created", async () => {
    const result = await run(
      build(createLeadTool, {
        leads: { createLead: () => ({ outcome: "existing", lead: lead() }) as LeadCreateResult },
      }),
      { name: "Dana Reed", attribution: { platformId: "linkedin" } },
    );
    expect(result).toMatchObject({ ok: true, data: { outcome: "existing", leadId: "l1" } });
  });

  it("marks a created lead as created", async () => {
    const result = await run(build(createLeadTool), {
      name: "Dana Reed",
      attribution: { postDraftId: "d1" },
    });
    expect(result).toMatchObject({ ok: true, data: { outcome: "created", leadId: "l1" } });
  });
});

/** AC-5. */
describe("attribution", () => {
  it("carries the originating post or campaign through to the service", async () => {
    await run(build(createLeadTool), {
      name: "Dana Reed",
      attribution: { postDraftId: "d1", campaignId: "c1", commentId: "cm1", platformId: "LinkedIn" },
    });
    expect(recorder.calls[0]?.args).toMatchObject({
      attribution: { postDraftId: "d1", campaignId: "c1", commentId: "cm1", platformId: "linkedin" },
    });
  });

  it("refuses a lead with nothing to attribute it to", async () => {
    // An unattributed lead is one the analytics step cannot connect to anything, which is what AC-5
    // exists to prevent. Accepting `{}` would make the field optional in practice while mandatory in
    // the type.
    const tool = build(createLeadTool);
    for (const attribution of [{}, undefined]) {
      expect(await run(tool, { name: "Dana Reed", attribution }), JSON.stringify(attribution)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("returns the attribution on a read, so the linkage is visible", async () => {
    const result = await run(build(listLeadsTool), {});
    expect(result).toMatchObject({
      ok: true,
      data: { leads: [{ leadId: "l1", attribution: { postDraftId: "d1", platformId: "linkedin" } }] },
    });
  });

  it("cannot be changed by an update", async () => {
    // Where a lead came from is a fact about its origin, not a property to edit — and rewriting it would
    // rewrite the analytics linkage after the fact.
    const tool = build(updateLeadTool);
    expect(await run(tool, { leadId: "l1", status: "qualified", attribution: { postDraftId: "d2" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls).toEqual([]);
  });
});

describe("updating a lead", () => {
  it("touches only the fields supplied, and never the id", async () => {
    await run(build(updateLeadTool), { leadId: "l1", status: "qualified" });
    expect(recorder.calls[0]?.args).toEqual({
      idempotencyKey: "k1",
      id: "l1",
      patch: { status: "qualified" },
    });
  });

  it("rejects an empty patch rather than reporting a successful no-op", async () => {
    expect(await run(build(updateLeadTool), { leadId: "l1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a malformed email rather than storing it", async () => {
    // An unreachable address on a lead is a lead nobody can follow up, and it fails silently later.
    expect(await run(build(updateLeadTool), { leadId: "l1", email: "not-an-address" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls).toEqual([]);
  });
});

describe("catalogs and delegation", () => {
  it("names the service method every capability wraps", () => {
    expect(
      [...ENGAGEMENT_TOOL_FACTORIES, ...LEAD_TOOL_FACTORIES]
        .map((f) => build(f).descriptor)
        .map((d) => [d.name, d.delegatesTo]),
    ).toEqual([
      ["list_comments", "EngagementService.listComments"],
      ["reply_to_comment", "EngagementService.reply"],
      ["dismiss_comment", "EngagementService.dismiss"],
      ["list_leads", "LeadService.listLeads"],
      ["create_lead", "LeadService.createLead"],
      ["update_lead", "LeadService.updateLead"],
    ]);
  });

  it("exposes no capability that approves a drafted reply or suppresses a lead", async () => {
    const provider = createShareFlowToolProvider({
      services: {
        engagement: stub<EngagementService>(recorder, engagementDefaults()),
        leads: stub<LeadService>(recorder, leadDefaults()),
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate("engagement") },
      factories: [...ENGAGEMENT_TOOL_FACTORIES, ...LEAD_TOOL_FACTORIES],
    });
    const names = (await provider.listTools(CONTEXT)).map((t) => t.descriptor.name);
    expect(names).toEqual([...ENGAGEMENT_TOOL_NAMES, ...LEAD_TOOL_NAMES]);
    // `approve_comment` sends the draft already in `inbox_comments.reply`, and `needs_review` exists so a
    // person looks first — an assistant that could approve its own draft would route around the review.
    // `suppress_lead` retires up to 200 existing rows.
    expect(names.some((n) => /approve|suppress|assign/.test(n))).toBe(false);
  });

  it("classifies every lead capability as internal, since nothing leaves the tenant", () => {
    for (const factory of LEAD_TOOL_FACTORIES) {
      const { descriptor } = build(factory);
      expect(descriptor.category).toBe("leads");
      expect(["read", "internal-write"]).toContain(descriptor.effect);
      expect(descriptor.approvalPolicy).toBe("never");
    }
  });
});
