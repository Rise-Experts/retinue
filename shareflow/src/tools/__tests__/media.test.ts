/**
 * The Media capabilities (#118).
 *
 * Two ACs here are about what is *absent*: AC-4 (no bytes reach the conversation) and AC-5 (no limit is
 * duplicated into this provider). Both are tested by looking at the shipped source as well as the
 * results, because "we did not hardcode a limit" is not something a stub can demonstrate.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  asId,
  createMemoryApprovalGrantStore,
  createMemoryIdempotencyStore,
  createApprovalGate,
  type ApprovalGate,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import {
  EDIT_REMEDY_DUPLICATE,
  MEDIA_TOOL_FACTORIES,
  MEDIA_TOOL_NAMES,
  attachMediaTool,
  checkMediaForPlatformsTool,
  checkMediaStorageTool,
  convertMediaTool,
  createShareFlowToolProvider,
  inspectMediaTool,
  listMediaTool,
  serviceFailure,
  type MediaAsset,
  type MediaAssetId,
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
    convert: record("convert", asset({ id: asId<MediaAssetId>("m9"), mimeType: "video/mp4", label: "launch-teaser.mp4" })),
    checkStorage: record("checkStorage", { ok: true, stage: "complete" }),
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

const build = (factory: ShareFlowToolFactory, media?: Partial<MediaService>): Tool =>
  factory({
    services: { media: stubMedia(recorder, media) } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency, approvals: grantingGate() },
  });

const run = (tool: Tool, input: unknown = {}, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

beforeEach(() => {
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1 and AC-2. */
describe("finding and inspecting media", () => {
  it("lists media with enough to choose one", async () => {
    const result = await run(build(listMediaTool));
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
          issue({ platformId: undefined, accountId: asId("a1"), code: "media-too-large", repairable: false }),
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
      const result = await run(tool, inputFor(tool.descriptor.name));
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
    expect(result).toMatchObject({ ok: true, data: { mediaAssetId: "m9", mimeType: "video/mp4" } });
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
    const tool = checkMediaStorageTool({
      services: { media: stubMedia(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
    });
    expect(await run(tool)).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(recorder.calls).toEqual([]);
  });
});

describe("delegation and the catalog", () => {
  it("names the service method every capability wraps", () => {
    expect(MEDIA_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["list_media", "MediaService.listAssets"],
      ["inspect_media", "MediaService.inspect"],
      ["check_media_for_platforms", "MediaService.checkPlatformCompatibility"],
      ["attach_media_to_post", "MediaService.attachToDraft"],
      ["convert_media", "MediaService.convert"],
      ["check_media_storage", "MediaService.checkStorage"],
    ]);
  });

  it("registers under the media category with only one gated capability", async () => {
    const provider = createShareFlowToolProvider({
      services: { media: stubMedia(recorder) } as unknown as ShareFlowServices,
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
    const tool = inspectMediaTool({
      services: { media: stubMedia(recorder) } as unknown as ShareFlowServices,
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
    case "check_media_storage":
      return {};
    case "inspect_media":
      return { mediaAssetId: "m1" };
    case "check_media_for_platforms":
      return { mediaAssetIds: ["m1"], platformIds: ["linkedin"] };
    case "attach_media_to_post":
      return { postDraftId: "d1", mediaAssetIds: ["m2"] };
    case "convert_media":
      return { mediaAssetId: "m1", targetFormat: "mp4" };
    default:
      throw new Error(`no input defined for ${name}`);
  }
}
