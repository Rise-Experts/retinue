import { describe, expect, it } from "vitest";
import { withMediaDefaults, withMediaInput } from "../media-defaults.js";
import { parseTurnSettings } from "../turn-settings.js";
import { channelRulesText } from "../turn-context.js";
import { withCaptionedChannels } from "../../tools/posts.js";
import { optionalIdString } from "../../tools/factory.js";
import { buildCodeSnippetHtml, codeSnippetProblem, highlight } from "../../adapters/web/code-snippet.js";

/** #572 — what the production run of 2026-09-28 got wrong, each as a check. */
describe("post creation (#573)", () => {
  it("sends a post to every channel it wrote a caption for", () => {
    // Production: targets ["facebook"], captions for instagram and linkedin → saved for Facebook only.
    expect(withCaptionedChannels(["facebook"], { instagram: "…", LinkedIn: "…" })).toEqual(["facebook", "instagram", "linkedin"]);
    expect(withCaptionedChannels(["x"], undefined)).toEqual(["x"]);
  });

  it("states the rules before writing, and says to split rather than fail", () => {
    const text = channelRulesText([{ platformId: "linkedin", charLimit: 3000, hashtagMin: 3, hashtagMax: 5 }])!;
    expect(text).toContain("- linkedin: at most 3000 characters, 3-5 hashtags");
    expect(channelRulesText([])).toBeNull();
  });
});

describe("a placeholder id means none (#577)", () => {
  it("reads the model's sentinels as not given, and keeps a real id", () => {
    for (const sentinel of ["none", "first", "/", "", "N/A"]) expect(optionalIdString.parse(sentinel)).toBeUndefined();
    expect(optionalIdString.parse("968d5cfe-c90f-406e-bfec-c48e0e3e502a")).toBe("968d5cfe-c90f-406e-bfec-c48e0e3e502a");
  });
});

describe("image and video settings (#575)", () => {
  it("parses them off the run leniently", () => {
    expect(parseTurnSettings({ mode: "auto", media: { kind: "video", aspectRatio: "9:16" } }).media).toEqual({ kind: "video", aspectRatio: "9:16" });
    expect(parseTurnSettings({ media: { kind: "gif" } }).media).toBeUndefined();
  });

  it("applies the person's settings over the model's guess, for the kind they were set for", () => {
    // Production, 2026-09-28: Video · 9:16 set, and the model passed "16:9" and "default_video_model".
    const media = { kind: "video" as const, aspectRatio: "9:16", model: "kling3_0" };
    expect(withMediaInput({ kind: "video", prompt: "leaves" }, media)).toMatchObject({ aspectRatio: "9:16", model: "kling3_0" });
    expect(withMediaInput({ kind: "video", prompt: "leaves", aspectRatio: "16:9", model: "default_video_model" }, media)).toMatchObject({ aspectRatio: "9:16", model: "kling3_0" });
    expect(withMediaInput({ kind: "image", prompt: "a cup", aspectRatio: "1:1" }, media)).toEqual({ kind: "image", prompt: "a cup", aspectRatio: "1:1" });
  });

  it("drops a model name invented to mean the default", () => {
    expect(withMediaInput({ kind: "video", prompt: "leaves", model: "default_video_model" }, undefined)).not.toHaveProperty("model");
  });

  it("never sends an image model on a video job", () => {
    // Production: generate_media({ kind: "video", model: "z_image" }).
    expect(withMediaInput({ kind: "video", prompt: "leaves", model: "z_image" }, undefined)).not.toHaveProperty("model");
    expect(withMediaInput({ kind: "video", prompt: "leaves", model: "kling3_0" }, undefined)).toMatchObject({ model: "kling3_0" });
  });
});

