/**
 * #595 part 2 — shot templates for generate_media, and the document template on generate_pdf. What is
 * sent is decided in pure functions (the prompt) or with stub services (the printed HTML), so no provider
 * or browser is needed.
 */
import { describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";

import { SHOT_PRESETS, composeMediaPrompt, generateMediaTool, withShot } from "../media.js";
import { generatePdfTool, projectLogo } from "../artifacts.js";
import { withMediaInput } from "../../app/media-defaults.js";

const CONTEXT = { tenantId: asId<TenantId>("ws"), principalId: asId<PrincipalId>("u") } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
const deps = () => ({ authorization: allowAll, idempotency: createMemoryIdempotencyStore() });

describe("shot templates", () => {
  it("adds the shot's composition after the prompt", () => {
    const out = withShot("a ceramic mug", "product-hero");
    expect(out).toBe(`a ceramic mug\n\nShot: ${SHOT_PRESETS["product-hero"]}`);
    expect(out).toContain("clean seamless backdrop");
  });

  it("leaves the prompt alone without a shot, or when it already carries the phrase", () => {
    expect(withShot("a mug", undefined)).toBe("a mug");
    const once = withShot("a mug", "flat-lay");
    expect(withShot(once, "flat-lay")).toBe(once);
  });

  it("has a distinct composition for each of the six", () => {
    expect(Object.keys(SHOT_PRESETS)).toEqual(["product-hero", "lifestyle", "flat-lay", "talking-head", "b-roll", "quote-card-bg"]);
    expect(new Set(Object.values(SHOT_PRESETS)).size).toBe(6);
    expect(SHOT_PRESETS["quote-card-bg"]).toContain("no words, letters or logos");
    expect(SHOT_PRESETS["talking-head"]).toContain("facing the camera");
  });

  it("puts the shot before the avatar and the project's picture look, so the look dresses the shot", () => {
    const out = composeMediaPrompt("our founder at a desk", {
      shot: "talking-head",
      avatar: { name: "Ava", look: "short red hair, green jacket" },
      design: { themeId: "editorial" },
    });
    const at = (text: string) => out.indexOf(text);
    expect(at("our founder at a desk")).toBe(0);
    expect(at("Shot: talking-head framing")).toBeGreaterThan(0);
    expect(at("Character (Ava)")).toBeGreaterThan(at("Shot:"));
    expect(at("Picture look: editorial magazine photography")).toBeGreaterThan(at("Character (Ava)"));
    expect(at("Brand palette:")).toBeGreaterThan(at("Picture look:"));
  });

  it("is the old prompt exactly without a shot", () => {
    expect(composeMediaPrompt("a mug", { design: { themeId: "bold" } })).toBe(
      composeMediaPrompt("a mug", { design: { themeId: "bold" }, avatar: {} }),
    );
    expect(composeMediaPrompt("a mug", {})).toBe("a mug");
  });

  it("leaves the chat box's settings in charge of shape and model; the shot passes through untouched", () => {
    const filled = withMediaInput({ kind: "video", prompt: "x", shot: "b-roll", aspectRatio: "16:9" }, { kind: "video", aspectRatio: "9:16" });
    expect(filled).toMatchObject({ shot: "b-roll", aspectRatio: "9:16" });
  });

  it("sends the composed prompt and says which shot it used", async () => {
    const sent: { prompt?: string }[] = [];
    const tool = generateMediaTool.build({
      services: {
        projects: { async current() { return { id: "p", name: "P", instructions: "", defaults: {}, design: { themeId: "playful" } }; } },
        media: { async generate(_c: unknown, input: { prompt: string }) { sent.push(input); return { jobId: "job-1" }; } },
      } as never,
      deps: deps(),
    });
    const result = await tool.execute({ context: CONTEXT, input: { kind: "image", prompt: "sneakers", shot: "flat-lay" }, idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: true, data: { jobId: "job-1", shot: "flat-lay" } });
    expect(sent[0]?.prompt).toContain("sneakers\n\nShot: flat-lay: objects arranged");
    expect(sent[0]?.prompt).toContain("Picture look: flat vector illustration");
  });

  it("refuses a shot it does not know", async () => {
    const tool = generateMediaTool.build({ services: { projects: { async current() { return null; } }, media: {} } as never, deps: deps() });
    const result = await tool.execute({ context: CONTEXT, input: { kind: "image", prompt: "x", shot: "drone" }, idempotencyKey: "k2" });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("generate_pdf with a template", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const build = (options: { logo?: string; mime?: string; failRead?: boolean } = {}) => {
    const printed: string[] = [];
    const reads: string[] = [];
    const tool = generatePdfTool.build({
      services: {
        projects: {
          async current() { return { id: "p", name: "P", instructions: "", defaults: {}, design: { themeId: "corporate", hasLogo: true } }; },
          async logoReference() { return options.logo; },
        },
        research: {
          async readImage(_c: unknown, input: { source: { assetId: string } }) {
            reads.push(input.source.assetId);
            if (options.failRead === true) throw new Error("gone");
            return { bytes: PNG, mime: options.mime ?? "image/png" };
          },
        },
        render: { async renderDocument(_c: unknown, input: { html: string }) { printed.push(input.html); return { bytes: PNG, mime: "application/pdf", pages: 2 }; } },
        media: { async storeAsset() { return { reference: "chorus-media:ws/doc.pdf", byteSize: 4 }; } },
      } as never,
      deps: deps(),
    });
    return { tool, printed, reads };
  };

  it("prints the template with the project's logo inlined in the header", async () => {
    const { tool, printed, reads } = build({ logo: "chorus-media:ws/projects/p/logo.png" });
    const result = await tool.execute({ context: CONTEXT, input: { kind: "markdown", source: "# Plan\n\nText", template: "report" }, idempotencyKey: "k3" });
    expect(result).toMatchObject({ ok: true, data: { template: "report", logo: true, pages: 2 } });
    expect(reads).toEqual(["chorus-media:ws/projects/p/logo.png"]);
    expect(printed[0]).toContain(`<img class="t-logo" src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}"`);
    expect(printed[0]).toContain("data-template='report'");
  });

  it("prints without a logo when the project has none or it cannot be read — never fails for it", async () => {
    for (const options of [{}, { logo: "chorus-media:ws/l.png", failRead: true }, { logo: "chorus-media:ws/l.pdf", mime: "application/pdf" }]) {
      const { tool, printed } = build(options);
      const result = await tool.execute({ context: CONTEXT, input: { kind: "markdown", source: "Text", template: "brief" }, idempotencyKey: `k-${JSON.stringify(options)}` });
      expect(result).toMatchObject({ ok: true, data: { template: "brief", logo: false } });
      expect(printed[0]).not.toContain("t-logo\" src");
    }
  });

  // Merged with #615: a project's logo dresses every themed document's header, template or not.
  it("prints plainly without a template, the logo in the ordinary themed header", async () => {
    const { tool, printed, reads } = build({ logo: "chorus-media:ws/l.png" });
    const result = await tool.execute({ context: CONTEXT, input: { kind: "markdown", source: "Text" }, idempotencyKey: "k4" });
    expect(result).toMatchObject({ ok: true });
    expect((result as { data: Record<string, unknown> }).data["template"]).toBeUndefined();
    expect(reads).toEqual(["chorus-media:ws/l.png"]);
    expect(printed[0]).not.toContain("data-template");
  });

  it("uses the markdown's own template directive", async () => {
    const { tool, printed } = build();
    await tool.execute({ context: CONTEXT, input: { kind: "markdown", source: "<!-- template: checklist -->\n- [ ] a" }, idempotencyKey: "k5" });
    expect(printed[0]).toContain("data-template='checklist'");
  });

  it("the logo helper is undefined outside a project service that has one", async () => {
    expect(await projectLogo(undefined, async () => ({ bytes: PNG, mime: "image/png" }), CONTEXT)).toBeUndefined();
    expect(await projectLogo({}, async () => ({ bytes: PNG, mime: "image/png" }), CONTEXT)).toBeUndefined();
  });
});
