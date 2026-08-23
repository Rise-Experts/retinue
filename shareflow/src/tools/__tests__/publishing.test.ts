/**
 * The Publishing capabilities (#119) — the zero-tolerance ones.
 *
 * **A note on what these tests can and cannot prove.** AC-1's refusal direction is proven end to end:
 * with no approval, nothing reaches the service. The *success* direction is exercised through a standing
 * grant, because that is the only approval the platform currently executes — `allow-once` issues no grant
 * and nothing reads `PendingApproval.normalizedInput` back to run the approved call. That gap is
 * reported on the issue rather than hidden behind a stubbed gate that makes it look wired.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  createApprovalGate,
  createMemoryApprovalGrantStore,
  createMemoryIdempotencyStore,
  type ApprovalGate,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@agentkit/backend";
import {
  PUBLISHING_TOOL_FACTORIES,
  PUBLISHING_TOOL_NAMES,
  createShareFlowToolProvider,
  getPublishStatusTool,
  publishOutcomeFor,
  publishPostNowTool,
  publishTargetIdempotencyKey,
  retryPublishTargetTool,
  schedulePostTool,
  serviceFailure,
  validatePublishTool,
  type PostDraftId,
  type PublishTarget,
  type PublishTargetId,
  type PublishTargetState,
  type PublishTargetStatus,
  type PublishingService,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type SocialAccountId,
  type ValidationIssue,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = {
  tenantId: T1,
  principalId: asId<PrincipalId>("p1"),
  conversationId: asId("c1"),
} as unknown as ExecutionContext;
const D1 = asId<PostDraftId>("d1");

const target = (over: Partial<PublishTargetStatus> = {}): PublishTargetStatus => ({
  id: asId<PublishTargetId>("t-a1"),
  accountId: asId<SocialAccountId>("a1"),
  state: "published",
  publishedAt: "2026-08-23T12:00:00.000Z",
  externalUrl: "https://linkedin.com/feed/update/1",
  ...over,
});

const issue = (over: Partial<ValidationIssue> = {}): ValidationIssue => ({
  code: "media-kind-unsupported",
  platformId: "linkedin",
  message: "LinkedIn does not accept video",
  repairable: true,
  ...over,
});

type Recorder = { readonly calls: { method: string; args: unknown }[] };

/**
 * An override supplies the *result*, not the method.
 *
 * The first version of this helper spread `Partial<PublishingService>` over the recording wrappers,
 * which silently replaced them — so any test that overrode a method and then asserted on
 * `recorder.calls` saw an empty array and read it as "the service was not called". Two tests here
 * failed on exactly that, and it would have made a test pass for the wrong reason as easily as fail.
 * Every method now records, override or not.
 */
type Producer = () => unknown;

const stubPublishing = (
  recorder: Recorder,
  overrides: Partial<Record<keyof PublishingService, Producer>> = {},
): PublishingService => {
  const method = (name: keyof PublishingService, fallback: Producer) => {
    const produce = overrides[name] ?? fallback;
    return async (_c: ExecutionContext, args?: unknown) => {
      recorder.calls.push({ method: name, args });
      return produce();
    };
  };
  return {
    validate: method("validate", () => ({ ok: true, issues: [] })),
    schedule: method("schedule", () => [target()]),
    getStatus: method("getStatus", () => [target()]),
    retry: method("retry", () => target()),
  } as unknown as PublishingService;
};

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

/**
 * A real gate over a real grant store, with a standing grant for the category.
 *
 * Deliberately the real `createApprovalGate` rather than `{ isAllowed: () => true }`: a stub would pass
 * these tests against an envelope that had no gate at all.
 */
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

/** The real gate with no grant at all — the state a first publish attempt is in. */
const ungrantedGate = (): ApprovalGate =>
  createApprovalGate({ grants: createMemoryApprovalGrantStore() });

let recorder: Recorder;
let idempotency: IdempotencyStore;