describe("code as an image (#574)", () => {
  it("colours keywords, strings, comments, numbers and calls, and escapes everything", () => {
    const html = highlight('const x = run("a<b"); // note 42');
    expect(html).toContain('<span class="k">const</span>');
    expect(html).toContain('<span class="f">run</span>');
    expect(html).toContain('<span class="s">"a&lt;b"</span>');
    expect(html).toContain('<span class="c">// note 42</span>');
  });

  it("keeps a keyword inside a string a string", () => {
    expect(highlight('"return early"')).toBe('<span class="s">"return early"</span>');
  });

  it("refuses what a feed image cannot hold, before a browser starts", () => {
    expect(codeSnippetProblem("   ")).toContain("no code");
    expect(codeSnippetProblem("x\n".repeat(81))).toContain("81 lines");
    expect(codeSnippetProblem("const a = 1;")).toBeNull();
  });

  it("draws a window with traffic lights and the title", () => {
    const html = buildCodeSnippetHtml({ code: "x", title: "a<b>.ts", theme: "light" });
    expect(html).toContain("#ff5f57");
    expect(html).toContain("a&lt;b&gt;.ts");
  });
});

describe("the answer says what was sent (#575 follow-up)", () => {
  it("writes the applied shape and model into generate_media's result", async () => {
    // Production: 9:16 was sent, and the reply said "it will be in a 16:9 aspect ratio".
    const seen: unknown[] = [];
    const registry = {
      async execute(_c: unknown, input: { input: unknown }) {
        seen.push(input.input);
        return { ok: true, data: { jobId: "j1", state: "queued" } };
      },
    } as never;
    const wrapped = withMediaDefaults(registry, {
      turnInput: async () => ({ settings: { mode: "auto", effort: "medium", media: { kind: "video", aspectRatio: "9:16" } }, message: "" }),
    });
    const result = (await wrapped.execute({} as never, { name: "generate_media", input: { kind: "video", prompt: "leaves", aspectRatio: "16:9", model: "default" } } as never)) as {
      data: { sent: unknown };
    };
    expect(seen[0]).toMatchObject({ aspectRatio: "9:16" });
    expect(seen[0]).not.toHaveProperty("model");
    expect(result.data.sent).toEqual({ kind: "video", aspectRatio: "9:16", model: "the default for the kind" });
    // Production: with `sent` alone the reply still said "16:9". The note says it in words, first.
    expect((result.data as { note?: string }).note).toContain("shape 9:16");
    expect(Object.keys(result.data)[0]).toBe("note");
  });
});

describe("web search reaches the internal SearXNG (production, 2026-09-28)", () => {
  it("widens egress for exactly the configured search host, and only for searxng", async () => {
    const { searchEgressFor } = await import("../deployment.js");
    // agentkit's default (https only, no private networks) refused http://searxng:8080 before any request.
    expect(searchEgressFor("searxng", { RETINUE_SEARCH_ENDPOINT: "http://searxng:8080" })).toEqual({
      policy: { allowedSchemes: ["https", "http"], allowPrivateNetworks: true, allowedHttpHosts: ["searxng"] },
    });
    // Hosted providers keep the default; a missing or broken endpoint widens nothing.
    expect(searchEgressFor("tavily", { RETINUE_SEARCH_ENDPOINT: "http://searxng:8080" })).toEqual({});
    expect(searchEgressFor("searxng", {})).toEqual({});
  });
});

describe("the turn's context reaches the model (production, 2026-09-28)", () => {
  it("is declared by the manifest, so the assembler keeps it", async () => {
    const { socialAssistantManifest } = await import("../../manifests/index.js");
    const { TURN_CONTEXT_PROVIDER_ID } = await import("../../context/index.js");
    // A turn's recorded context had no `shareflow.turn` section: channel rules, modes and media settings
    // were built and tested and never assembled, because nothing declared them.
    const manifest = socialAssistantManifest({ instructions: "x", version: 1 } as never) as { contextProviderIds?: readonly string[] };
    expect(manifest.contextProviderIds).toContain(TURN_CONTEXT_PROVIDER_ID);
  });

  it("says so when a wired provider is dropped for not being declared", async () => {
    const { selectDeclaredProviders } = await import("../context-for-turn.js");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const kept = selectDeclaredProviders(
        [{ id: "a" }, { id: "b" }] as never,
        { id: "agent", instructions: "", contextProviderIds: ["a"] } as never,
      );
      expect(kept.map((p) => p.id)).toEqual(["a"]);
    } finally {
      console.warn = warn;
    }
    expect(warnings.join(" ")).toContain("b are wired but not declared");
  });
});

