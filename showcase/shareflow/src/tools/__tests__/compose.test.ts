import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentPlatformError,
  asId,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import type { PostDraft, ShareFlowServices } from "../../services/index.js";
import type { ShareFlowToolFactory } from "../factory.js";
import { draftPostForChannelsTool, revisePostChannelsTool, revisionBrief, splitCaptions } from "../compose.js";

/**
 * The post agent's tools — #496. A fake generator that records every call, a validator that refuses
 * one channel on demand, and a content store that records what was saved.
 */
const CONTEXT = { tenantId: asId<TenantId>("t1"), principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

type Rec = { method: string; args: Record<string, unknown> };
let recorded: Rec[];
let generated: Array<{ platformId: string; brief: string }>;
let inFlight: number;
let maxInFlight: number;
let idempotency: IdempotencyStore;

const DRAFT: PostDraft = {
  id: asId("d1"),
  status: "draft",
  caption: "Instagram text",
  platformCaptions: { linkedin: "LinkedIn text", x: "X text" },
  targetPlatforms: ["instagram", "linkedin", "x"],
  mediaAssetIds: [],
  updatedAt: "2026-09-27T10:00:00.000Z",
} as unknown as PostDraft;

let credits: Rec[];

const services = (opts: { refuse?: string[]; outOfCredits?: boolean; byo?: boolean; project?: unknown } = {}): ShareFlowServices =>
  ({
    projects: { async current() { return opts.project ?? null; } },
    credits: {
      async reserve(_c: ExecutionContext, args: Record<string, unknown>) {
        credits.push({ method: "reserve", args });
        if (opts.outOfCredits === true) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "This needs 3 AI credits, but your Free plan only has 1 left. Upgrade for more.",
            retryable: false,
          });
        }
        return { byo: opts.byo === true, metered: true };
      },
      async charge(_c: ExecutionContext, args: { credits: number }) {
        credits.push({ method: "charge", args });
        return { charged: opts.byo === true ? 0 : args.credits };
      },
    },
    brand: { async getClaimPolicy() { return { forbidden: [] }; } },
    generator: {
      async generate(_c: ExecutionContext, input: { brief: string; platformIds: string[] }) {
        const platformId = input.platformIds[0]!;
        generated.push({ platformId, brief: input.brief });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return [{ platformId, caption: `${platformId} version` }];
      },
    },
    content: {
      async listDrafts() { return { items: [] }; },
      async validateContent(_c: ExecutionContext, input: { caption: string; platformIds: string[] }) {
        const refused = (opts.refuse ?? []).includes(input.platformIds[0]!);
        return refused
          ? { ok: false, issues: [{ code: "too-long", message: "over the limit", repairable: false, platformId: input.platformIds[0] }] }
          : { ok: true, issues: [] };
      },
      async createDraft(_c: ExecutionContext, args: Record<string, unknown>) {
        recorded.push({ method: "createDraft", args });
        return { ...DRAFT, id: asId("new1"), captionLength: String(args.caption).length, droppedMedia: [] };
      },
      async getDraft() { return DRAFT; },
      async updateDraft(_c: ExecutionContext, args: Record<string, unknown>) {
        recorded.push({ method: "updateDraft", args });
        return DRAFT;
      },
    },
  }) as unknown as ShareFlowServices;

const build = (factory: ShareFlowToolFactory, s: ShareFlowServices): Tool =>
  factory.build({ services: s, deps: { authorization: allowAll, idempotency } });
const run = (tool: Tool, input: unknown): Promise<ToolResult> => tool.execute({ context: CONTEXT, input, idempotencyKey: "k1" });