const build = (
  factory: ShareFlowToolFactory,
  options: { publishing?: Partial<Record<keyof PublishingService, Producer>>; approvals?: ApprovalGate } = {},
): Tool =>
  factory({
    services: { publishing: stubPublishing(recorder, options.publishing) } as unknown as ShareFlowServices,
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

/** AC-1 — the refusal direction, which is the one that must never fail. */
describe("nothing publishes without an approval", () => {
  it("refuses with no standing grant, and the service is never called", async () => {
    const tool = build(publishPostNowTool, { approvals: ungrantedGate() });
    const result = await run(tool, { postDraftId: "d1", accountIds: ["a1"] });
    expect(result).toMatchObject({ ok: false, error: { code: "approval_required" } });
    // The observable effect. `validate` is allowed to have run (it is the read-only preflight); what
    // must not have happened is a `schedule`.
    expect(recorder.calls.filter((c) => c.method === "schedule")).toEqual([]);
  });

  it("refuses when no approval gate is wired at all, rather than proceeding", async () => {
    // Fail closed. An unwired dependency must never become permission for an unapproved public action.
    const tool = build(publishPostNowTool);
    expect(await run(tool, { postDraftId: "d1", accountIds: ["a1"] })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" },
    });
    expect(recorder.calls.filter((c) => c.method === "schedule")).toEqual([]);
  });

  it("gates schedule and retry as well as publish", async () => {
    for (const factory of [schedulePostTool, retryPublishTargetTool]) {
      const tool = build(factory, { approvals: ungrantedGate() });
      const input =
        tool.descriptor.name === "schedule_post"
          ? { postDraftId: "d1", accountIds: ["a1"], scheduledAt: "2026-09-01T09:00:00.000Z" }
          : { publishTargetId: "t-a1" };
      expect(await run(tool, input), tool.descriptor.name).toMatchObject({
        ok: false,
        error: { code: "approval_required" },
      });
    }
    // Scheduling publishes later without asking again, so it is not a lesser action than publishing.
    expect(recorder.calls.filter((c) => c.method !== "validate")).toEqual([]);
  });

  it("declares every write as external with approval always required", () => {
    const byName = new Map(
      PUBLISHING_TOOL_FACTORIES.map((f) => {
        const { descriptor } = build(f);
        return [descriptor.name, descriptor] as const;
      }),
    );
    for (const name of ["publish_post_now", "schedule_post", "retry_publish_target"]) {
      expect(byName.get(name)?.effect, name).toBe("external-write");
      expect(byName.get(name)?.approvalPolicy, name).toBe("always");
      expect(byName.get(name)?.requiresIdempotencyKey, name).toBe(true);
    }
    for (const name of ["validate_publish", "get_publish_status"]) {
      expect(byName.get(name)?.effect, name).toBe("read");
    }
  });

  it("publishes once a standing grant covers it", async () => {
    // The success direction, through the only approval the platform currently executes. `allow-once`
    // issues no grant and nothing runs the stored input, so this is what an approved publish looks like
    // today — see the note at the top of this file.
    const tool = build(publishPostNowTool, { approvals: await grantedGate("publishing") });
    expect(await run(tool, { postDraftId: "d1", accountIds: ["a1"] })).toMatchObject({
      ok: true,
      data: { outcome: "published" },
    });
    expect(recorder.calls.some((c) => c.method === "schedule")).toBe(true);
  });
});

/** AC-2 and AC-3. */
describe("the per-destination idempotency key", () => {
  it("depends on the draft and the destination and nothing else", () => {
    const key = publishTargetIdempotencyKey({ draftId: D1, accountId: asId<SocialAccountId>("a1") });
    // Stable across calls, runs and arguments — which is the point. Two distinct publish calls for one
    // draft and account must produce the same key, or the second republishes.
    expect(publishTargetIdempotencyKey({ draftId: D1, accountId: asId<SocialAccountId>("a1") })).toBe(key);
    expect(publishTargetIdempotencyKey({ draftId: D1, accountId: asId<SocialAccountId>("a2") })).not.toBe(key);
    expect(
      publishTargetIdempotencyKey({ draftId: asId<PostDraftId>("d2"), accountId: asId<SocialAccountId>("a1") }),
    ).not.toBe(key);
  });

  it("cannot collide when an id contains the separator", () => {
    // #105's lesson: `a:b` + `c` and `a` + `b:c` produce one string if the separator can appear inside a
    // part. Two destinations sharing a key would mean one of them silently never publishes.
    const a = publishTargetIdempotencyKey({
      draftId: asId<PostDraftId>("d:1"),
      accountId: asId<SocialAccountId>("a1"),
    });
    const b = publishTargetIdempotencyKey({
      draftId: asId<PostDraftId>("d"),
      accountId: asId<SocialAccountId>("1:a1"),
    });
    expect(a).not.toBe(b);
  });

  it("sends one key per destination, not one for the call", async () => {
    const tool = build(publishPostNowTool, {
      approvals: await grantedGate("publishing"),
      publishing: { schedule: () => [target(), target({ id: asId("t-a2"), accountId: asId("a2") })] },
    });
    await run(tool, { postDraftId: "d1", accountIds: ["a1", "a2"] });
    const args = recorder.calls.find((c) => c.method === "schedule")?.args as {
      targets: PublishTarget[];
    };
    expect(args.targets.map((t) => t.idempotencyKey)).toEqual([
      publishTargetIdempotencyKey({ draftId: D1, accountId: asId<SocialAccountId>("a1") }),
      publishTargetIdempotencyKey({ draftId: D1, accountId: asId<SocialAccountId>("a2") }),
    ]);
  });

  it("produces the same destination keys for a second, distinct call", async () => {
    // The half that matters, and the one an envelope-derived key would fail. Two separate calls with
    // *different* envelope keys must still hand the service the same per-destination keys, so the
    // service can decline to republish.
    const gate = await grantedGate("publishing");
    const first = build(publishPostNowTool, { approvals: gate });
    await run(first, { postDraftId: "d1", accountIds: ["a1"] }, "call-one");
    const second = build(publishPostNowTool, { approvals: gate });
    await run(second, { postDraftId: "d1", accountIds: ["a1"] }, "call-two");

    const keysSeen = recorder.calls
      .filter((c) => c.method === "schedule")
      .map((c) => (c.args as { targets: PublishTarget[] }).targets[0]?.idempotencyKey);
    expect(keysSeen).toHaveLength(2);
    expect(keysSeen[0]).toBe(keysSeen[1]);
  });

  it("returns the stored result rather than re-calling on a replayed call", async () => {
    const tool = build(publishPostNowTool, { approvals: await grantedGate("publishing") });
    const input = { postDraftId: "d1", accountIds: ["a1"] };
    await run(tool, input, "same");
    await run(tool, input, "same");
    expect(recorder.calls.filter((c) => c.method === "schedule")).toHaveLength(1);
  });

  it("retries one destination by its own id, never the draft", async () => {
    // A post that reached three of four channels must not be re-sent to the three that worked, and a
    // draft-level retry makes avoiding that the caller's problem every time.
    const tool = build(retryPublishTargetTool, { approvals: await grantedGate("publishing") });
    const result = await run(tool, { publishTargetId: "t-a2" });
    expect(result).toMatchObject({ ok: true, data: { publishTargetId: "t-a1" } });
    expect(recorder.calls.find((c) => c.method === "retry")?.args).toMatchObject({ targetId: "t-a2" });
    // No draft id anywhere in the retry call.
    expect(JSON.stringify(recorder.calls.find((c) => c.method === "retry")?.args)).not.toContain("d1");
  });
});

/** AC-4. */
describe("validation runs before the approval gate", () => {
  it("refuses a post that would fail, without asking for approval", async () => {
    const tool = build(publishPostNowTool, {
      approvals: ungrantedGate(),
      publishing: { validate: () => ({ ok: false, issues: [issue()] }) },
    });
    const result = await run(tool, { postDraftId: "d1", accountIds: ["a1"] });
    // `invalid_input` with the findings, NOT `approval_required`. The ordering is the assertion: a
    // human must never be asked to authorise something that cannot succeed.
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { issues: [{ code: "media-kind-unsupported" }] } },
    });
    expect(recorder.calls.filter((c) => c.method === "schedule")).toEqual([]);
  });

  it("validates even when a grant already exists", async () => {
    const tool = build(publishPostNowTool, {
      approvals: await grantedGate("publishing"),
      publishing: { validate: () => ({ ok: false, issues: [issue()] }) },
    });
    expect(await run(tool, { postDraftId: "d1", accountIds: ["a1"] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls.filter((c) => c.method === "schedule")).toEqual([]);
  });

  it("carries the findings structured, so a repair can branch on a code", async () => {
    const tool = build(publishPostNowTool, {
      approvals: await grantedGate("publishing"),
      publishing: {
        validate: () => ({
          ok: false,
          issues: [issue({ code: "media-too-large", repairable: false, accountId: asId("a1") })],
        }),
      },
    });
    const result = await run(tool, { postDraftId: "d1", accountIds: ["a1"] });
    const issues = (result as { error: { details: { issues: Record<string, unknown>[] } } }).error.details
      .issues;
    expect(issues[0]).toMatchObject({ code: "media-too-large", repairable: false, accountId: "a1" });
  });

  it("exposes validation on its own as a read, so it can be asked before proposing", async () => {
    const result = await run(build(validatePublishTool), { postDraftId: "d1", accountIds: ["a1"] });
    expect(result).toEqual({ ok: true, data: { ok: true, issues: [] } });
    expect(recorder.calls).toEqual([{ method: "validate", args: { draftId: "d1", accountIds: ["a1"] } }]);
  });
});

