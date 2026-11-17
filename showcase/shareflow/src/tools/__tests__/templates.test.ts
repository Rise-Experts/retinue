import { describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { renderPostTemplateTool } from "../projects.js";
import { createPostgresProjectService } from "../../adapters/postgres/projects.js";
import type { ShareFlowServices } from "../../index.js";
import { POST_TEMPLATE_IDS } from "../../services/index.js";

/** render_post_template — #525 part 2. */
const CONTEXT = { tenantId: asId<TenantId>("t1"), principalId: asId<PrincipalId>("p1"), conversationId: "c1" } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
const DRAFT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const build = (projects: Partial<ShareFlowServices["projects"]>) =>
  renderPostTemplateTool.build({
    services: { projects } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() },
  });

describe("render_post_template", () => {
  it("renders, then attaches every image to the draft in slide order", async () => {
    const attached: string[] = [];
    const tool = build({
      async renderTemplate() { return { assets: [{ id: "s1", label: "Carousel 1/2" }, { id: "s2", label: "Carousel 2/2" }] }; },
      async attachAsset(_c, input) { attached.push(input.projectAssetId); return { postDraftId: input.postDraftId, attached: 1 }; },
    });
    const result = await tool.execute({ context: CONTEXT, input: { template: "carousel", text: "", slides: ["One", "Two"], postDraftId: DRAFT }, idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: true, data: { attached: 2, postDraftId: DRAFT } });
    expect(attached).toEqual(["s1", "s2"]);
  });

  it("only saves to the project when no draft is given", async () => {
    let attachCalls = 0;
    const tool = build({
      async renderTemplate() { return { assets: [{ id: "q1", label: "Quote card" }] }; },
      async attachAsset() { attachCalls += 1; return { postDraftId: DRAFT, attached: 1 }; },
    });
    const result = await tool.execute({ context: CONTEXT, input: { template: "quote", text: "Hi" }, idempotencyKey: "k2" });
    expect(result).toMatchObject({ ok: true, data: { attached: 0 } });
    expect(attachCalls).toBe(0);
  });

  it("refuses a one-slide carousel before anything is drawn", async () => {
    let rendered = false;
    const tool = build({ async renderTemplate() { rendered = true; return { assets: [] }; } });
    const result = await tool.execute({ context: CONTEXT, input: { template: "carousel", text: "", slides: ["Only"] }, idempotencyKey: "k3" });
    expect(result).toMatchObject({ ok: false });
    expect(rendered).toBe(false);
  });
});

describe("the #595 templates", () => {
  it("accepts every template the app draws and passes the text through unchanged", async () => {
    const seen: string[] = [];
    const tool = build({ async renderTemplate(_c, input) { seen.push(`${input.template}:${input.text}`); return { assets: [{ id: "a1", label: input.template }] }; } });
    for (const template of ["announcement", "event", "tip", "stat", "testimonial"] as const) {
      const result = await tool.execute({ context: CONTEXT, input: { template, text: "Line one\nLine two" }, idempotencyKey: `k-${template}` });
      expect(result).toMatchObject({ ok: true });
    }
    expect(seen).toEqual(["announcement", "event", "tip", "stat", "testimonial"].map((t) => `${t}:Line one\nLine two`));
  });

  it("refuses a template id the app does not draw, before anything is drawn", async () => {
    let rendered = false;
    const tool = build({ async renderTemplate() { rendered = true; return { assets: [] }; } });
    const result = await tool.execute({ context: CONTEXT, input: { template: "before-after", text: "x" }, idempotencyKey: "k-bad" });
    expect(result).toMatchObject({ ok: false });
    expect(rendered).toBe(false);
  });

  it("tells the model each template's lines", () => {
    const tool = build({});
    for (const id of POST_TEMPLATE_IDS) expect(tool.descriptor.description).toContain(`\`${id}\``);
    expect(POST_TEMPLATE_IDS).toEqual(["quote", "carousel", "frame", "announcement", "event", "tip", "stat", "testimonial"]);
  });
});

describe("the project service's renderTemplate", () => {
  const sql = (inProject: boolean) => ({ async query<Row>(): Promise<Row[]> { return (inProject ? [{ id: "p1", name: "AI", instructions: "", defaults: {} }] : []) as Row[]; } });

  it("says why outside a project, and when the deployment has no route", async () => {
    const withRoute = createPostgresProjectService({ sql: sql(false) as never, renderTemplate: async () => ({ assets: [] }) });
    await expect(withRoute.renderTemplate(CONTEXT, { template: "quote", text: "Hi" })).rejects.toMatchObject({ code: "invalid_input" });
    const noRoute = createPostgresProjectService({ sql: sql(true) as never });
    await expect(noRoute.renderTemplate(CONTEXT, { template: "quote", text: "Hi" })).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});

describe("the reply after rendering", () => {
  it("is told the ids are not chorus-media paths — found on production, where the model linked them as images", async () => {
    const tool = build({ async renderTemplate() { return { assets: [{ id: "q1", label: "Quote card" }] }; } });
    const result = await tool.execute({ context: CONTEXT, input: { template: "quote", text: "Hi" }, idempotencyKey: "k9" });
    expect(result).toMatchObject({ ok: true, data: { note: expect.stringContaining("chorus-media") } });
    expect(tool.descriptor.description).toContain("never write a chorus-media: link");
  });
});