describe("asked for a PDF, answered with an artifact (#587)", () => {
  it("tells the model to call generate_pdf, only when the message asked for a PDF", async () => {
    const { withPdfNote } = await import("../media-defaults.js");
    const made = { ok: true, data: { reference: "chorus-artifact:a1" } };
    expect((withPdfNote(made, "Make a one-page PDF brief") as { data: { note?: string } }).data.note).toContain("call generate_pdf");
    expect(withPdfNote(made, "Write a strategy document")).toBe(made);
  });
});

describe("attach_artifact_to_post (#589)", () => {
  const run = async (artifact: { kind: string; content: string; title: string }, as?: "pdf" | "image") => {
    const { attachArtifactToPostTool } = await import("../../tools/artifacts.js");
    const calls: string[] = [];
    const png = { bytes: new Uint8Array([1]), mime: "image/png", width: 10, height: 10 };
    const services = {
      artifacts: { get: async () => ({ id: "a1", version: 1, ...artifact }) },
      render: {
        renderDiagram: async () => (calls.push("diagram"), png),
        renderDocument: async () => (calls.push("pdf"), { bytes: new Uint8Array([2]), mime: "application/pdf", pages: 1 }),
        renderHtmlImage: async () => (calls.push("image"), png),
      },
      media: {
        storeAsset: async () => ({ reference: "chorus-media:ws/generated/x.png", contentType: "image/png", byteSize: 1 }),
        attachPathsToDraft: async (_c: unknown, input: { draftId: string; paths: string[] }) => (calls.push(`attach ${input.paths[0]}`), { draftId: input.draftId, mediaAssetIds: [] }),
      },
    };
    const { createMemoryIdempotencyStore } = await import("@retinue/agentkit/persistence");
    const deps = { authorization: { async can() { return { allow: true }; } }, idempotency: createMemoryIdempotencyStore() };
    const tool = attachArtifactToPostTool.build({ services: services as never, deps: deps as never });
    const result = await (tool as unknown as { execute: (call: unknown) => Promise<{ ok: boolean; data?: { as: string } }> }).execute({
      context: { tenantId: "t", principalId: "p" },
      input: { artifactId: "a1", postDraftId: "d1", ...(as === undefined ? {} : { as }) },
      idempotencyKey: `k-${Math.random()}`,
    });
    return { calls, result };
  };

  it("makes a document a PDF by default, an image when asked, and a diagram always an image", async () => {
    expect((await run({ kind: "markdown", content: "# T\n\nbody", title: "T" })).calls).toEqual(["pdf", "attach ws/generated/x.png"]);
    expect((await run({ kind: "markdown", content: "# T", title: "T" }, "image")).calls).toEqual(["image", "attach ws/generated/x.png"]);
    expect((await run({ kind: "mermaid", content: "flowchart LR\n A --> B", title: "F" }, "pdf")).calls).toEqual(["diagram", "attach ws/generated/x.png"]);
  });
});

describe("sweep 2 on production (2026-09-28)", () => {
  it("puts a markdown PDF's images after its text instead of refusing them", async () => {
    const { buildDocumentHtml } = await import("../../adapters/web/document.js");
    const html = await buildDocumentHtml({ kind: "markdown", source: "# Agenda\n\nWelcome.", images: ["data:image/png;base64,AAAA"] });
    expect(html.indexOf("Welcome.")).toBeLessThan(html.indexOf('src="data:image/png;base64,AAAA"'));
  });

  it("reads render_diagram's 'dummy' draft id as not given, and knows a path is no draft id", async () => {
    const { optionalIdString, plausibleDraftId } = await import("../../tools/factory.js");
    expect(optionalIdString.parse("dummy")).toBeUndefined();
    expect(plausibleDraftId("/tmp/temp_post_id")).toBe(false);
    expect(plausibleDraftId("968d5cfe-c90f-406e-bfec-c48e0e3e502a")).toBe(true);
    expect(plausibleDraftId("d1")).toBe(true);
  });
});