/** AC-5 and AC-6. */
describe("the outcome is derived, and unconfirmed outranks published", () => {
  const s = (state: PublishTargetState, id = "t-x"): PublishTargetStatus =>
    target({ id: asId<PublishTargetId>(id), state });

  it("maps every combination that matters", () => {
    expect(publishOutcomeFor([])).toBe("none");
    expect(publishOutcomeFor([s("published"), s("published", "t-y")])).toBe("published");
    expect(publishOutcomeFor([s("scheduled"), s("scheduled", "t-y")])).toBe("scheduled");
    expect(publishOutcomeFor([s("published"), s("failed", "t-y")])).toBe("partial");
    expect(publishOutcomeFor([s("failed"), s("failed", "t-y")])).toBe("failed");
    expect(publishOutcomeFor([s("cancelled")])).toBe("failed");
    // The orderings that are the point: an unfinished destination makes the whole answer unfinished,
    // however well the others went.
    expect(publishOutcomeFor([s("published"), s("awaiting-platform", "t-y")])).toBe("unconfirmed");
    expect(publishOutcomeFor([s("published"), s("publishing", "t-y")])).toBe("unconfirmed");
    expect(publishOutcomeFor([s("failed"), s("awaiting-platform", "t-y")])).toBe("unconfirmed");
    // The case where `partial` and `unconfirmed` genuinely compete — one destination live, one failed,
    // one still processing. `partial` claims the action finished, and it has not. My first sabotage pass
    // reordered the `all published` check instead, which is *equivalent* (the two are mutually
    // exclusive) and so proved nothing; this is the combination that actually discriminates.
    expect(publishOutcomeFor([s("published"), s("failed", "t-y"), s("awaiting-platform", "t-z")])).toBe(
      "unconfirmed",
    );
    expect(publishOutcomeFor([s("published"), s("failed", "t-y"), s("publishing", "t-z")])).toBe("unconfirmed");
    expect(publishOutcomeFor([s("scheduled"), s("published", "t-y")])).toBe("partial");
  });

  it("never reports a partial publish as a success", async () => {
    const tool = build(publishPostNowTool, {
      approvals: await grantedGate("publishing"),
      publishing: {
        schedule: () => [
          target(),
          target({
            id: asId("t-a2"),
            accountId: asId("a2"),
            state: "failed",
            failure: { code: "rate_limited", message: "too many posts today" },
          }),
        ],
      },
    });
    const result = await run(tool, { postDraftId: "d1", accountIds: ["a1", "a2"] });
    expect(result).toMatchObject({ ok: true, data: { outcome: "partial" } });
    // Per destination, individually, with the failure named.
    const targets = (result as { data: { targets: Record<string, unknown>[] } }).data.targets;
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ accountId: "a1", state: "published" });
    expect(targets[1]).toMatchObject({ accountId: "a2", state: "failed", failure: { code: "rate_limited" } });
  });

  it("reports an unconfirmable destination as unconfirmed with a follow-up", async () => {
    // `awaiting-platform` is the normal path for video: the platform took the upload and confirmed
    // nothing. The remediation is not a user action — the sweep finishes it — so the guidance is to
    // re-read the status, not to retry and risk a second post.
    const tool = build(getPublishStatusTool, {
      publishing: {
        getStatus: () => [target(), target({ id: asId("t-a2"), accountId: asId("a2"), state: "awaiting-platform" })],
      },
    });
    const result = await run(tool, { postDraftId: "d1" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: "unconfirmed",
        followUp: { action: "recheck-later", unconfirmedAccountIds: ["a2"] },
      },
    });
  });

  it("escalates a destination that has been unconfirmed past the platform's own ceiling", async () => {
    // ShareFlow gives up after 24 hours, because "Instagram expires an unpublished container after 24
    // hours … Anything older is stuck, and saying so beats a row that claims to be publishing for a
    // week." The threshold is ShareFlow's; the flag is the answer.
    const tool = build(getPublishStatusTool, {
      publishing: { getStatus: () => [target({ state: "awaiting-platform", stuck: true })] },
    });
    expect(await run(tool, { postDraftId: "d1" })).toMatchObject({
      ok: true,
      data: { outcome: "unconfirmed", followUp: { action: "needs-attention" } },
    });
  });

  it("omits the follow-up entirely when everything is settled", async () => {
    const result = await run(build(getPublishStatusTool), { postDraftId: "d1" });
    expect((result as { data: Record<string, unknown> }).data).not.toHaveProperty("followUp");
  });

  it("reports a scheduled post as scheduled, not as published", async () => {
    const tool = build(schedulePostTool, {
      approvals: await grantedGate("publishing"),
      publishing: {
        schedule: () => [target({ state: "scheduled", scheduledAt: "2026-09-01T09:00:00.000Z", publishedAt: undefined, externalUrl: undefined })],
      },
    });
    expect(
      await run(tool, { postDraftId: "d1", accountIds: ["a1"], scheduledAt: "2026-09-01T09:00:00.000Z" }),
    ).toMatchObject({ ok: true, data: { outcome: "scheduled" } });
  });
});

