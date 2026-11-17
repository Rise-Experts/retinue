/**
 * The artifact tools against the **old** runtime's contract — REQ-041 AC-4 (#190).
 *
 * This is the file `CAPABILITY_INVENTORY` names as the `contractTest` for `create_artifact`,
 * `update_artifact` and `get_artifact`, so what it has to establish is not "the tools work" but the five
 * clauses of `BEHAVIOURAL_CONTRACT`: the same inputs refused, the same shape written, the same side effects in
 * the same order, the same behaviour on retry, and the same approval requirement.
 *
 * The approval clause is the one that matters most in general, and here it is the least dramatic: all three
 * old tools are `@tool(requires_confirmation=False)` and all three replacements are `read` or
 * `internal-write`, so `approvalParity` reports `not-gated` for each. It is asserted anyway — a future
 * `destructive` reclassification would change it, and a *silent* change to what a person is asked to confirm
 * is the failure mode the whole comparison exists for.
 *
 * The ordering clause is asserted against the database in `adapters/postgres/__tests__/services.test.ts`,
 * because "archived before the update" is a claim about two statements and a stub cannot fail it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
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
import {
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  ARTIFACT_TOOL_FACTORIES,
  ARTIFACT_TOOL_NAMES,
  generatePdfTool,
  createArtifactTool,
  createShareFlowToolProvider,
  getArtifactTool,
  updateArtifactTool,
  attachArtifactToPostTool,
  applyArtifactEdits,
  applySlideEdits,
  applySlideEditsTracked,
  type ActiveProject,
  type Artifact,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const ARTIFACT: Artifact = {
  id: asId("a1"),
  title: "Q3 content plan",
  kind: "markdown",
  content: "# Plan\n\nFirst paragraph.",
  version: 1,
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T09:00:00.000Z",
  reference: "chorus-artifact:550e8400-e29b-41d4-a716-446655440000",
};

let calls: { method: string; args: Record<string, unknown> }[];
let stored = 0;
/** #595: the chat's project, for the theme; null is a chat outside a project. */
let project: ActiveProject | null = null;
/** #615: the project's logo reference, or none. */
let logo: string | undefined;

const services = (over: Partial<Artifact> = {}): ShareFlowServices =>
  ({
    artifacts: {
      async create(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "create", args });
        return { ...ARTIFACT, ...over };
      },
      async revise(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "revise", args });
        return { ...ARTIFACT, version: 2, ...over };
      },
      async get(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "get", args });
        return { ...ARTIFACT, ...over };
      },
    },
    /**
     * The three `generate_pdf` needs, and the provider refuses to build without them — which is the
     * `requires` mechanism working: *"a tool that is registered without one would fail in the middle of
     * a conversation instead of here."*
     *
     * What the *renderer* does is exercised against a real Chromium in `adapters/web/__tests__`; these
     * are here so the tool's own contract can be tested.
     */
    render: {
      async renderDocument(_c: ExecutionContext, args: Record<string, unknown>) {
        // The built HTML is recorded, because what document was printed is the interesting half.
        const { html, page, layoutWidth } = args as { html: string; page?: unknown; layoutWidth?: number };
        calls.push({
          method: "renderDocument",
          args: { html: String(html), ...(page === undefined ? {} : { page }), ...(layoutWidth === undefined ? {} : { layoutWidth }) },
        });
        return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2]), mime: "application/pdf", pages: 3 };
      },
      // #607 part 3: an svg artifact goes on a post through this, as a PNG of a page holding the drawing.
      async renderHtmlImage(_c: ExecutionContext, args: { html: string }) {
        calls.push({ method: "renderHtmlImage", args: { html: args.html } });
        return { bytes: new Uint8Array([7]), mime: "image/png", width: 1080, height: 400 };
      },
      // #607: one PNG per `section.slide`, counted out of the built page as the real renderer does.
      async renderSlideImages(_c: ExecutionContext, args: { html: string; width: number; height: number }) {
        calls.push({ method: "renderSlideImages", args: { width: args.width, height: args.height } });
        const count = (args.html.match(/<section class="slide /g) ?? []).length;
        return Array.from({ length: count }, (_, i) => ({ bytes: new Uint8Array([i + 1]), mime: "image/png", width: args.width, height: args.height }));
      },
      // #620: the deck's play page recorded as an MP4; what was recorded is the interesting half.
      async renderSlidesVideo(_c: ExecutionContext, args: { html: string; width: number; height: number; transitions: readonly string[]; secondsPerSlide?: number }) {
        calls.push({
          method: "renderSlidesVideo",
          args: { width: args.width, height: args.height, transitions: [...args.transitions], secondsPerSlide: args.secondsPerSlide, play: args.html.includes('class="s-deck-play"') },
        });
        const seconds = Math.min(args.secondsPerSlide ?? 3, 60 / args.transitions.length);
        return { bytes: new Uint8Array([0, 0, 0, 24]), mime: "video/mp4", width: args.width, height: args.height, durationMs: seconds * 1000 * args.transitions.length, secondsPerSlide: seconds, shortened: seconds < (args.secondsPerSlide ?? 3) };
      },
    },
    media: {
      async storeAsset(_c: ExecutionContext, args: { contentType: string; bytes: Uint8Array }) {
        calls.push({ method: "storeAsset", args: { contentType: args.contentType, bytes: args.bytes.byteLength } });
        stored += 1;
        const name = args.contentType === "image/png" ? `slide-${args.bytes[0]}.png` : args.contentType === "video/mp4" ? "deck.mp4" : "report.pdf";
        return { reference: `chorus-media:ws-1/${stored > 1 && name === "report.pdf" ? `report-${stored}.pdf` : name}`, contentType: args.contentType, byteSize: args.bytes.byteLength };
      },
      async attachPathsToDraft(_c: ExecutionContext, args: { draftId: string; paths: readonly string[] }) {
        calls.push({ method: "attachPathsToDraft", args: { draftId: args.draftId, paths: [...args.paths] } });
        return { draftId: args.draftId, mediaAssetIds: [...args.paths] };
      },
    },
    projects: {
      async current() {
        return project;
      },
      async logoReference() {
        return logo;
      },
    },
    research: {
      async readImage(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "readImage", args });
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" };
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, over: Partial<Artifact> = {}): Tool =>
  factory.build({ services: services(over), deps: { authorization: allowAll, idempotency } });

