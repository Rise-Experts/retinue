/**
 * The Media capabilities (#118).
 *
 * Two ACs here are about what is *absent*: AC-4 (no bytes reach the conversation) and AC-5 (no limit is
 * duplicated into this provider). Both are tested by looking at the shipped source as well as the
 * results, because "we did not hardcode a limit" is not something a stub can demonstrate.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SocialAccountId } from "../../services/ids.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { asId, type ApprovalGate, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createApprovalGate } from "@retinue/agentkit/hitl";
import { createMemoryApprovalGrantStore, createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  EDIT_REMEDY_DUPLICATE,
  MEDIA_TOOL_FACTORIES,
  generateMediaTool,
  planVideoScenesTool,
  renderDiagramTool,
  renderCodeSnippetTool,
  MEDIA_TOOL_NAMES,
  attachMediaTool,
  checkMediaForPlatformsTool,
  checkMediaStorageTool,
  convertMediaTool,
  describeImageTool,
  enhanceMediaPromptTool,
  createShareFlowToolProvider,
  inspectMediaTool,
  listMediaTool,
  serviceFailure,
  type ActiveProject,
  type MediaAsset,
  type MediaAssetId,
  type MediaConversionJobId,
  type MediaService,
  type PostDraftId,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type ValidationIssue,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = { tenantId: T1, principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;
const M1 = asId<MediaAssetId>("m1");

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: M1,
  kind: "video",
  mimeType: "video/quicktime",
  bytes: 18_400_000,
  width: 1080,
  height: 1920,
  durationSeconds: 42,
  label: "launch-teaser.mov",
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

const stubMedia = (recorder: Recorder, overrides: Partial<MediaService> = {}): MediaService => {
  const record =
    <T>(method: string, result: T) =>
    async (_c: ExecutionContext, args?: unknown) => {
      recorder.calls.push({ method, args });
      return result;
    };
  return {
    listAssets: record("listAssets", { items: [asset()], nextCursor: "cur1" }),
    inspect: record("inspect", asset()),
    checkPlatformCompatibility: record("checkPlatformCompatibility", [issue()]),
    attachToDraft: record("attachToDraft", {
      draftId: asId<PostDraftId>("d1"),
      mediaAssetIds: [M1, asId<MediaAssetId>("m2")],
    }),
    attachPathsToDraft: record("attachPathsToDraft", {
      draftId: asId<PostDraftId>("d1"),
      mediaAssetIds: [M1],
    }),
    /**
     * A **conversion**, not an asset — the port changed shape in REQ-041 (#190) so a queued video conversion
     * could be represented at all. `succeeded` here, so the asset is present; the queued case has its own test.
     */
    convert: record("convert", {
      jobId: asId<MediaConversionJobId>("job1"),
      state: "succeeded",
      targetFormat: "mp4",
      asset: asset({ id: asId<MediaAssetId>("m9"), mimeType: "video/mp4", label: "launch-teaser.mp4" }),
    }),
    getConversion: record("getConversion", {
      jobId: asId<MediaConversionJobId>("job1"),
      state: "running",
      targetFormat: "mp4",
    }),
    detachFromDraft: record("detachFromDraft", {
      draftId: asId<PostDraftId>("d1"),
      mediaAssetIds: [M1],
    }),
    replaceOnDraft: record("replaceOnDraft", {
      draftId: asId<PostDraftId>("d1"),
      mediaAssetIds: [asId<MediaAssetId>("m9")],
    }),
    checkStorage: record("checkStorage", { ok: true, stage: "complete" }),
    /**
     * The one write that starts from bytes rather than from something already stored.
     *
     * Returns a **reference** and no path, which is what the port promises — and what the byte scan in
     * this file checks for every capability, `render_diagram` included.
     */
    storeAsset: record("storeAsset", {
      reference: "chorus-media:ws-1/diagram.png",
      contentType: "image/png",
      byteSize: 6,
    }),
    /** #496: a job id straight back, and a finished job whose assets are ids — never paths or URLs. */
    generate: record("generate", { jobId: "job7", provider: "higgsfield" }),
    getGeneration: record("getGeneration", {
      jobId: "job7",
      kind: "image",
      state: "succeeded",
      provider: "higgsfield",
      assets: [{ id: "a1", mimeType: "image/png" }],
    }),
    ...overrides,
  } as unknown as MediaService;
};

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

/** Grants everything, so the gated storage check can be exercised. */
const grantingGate = (): ApprovalGate => ({
  ...createApprovalGate({ grants: createMemoryApprovalGrantStore() }),
  async isAllowed() {
    return true;
  },
});