describe("arguments and delegation", () => {
  it("rejects malformed arguments before anything else happens", async () => {
    const tool = build(publishPostNowTool, { approvals: ungrantedGate() });
    for (const input of [
      {},
      { postDraftId: "d1" },
      { postDraftId: "d1", accountIds: [] },
      { postDraftId: "d1", accountIds: ["a1"], scheduledAt: "2026-09-01T09:00:00.000Z" },
      { postDraftId: "d1", accountIds: Array(21).fill("a") },
    ]) {
      expect(await run(tool, input), JSON.stringify(input).slice(0, 60)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    // Nothing ran — not even the preflight, which is a read but still a round trip.
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a schedule time that is not an instant", async () => {
    const tool = build(schedulePostTool, { approvals: await grantedGate("publishing") });
    for (const scheduledAt of ["2026-09-01", "next tuesday", "", "09:00"]) {
      expect(await run(tool, { postDraftId: "d1", accountIds: ["a1"], scheduledAt }), scheduledAt).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("names the service method every capability wraps", () => {
    expect(PUBLISHING_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["validate_publish", "PublishingService.validate"],
      ["publish_post_now", "PublishingService.schedule"],
      ["schedule_post", "PublishingService.schedule"],
      ["get_publish_status", "PublishingService.getStatus"],
      ["retry_publish_target", "PublishingService.retry"],
    ]);
  });

  it("registers under publishing with exactly three gated capabilities", async () => {
    const provider = createShareFlowToolProvider({
      services: { publishing: stubPublishing(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate("publishing") },
      factories: PUBLISHING_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...PUBLISHING_TOOL_NAMES]);
    for (const d of descriptors) expect(d.category).toBe("publishing");
    expect(descriptors.filter((d) => d.approvalPolicy !== "never").map((d) => d.name)).toEqual([
      "publish_post_now",
      "schedule_post",
      "retry_publish_target",
    ]);
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = publishPostNowTool({
      services: { publishing: stubPublishing(recorder) } as unknown as ShareFlowServices,
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
        approvals: await grantedGate("publishing"),
      },
    });
    expect(await run(tool, { postDraftId: "d1", accountIds: ["a1"] })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    // Not even the preflight: an unauthorised caller learns nothing, including whether the post is valid.
    expect(recorder.calls).toEqual([]);
  });

  it("surfaces a service failure without claiming an outcome", async () => {
    const tool = build(publishPostNowTool, {
      approvals: await grantedGate("publishing"),
      publishing: {
        schedule: () => {
          throw serviceFailure("provider_unavailable", "LinkedIn is not responding");
        },
      },
    });
    const result = await run(tool, { postDraftId: "d1", accountIds: ["a1"] });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_unavailable", retryable: true } });
    // And the failure is not stored, so a retry actually retries rather than returning a cached failure.
    const again = await run(tool, { postDraftId: "d1", accountIds: ["a1"] }, "k1");
    expect(again.ok).toBe(false);
    expect(recorder.calls.filter((c) => c.method === "schedule")).toHaveLength(2);
  });
});