beforeEach(() => {
  recorded = [];
  credits = [];
  generated = [];
  inFlight = 0;
  maxInFlight = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("draft_post_for_channels", () => {
  it("writes every channel in parallel and saves ONE draft with a caption per channel", async () => {
    const result = await run(build(draftPostForChannelsTool, services()), { brief: "autumn menu", platformIds: ["instagram", "linkedin", "x"] });
    expect(result.ok).toBe(true);
    expect(generated.map((g) => g.platformId).sort()).toEqual(["instagram", "linkedin", "x"]);
    expect(maxInFlight).toBe(3); // at once, like compose's first turn
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: "createDraft",
      args: {
        caption: "instagram version",
        targetPlatforms: ["instagram", "linkedin", "x"],
        platformCaptions: { linkedin: "linkedin version", x: "x version" },
      },
    });
    expect(result).toMatchObject({ ok: true, data: { postDraftId: "new1", captionStoredInFull: true, failed: [] } });
  });

  it("reports each channel as it finishes, before the draft is saved (#497 AC-1)", async () => {
    const notes: Array<{ at: number; platformId: string; caption: string | null; callKey: string }> = [];
    const base = services({ refuse: ["x"] }) as unknown as { content: Record<string, unknown> };
    base.content["noteChannelWritten"] = async (_c: ExecutionContext, input: { callKey: string; platformId: string; caption: string | null }) => {
      notes.push({ at: recorded.length, ...input });
    };
    await run(build(draftPostForChannelsTool, base as unknown as ShareFlowServices), { brief: "autumn menu", platformIds: ["instagram", "linkedin", "x"] });
    expect(notes.map((n) => n.platformId).sort()).toEqual(["instagram", "linkedin", "x"]);
    // Every note lands before createDraft: that is the point — the panel fills cards while the post is being written.
    expect(notes.every((n) => n.at === 0)).toBe(true);
    expect(notes.find((n) => n.platformId === "linkedin")?.caption).toBe("linkedin version");
    // A channel that could not be written is reported as such, so its card stops spinning.
    expect(notes.find((n) => n.platformId === "x")?.caption).toBeNull();
    expect(new Set(notes.map((n) => n.callKey)).size).toBe(1);
  });

  it("writes the post even when the preview cannot be recorded", async () => {
    const base = services() as unknown as { content: Record<string, unknown> };
    base.content["noteChannelWritten"] = async () => {
      throw new Error("column \"writing\" does not exist");
    };
    const result = await run(build(draftPostForChannelsTool, base as unknown as ShareFlowServices), { brief: "autumn menu", platformIds: ["instagram"] });
    expect(result.ok).toBe(true);
    expect(recorded[0]?.method).toBe("createDraft");
  });

  it("saves only the channels it could write, and names the one it could not", async () => {
    const result = await run(build(draftPostForChannelsTool, services({ refuse: ["x"] })), {
      brief: "autumn menu",
      platformIds: ["instagram", "x"],
    });
    // X is not a target: it would otherwise publish Instagram's caption, which was never checked for X.
    expect(recorded[0]?.args).toMatchObject({ targetPlatforms: ["instagram"], platformCaptions: {} });
    expect(result).toMatchObject({ ok: true, data: { failed: [{ platformId: "x" }] } });
  });

  it("refuses, saving nothing, when no channel could be written", async () => {
    const result = await run(build(draftPostForChannelsTool, services({ refuse: ["instagram", "x"] })), {
      brief: "autumn menu",
      platformIds: ["instagram", "x"],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorded).toEqual([]);
  });
});

describe("revise_post_channels", () => {
  it("revises only the named channel, from that channel's own saved text", async () => {
    const result = await run(build(revisePostChannelsTool, services()), {
      postDraftId: "d1",
      instruction: "more professional",
      platformIds: ["linkedin"],
    });
    expect(result.ok).toBe(true);
    expect(generated).toHaveLength(1);
    expect(generated[0]!.platformId).toBe("linkedin");
    expect(generated[0]!.brief).toContain("LinkedIn text"); // its own text, not Instagram's
    expect(recorded[0]).toMatchObject({
      method: "updateDraft",
      args: { patch: { caption: "Instagram text", platformCaptions: { linkedin: "linkedin version", x: "X text" } } },
    });
  });

  it("revises every channel when none is named", async () => {
    await run(build(revisePostChannelsTool, services()), { postDraftId: "d1", instruction: "shorter" });
    expect(generated.map((g) => g.platformId).sort()).toEqual(["instagram", "linkedin", "x"]);
  });

  it("keeps a channel's text when it could not be revised, and reports it", async () => {
    const result = await run(build(revisePostChannelsTool, services({ refuse: ["x"] })), { postDraftId: "d1", instruction: "shorter" });
    expect(recorded[0]?.args).toMatchObject({ patch: { platformCaptions: { x: "X text" } } });
    expect(result).toMatchObject({ ok: true, data: { failed: [{ platformId: "x" }] } });
  });

  it("refuses a channel the post is not for", async () => {
    const result = await run(build(revisePostChannelsTool, services()), { postDraftId: "d1", instruction: "x", platformIds: ["tiktok"] });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorded).toEqual([]);
  });
});