let recorder: Recorder;
let idempotency: IdempotencyStore;
/** #595: the chat's project, for the renderers' theme. */
let chatProject: ActiveProject | null = null;

/**
 * The generator, for the two prompt-writing capabilities.
 *
 * They live in this file because they are *about* media, and they touch `MediaService` not at all —
 * which is why the stub is separate and why `requires` differs per factory.
 */
const stubGenerator = () => ({
  async enhanceMediaPrompt(_c: unknown, input: { brief: string; kind: string }) {
    recorder.calls.push({ method: "ContentGenerator.enhanceMediaPrompt", args: input as never });
    /**
     * A brief that is already long comes back verbatim, which is what a real model does with one — and
     * it is the case `changed` exists to describe. Without it the stub could never produce the
     * unchanged answer and that flag would be untestable.
     */
    if (input.brief.trim().length > 120) return input.brief.trim();
    return `A ${input.kind} of ${input.brief}, shot on 35mm, golden hour, slow push in.`;
  },
  async describeImage(_c: unknown, input: { image: { bytes: Uint8Array; mime: string }; mode: string }) {
    recorder.calls.push({
      method: "ContentGenerator.describeImage",
      // The bytes themselves are never recorded — only that they arrived, and how many.
      args: { mode: input.mode, mime: input.image.mime, bytes: input.image.bytes.byteLength } as never,
    });
    return input.mode === "alt_text" ? "A tabby cat on a windowsill." : "Something worth a second look.";
  },
  async planVideoScenes(_c: unknown, input: { concept: string; sceneCount: number }) {
    recorder.calls.push({ method: "ContentGenerator.planVideoScenes", args: input as never });
    return Array.from({ length: input.sceneCount }, (_, index) => `Scene ${index + 1} of ${input.concept}.`);
  },
});

/**
 * The research service, for `describe_image` — which reads its bytes through it rather than through a
 * second copy of the guarded fetch and the asset resolver.
 */
/** The renderer, for `render_diagram`. Its own behaviour is tested against a real Chromium elsewhere. */
const stubRender = () => ({
  async renderDiagram(_c: unknown, input: { source: string; width?: number; transparent?: boolean }) {
    recorder.calls.push({ method: "RenderService.renderDiagram", args: input as never });
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), mime: "image/png" as const, width: 900, height: 220 };
  },
  async renderCodeSnippet(_c: unknown, input: { code: string }) {
    recorder.calls.push({ method: "RenderService.renderCodeSnippet", args: input as never });
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3, 4]), mime: "image/png" as const, width: 1100, height: 480 };
  },
});

const stubResearch = () => ({
  async readImage(_c: unknown, input: { source: { kind: string; url?: string; assetId?: string } }) {
    recorder.calls.push({ method: "ResearchService.readImage", args: input as never });
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), mime: "image/png" };
  },
});

const build = (factory: ShareFlowToolFactory, media?: Partial<MediaService>): Tool =>
  factory.build({
    services: {
      media: stubMedia(recorder, media),
      generator: stubGenerator(),
      research: stubResearch(),
      render: stubRender(),
      projects: { async current() { return chatProject; } },
    } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency, approvals: grantingGate() },
  });

