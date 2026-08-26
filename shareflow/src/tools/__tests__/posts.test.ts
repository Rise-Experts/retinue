/**
 * The Posts capabilities (#115).
 *
 * Every test drives the tool through `execute`, against a stub `ContentService` that records what it
 * was called with. The point is what reaches the service — an assertion that a tool "returned ok" has
 * been wrong twice on this project, so each case below checks the observable effect: the call the
 * service received, or the fact that it received none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  EDIT_REMEDY_DUPLICATE,
  POSTS_TOOL_FACTORIES,
  createPostDraftTool,
  createShareFlowToolProvider,
  duplicatePostDraftTool,
  getPostDraftTool,
  listPostDraftsTool,
  serviceFailure,
  updatePostDraftTool,
  type ContentService,
  type MediaAssetId,
  type PostDraft,
  type PostDraftId,
  type PostDraftSummary,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = { tenantId: T1, principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;
const DRAFT_ID = asId<PostDraftId>("d1");

const draft = (over: Partial<PostDraft> = {}): PostDraft => ({
  id: DRAFT_ID,
  status: "approved",
  caption: "Shipping the new pricing page today.",
  targetPlatforms: ["linkedin"],
  mediaAssetIds: [],
  updatedAt: "2026-08-23T10:00:00.000Z",
  ...over,
});

const summary = (over: Partial<PostDraftSummary> = {}): PostDraftSummary => ({
  id: DRAFT_ID,
  status: "approved",
  excerpt: "Shipping the new pricing page…",
  captionLength: 36,
  targetPlatforms: ["linkedin"],
  mediaCount: 0,
  updatedAt: "2026-08-23T10:00:00.000Z",
  ...over,
});

/** Records every call, so a test can assert what the service actually received — or that it did not. */
type Recorder = { readonly calls: { method: string; args: unknown }[] };

const stubContent = (recorder: Recorder, overrides: Partial<ContentService> = {}): ContentService => {
  const record =
    <T>(method: string, result: T) =>
    async (_c: ExecutionContext, args: unknown) => {
      recorder.calls.push({ method, args });
      return result;
    };
  return {
    getDraft: record("getDraft", draft()),
    listDrafts: record("listDrafts", { items: [summary()], nextCursor: "cur1" }),
    createDraft: record("createDraft", {
      ...draft(),
      captionLength: 36,
      droppedMedia: [] as MediaAssetId[],
    }),
    updateDraft: record("updateDraft", draft()),
    duplicateDraft: record("duplicateDraft", draft({ id: asId<PostDraftId>("d2") })),
    getCampaign: record("getCampaign", { id: asId("c1"), name: "c" }),
    listCampaigns: record("listCampaigns", { items: [] }),
    upsertCampaign: record("upsertCampaign", { id: asId("c1"), name: "c" }),
    ...overrides,
  } as unknown as ContentService;
};

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let recorder: Recorder;
let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, content?: Partial<ContentService>): Tool =>
  factory({
    services: { content: stubContent(recorder, content) } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency },
  });