describe("credits — #499, one per channel written", () => {
  it("checks for every channel before writing, and charges for the ones written", async () => {
    const result = await run(build(draftPostForChannelsTool, services({ refuse: ["x"] })), {
      brief: "autumn menu",
      platformIds: ["instagram", "linkedin", "x"],
    });
    expect(credits).toEqual([
      { method: "reserve", args: { credits: 3, tool: "draft_post_for_channels" } },
      // X failed its checks: two channels written, two credits — not three, and not per attempt.
      { method: "charge", args: { credits: 2, tool: "draft_post_for_channels" } },
    ]);
    expect(result).toMatchObject({ ok: true, data: { creditsUsed: 2 } });
  });

  it("refuses with the plan's upgrade message when credits are short, and writes nothing (AC-4)", async () => {
    const result = await run(build(draftPostForChannelsTool, services({ outOfCredits: true })), {
      brief: "autumn menu",
      platformIds: ["instagram", "linkedin", "x"],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("Upgrade for more") } });
    expect(generated).toEqual([]);
    expect(recorded).toEqual([]);
    expect(credits.filter((c) => c.method === "charge")).toEqual([]);
  });

  it("charges nothing when nothing could be written", async () => {
    await run(build(draftPostForChannelsTool, services({ refuse: ["instagram", "x"] })), { brief: "a", platformIds: ["instagram", "x"] });
    expect(credits.filter((c) => c.method === "charge")).toEqual([]);
  });

  it("reports the workspace's own key as costing nothing", async () => {
    const result = await run(build(draftPostForChannelsTool, services({ byo: true })), { brief: "a", platformIds: ["instagram"] });
    expect(result).toMatchObject({ ok: true, data: { creditsUsed: 0 } });
  });

  it("charges a revision for the channels it revised", async () => {
    const result = await run(build(revisePostChannelsTool, services({ refuse: ["x"] })), { postDraftId: "d1", instruction: "shorter" });
    expect(credits).toEqual([
      { method: "reserve", args: { credits: 3, tool: "revise_post_channels" } },
      { method: "charge", args: { credits: 2, tool: "revise_post_channels" } },
    ]);
    expect(result).toMatchObject({ ok: true, data: { creditsUsed: 2 } });
  });
});

describe("in a project — #522", () => {
  it("writes every channel from a brief that carries the project's instructions", async () => {
    const project = { id: "p1", name: "Posting about AI", instructions: "Always end with one question.", defaults: {} };
    await run(build(draftPostForChannelsTool, services({ project })), { brief: "small AI features", platformIds: ["instagram", "linkedin"] });
    expect(generated.map((g) => g.brief)).toEqual([expect.stringContaining("Always end with one question."), expect.stringContaining("Always end with one question.")]);
  });

  it("revises from a brief that carries them too", async () => {
    const project = { id: "p1", name: "Posting about AI", instructions: "Plain, no hype.", defaults: {} };
    await run(build(revisePostChannelsTool, services({ project })), { postDraftId: "d1", instruction: "shorter", platformIds: ["linkedin"] });
    expect(generated[0]!.brief).toContain("Plain, no hype.");
    expect(generated[0]!.brief).toContain("LinkedIn text");
  });
});

describe("the pure parts", () => {
  it("builds a revision brief that carries the current text and the change", () => {
    expect(revisionBrief("shorter", "Hello world")).toContain("Hello world");
    expect(revisionBrief("shorter", "Hello world")).toContain("Change requested: shorter");
    expect(revisionBrief("  launch post ", "")).toBe("launch post");
  });

  it("shares the first channel's text and keeps only the others that differ", () => {
    const texts: Record<string, string> = { instagram: "A", linkedin: "B", x: "A" };
    expect(splitCaptions(["instagram", "linkedin", "x"] as never, (p) => texts[p]!)).toEqual({
      caption: "A",
      platformCaptions: { linkedin: "B" },
    });
  });
});
