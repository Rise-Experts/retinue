import { describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { generateMediaTool, withDesignKit } from "../media.js";
import { projectSectionBody } from "../../context/providers.js";
import { createPostgresProjectService } from "../../adapters/postgres/projects.js";
import type { ActiveProject, ShareFlowServices } from "../../index.js";

/** #525 — a project's style kit: how its images look and what shape they take. */
const KIT = { imageStyle: "flat illustration, soft grain", colors: ["#1A2B3C", "#F2C14E"], aspectRatios: ["4:5", "9:16"] };
const CONTEXT = { tenantId: asId<TenantId>("t1"), principalId: asId<PrincipalId>("p1"), conversationId: "c1" } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

describe("the style kit in a media prompt", () => {
  it("adds the image style and brand colours", () => {
    // #595: a legacy kit reads as a theme — the style sentence is the picture's notes, [0]/[1] primary/accent.
    expect(withDesignKit("a laptop on a desk", KIT)).toBe(
      "a laptop on a desk\n\nPicture look: flat illustration, soft grain\nBrand palette: primary #1a2b3c, accent #f2c14e",
    );
  });

  it("gives a chosen theme's picture look and palette as structured lines (#595)", () => {
    const prompt = withDesignKit("a laptop", { themeId: "editorial", picture: { style: "3d-render", mood: "cold, clinical" }, imageStyle: "no people" });
    expect(prompt).toBe(
      "a laptop\n\nPicture look: polished 3D render, soft studio lighting, smooth materials; mood: cold, clinical; no people\n" +
        "Brand palette: primary #1c1917, accent #b45309, background #fbf8f3",
    );
  });

  it("does not push the base preset's look onto a kit that only has notes (#595)", () => {
    expect(withDesignKit("a laptop", { imageStyle: "watercolour" })).toBe("a laptop\n\nPicture look: watercolour");
  });

  it("adds nothing the prompt already carries, and nothing outside a project", () => {
    const already = "a laptop, flat illustration, soft grain, in #1A2B3C and #F2C14E";
    expect(withDesignKit(already, KIT)).toBe(already);
    expect(withDesignKit("a laptop", undefined)).toBe("a laptop");
    expect(withDesignKit("a laptop", {})).toBe("a laptop");
  });
});

describe("generate_media in a project with a kit", () => {
  const build = (project: ActiveProject | null) => {
    const calls: Record<string, unknown>[] = [];
    const tool = generateMediaTool.build({
      services: {
        media: { async generate(_c: ExecutionContext, input: Record<string, unknown>) { calls.push(input); return { jobId: "j1" }; } },
        projects: { async current() { return project; } },
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() },
    });
    return { tool, calls };
  };
  const project: ActiveProject = { id: "p1", name: "AI", instructions: "", defaults: {}, design: KIT };

  it("carries the kit and defaults to its first aspect ratio", async () => {
    const { tool, calls } = build(project);
    await tool.execute({ context: CONTEXT, input: { kind: "image", prompt: "a laptop" }, idempotencyKey: "k1" });
    expect(calls[0]).toMatchObject({ prompt: expect.stringContaining("Picture look: flat illustration"), aspectRatio: "4:5" });
  });

  it("keeps an aspect ratio the model asked for", async () => {
    const { tool, calls } = build(project);
    await tool.execute({ context: CONTEXT, input: { kind: "video", prompt: "a laptop", aspectRatio: "9:16" }, idempotencyKey: "k2" });
    expect(calls[0]).toMatchObject({ aspectRatio: "9:16" });
  });

  it("sends no aspect ratio outside a project", async () => {
    const { tool, calls } = build(null);
    await tool.execute({ context: CONTEXT, input: { kind: "image", prompt: "a laptop" }, idempotencyKey: "k3" });
    expect(calls[0]).toEqual({ kind: "image", prompt: "a laptop" });
  });
});

describe("the kit in the project section", () => {
  it("names the style, colours, ratios, logo and Facebook background", () => {
    const body = projectSectionBody({ name: "AI", instructions: "", defaults: {}, design: { ...KIT, fonts: "Inter", hasLogo: true, facebookBackground: "248623902401250" } });
    // #595: the kit reads as a theme in the section.
    expect(body).toContain("Picture look: flat illustration, soft grain");
    expect(body).toContain("primary #1a2b3c, accent #f2c14e");
    expect(body).toContain("Fonts: Inter for headings, Inter for body text.");
    expect(body).toContain("Preferred aspect ratios: 4:5, 9:16 (the first is the default)");
    expect(body).toContain("A logo is chosen");
    expect(body).toContain("Text-only Facebook drafts get the project's background");
  });

  it("describes a theme in six short lines at most (#595)", () => {
    const body = projectSectionBody({
      name: "AI",
      instructions: "",
      defaults: {},
      design: { themeId: "dark-tech", headingFont: "JetBrains Mono", logoPlacement: "top-left", hasLogo: true, aspectRatios: ["4:5"], facebookBackground: "1" },
    });
    const kit = body.slice(body.indexOf("Theme: Dark tech"), body.indexOf("\n\nWhen the person teaches")).split("\n");
    expect(kit.length).toBeLessThanOrEqual(6);
    expect(kit[0]).toMatch(/^Theme: Dark tech/);
    expect(body).toContain("Palette: background #0b1020, surface #131a2e, primary #22d3ee, accent #a855f7, text #e5e7eb, muted #94a3b8.");
    expect(body).toContain("Fonts: JetBrains Mono for headings, Inter for body text.");
    expect(body).toContain("Picture look: polished 3D render");
    expect(body).toContain("(placed top-left)");
  });

  it("says nothing about a kit the project does not have", () => {
    expect(projectSectionBody({ name: "AI", instructions: "", defaults: {} })).not.toContain("Style kit");
  });
});

describe("the project service reads the kit", () => {
  it("keeps what is set, drops blanks, and reports a logo without its id", async () => {
    const sql = {
      async query<Row>(): Promise<Row[]> {
        return [{ id: "p1", name: "AI", instructions: "", defaults: {}, design: { ...KIT, fonts: " ", logoAssetId: "9b2d1a4e-1111-4222-8333-944455556666" } }] as Row[];
      },
    };
    const project = await createPostgresProjectService({ sql: sql as never }).current(CONTEXT);
    expect(project?.design).toEqual({ ...KIT, hasLogo: true });
  });

  it("carries the theme keys as stored, dropping blanks and wrong shapes (#595)", async () => {
    const stored = {
      themeId: "bold",
      palette: { primary: "#ff0000", accent: " ", text: 7 },
      headingFont: "Inter",
      bodyFont: "",
      radius: 10,
      picture: { style: "photo", mood: " " },
      logoPlacement: "top-right",
    };
    const sql = { async query<Row>(): Promise<Row[]> { return [{ id: "p1", name: "AI", instructions: "", defaults: {}, design: stored }] as Row[]; } };
    const project = await createPostgresProjectService({ sql: sql as never }).current(CONTEXT);
    expect(project?.design).toEqual({
      themeId: "bold",
      palette: { primary: "#ff0000" },
      headingFont: "Inter",
      radius: 10,
      picture: { style: "photo" },
      logoPlacement: "top-right",
    });
  });
});

describe("the project's logo for a document template (#595 part 2)", () => {
  const service = (rows: unknown[] | Error) =>
    createPostgresProjectService({
      sql: {
        async query<Row>(): Promise<Row[]> {
          if (rows instanceof Error) throw rows;
          return rows as Row[];
        },
      } as never,
    });
  const context = { ...CONTEXT, conversationId: "c1" } as typeof CONTEXT;

  it("is a chorus-media reference to the stored image in the workspace's own folder", async () => {
    const tenant = String(context.tenantId);
    expect(await service([{ path: `${tenant}/projects/p1/logo.png` }]).logoReference?.(context)).toBe(`chorus-media:${tenant}/projects/p1/logo.png`);
  });

  it("is undefined without a logo, outside the workspace's folder, on a traversal, or when the lookup fails", async () => {
    const tenant = String(context.tenantId);
    expect(await service([]).logoReference?.(context)).toBeUndefined();
    expect(await service([{ path: null }]).logoReference?.(context)).toBeUndefined();
    expect(await service([{ path: "other-ws/logo.png" }]).logoReference?.(context)).toBeUndefined();
    expect(await service([{ path: `${tenant}/../other/logo.png` }]).logoReference?.(context)).toBeUndefined();
    expect(await service(new Error("db down")).logoReference?.(context)).toBeUndefined();
    const { conversationId: _none, ...outside } = context as unknown as Record<string, unknown>;
    expect(await service([{ path: `${tenant}/x.png` }]).logoReference?.(outside as unknown as typeof CONTEXT)).toBeUndefined(); // no conversation
  });
});