const run = (tool: Tool, input: unknown, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

beforeEach(() => {
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("reading a post", () => {
  it("answers from the record", async () => {
    const result = await run(build(getPostDraftTool), { postDraftId: "d1" });
    expect(result).toEqual({
      ok: true,
      data: {
        postDraftId: "d1",
        status: "approved",
        caption: "Shipping the new pricing page today.",
        captionLength: 36,
        targetPlatforms: ["linkedin"],
        mediaAssetIds: [],
        updatedAt: "2026-08-23T10:00:00.000Z",
      },
    });
    expect(recorder.calls).toEqual([{ method: "getDraft", args: { id: "d1" } }]);
  });

  it("returns summaries from a list, never the bodies", async () => {
    const result = await run(build(listPostDraftsTool), { limit: 5, status: "approved" });
    expect(result.ok).toBe(true);
    const data = (result as { data: { posts: unknown[]; nextCursor?: string } }).data;
    // The whole reason a list is a different shape: twenty captions in one tool result is a
    // context-overflow waiting for a busy tenant.
    expect(data.posts[0]).not.toHaveProperty("caption");
    expect(data.posts[0]).toMatchObject({
      excerpt: "Shipping the new pricing page…",
      captionLength: 36,
    });
    expect(data.nextCursor).toBe("cur1");
    expect(recorder.calls[0]?.args).toEqual({ limit: 5, status: "approved" });
  });

  it("defaults the page size low rather than unbounded", async () => {
    await run(build(listPostDraftsTool), {});
    expect(recorder.calls[0]?.args).toEqual({ limit: 10 });
  });
});

/** AC-2. */
describe("creating a draft", () => {
  it("passes the complete caption through and normalises the destinations", async () => {
    const result = await run(build(createPostDraftTool), {
      caption: "Shipping the new pricing page today.",
      targetPlatforms: ["LinkedIn"],
    });
    expect(result).toMatchObject({ ok: true, data: { captionStoredInFull: true, droppedMedia: [] } });
    expect(recorder.calls[0]?.args).toMatchObject({
      caption: "Shipping the new pricing page today.",
      // Lower-cased: `social_accounts.platform` is lowercase and a model routinely sends "LinkedIn".
      targetPlatforms: ["linkedin"],
    });
  });

  it("flags a caption the store did not keep in full", async () => {
    // The failure ShareFlow saw in production: a model asked to repeat a long caption abbreviates it,
    // and a fragment gets published while the assistant reports success. The comparison is done in
    // code rather than asked of the model.
    const result = await run(
      build(createPostDraftTool, {
        createDraft: async () => ({ ...draft(), captionLength: 9, droppedMedia: [] as MediaAssetId[] }),
      }),
      { caption: "a much longer caption than nine characters", targetPlatforms: ["x"] },
    );
    expect(result).toMatchObject({ ok: true, data: { captionStoredInFull: false, captionLength: 9 } });
  });

  it("surfaces a refused attachment instead of dropping it silently", async () => {
    // "Silence here is what let an assistant announce an attachment it never made."
    const result = await run(
      build(createPostDraftTool, {
        createDraft: async () => ({
          ...draft(),
          captionLength: 36,
          droppedMedia: [asId<MediaAssetId>("m9")],
        }),
      }),
      {
        caption: "Shipping the new pricing page today.",
        targetPlatforms: ["x"],
        mediaAssetIds: ["m9"],
      },
    );
    expect(result).toMatchObject({ ok: true, data: { droppedMedia: ["m9"] } });
  });

  it("deduplicates destinations that differ only in case", async () => {
    await run(build(createPostDraftTool), { caption: "hi there", targetPlatforms: ["X", "x"] });
    expect(recorder.calls[0]?.args).toMatchObject({ targetPlatforms: ["x"] });
  });

  it("threads the envelope's idempotency key into the service", async () => {
    // Two layers, not one: the envelope stops a second agent call, this key stops a second delivery
    // of one accepted call inside ShareFlow. An empty placeholder would look fine and do nothing.
    await run(build(createPostDraftTool), { caption: "hi there", targetPlatforms: ["x"] }, "key-abc");
    expect(recorder.calls[0]?.args).toMatchObject({ idempotencyKey: "key-abc" });
  });

  it("does not create the draft twice when the call is retried", async () => {
    const tool = build(createPostDraftTool);
    const input = { caption: "hi there", targetPlatforms: ["x"] };
    await run(tool, input, "same");
    await run(tool, input, "same");
    expect(recorder.calls.filter((c) => c.method === "createDraft")).toHaveLength(1);
  });
});

/** AC-2, and the sparse-patch semantics. */
describe("updating a draft", () => {
  it("touches only the fields supplied", async () => {
    await run(build(updatePostDraftTool), { postDraftId: "d1", caption: "revised text" });
    // No `targetPlatforms` and no `mediaAssetIds` key at all — a caption-only edit must not clear the
    // attachments, which is what a default would have done.
    expect(recorder.calls[0]?.args).toEqual({
      idempotencyKey: "k1",
      id: "d1",
      patch: { caption: "revised text" },
    });
  });

  it("treats an explicit empty media list as 'remove them all'", async () => {
    await run(build(updatePostDraftTool), { postDraftId: "d1", mediaAssetIds: [] });
    expect(recorder.calls[0]?.args).toMatchObject({ patch: { mediaAssetIds: [] } });
  });

  it("rejects an empty patch rather than reporting a successful no-op", async () => {
    const result = await run(build(updatePostDraftTool), { postDraftId: "d1" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorder.calls).toEqual([]);
  });

  it("carries the duplicate remedy when the post is already partly public", async () => {
    // `assertEditable`'s second gate: a post to three platforms can be half-published, so editing
    // would make the record disagree with what is publicly visible. The remedy is in the error so the
    // assistant can offer it instead of reporting a dead end.
    const result = await run(
      build(updatePostDraftTool, {
        updateDraft: async () => {
          throw serviceFailure("conflict", "already published to at least one destination", {
            details: { remedy: EDIT_REMEDY_DUPLICATE },
          });
        },
      }),
      { postDraftId: "d1", caption: "revised" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false, details: { remedy: "duplicate-then-edit" } },
    });
  });
});

describe("duplicating a draft", () => {
  it("returns the copy and leaves the original alone", async () => {
    const result = await run(build(duplicatePostDraftTool), {
      postDraftId: "d1",
      targetPlatforms: ["Threads"],
    });
    expect(result).toMatchObject({ ok: true, data: { postDraftId: "d2" } });
    expect(recorder.calls[0]).toEqual({
      method: "duplicateDraft",
      args: { idempotencyKey: "k1", id: "d1", targetPlatforms: ["threads"] },
    });
  });
});

/** AC-3. */
describe("effects", () => {
  it("classifies reads as read and draft writes as internal-write, so no approval fires", () => {
    const byName = new Map(
      POSTS_TOOL_FACTORIES.map((f) => {
        const { descriptor } = build(f);
        return [descriptor.name, descriptor] as const;
      }),
    );
    expect(byName.get("get_post_draft")?.effect).toBe("read");
    expect(byName.get("list_post_drafts")?.effect).toBe("read");
    for (const name of ["create_post_draft", "update_post_draft", "duplicate_post_draft"]) {
      expect(byName.get(name)?.effect).toBe("internal-write");
      // The point of AC-3: `defineTool`'s defaults make external/destructive effects `always`-approval.
      // `internal-write` must therefore be `never`, or drafting would prompt a human every time.
      expect(byName.get(name)?.approvalPolicy).toBe("never");
    }
  });

  it("nothing in this category can publish", () => {
    // Structural rather than by inspection: no Posts capability delegates to the publishing service,
    // and none is classified as an external write.
    for (const factory of POSTS_TOOL_FACTORIES) {
      const { descriptor } = build(factory);
      expect(descriptor.delegatesTo).toMatch(/^ContentService\./);
      expect(descriptor.effect).not.toBe("external-write");
      expect(descriptor.effect).not.toBe("destructive");
    }
  });

  it("runs with no approval gate configured at all", async () => {
    // The strongest form of AC-3: `defineDelegatingTool` refuses a gated effect when no approval gate
    // is wired. These must not be gated, so they must work with `approvals` absent — which is exactly
    // what a drafting-only deployment would have.
    const tool = createPostDraftTool({
      services: { content: stubContent(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
    });
    expect(await run(tool, { caption: "hi there", targetPlatforms: ["x"] })).toMatchObject({ ok: true });
  });
});

/** AC-4. */
describe("entitlement", () => {
  it("reports another tenant's post as not found, never as forbidden", async () => {
    // ShareFlow's own reason: "the two must be indistinguishable, or the endpoint confirms the
    // existence of other tenants' ids."
    const result = await run(
      build(getPostDraftTool, {
        getDraft: async () => {
          throw serviceFailure("not_found", "Post not found");
        },
      }),
      { postDraftId: "someone-elses" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = getPostDraftTool({
      services: { content: stubContent(recorder) } as unknown as ShareFlowServices,
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    const result = await run(tool, { postDraftId: "d1" });
    expect(result.ok).toBe(false);
    // The observable effect, not just the flag: an unauthorised read must not reach the record at all.
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-5. */
describe("argument validation", () => {
  it("rejects malformed arguments with no service call", async () => {
    const cases: unknown[] = [
      {},
      { caption: "", targetPlatforms: ["x"] },
      { caption: "hi there", targetPlatforms: [] },
      { caption: "hi there" },
      { caption: "x".repeat(20_001), targetPlatforms: ["x"] },
      { caption: "hi there", targetPlatforms: "x" },
    ];
    const tool = build(createPostDraftTool);
    for (const input of cases) {
      expect(await run(tool, input), JSON.stringify(input).slice(0, 60)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    // The one that matters: a model passing `status: "approved"` must be refused, not silently
    // ignored. Silent ignoring is the dangerous outcome, because the model then reports success and
    // the user believes the post was approved for publishing.
    const result = await run(build(createPostDraftTool), {
      caption: "hi there",
      targetPlatforms: ["x"],
      status: "approved",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorder.calls).toEqual([]);
  });

  it("cannot change the review status through the update patch either", async () => {
    // The patch carries a *legitimate* field as well, so only `.strict()` can be what rejects this.
    // The first version of this test sent `status` alone, and passed because the empty-patch
    // refinement caught it — it would have kept passing with `.strict()` removed, which sabotage
    // showed. A test that passes for the wrong reason is worse than no test.
    const result = await run(build(updatePostDraftTool), {
      postDraftId: "d1",
      caption: "revised text",
      status: "approved",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-6. */
describe("delegation", () => {
  it("names the service method every capability wraps", () => {
    expect(POSTS_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["list_post_drafts", "ContentService.listDrafts"],
      ["get_post_draft", "ContentService.getDraft"],
      ["create_post_draft", "ContentService.createDraft"],
      ["update_post_draft", "ContentService.updateDraft"],
      ["duplicate_post_draft", "ContentService.duplicateDraft"],
    ]);
  });

  it("registers as a provider under the Posts category", async () => {
    const provider = createShareFlowToolProvider({
      services: { content: stubContent(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
      factories: POSTS_TOOL_FACTORIES,
    });
    const tools = await provider.listTools(CONTEXT);
    expect(tools).toHaveLength(5);
    expect(new Set(tools.map((t) => t.descriptor.category))).toEqual(new Set(["posts"]));
  });
});