describe("generate_pdf from what the model has in hand (#587, production 2026-09-28)", () => {
  const run = async (input: Record<string, unknown>) => {
    const { generatePdfTool } = await import("../../tools/artifacts.js");
    const { createMemoryIdempotencyStore } = await import("@retinue/agentkit/persistence");
    const printed: string[] = [];
    const services = {
      artifacts: { get: async () => ({ id: "a1", version: 1, kind: "markdown", title: "Brief", content: "# Brief\n\nThe agenda." }) },
      research: { readImage: async () => { throw new Error("No media asset a1 in this workspace."); } },
      render: { renderDocument: async (_c: unknown, { html }: { html: string }) => (printed.push(html), { bytes: new Uint8Array([1]), mime: "application/pdf", pages: 1 }) },
      media: { storeAsset: async () => ({ reference: "chorus-media:ws/generated/b.pdf", contentType: "application/pdf", byteSize: 1 }) },
    };
    const tool = generatePdfTool.build({
      services: services as never,
      deps: { authorization: { async can() { return { allow: true }; } }, idempotency: createMemoryIdempotencyStore() } as never,
    });
    const result = await (tool as unknown as { execute: (call: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown> }> }).execute({
      context: { tenantId: "t", principalId: "p" },
      input,
      idempotencyKey: `k-${Math.random()}`,
    });
    return { printed, result };
  };

  it("prints an artifact by id, without the content being resent", async () => {
    const { printed, result } = await run({ kind: "markdown", artifactId: "a1" });
    expect(result.ok).toBe(true);
    expect(printed[0]).toContain("The agenda.");
  });

  it("still makes a text PDF when an id in mediaAssetIds is not an image — the artifact's own id, in production", async () => {
    const { printed, result } = await run({ kind: "markdown", source: "# Brief\n\nText.", mediaAssetIds: ["a1"] });
    expect(result.ok).toBe(true);
    expect(printed[0]).toContain("Text.");
    expect(result.data?.["skippedMedia"]).toEqual(["a1"]);
  });
});

describe("plan_visuals (#587 follow-up)", () => {
  it("plans distinct images in the channel's shape and a Reel's scenes, and generates nothing", async () => {
    const { planVisualsTool, stillShapeFor } = await import("../../tools/media.js");
    const { createMemoryIdempotencyStore } = await import("@retinue/agentkit/persistence");
    const calls: string[] = [];
    const services = {
      generator: {
        proposeAngles: async (_c: unknown, { count }: { count: number }) => (calls.push(`angles ${count}`), Array.from({ length: count }, (_, i) => ({ label: `A${i + 1}`, rationale: `why ${i + 1}` }))),
        enhanceMediaPrompt: async (_c: unknown, { brief }: { brief: string }) => (calls.push("enhance"), `PROMPT(${brief.split("—")[1]?.trim()})`),
        planVideoScenes: async (_c: unknown, { sceneCount }: { sceneCount: number }) => (calls.push(`scenes ${sceneCount}`), Array.from({ length: sceneCount }, (_, i) => `scene ${i + 1}`)),
      },
    };
    const tool = planVisualsTool.build({
      services: services as never,
      deps: { authorization: { async can() { return { allow: true }; } }, idempotency: createMemoryIdempotencyStore() } as never,
    });
    const result = (await (tool as unknown as { execute: (call: unknown) => Promise<unknown> }).execute({
      context: { tenantId: "t", principalId: "p" },
      input: { brief: "webinar on AI agents", images: 3, channel: "instagram", reelScenes: 3 },
      idempotencyKey: "k-plan",
    })) as { ok: boolean; data: { images: { concept: string; aspectRatio: string }[]; reel: { aspectRatio: string; scenes: unknown[] } } };
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["angles 3", "enhance", "enhance", "enhance", "scenes 3"]);
    expect(result.data.images.map((i) => i.concept)).toEqual(["A1", "A2", "A3"]);
    expect(result.data.images.every((i) => i.aspectRatio === "4:5")).toBe(true);
    expect(result.data.reel).toMatchObject({ aspectRatio: "9:16", scenes: [{}, {}, {}] });
    expect([stillShapeFor("TikTok"), stillShapeFor("X"), stillShapeFor("LinkedIn")]).toEqual(["9:16", "16:9", "1:1"]);
  });
});