const run = (tool: Tool, input: unknown = {}, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

beforeEach(() => {
  chatProject = null;
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1 and AC-2. */
describe("finding and inspecting media", () => {
  it("lists media with enough to choose one", async () => {
    const result = await run(build(listMediaTool), { page: { kind: "first" } });
    expect(result).toMatchObject({
      ok: true,
      data: { media: [{ mediaAssetId: "m1", kind: "video", mimeType: "video/quicktime" }], nextCursor: "cur1" },
    });
    expect(recorder.calls[0]?.args).toEqual({ limit: 10 });
  });

  it("returns dimensions, duration, format and size", async () => {
    // Exactly AC-2: enough for a per-platform limit check to be decidable.
    const result = await run(build(inspectMediaTool), { mediaAssetId: "m1" });
    expect(result).toEqual({
      ok: true,
      data: {
        mediaAssetId: "m1",
        kind: "video",
        mimeType: "video/quicktime",
        bytes: 18_400_000,
        label: "launch-teaser.mov",
        width: 1080,
        height: 1920,
        durationSeconds: 42,
      },
    });
  });
});

/** AC-3. */
describe("checking media against destinations", () => {
  it("returns structured findings with stable codes", async () => {
    const result = await run(build(checkMediaForPlatformsTool), {
      mediaAssetIds: ["m1"],
      platformIds: ["LinkedIn"],
    });
    expect(result).toEqual({
      ok: true,
      data: {
        ok: false,
        issues: [
          {
            code: "media-kind-unsupported",
            platformId: "linkedin",
            message: "LinkedIn does not accept video",
            repairable: true,
          },
        ],
      },
    });
    // Platform ids normalised, as everywhere else — a model sends "LinkedIn".
    expect(recorder.calls[0]?.args).toEqual({ assetIds: ["m1"], platformIds: ["linkedin"] });
  });

  it("derives ok rather than asking the service for it", async () => {
    // A caller that has to count the issues itself will eventually forget to, and an empty list read as
    // "no answer" is the failure mode.
    const result = await run(
      build(checkMediaForPlatformsTool, { checkPlatformCompatibility: async () => [] }),
      { mediaAssetIds: ["m1"], platformIds: ["x"] },
    );
    expect(result).toMatchObject({ ok: true, data: { ok: true, issues: [] } });
  });

  it("returns the same finding shape the publishing validator uses", async () => {
    // AC-3's real requirement: #119 consumes one contract. A finding scoped to an account rather than a
    // platform must round-trip through the same view.
    const result = await run(
      build(checkMediaForPlatformsTool, {
        checkPlatformCompatibility: async () => [
          issue({ platformId: undefined, accountId: asId<SocialAccountId>("a1"), code: "media-too-large", repairable: false }),
        ],
      }),
      { mediaAssetIds: ["m1"], platformIds: ["x"] },
    );
    const issues = (result as { data: { issues: Record<string, unknown>[] } }).data.issues;
    expect(issues[0]).toEqual({
      code: "media-too-large",
      message: "LinkedIn does not accept video",
      repairable: false,
      accountId: "a1",
    });
    expect(issues[0]).not.toHaveProperty("platformId");
  });
});

/** AC-4. */
describe("generating media — #496", () => {
  it("hands the service exactly what was asked, and answers with the job to poll", async () => {
    const result = await run(build(generateMediaTool), { kind: "video", prompt: "latte art", aspectRatio: "9:16", count: 2, postDraftId: "d1" });
    expect(recorder.calls).toEqual([
      { method: "generate", args: { kind: "video", prompt: "latte art", aspectRatio: "9:16", count: 2, postDraftId: "d1" } },
    ]);
    expect(result).toMatchObject({ ok: true, data: { jobId: "job7", provider: "higgsfield", state: "queued" } });
  });

  it("refuses a shape that is not a ratio, before anything is spent", async () => {
    const result = await run(build(generateMediaTool), { kind: "image", prompt: "latte art", aspectRatio: "square" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorder.calls).toEqual([]);
  });
});

describe("attaching by reference", () => {
  it("adds to the existing attachments rather than replacing them", async () => {
    const result = await run(build(attachMediaTool), { postDraftId: "d1", mediaAssetIds: ["m2"] });
    expect(result).toEqual({
      ok: true,
      data: { postDraftId: "d1", mediaAssetIds: ["m1", "m2"] },
    });
    // The caller sent one id and the result carries two: the service appended. A replace would have made
    // the model read the current list first, which is a read-modify-write it can get wrong.
    expect(recorder.calls[0]?.args).toEqual({ idempotencyKey: "k1", draftId: "d1", assetIds: ["m2"] });
  });

  it("never returns bytes, content or a URL from any capability", async () => {
    // The structural half of AC-4, over every capability. A signed URL in a tool result is persisted in
    // the run event log and readable by anyone who can read the conversation, long after the permission
    // check that produced it.
    const forbiddenKeys = ["url", "signedUrl", "publicUrl", "path", "storagePath", "content", "data", "base64"];
    const forbiddenValues = [/^data:/, /base64,/, /^https?:\/\/[^ ]+\.(png|jpe?g|mp4|mov|webp|gif)/i];

    for (const factory of MEDIA_TOOL_FACTORIES) {
      const tool = build(factory);
      /**
       * **A key per tool.** Every call here shared `"k1"`, and the envelope caches a successful result
       * under its idempotency key — so the first tool's answer was returned for all of the others and
       * this loop checked exactly one capability while claiming to check every one.
       *
       * Found when a new factory that legitimately fails under this stub still passed.
       */
      const result = await run(tool, inputFor(tool.descriptor.name), `bytes:${tool.descriptor.name}`);
      expect(result.ok, tool.descriptor.name).toBe(true);
      // The *payload*, not the envelope: `data` is `ToolResult`'s own key, so scanning the whole result
      // would flag every success. Keeping `data` in the list below still catches a payload field called
      // `data`, which is what an adapter inlining content would produce.
      const serialised = JSON.stringify((result as { data: unknown }).data);
      for (const key of forbiddenKeys) {
        expect(serialised, `${tool.descriptor.name} / ${key}`).not.toContain(`"${key}"`);
      }
      for (const pattern of forbiddenValues) {
        expect(serialised, `${tool.descriptor.name} / ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("refuses an attachment that would break a destination, with the reasons", async () => {
    // ShareFlow's writer re-validates compatibility against the resulting set and refuses. That must
    // arrive as findings the assistant can act on, not as a joined-up string.
    const result = await run(
      build(attachMediaTool, {
        attachToDraft: async () => {
          throw serviceFailure("invalid_input", "LinkedIn does not accept video", {
            details: { issues: [issue()] },
          });
        },
      }),
      { postDraftId: "d1", mediaAssetIds: ["m1"] },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { issues: [{ code: "media-kind-unsupported" }] } },
    });
  });

  it("carries the duplicate remedy when the post is no longer editable", async () => {
    // The writer re-asserts the editable set at write time, because "the post may have been approved and
    // published between the read above and this update". Same conflict, same remedy as #115.
    const result = await run(
      build(attachMediaTool, {
        attachToDraft: async () => {
          throw serviceFailure("conflict", "already published", {
            details: { remedy: EDIT_REMEDY_DUPLICATE },
          });
        },
      }),
      { postDraftId: "d1", mediaAssetIds: ["m1"] },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { remedy: "duplicate-then-edit" } },
    });
  });
});

/** AC-5. */
describe("no limit is duplicated into this provider", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../media.ts"),
    "utf8",
  );

  it("contains no byte ceiling, file count or MIME list", () => {
    // Asserted against the shipped source, because a stub cannot demonstrate the absence of a constant.
    // `platform_rules` is workspace-overridable data — a limit copied here would be silently wrong for
    // any workspace that overrode it, and wrong in the direction that refuses legitimate media.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // strip comments; prose may mention them
    // ShareFlow's real values: MEDIA_MAX_BYTES = 52_428_800, MEDIA_MAX_FILES = 4.
    expect(code).not.toMatch(/52_?428_?800/);
    expect(code).not.toMatch(/\bMEDIA_MAX/);
    expect(code).not.toMatch(/image\/(png|jpeg|webp|gif)/);
    expect(code).not.toMatch(/video\/(mp4|webm|quicktime)/);
  });

  it("does not enumerate the conversion formats the service supports", () => {
    // `CONVERT_TARGETS` can grow. A copy here would eventually refuse something the service supports,
    // and the refusal would read as a platform limitation rather than a stale constant.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const format of ["webp", "webm", "quicktime"]) {
      expect(code, format).not.toContain(`"${format}"`);
    }
    expect(code).not.toMatch(/z\.enum\(\s*\[\s*["']mp4/);
  });

  it("passes an unrecognised format to the service instead of rejecting it locally", async () => {
    // The consequence of not duplicating the list: a format this file has never heard of must reach the
    // service, which is the only thing that knows whether it is supported.
    await run(build(convertMediaTool), { mediaAssetId: "m1", targetFormat: "avif" });
    expect(recorder.calls[0]?.args).toMatchObject({ targetFormat: "avif" });
  });

  it("still rejects obvious nonsense without a round trip", async () => {
    const tool = build(convertMediaTool);
    for (const bad of ["", "video/mp4", "a", "make it smaller please", "MP4!"]) {
      expect(await run(tool, { mediaAssetId: "m1", targetFormat: bad }), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-6. */
describe("conversion delegates", () => {
  it("asks for a format, not a platform", async () => {
    // #114 had `targetPlatformId`. Deciding which format a platform accepts is platform-rules knowledge
    // this provider must not hold, so the parameter is the format the existing service actually takes.
    const result = await run(build(convertMediaTool), { mediaAssetId: "m1", targetFormat: "MP4" });
    /**
     * The asset now sits **under** the conversion, because the port returns a job. That nesting is the
     * point: a caller has to look at `state` before it can reach a file, so there is no path to read off a
     * conversion that has not finished.
     */
    expect(result).toMatchObject({
      ok: true,
      data: { state: "succeeded", targetFormat: "mp4", asset: { mediaAssetId: "m9", mimeType: "video/mp4" } },
    });
    expect(recorder.calls[0]).toEqual({
      method: "convert",
      args: { idempotencyKey: "k1", id: "m1", targetFormat: "mp4" },
    });
  });

  it("does not convert twice when the call is retried", async () => {
    // The service is already content-addressed — "Determinism IS the cache" — so the two layers agree
    // rather than compete, and a retry neither re-encodes nor produces a second asset.
    const tool = build(convertMediaTool);
    await run(tool, { mediaAssetId: "m1", targetFormat: "mp4" }, "same");
    await run(tool, { mediaAssetId: "m1", targetFormat: "mp4" }, "same");
    expect(recorder.calls.filter((c) => c.method === "convert")).toHaveLength(1);
  });
});

describe("the storage diagnostic", () => {
  it("reports the stage it reached, not just a failure", async () => {
    // A config failure, an unreachable host and a private bucket need three different fixes and look
    // identical from a failed publish.
    const result = await run(
      build(checkMediaStorageTool, {
        checkStorage: async () => ({
          ok: false,
          stage: "public-read" as const,
          hint: "the bucket is private; the platforms fetch with no credentials",
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { ok: false, stage: "public-read", hint: expect.stringContaining("private") },
    });
  });

  it("reports missing configuration by name only", async () => {
    const result = await run(
      build(checkMediaStorageTool, {
        checkStorage: async () => ({ ok: false, stage: "config" as const, missing: ["R2_ACCOUNT_ID"] }),
      }),
    );
    expect(result).toMatchObject({ ok: true, data: { missingConfiguration: ["R2_ACCOUNT_ID"] } });
    // Names, never values — the same line #117 draws for `credentialVariables`.
    expect(JSON.stringify(result)).not.toMatch(/=/);
  });

  it("is classified as an external write, so the approval gate applies", () => {
    // Honest rather than convenient. It PUTs a diagnostic object, and #117's `check_account_health` is
    // `read` only because it GETs. Relabelling this to dodge an approval prompt would be bending the
    // taxonomy the gate depends on.
    const { descriptor } = build(checkMediaStorageTool);
    expect(descriptor.effect).toBe("external-write");
    expect(descriptor.approvalPolicy).toBe("always");
    expect(descriptor.requiresIdempotencyKey).toBe(true);
  });

  it("is refused outright when no approval gate is wired", async () => {
    const tool = checkMediaStorageTool.build({
      services: {
        media: stubMedia(recorder),
        generator: stubGenerator(),
        research: stubResearch(),
        render: stubRender(),
        projects: { async current() { return null; } },
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
    });
    expect(await run(tool)).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(recorder.calls).toEqual([]);
  });
});

describe("the two prompt-writing capabilities", () => {
  /**
   * `enhance_media_prompt` and `plan_video_scenes` — REQ-019. Neither generates media and neither
   * touches `MediaService`; they write the prompt a generation job is queued with.
   */
  it("passes the kind through, because a still and a clip are different instructions", async () => {
    // The adapter branches on it — motion and audio for video, composition and mood for a still — so a
    // tool that dropped it would produce still-image language for a video.
    await run(build(enhanceMediaPromptTool), { brief: "a cat drinking oat milk", kind: "video" });
    expect(recorder.calls[0]).toEqual({
      method: "ContentGenerator.enhanceMediaPrompt",
      args: { brief: "a cat drinking oat milk", kind: "video" },
    });
  });

  it("says whether the brief actually changed", async () => {
    /**
     * A model handed an already-detailed brief can legitimately return it nearly verbatim, and a UI
     * showing "enhanced" over unchanged text is a small lie of the kind this cutover keeps removing.
     */
    const changed = await run(build(enhanceMediaPromptTool), { brief: "a cat", kind: "image" });
    expect(changed).toMatchObject({ ok: true, data: { changed: true, kind: "image" } });

    // A brief the stub returns verbatim, the way a model leaves an already-detailed one alone.
    const detailed =
      "A tabby cat drinking oat milk from a ceramic bowl on a sunlit kitchen counter, shot on 35mm, " +
      "golden hour, shallow depth of field, slow push in.";
    const unchanged = await run(build(enhanceMediaPromptTool), { brief: detailed, kind: "image" }, "k2");
    expect(unchanged).toMatchObject({ ok: true, data: { changed: false } });
  });

  it("refuses a kind that is not image or video, and an empty brief", async () => {
    for (const bad of [{ brief: "a cat", kind: "gif" }, { brief: "   ", kind: "image" }, { brief: "a cat" }]) {
      expect(await run(build(enhanceMediaPromptTool), bad, JSON.stringify(bad))).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("numbers the scenes, because the order is the film", async () => {
    // A caller queues one generation job per scene; losing the order makes the cuts meaningless.
    const result = await run(build(planVideoScenesTool), { concept: "a barista's morning", sceneCount: 3 });
    expect(result).toMatchObject({
      ok: true,
      data: {
        sceneCount: 3,
        scenes: [
          { scene: 1, prompt: "Scene 1 of a barista's morning." },
          { scene: 2, prompt: "Scene 2 of a barista's morning." },
          { scene: 3, prompt: "Scene 3 of a barista's morning." },
        ],
      },
    });
  });

  it("refuses a scene count outside what the planner plans", async () => {
    /**
     * `ge=2, le=4`, transcribed. One scene is not a planned video — it is a clip, and
     * `enhance_media_prompt` is the tool for that.
     */
    for (const sceneCount of [1, 5, 0, -1]) {
      expect(
        await run(build(planVideoScenesTool), { concept: "a morning", sceneCount }, `k${sceneCount}`),
        String(sceneCount),
      ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("neither one is gated, because neither changes anything", async () => {
    // `read`. A prompt is text; the generation job it is queued with is ShareFlow's, and that is where
    // the cost and the approval question live.
    for (const factory of [enhanceMediaPromptTool, planVideoScenesTool]) {
      expect(build(factory).descriptor.effect).toBe("read");
    }
  });
});

describe("describe_image", () => {
  /**
   * A vision model over one image — REQ-019. Three modes that are not three tones of one answer.
   */
  it("reads its bytes through the research service, not a second fetch", async () => {
    /**
     * The guarded fetch and the asset resolver live in `ResearchService` because `read_pdf` needed them
     * first. A second copy here would be a second egress policy, and *"the one that drifts is the one
     * nobody re-reads."*
     */
    await run(build(describeImageTool), {
      source: { kind: "url", url: "https://example.test/cat.png" },
      mode: "alt_text",
    });
    expect(recorder.calls[0]).toEqual({
      method: "ResearchService.readImage",
      args: { source: { kind: "url", url: "https://example.test/cat.png" } },
    });
    // And the mime it resolved travels to the model: a PNG sent as JPEG is a decode error in the provider.
    expect(recorder.calls[1]).toMatchObject({ method: "ContentGenerator.describeImage", args: { mime: "image/png" } });
  });

  it("defaults to alt text, which is the free and most common mode", async () => {
    await run(build(describeImageTool), { source: { kind: "asset", assetId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" } });
    expect(recorder.calls[1]).toMatchObject({ args: { mode: "alt_text" } });
  });

  it("returns the byte count and never the bytes", async () => {
    /**
     * *"A signed URL in a tool result is persisted in the run event log and readable by anyone who can
     * read the conversation"* — which applies to inlined bytes twice over. The size is what makes the
     * answer checkable: a description of a 200-byte image is a description of nothing.
     */
    const result = await run(build(describeImageTool), {
      source: { kind: "url", url: "https://example.test/cat.png" },
      mode: "alt_text",
    });
    expect(result).toMatchObject({ ok: true, data: { text: "A tabby cat on a windowsill.", mode: "alt_text", imageBytes: 8 } });
    expect(JSON.stringify((result as { data: unknown }).data)).not.toContain("base64");
    /**
     * The count the caller is given is the count the model was given.
     *
     * Asserted as a pair because the alternative is a result that *describes* an image nobody looked at:
     * a tool passing empty bytes to the model while reporting the resolved size would read as a working
     * description of the right file.
     */
    expect(recorder.calls[1]).toMatchObject({ method: "ContentGenerator.describeImage", args: { bytes: 8 } });
  });

  it("refuses a base64 payload and a storage path outright", async () => {
    /**
     * The old MCP tool took `data` (base64) and `storagePath`. A model cannot produce image bytes, so a
     * field for them is an invitation to hallucinate a payload; and nothing in this runtime can produce
     * a path. `.strict()` is what makes both refusals real rather than conventions.
     */
    for (const input of [
      { source: { kind: "url", url: "https://example.test/a.png" }, data: "iVBORw0KGgo=" },
      { source: { kind: "path", path: "ws/cat.png" } },
      { source: { kind: "asset", assetId: "m1" }, mode: "alt_text", storagePath: "ws/cat.png" },
    ]) {
      expect(await run(build(describeImageTool), input, JSON.stringify(input)), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("refuses a mode it does not have a prompt for", async () => {
    // Three modes, each with its own instruction. A fourth would be a mode with no prompt behind it.
    expect(await run(build(describeImageTool), {
      source: { kind: "url", url: "https://example.test/a.png" },
      mode: "roast",
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("render_code_snippet in a project (#595)", () => {
  const themed: ActiveProject = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "playful" } };

  it("defaults to the brand window when the project has a theme", async () => {
    chatProject = themed;
    const result = await run(build(renderCodeSnippetTool), { code: "const a = 1;" });
    expect(recorder.calls[0]).toMatchObject({ args: { theme: "brand", brand: { id: "playful" } } });
    expect(result).toMatchObject({ ok: true, data: { theme: "brand" } });
  });

  it("keeps a theme the model asked for", async () => {
    chatProject = themed;
    await run(build(renderCodeSnippetTool), { code: "const a = 1;", theme: "light" });
    expect(recorder.calls[0]?.args).toMatchObject({ theme: "light" });
    expect(recorder.calls[0]?.args).not.toHaveProperty("brand");
  });

  it("draws the dark window outside a project, and says so when brand was asked for", async () => {
    const plain = await run(build(renderCodeSnippetTool), { code: "const a = 1;" });
    expect(recorder.calls[0]?.args).not.toHaveProperty("theme");
    expect(plain).toMatchObject({ ok: true, data: { theme: "dark" } });
    const asked = await run(build(renderCodeSnippetTool), { code: "const a = 1;", theme: "brand" }, "k2");
    const drawn = recorder.calls.filter((c) => c.method === "RenderService.renderCodeSnippet");
    expect(drawn[1]?.args).toMatchObject({ theme: "dark" });
    expect(asked).toMatchObject({ ok: true, data: { theme: "dark", themeNote: expect.stringContaining("no theme") } });
  });
});

describe("render_diagram", () => {
  /**
   * Mermaid source to a stored PNG. What the *renderer* does is tested against a real Chromium in
   * `adapters/web/__tests__/`; these are about the tool's contract.
   */
  it("stores the drawing and returns a reference with its dimensions", async () => {
    /**
     * The dimensions are here because the caller is about to attach this somewhere with its own rules.
     * `check_media_for_platforms` answers whether it fits; these make the question askable without a
     * round trip to inspect what was just created.
     */
    const result = await run(build(renderDiagramTool), { diagram: "flowchart LR\n A --> B", width: 900 });
    expect(result).toMatchObject({
      ok: true,
      data: { reference: "chorus-media:ws-1/diagram.png", width: 900, height: 220, byteSize: 6 },
    });
    expect(recorder.calls.map((c) => c.method)).toEqual(["RenderService.renderDiagram", "storeAsset"]);
  });

  it("passes transparency through, since it is what makes a diagram usable on a card", async () => {
    // *"Drops the white background, which is what you want when the image will sit on a platform's own
    // card styling."*
    await run(build(renderDiagramTool), { diagram: "flowchart LR\n A --> B", transparent: true });
    expect(recorder.calls[0]).toMatchObject({ args: { transparent: true } });
  });

  it("draws in the project's theme inside a themed project, and passes none outside one (#595)", async () => {
    await run(build(renderDiagramTool), { diagram: "flowchart LR\n A --> B" });
    expect(recorder.calls[0]?.args).not.toHaveProperty("theme");
    chatProject = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "bold" } };
    recorder = { calls: [] };
    await run(build(renderDiagramTool), { diagram: "flowchart LR\n A --> B" }, "k2");
    expect(recorder.calls[0]).toMatchObject({ args: { theme: { id: "bold", palette: { primary: "#dc2626" } } } });
  });

  it("keeps today's drawing for a project whose kit sets only shapes (#595)", async () => {
    chatProject = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { aspectRatios: ["4:5"] } };
    await run(build(renderDiagramTool), { diagram: "flowchart LR\n A --> B" });
    expect(recorder.calls[0]?.args).not.toHaveProperty("theme");
  });

  it("tells the model to use a fenced block for showing rather than storing", async () => {
    /**
     * The instruction that decides *when* to call it, and the reason it is in the description: *"For
     * simply SHOWING a diagram in the conversation, put a ```mermaid block in your reply instead — that
     * renders directly and costs nothing."* A tool that renders every diagram to a PNG fills the
     * workspace's media with pictures of conversations.
     */
    const { description } = build(renderDiagramTool).descriptor;
    expect(description).toMatch(/costs nothing/);
    expect(description).toMatch(/wants the diagram as an IMAGE/);
  });

  it("is an internal write, like the capture", async () => {
    expect(build(renderDiagramTool).descriptor.effect).toBe("internal-write");
  });

  it("refuses an empty diagram and a width nothing can render", async () => {
    for (const bad of [{ diagram: "   " }, { diagram: "flowchart LR\n A --> B", width: 10 }, { diagram: "x", width: 99_999 }]) {
      expect(await run(build(renderDiagramTool), bad, JSON.stringify(bad)), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });
});

describe("delegation and the catalog", () => {
  it("names the service method every capability wraps", () => {
    expect(MEDIA_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["list_media", "MediaService.listAssets"],
      ["inspect_media", "MediaService.inspect"],
      ["check_media_for_platforms", "MediaService.checkPlatformCompatibility"],
      ["attach_media_to_post", "MediaService.attachToDraft"],
      ["attach_uploaded_media", "MediaService.attachPathsToDraft"],
      ["detach_media_from_post", "MediaService.detachFromDraft"],
      ["replace_media_on_post", "MediaService.replaceOnDraft"],
      ["convert_media", "MediaService.convert"],
      ["check_conversion", "MediaService.getConversion"],
      ["check_media_storage", "MediaService.checkStorage"],
      // Not `MediaService`: these write prompts for an image/video model and touch no media at all.
      ["enhance_media_prompt", "ContentGenerator.enhanceMediaPrompt"],
      ["plan_video_scenes", "ContentGenerator.planVideoScenes"],
      ["describe_image", "ContentGenerator.describeImage"],
      ["plan_visuals", "ContentGenerator.proposeAngles"],
      ["render_diagram", "RenderService.renderDiagram"],
      ["render_code_snippet", "RenderService.renderCodeSnippet"],
      ["generate_media", "MediaService.generate"],
      ["check_media_job", "MediaService.getGeneration"],
    ]);
  });

  it("registers under the media category with only one gated capability", async () => {
    const provider = createShareFlowToolProvider({
      services: {
        media: stubMedia(recorder),
        generator: stubGenerator(),
        research: stubResearch(),
        render: stubRender(),
        projects: { async current() { return null; } },
        // #597: metered tools need the credit service; unmetered here.
        credits: { async reserve() { return { byo: false, metered: false }; }, async charge() { return { charged: 0 }; } },
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency, approvals: grantingGate() },
      factories: MEDIA_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...MEDIA_TOOL_NAMES]);
    for (const d of descriptors) expect(d.category).toBe("media");
    // Only the diagnostic is gated. Attaching and converting change nothing outside the workspace, so
    // prompting for them would train the user to approve without reading.
    expect(descriptors.filter((d) => d.approvalPolicy !== "never").map((d) => d.name)).toEqual([
      "check_media_storage",
    ]);
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = inspectMediaTool.build({
      services: {
        media: stubMedia(recorder),
        generator: stubGenerator(),
        research: stubResearch(),
        render: stubRender(),
        projects: { async current() { return null; } },
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
    expect(await run(tool, { mediaAssetId: "m1" })).toMatchObject({ ok: false });
    expect(recorder.calls).toEqual([]);
  });
});

/** Valid arguments per tool, for the sweeps above. */
function inputFor(name: string): unknown {
  switch (name) {
    case "list_media":
      // `page` is a required choice now, not an optional cursor — see `pageInput`.
      return { page: { kind: "first" } };
    case "check_media_storage":
      return {};
    case "inspect_media":
      return { mediaAssetId: "m1" };
    case "check_media_for_platforms":
      return { mediaAssetIds: ["m1"], platformIds: ["linkedin"] };
    case "attach_media_to_post":
      return { postDraftId: "d1", mediaAssetIds: ["m2"] };
    case "attach_uploaded_media":
      return { postDraftId: "d1", paths: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301/upload.png"] };
    case "convert_media":
      return { mediaAssetId: "m1", targetFormat: "mp4" };
    case "check_conversion":
      return { jobId: "job1" };
    case "detach_media_from_post":
      return { postDraftId: "d1", mediaAssetIds: ["m1"] };
    case "replace_media_on_post":
      return { postDraftId: "d1", remove: "m1", add: "m9" };
    case "enhance_media_prompt":
      return { brief: "a cat drinking oat milk", kind: "image" };
    case "plan_video_scenes":
      return { concept: "a barista's morning", sceneCount: 2 };
    case "render_diagram":
      return { diagram: "flowchart LR\n A --> B" };
    case "plan_visuals":
      return { brief: "autumn menu launch", images: 1 };
    case "render_code_snippet":
      return { code: "const answer = 42;", title: "answer.ts" };
    case "describe_image":
      return { source: { kind: "asset", assetId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }, mode: "alt_text" };
    case "generate_media":
      return { kind: "image", prompt: "a flat white on a marble counter", aspectRatio: "4:5", postDraftId: "d1" };
    case "check_media_job":
      return { jobId: "job7" };
    default:
      throw new Error(`no input defined for ${name}`);
  }
}

describe("generate_media with a draft id that is not one (#577)", () => {
  it("still makes the media, unattached, and says how to attach it", async () => {
    // Production sent this alongside create_post_draft, before the draft existed.
    const result = await run(build(generateMediaTool), { kind: "image", prompt: "latte art", postDraftId: "/create_post_draft_result_id_placeholder" });
    expect(recorder.calls).toEqual([{ method: "generate", args: { kind: "image", prompt: "latte art" } }]);
    expect(result).toMatchObject({ ok: true, data: { jobId: "job7", state: "queued" } });
    expect(JSON.stringify(result)).toContain("attach_media_to_post");
  });
});