/** A unique key per call, so a loop cannot assert against a replayed earlier result. */
let callCounter = 0;
const run = (tool: Tool, input: unknown, key?: string): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key ?? `k${(callCounter += 1)}` });

const dataOf = (result: ToolResult): Record<string, unknown> =>
  (result as { data: Record<string, unknown> }).data;
const errorOf = (result: ToolResult): { code: string; message: string } =>
  (result as { error: { code: string; message: string } }).error;

beforeEach(() => {
  project = null;
  logo = undefined;
  stored = 0;
  calls = [];
  callCounter = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("the same shape is written, and the same shape returned", () => {
  it("returns what the old tool returned, and not the document", async () => {
    /**
     * The old tool's docstring names its result exactly: `{"id", "title", "kind", "version", "reference"}`.
     * Content is deliberately absent, and the reason is the context window: the model was just handed the
     * document, so echoing 200,000 characters back adds nothing and costs the turn.
     */
    const result = await run(build(createArtifactTool), {
      title: "Q3 content plan",
      kind: "markdown",
      content: "# Plan\n\nFirst paragraph.",
    });
    const data = dataOf(result);
    expect(Object.keys(data).sort()).toEqual(["artifactId", "kind", "reference", "title", "updatedAt", "version"]);
    expect(data["content"]).toBeUndefined();
    expect(data["reference"]).toBe(ARTIFACT.reference);
  });

  it("returns the document when reading, because reading is the point", async () => {
    const data = dataOf(await run(build(getArtifactTool), { artifactId: "a1" }));
    expect(data["content"]).toBe("# Plan\n\nFirst paragraph.");
    expect(data["version"]).toBe(1);
  });

  it("omits the reference rather than sending a broken one", async () => {
    /**
     * The app's formatter returns null for a non-uuid, and the reason is streaming: a half-written
     * `chorus-artifact:8f14e45` exists for a frame. A client rendering a card for it fetches nothing. So the
     * field is absent, which is a different instruction from an empty string.
     */
    const data = dataOf(await run(build(getArtifactTool, { reference: undefined }), { artifactId: "a1" }));
    expect("reference" in data).toBe(false);
  });
});

describe("the same inputs are refused", () => {
  it("refuses a kind the database would refuse, before the document is written", async () => {
    /**
     * `assistant_artifacts_kind_check` admits markdown, html and mermaid. A closed enum in the schema means
     * "md" is refused at the tool boundary rather than by the database *after* the model produced a whole
     * document — which is the same failure, an hour of tokens later.
     */
    const result = await run(build(createArtifactTool), { title: "t", kind: "md", content: "body" });
    expect(errorOf(result).code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses an empty title and an empty document", async () => {
    for (const input of [
      { title: "   ", kind: "markdown", content: "body" },
      { title: "A title", kind: "markdown", content: "" },
    ]) {
      const result = await run(build(createArtifactTool), input);
      expect(errorOf(result).code, JSON.stringify(input)).toBe("invalid_input");
    }
    expect(calls).toEqual([]);
  });

  it("names the limit rather than letting the model spend the tokens first", async () => {
    // The schema's job, distinct from the adapter's: the adapter protects the row, this protects the turn.
    const long = await run(build(createArtifactTool), {
      title: "t".repeat(ARTIFACT_MAX_TITLE + 1),
      kind: "markdown",
      content: "body",
    });
    expect(errorOf(long).code).toBe("invalid_input");
    const big = await run(build(createArtifactTool), {
      title: "t",
      kind: "markdown",
      content: "c".repeat(ARTIFACT_MAX_CHARS + 1),
    });
    expect(errorOf(big).code).toBe("invalid_input");
  });

  it("gives a revision no way to change the kind", async () => {
    /**
     * The old lib validates a revision against the **stored** kind — `validate(title, row.kind, content)` —
     * so markdown cannot become html by revision. Expressed here as a strict schema with no `kind` field, so
     * a caller who tries is refused rather than silently ignored: ignored, the model would believe it had
     * converted a document and describe it that way.
     */
    const result = await run(build(updateArtifactTool), {
      artifactId: "a1",
      content: "new body",
      kind: "html",
    });
    expect(errorOf(result).code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("takes a title on a revision as optional, and omitting it changes nothing", async () => {
    await run(build(updateArtifactTool), { artifactId: "a1", content: "new body" });
    expect(calls[0]?.method).toBe("revise");
    expect("title" in (calls[0]?.args ?? {})).toBe(false);
  });
});

describe("the same approval requirement — the clause a migration loses quietly", () => {
  it("asks for no confirmation, exactly as the old tools did", () => {
    /**
     * All three old tools are `@tool(requires_confirmation=False)`. Asserted here as well as mechanically in
     * `approvalParity` because that check compares the old flag against the new policy, and this pins the new
     * policy itself: a later reclassification to `destructive` would start prompting, and one to a weaker
     * effect on a tool that *should* prompt is the direction that looks like an improvement.
     */
    const deps = { authorization: allowAll, idempotency };
    const built = ARTIFACT_TOOL_FACTORIES.map((factory) =>
      factory.build({ services: services(), deps }).descriptor,
    );
    for (const descriptor of built) expect(descriptor.approvalPolicy, descriptor.name).toBe("never");
    expect(built.map((d) => `${d.name}:${d.effect}`).sort()).toEqual([
      // #589: it attaches to a draft, which is a workspace row like the others — nothing is published.
      "attach_artifact_to_post:internal-write",
      "create_artifact:internal-write",
      // A PDF is a stored file rather than a row, and the classification is the same: it goes into the
      // workspace's own media and nothing reaches a platform.
      "generate_pdf:internal-write",
      "get_artifact:read",
      "update_artifact:internal-write",
    ]);
  });

  it("writes inside the tenant only, which is why no approval is right", () => {
    // `internal-write` and not `external-write`: an artifact is a row a customer's own team reads. Nothing
    // reaches a platform, so there is no irreversible public effect for a person to authorise.
    const deps = { authorization: allowAll, idempotency };
    const writes = ARTIFACT_TOOL_FACTORIES.map((f) => f.build({ services: services(), deps }).descriptor).filter(
      (d) => d.effect !== "read",
    );
    expect(writes.every((d) => d.effect === "internal-write")).toBe(true);
    expect(writes.every((d) => d.requiresIdempotencyKey === false)).toBe(true);
  });
});

describe("the same behaviour on retry", () => {
  it("replays a create on the same idempotency key instead of writing twice", async () => {
    /**
     * The envelope's guarantee, asserted because a document is the kind of thing a retry duplicates
     * expensively: two identical plans, and a user who cannot tell which one their link points at.
     */
    const tool = build(createArtifactTool);
    const input = { title: "Q3 content plan", kind: "markdown", content: "# Plan\n\nFirst paragraph." };
    const first = await run(tool, input, "same-key");
    const second = await run(tool, input, "same-key");
    expect(dataOf(second)).toEqual(dataOf(first));
    expect(calls.filter((c) => c.method === "create")).toHaveLength(1);
  });
});

describe("the catalog", () => {
  it("prints a markdown document and stores it, reporting the page count", async () => {
    /**
     * The page count is what tells a person whether they got the document they meant — read out of the
     * PDF's own structure, and best-effort: *"a nicety for the reply text, never something to fail a
     * successful render over."*
     */
    const result = await run(build(generatePdfTool), {
      kind: "markdown",
      source: "# Q3\n\nRevenue rose 4%.",
      title: "Q3 report",
    });
    expect(result).toMatchObject({
      ok: true,
      data: { reference: "chorus-media:ws-1/report.pdf", pages: 3, byteSize: 6 },
    });
    expect(calls.map((c) => c.method)).toEqual(["renderDocument", "storeAsset"]);
  });

  it("turns a mermaid fence into a diagram inside the document, not a code block", async () => {
    /**
     * The feature the whole pipeline exists for: *"by default a ```mermaid fence renders as
     * `<pre><code class=\"language-mermaid\">`, and Chromium prints that as the diagram's SOURCE
     * TEXT — which is exactly what it did."*
     *
     * And the label repair runs on the way in, so the source mermaid parses is the source embedded —
     * `A[Draft (v2)]` is a parse error that kills the whole diagram.
     */
    await run(build(generatePdfTool), {
      kind: "markdown",
      source: "# Plan\n\n```mermaid\nflowchart LR\n  A[Draft (v2)] --> B\n```\n",
    });
    const html = String((calls[0]?.args as { html: string }).html);
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain("language-mermaid");
    expect(html, "the label must be repaired before it is embedded").toContain("&quot;Draft (v2)&quot;");
  });

  it("prints in the project's theme inside a themed project, and unthemed outside one (#595)", async () => {
    await run(build(generatePdfTool), { kind: "markdown", source: "# Plan\n\nBody." });
    const plain = String((calls[0]?.args as { html: string }).html);
    expect(plain).not.toContain("--t-primary");

    project = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "editorial", palette: { primary: "#123456" } } };
    calls = [];
    await run(build(generatePdfTool), { kind: "markdown", source: "# Plan\n\n```mermaid\nflowchart LR\n A --> B\n```\n" });
    const themed = String((calls[0]?.args as { html: string }).html);
    expect(themed).toContain("--t-primary:#123456;");
    expect(themed).toContain('--t-font-heading:"EB Garamond", serif;');
    expect(themed).toContain("<div class='t-rule'></div>");
    // The diagrams inside it are themed too, through the page's own config block.
    expect(themed).toContain('id="t-mermaid"');
    expect(themed).toContain('"primaryColor":"#123456"');
  });

  it("uses html as the document body, so the print setup always applies", async () => {
    /**
     * *"A model-supplied `<html>` wrapper would otherwise silently drop the page setup"* — the A4 size,
     * the margins and the diagram CSS all live in the wrapper this builds.
     */
    await run(build(generatePdfTool), { kind: "html", source: "<h2>Section</h2><p>Body</p>" });
    const html = String((calls[0]?.args as { html: string }).html);
    expect(html).toContain("@page { size: A4;");
    expect(html).toContain("<h2>Section</h2>");
    // One document, not a document inside a document.
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
  });

  it("prints an html deck on a 16:9 page and a sheet full-bleed, as asked (#661)", async () => {
    // Production, 2026-09-30: `format: "16:9"` (slides only) on an html deck printed portrait A4, cropped.
    await run(build(generatePdfTool), { kind: "html", source: "<section>One</section>", page: "16:9" });
    const deck = calls[0]?.args as { html: string; layoutWidth?: number };
    expect(deck.html).toContain("@page { size: 1920px 1080px; }");
    // A slide format is full-bleed unless asked otherwise — in the head, so the page's own @page still wins.
    expect(deck.html.indexOf("<style>@page { margin: 0; }</style>")).toBeGreaterThan(-1);
    expect(deck.html.indexOf("<style>@page { margin: 0; }</style>")).toBeLessThan(deck.html.indexOf("<body>"));
    expect(deck.layoutWidth).toBe(1920);
    calls.length = 0;
    await run(build(generatePdfTool), { kind: "html", source: "<div style='background:#0b1f4d'>Prices</div>", margin: 0, pageNumbers: true });
    const sheet = calls[0]?.args as { html: string; layoutWidth?: number };
    // Asked by name, so after the body: it beats the page's own rule and the defaults.
    expect(sheet.html).toContain(`Prices</div><style>@page { margin: 0mm; margin-bottom: 12mm; @bottom-center { content: counter(page) " / " counter(pages);`);
    expect(sheet.layoutWidth).toBe(794);
  });

  it("leaves the page alone when no page option is given", async () => {
    await run(build(generatePdfTool), { kind: "markdown", source: "# Plan" });
    const printed = calls[0]?.args as { html: string; layoutWidth?: number };
    expect(printed.layoutWidth).toBeUndefined();
    expect(printed.html.match(/@page/g)).toHaveLength(1);
  });

  it("refuses a margin past 50 mm and a page it does not know", async () => {
    for (const input of [{ kind: "html", source: "x", margin: 80 }, { kind: "html", source: "x", page: "A3" }, { kind: "html", source: "x", margin: -1 }]) {
      expect(await run(build(generatePdfTool), input, JSON.stringify(input)), JSON.stringify(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("teaches the HTML path, the installed fonts and that web fonts do not load (#661)", () => {
    const { description } = build(generatePdfTool).descriptor;
    expect(description).toContain("COLOURS AND LAYOUT NEED kind='html'");
    expect(description).toContain("margin 0 is full-bleed");
    for (const font of ["Inter", "Bebas Neue", "EB Garamond", "JetBrains Mono"]) expect(description).toContain(font);
    expect(description).toMatch(/Google Fonts or any other web font do not load/);
  });

  it("inlines media as data URLs rather than sending the page to fetch them", async () => {
    /**
     * The old pipeline passed signed URLs into the page and let Chromium fetch them. Inlining means the
     * page makes no request at all — no expiry, no question about whether the container can reach
     * storage, and nothing for the page's request guard to weigh.
     */
    await run(build(generatePdfTool), {
      kind: "media",
      mediaAssetIds: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
      title: "Screens",
    });
    expect(calls[0]?.method).toBe("readImage");
    const html = String((calls[1]?.args as { html: string }).html);
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("https://");
    // One page per image — `.media-page` is what makes that true.
    expect(html).toContain("class='media-page'");
  });

  it("needs images for kind media, and puts a text document's images after its text (#587)", async () => {
    /**
     * A `media` document with nothing to put in it is refused. A `markdown` call carrying images used to be
     * refused too, and production showed a model resend the same image six times and never get its PDF —
     * a caller expecting its pictures to appear gets them, after the text.
     */
    expect(
      await run(build(generatePdfTool), { kind: "markdown", source: "# x", mediaAssetIds: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"] }, "with-images"),
    ).toMatchObject({ ok: true });
    calls.length = 0;
    for (const input of [
      { kind: "media" },
      { kind: "media", mediaAssetIds: [] },
    ]) {
      expect(await run(build(generatePdfTool), input, JSON.stringify(input)), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses an empty source and a kind it cannot print", async () => {
    for (const input of [{ kind: "text", source: "   " }, { kind: "text" }, { kind: "docx", source: "x" }]) {
      expect(await run(build(generatePdfTool), input, JSON.stringify(input)), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("tells the model to put the diagram in the document rather than exporting a PNG first", async () => {
    /**
     * The instruction that destroys the answer when it is got wrong: *"Do NOT render a diagram to a PNG
     * first and pass it as kind='media' — that puts it on its own page and throws the surrounding text
     * away."* And its companion, about not using a PDF for something meant for a feed.
     */
    const { description } = build(generatePdfTool).descriptor;
    expect(description).toContain("DIAGRAMS GO INSIDE THE DOCUMENT");
    // #589: LinkedIn does post a PDF (a document post), so the old "no platform" was wrong.
    expect(description).toMatch(/only LinkedIn posts a PDF/);
  });

  it("is exactly the four the old runtime had", async () => {
    /**
     * No `list_artifacts` and no `delete_artifact`. The old runtime has neither, and a tool the old product
     * did not have is not parity — the gate would have nothing to compare it against, so it would be scope
     * wearing a parity label.
     *
     * Four rather than three since `generate_pdf` landed: the old runtime *did* have it, on the same
     * Documents agent, and `artifacts` is where a document a person keeps belongs.
     */
    const provider = createShareFlowToolProvider({
      services: services(),
      deps: { authorization: allowAll, idempotency },
      factories: ARTIFACT_TOOL_FACTORIES,
    });
    const names = (await provider.listTools(CONTEXT)).map((t) => t.descriptor.name);
    expect([...names].sort()).toEqual([...ARTIFACT_TOOL_NAMES].sort());
    // Five since #589: putting a document on a post, which the old runtime could not do at all.
    expect(names).toHaveLength(5);
  });

  it("classifies all three under one category, so a manifest can select them", () => {
    // `ToolDescriptor.category` is what an agent manifest selects on, and a typo yields an assistant with
    // fewer tools than configured — which reads as the model being unhelpful.
    const deps = { authorization: allowAll, idempotency };
    for (const factory of ARTIFACT_TOOL_FACTORIES) {
      expect(factory.build({ services: services(), deps }).descriptor.category).toBe("artifacts");
    }
  });
});

const SLIDES = [
  "# Why we ship weekly",
  "A field report",
  "---",
  "## What changed",
  "- Smaller releases",
  "- Faster feedback",
  "---",
  "## Rollbacks",
  "87%",
  "---",
  "> Shipping weekly made us braver.",
  "— Dana",
  "---",
  "![The team](chorus-media:ws-1/team.png)",
].join("\n");
const DRAFT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("slides — #607", () => {
  it("takes slides as a kind, and says how to write a deck", async () => {
    const result = await run(build(createArtifactTool, { kind: "slides" }), { title: "Deck", kind: "slides", content: SLIDES });
    expect(result).toMatchObject({ ok: true, data: { kind: "slides" } });
    expect(calls[0]).toMatchObject({ method: "create", args: { kind: "slides" } });
    const { description } = build(createArtifactTool).descriptor;
    expect(description).toMatch(/markdown, html, mermaid, slides, react or svg/);
    expect(description).toContain("<!-- layout: title|section|bullets|agenda|timeline|stat|stat-grid|two-column|comparison|columns|quote|image|image-left|image-right|team|logos|cta -->");
    expect(description).toContain("<!-- transition: fade|slide|zoom|none -->");
    expect(description).toContain("<!-- eyebrow:");
    expect(description).toContain("<!-- background: chorus-media:... -->");
    expect(description).toContain("<!-- format: 16:9 -->");
  });

  it("prints a slides artifact one slide per page, at the slide's size, with its images inlined", async () => {
    const result = await run(build(generatePdfTool, { kind: "slides", content: SLIDES }), { kind: "markdown", artifactId: "a1" });
    expect(result).toMatchObject({ ok: true, data: { slides: 5, format: "4:5", pages: 3 } });
    expect(calls.map((c) => c.method)).toEqual(["get", "readImage", "renderDocument", "storeAsset"]);
    expect(calls[1]?.args).toEqual({ source: { kind: "asset", assetId: "chorus-media:ws-1/team.png" } });
    const printed = calls[2]?.args as { html: string; page: unknown };
    expect(printed.page).toEqual({ width: 1080, height: 1350 });
    expect(printed.html.match(/<section class="slide /g)).toHaveLength(5);
    expect(printed.html).toContain("data:image/png;base64,");
    expect(printed.html).not.toContain("@page { size: A4;");
  });

  it("prints a slides artifact at 16:9 when asked with page instead of format (#661)", async () => {
    const result = await run(build(generatePdfTool, { kind: "slides", content: "# One\n---\n## Two\n- a" }), { kind: "markdown", artifactId: "a1", page: "16:9" });
    expect(result).toMatchObject({ ok: true, data: { format: "16:9" } });
    expect((calls.find((c) => c.method === "renderDocument")?.args as { page: unknown }).page).toEqual({ width: 1920, height: 1080 });
  });

  it("puts the project's logo on every slide, read like any deck image (#615)", async () => {
    logo = "chorus-media:ws-1/projects/p1/logo.png";
    project = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "corporate" } };
    await run(build(generatePdfTool, { kind: "slides", content: "# One\n---\n## Two\n- a" }), { kind: "markdown", artifactId: "a1" });
    expect(calls.filter((c) => c.method === "readImage").map((c) => c.args)).toEqual([{ source: { kind: "asset", assetId: logo } }]);
    const printed = calls.find((c) => c.method === "renderDocument")?.args as { html: string };
    expect(printed.html.match(/<img class="s-logo top-right" src="data:image\/png;base64,/g)).toHaveLength(2);
  });

  it("prints a markdown document's imported photo and the logo in its header (#615)", async () => {
    logo = "chorus-media:ws-1/projects/p1/logo.png";
    project = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "corporate" } };
    const result = await run(build(generatePdfTool), { kind: "markdown", source: "# Brief\n\n![Latte](chorus-media:ws-1/generated/a.jpg)\n\n*Photo by Ana on Pexels*" });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "readImage").map((c) => c.args)).toEqual([
      { source: { kind: "asset", assetId: logo } },
      { source: { kind: "asset", assetId: "chorus-media:ws-1/generated/a.jpg" } },
    ]);
    const printed = calls.find((c) => c.method === "renderDocument")?.args as { html: string };
    expect(printed.html).toContain("<div class='t-head right'><img class='t-logo' src=\"data:image/png;base64,");
    expect(printed.html).toContain('<img src="data:image/png;base64,iVBORw==" alt="Latte" />');
    expect(printed.html).not.toContain("chorus-media:");
  });

  it("prints 16:9 when asked, in the chat's theme", async () => {
    project = { id: "p1", name: "AI", instructions: "", defaults: {}, design: { themeId: "bold", palette: { primary: "#123456" } } };
    await run(build(generatePdfTool, { kind: "slides", content: "# One\n---\n# Two" }), { kind: "markdown", artifactId: "a1", format: "16:9" });
    const printed = calls.find((c) => c.method === "renderDocument")?.args as { html: string; page: unknown };
    expect(printed.page).toEqual({ width: 1920, height: 1080 });
    expect(printed.html).toContain("--t-primary:#123456;");
  });

  it("attaches a deck as a carousel: one image per slide, attached in order in one call", async () => {
    const result = await run(build(attachArtifactToPostTool, { kind: "slides", content: SLIDES }), { artifactId: "a1", postDraftId: DRAFT, as: "carousel" });
    expect(result).toMatchObject({ ok: true, data: { as: "carousel", slides: 5 } });
    expect(calls.filter((c) => c.method === "renderSlideImages")).toEqual([{ method: "renderSlideImages", args: { width: 1080, height: 1350 } }]);
    const attach = calls.filter((c) => c.method === "attachPathsToDraft");
    expect(attach).toHaveLength(1);
    expect(attach[0]?.args).toEqual({ draftId: DRAFT, paths: [1, 2, 3, 4, 5].map((n) => `ws-1/slide-${n}.png`) });
    expect(dataOf(result)["references"]).toHaveLength(5);
  });

  it("attaches a deck as one PDF by default — a LinkedIn document post", async () => {
    const result = await run(build(attachArtifactToPostTool, { kind: "slides", content: SLIDES }), { artifactId: "a1", postDraftId: DRAFT });
    expect(result).toMatchObject({ ok: true, data: { as: "pdf", reference: "chorus-media:ws-1/report.pdf" } });
    expect(calls.find((c) => c.method === "renderDocument")?.args).toMatchObject({ page: { width: 1080, height: 1350 } });
    expect(calls.find((c) => c.method === "attachPathsToDraft")?.args).toEqual({ draftId: DRAFT, paths: ["ws-1/report.pdf"] });
  });

  it("refuses a carousel past 10 slides before drawing anything", async () => {
    const long = Array.from({ length: 11 }, (_, i) => `# Slide ${i + 1}`).join("\n---\n");
    const result = await run(build(attachArtifactToPostTool, { kind: "slides", content: long }), { artifactId: "a1", postDraftId: DRAFT, as: "carousel" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(errorOf(result).message).toMatch(/at most 10 slides and this deck has 11/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("attaches a deck as a video: its play page recorded with each slide's transition, stored as an MP4 (#620)", async () => {
    const deck = "<!-- transition: zoom -->\n# One\n---\n<!-- transition: slide -->\n## Two\n- a\n---\n## Three\n87%";
    const result = await run(build(attachArtifactToPostTool, { kind: "slides", content: deck }), { artifactId: "a1", postDraftId: DRAFT, as: "video", secondsPerSlide: 4, format: "16:9" });
    expect(result).toMatchObject({ ok: true, data: { as: "video", reference: "chorus-media:ws-1/deck.mp4", slides: 3, format: "16:9", seconds: 12, secondsPerSlide: 4 } });
    expect(calls.find((c) => c.method === "renderSlidesVideo")?.args).toEqual({ width: 1920, height: 1080, transitions: ["zoom", "slide", "zoom"], secondsPerSlide: 4, play: true });
    expect(calls.find((c) => c.method === "storeAsset")?.args).toEqual({ contentType: "video/mp4", bytes: 4 });
    expect(calls.find((c) => c.method === "attachPathsToDraft")?.args).toEqual({ draftId: DRAFT, paths: ["ws-1/deck.mp4"] });
    expect(dataOf(result)["note"]).toMatch(/MP4 video, 3 slides at 4s each/);
  });

  it("says so when the slides were shortened to fit the minute", async () => {
    const deck = Array.from({ length: 12 }, (_, i) => `# Slide ${i + 1}`).join("\n---\n");
    const result = await run(build(attachArtifactToPostTool, { kind: "slides", content: deck }), { artifactId: "a1", postDraftId: DRAFT, as: "video", secondsPerSlide: 8 });
    expect(dataOf(result)).toMatchObject({ secondsPerSlide: 5 });
    expect(dataOf(result)["note"]).toMatch(/shortened to fit the 60-second limit/);
  });

  it("refuses a video past 20 slides, and a video of anything but a deck, before rendering", async () => {
    const long = Array.from({ length: 21 }, (_, i) => `# Slide ${i + 1}`).join("\n---\n");
    const tooLong = await run(build(attachArtifactToPostTool, { kind: "slides", content: long }), { artifactId: "a1", postDraftId: DRAFT, as: "video" });
    expect(errorOf(tooLong).message).toMatch(/at most 20 slides and this deck has 21/);
    const doc = await run(build(attachArtifactToPostTool, { kind: "markdown", content: "# Plan" }), { artifactId: "a1", postDraftId: DRAFT, as: "video" });
    expect(doc).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(errorOf(doc).message).toMatch(/Only a slides artifact can become a video/);
    expect(calls.some((c) => c.method === "renderSlidesVideo")).toBe(false);
    const { description } = build(attachArtifactToPostTool).descriptor;
    expect(description).toContain("as='video'");
  });
});

describe("patch edits in update_artifact — #607", () => {
  it("applies find/replace edits in order, each to the result of the one before", () => {
    expect(applyArtifactEdits("# Plan\n\nIntro.\n\n## Two", [
      { find: "## Two", replace: "## Second" },
      { find: "Second", replace: "Second heading" },
    ])).toBe("# Plan\n\nIntro.\n\n## Second heading");
  });

  it("names the edit that did not match, and changes nothing", () => {
    expect(() => applyArtifactEdits("a b", [{ find: "a", replace: "x" }, { find: "zzz", replace: "y" }])).toThrow(
      /Edit 2 of 2: `find` "zzz" is not in the document \(after the edits before it\)/,
    );
    expect(() => applyArtifactEdits("na na", [{ find: "na", replace: "x" }])).toThrow(/Edit 1 of 1: `find` "na" appears 2 times/);
    expect(() => applyArtifactEdits("text", [{ find: "text", replace: "  " }])).toThrow(/leave the document empty/);
    expect(() => applyArtifactEdits("text", [{ find: "", replace: "x" }])).toThrow(/is empty/);
  });

  it("patches the stored text and saves it as a new version", async () => {
    const result = await run(build(updateArtifactTool), {
      artifactId: "a1",
      edits: [{ find: "First paragraph.", replace: "A better first paragraph." }],
    });
    expect(result).toMatchObject({ ok: true, data: { version: 2, edited: 1 } });
    expect(calls.map((c) => c.method)).toEqual(["get", "revise"]);
    expect(calls[1]?.args).toMatchObject({ content: "# Plan\n\nA better first paragraph." });
  });

  it("revises nothing when an edit fails", async () => {
    const result = await run(build(updateArtifactTool), { artifactId: "a1", edits: [{ find: "not there", replace: "x" }] });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(errorOf(result).message).toMatch(/Edit 1 of 1/);
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("takes content or edits — not neither", async () => {
    for (const input of [
      { artifactId: "a1" },
      { artifactId: "a1", edits: [] },
    ]) {
      expect(await run(build(updateArtifactTool), input), JSON.stringify(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(calls).toEqual([]);
  });

  /* Production, 2026-09-28: gpt-4.1 sent both three times; each was refused before the tool ran, and it gave up. */
  it("given both, applies the edits and leaves the content unused", async () => {
    const result = await run(build(updateArtifactTool), {
      artifactId: "a1",
      content: "# Plan\n\n(a rewrite that dropped a section)",
      edits: [{ find: "First paragraph.", replace: "A better first paragraph." }],
    });
    expect(result).toMatchObject({ ok: true, data: { edited: 1, note: expect.stringContaining("not used") } });
    expect(calls[1]?.args).toMatchObject({ content: "# Plan\n\nA better first paragraph." });
  });

  it("given both and an edit that does not match, saves the content instead", async () => {
    const result = await run(build(updateArtifactTool), {
      artifactId: "a1",
      content: "# Plan\n\nThe whole new text.",
      edits: [{ find: "not there", replace: "x" }],
    });
    expect(result).toMatchObject({ ok: true, data: { note: expect.stringContaining("full content you sent was saved") } });
    expect(calls[1]?.args).toMatchObject({ content: "# Plan\n\nThe whole new text." });
  });

  it("tells the model to patch a small change and rewrite only when asked", () => {
    const { description } = build(updateArtifactTool).descriptor;
    expect(description).toContain("For a SMALL change");
    expect(description).toContain("`edits`: [{ find, replace }]");
    expect(description).toMatch(/only when most of it changes or the person asks for a rewrite/);
  });
});

describe("the react and svg kinds — #607 part 3", () => {
  const SVG = '<svg viewBox="0 0 4 4" onload="alert(1)"><script>alert(2)</script><rect width="4" height="4"/></svg>';
  const REACT = "import { useState } from 'react';\nexport default function App() { const [n, set] = useState(0); return <button onClick={() => set(n + 1)}>{n}</button>; }";

  it("creates both kinds", async () => {
    for (const kind of ["react", "svg"] as const) {
      calls = [];
      const result = await run(build(createArtifactTool, { kind }), { title: "T", kind, content: kind === "svg" ? SVG : REACT });
      expect(result, kind).toMatchObject({ ok: true, data: { kind } });
    }
  });

  it("tells the model what each kind is for", () => {
    const { description } = build(createArtifactTool).descriptor;
    expect(description).toContain("slides, react or svg");
    expect(description).toMatch(/REACT: ONE component file with a default export/);
    expect(description).toMatch(/SVG: one <svg> element/);
  });

  it("puts an svg on a post as a PNG of the sanitized drawing, never a PDF", async () => {
    const result = await run(build(attachArtifactToPostTool, { kind: "svg", content: SVG }), { artifactId: "a1", postDraftId: DRAFT, as: "pdf" });
    expect(result).toMatchObject({ ok: true, data: { as: "image", attached: true } });
    const drawn = calls.find((c) => c.method === "renderHtmlImage");
    expect(String(drawn?.args["html"])).toContain('<rect width="4" height="4"/>');
    expect(String(drawn?.args["html"])).not.toMatch(/alert|onload|<script/);
    expect(calls.some((c) => c.method === "renderDocument")).toBe(false);
  });

  it("prints an svg as a page holding the drawing", async () => {
    const result = await run(build(generatePdfTool, { kind: "svg", content: SVG }), { kind: "markdown", artifactId: "a1" });
    expect(result).toMatchObject({ ok: true });
    const printed = String(calls.find((c) => c.method === "renderDocument")?.args["html"]);
    expect(printed).toContain("<svg");
    expect(printed).not.toMatch(/alert|onload/);
  });

  it("refuses to print or attach a react artifact, saying why", async () => {
    const pdf = await run(build(generatePdfTool, { kind: "react", content: REACT }), { kind: "markdown", artifactId: "a1" });
    expect(errorOf(pdf)).toMatchObject({ code: "invalid_input", message: expect.stringContaining("cannot be turned into a PDF") });
    const image = await run(build(attachArtifactToPostTool, { kind: "react", content: REACT }), { artifactId: "a1", postDraftId: DRAFT, as: "image" });
    expect(errorOf(image)).toMatchObject({ code: "invalid_input", message: expect.stringContaining("cannot be turned into an image") });
    expect(calls.some((c) => c.method === "renderDocument" || c.method === "renderHtmlImage" || c.method === "attachPathsToDraft")).toBe(false);
  });
});

describe("slide edits in update_artifact — #644", () => {
  const DECK = "<!-- format: 16:9 -->\n---\n# Retinue Agent Kit\n---\n## Why Retinue?\n- Durable\n---\n## Setup\n```ts\n---\nconst a = 1\n```";

  it("replaces, inserts and deletes slides by the outline's numbers, keeping the format line and code intact", () => {
    const next = applySlideEdits(DECK, [
      { slide: 2, action: "replace", content: "## Why Retinue?\n- Durable\n- Typed" },
      { slide: 3, action: "insert_after", content: "## Setup, part two\n```ts\nconst b = 2\n```" },
      { slide: 1, action: "insert_before", content: "# Cover" },
    ]);
    expect(next.startsWith("<!-- format: 16:9 -->\n\n---\n\n# Cover")).toBe(true);
    expect(next).toContain("- Typed");
    expect(next).toContain("```ts\n---\nconst a = 1\n```");
    expect(next.indexOf("## Setup\n")).toBeLessThan(next.indexOf("## Setup, part two"));
    expect(applySlideEdits(DECK, [{ slide: 3, action: "delete" }])).not.toContain("## Setup");
  });

  it("refuses a slide that does not exist, an empty slide, two slides in one edit, and an empty deck", () => {
    for (const edits of [
      [{ slide: 9, action: "replace" as const, content: "x" }],
      [{ slide: 1, action: "replace" as const, content: "  " }],
      [{ slide: 1, action: "replace" as const, content: "# A\n---\n# B" }],
      [{ slide: 1, action: "delete" as const }, { slide: 1, action: "delete" as const }, { slide: 1, action: "delete" as const }],
    ]) {
      expect(() => applySlideEdits(DECK, edits), JSON.stringify(edits)).toThrow(/Nothing was changed/);
    }
  });

  it("saves the edited deck as a new version and says how", async () => {
    const result = await run(build(updateArtifactTool, { kind: "slides", content: DECK }), {
      artifactId: "a1",
      slideEdits: [{ slide: 2, action: "replace", content: "## Why Retinue?\n- Durable\n- Typed" }],
    });
    expect(result).toMatchObject({ ok: true, data: { savedFrom: "slideEdits", slidesEdited: 1, slides: 3 } });
    expect(String(calls.at(-1)?.args["content"])).toContain("- Typed");
  });

  it("#665: names the slides that changed — in the saved deck's numbering, and removed ones in the old deck's", () => {
    const outcome = applySlideEditsTracked(DECK, [
      { slide: 1, action: "delete" },
      { slide: 1, action: "replace", content: "## Why Retinue?\n- Typed" },
      { slide: 2, action: "insert_after", content: "## Next" },
    ]);
    expect(outcome.changed).toEqual([1, 3]);
    expect(outcome.removed).toEqual([1]);
    expect(applySlideEditsTracked(DECK, [{ slide: 2, action: "replace", content: "## X" }])).toMatchObject({ changed: [2], removed: [] });
  });

  it("#665: the result lists which slides changed, and says nothing of slides after a fallback to the full content", async () => {
    const result = await run(build(updateArtifactTool, { kind: "slides", content: DECK }), {
      artifactId: "a1",
      slideEdits: [{ slide: 3, action: "replace", content: "## Setup\n- npm i" }, { slide: 1, action: "insert_before", content: "# Cover" }],
    });
    expect(result).toMatchObject({ ok: true, data: { savedFrom: "slideEdits", slidesChanged: [1, 4] } });
    expect((result as { data: Record<string, unknown> }).data["slidesRemoved"]).toBeUndefined();

    const fellBack = await run(build(updateArtifactTool, { kind: "slides", content: DECK }), {
      artifactId: "a1",
      slideEdits: [{ slide: 1, action: "replace", content: "# Retinue" }],
      edits: [{ find: "not in the deck", replace: "x" }],
      content: `${DECK}\n\n---\n\n## Extra`,
    });
    expect(fellBack).toMatchObject({ ok: true, data: { savedFrom: "content" } });
    expect((fellBack as { data: Record<string, unknown> }).data["slidesChanged"]).toBeUndefined();
  });

  it("#665: tells the model to change particular slides with slideEdits and keep content for a restructure", () => {
    const { description } = build(updateArtifactTool).descriptor;
    expect(description).toContain("is always `slideEdits`");
    expect(description).toContain("only to restructure it");
    expect(description).toContain("`slidesChanged`");
  });

  it("refuses slide edits on a document that is not a deck", async () => {
    const result = await run(build(updateArtifactTool, { kind: "markdown" }), { artifactId: "a1", slideEdits: [{ slide: 1, action: "delete" }] });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("will not let a much shorter rewrite stand in for a failed edit (chat d756738b)", async () => {
    const long = `# Plan\n\n${"A section the person wants. ".repeat(40)}`;
    const result = await run(build(updateArtifactTool, { content: long }), {
      artifactId: "a1",
      edits: [{ find: "guessed text", replace: "x" }],
      content: "# Plan\n\nA rewrite from memory.",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls.some((c) => c.method === "revise")).toBe(false);
  });

  it("tells the model to edit in place and never create a second document", () => {
    const { description } = build(updateArtifactTool).descriptor;
    expect(description).toContain("never create_artifact");
    expect(description).toContain("slideEdits");
  });
});

/**
 * #654 — printing an unchanged document again returns the same file and says so.
 *
 * Production, 2026-09-30: told "that came out as a web page, remake it as proper slides", the agent re-ran
 * generate_pdf on the unchanged document, got the identical 55,320-byte file and called it "the corrected PDF".
 */
describe("printing an unchanged document (#654)", () => {
  const unique = (label: string) => `# ${label} ${Math.random()}\n\nBody.`;

  it("returns the earlier PDF with unchanged: true, and renders nothing", async () => {
    const content = unique("Same");
    const tool = build(generatePdfTool, { content });
    const first = dataOf(await run(tool, { kind: "markdown", artifactId: "a1" }));
    calls = [];
    const second = dataOf(await run(tool, { kind: "markdown", artifactId: "a1" }));
    expect(second).toMatchObject({ reference: first["reference"], unchanged: true });
    expect(String(second["note"])).toContain("change the document with update_artifact first");
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("prints again when the version, the content or the options changed", async () => {
    const content = unique("Moves");
    await run(build(generatePdfTool, { content }), { kind: "markdown", artifactId: "a1" });
    calls = [];
    await run(build(generatePdfTool, { content, version: 2 }), { kind: "markdown", artifactId: "a1" });
    expect(calls.map((c) => c.method)).toContain("renderDocument");
    calls = [];
    await run(build(generatePdfTool, { content: `${content}\nMore.` }), { kind: "markdown", artifactId: "a1" });
    expect(calls.map((c) => c.method)).toContain("renderDocument");
    calls = [];
    await run(build(generatePdfTool, { content }), { kind: "markdown", artifactId: "a1", template: "report" });
    expect(calls.map((c) => c.method)).toContain("renderDocument");
  });

  it("tells the model to print only when asked", () => {
    const { description } = build(generatePdfTool).descriptor;
    expect(description).toContain("only when the person asked for a PDF or a file");
  });
});