/**
 * Production, 2026-09-28: "Make a one-page PDF brief" — gpt-4.1-mini made the artifact and said "It's ready as
 * a PDF", after both the prompt and the result's note told it to call generate_pdf.
 */
describe("a PDF asked for is printed, not just described", () => {
  const artifact = { ok: true, data: { artifactId: "a-1", kind: "markdown", title: "Brief", reference: "chorus-artifact:a-1" } };
  const pdf = { ok: true, data: { reference: "chorus-media:ws/brief.pdf", pages: 1 } };
  const registryWith = (pdfResult: unknown) => {
    const calls: { name: string; input: unknown }[] = [];
    const registry = {
      async execute(_c: unknown, call: { name: string; input: unknown }) {
        calls.push({ name: call.name, input: call.input });
        return call.name === "generate_pdf" ? pdfResult : artifact;
      },
    };
    return { calls, registry };
  };
  const turn = (message: string, mode = "auto") => async () => ({ message, settings: { mode } });

  it("prints the document when the message asks for a PDF, and hands back both", async () => {
    const { calls, registry } = registryWith(pdf);
    const wrapped = withMediaDefaults(registry as never, { turnInput: turn("Make a one-page PDF brief for the webinar") as never });
    const result = (await wrapped.execute({} as never, { name: "create_artifact", input: {}, idempotencyKey: "k" })) as { data: Record<string, unknown> };
    expect(calls.map((c) => c.name)).toEqual(["create_artifact", "generate_pdf"]);
    expect(calls[1]?.input).toEqual({ kind: "markdown", artifactId: "a-1" });
    // Against the real schema: the first version sent only the id, and production refused every print.
    const { generatePdfSchema } = await import("../../tools/artifacts.js");
    expect(generatePdfSchema.safeParse(calls[1]?.input).success).toBe(true);
    expect(result.data["pdf"]).toEqual(pdf.data);
    expect(String(result.data["note"])).toContain("it was printed from this document");
  });

  it("does not print for a post attachment, a plain document, or Chat only", async () => {
    for (const [message, mode] of [["Attach it to the post as a PDF", "auto"], ["Write a strategy document", "auto"], ["Make a PDF brief", "chat_only"]] as const) {
      const { calls, registry } = registryWith(pdf);
      const wrapped = withMediaDefaults(registry as never, { turnInput: turn(message, mode) as never });
      await wrapped.execute({} as never, { name: "create_artifact", input: {} });
      expect(calls.map((c) => c.name), message).toEqual(["create_artifact"]);
    }
  });

  it("falls back to the note when printing is refused", async () => {
    const { registry } = registryWith({ ok: false, error: { code: "approval_required" } });
    const wrapped = withMediaDefaults(registry as never, { turnInput: turn("Make a PDF brief") as never });
    const result = (await wrapped.execute({} as never, { name: "create_artifact", input: {} })) as { data: Record<string, unknown> };
    expect(result.data["pdf"]).toBeUndefined();
    expect(String(result.data["note"])).toContain("call generate_pdf");
  });
});
