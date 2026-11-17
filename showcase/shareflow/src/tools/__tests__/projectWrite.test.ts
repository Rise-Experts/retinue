import { describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { proposeProjectSetupTool, updateProjectTool } from "../projects.js";
import { createPostgresProjectService, MEMORY_LIMIT } from "../../adapters/postgres/projects.js";
import { projectSectionBody } from "../../context/providers.js";
import type { ShareFlowServices } from "../../index.js";

/** #553 (the agent writes the project) and #554 (project memory). */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER = "9b2d1a4e-1111-4222-8333-944455556666";
const CONTEXT = { tenantId: asId<TenantId>(WS), principalId: asId<PrincipalId>(USER), conversationId: "conv-1" } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
const PROJECT = { id: "p1", name: "Café Luna", instructions: "", defaults: {} };

describe("update_project", () => {
  it("is gated, so the person sees the change first", () => {
    const tool = updateProjectTool.build({ services: {} as never, deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() } });
    expect(tool.descriptor.approvalPolicy).toBe("always");
  });

  it("sends the app's own field names — the style kit is the project's design", async () => {
    const patches: unknown[] = [];
    const tool = updateProjectTool.build({
      services: { projects: { async update(_c: unknown, patch: unknown) { patches.push(patch); return { projectId: "p1", changed: ["design"] }; } } } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore(), approvals: { async isAllowed() { return true; } } as never },
    });
    await tool.execute({ context: CONTEXT, input: { styleKit: { colors: ["#1A2B3C"] }, instructions: "Warm." }, idempotencyKey: "k1", approval: { interactionId: "i1" } } as never);
    expect(patches).toEqual([{ instructions: "Warm.", design: { colors: ["#1A2B3C"] } }]);
  });
});

/**
 * Production, 2026-09-28: asked to set a theme, the model sent `logoAssetId: "default"` (then the nil UUID) and
 * the web refused the whole update for a logo nobody asked for.
 */
describe("update_project with a file id the project does not have", () => {
  const LOGO = "5d9f2c1a-0000-4000-8000-000000000001";
  const run = async (input: Record<string, unknown>) => {
    const patches: unknown[] = [];
    const tool = updateProjectTool.build({
      services: {
        projects: {
          async listAssets() { return [{ id: LOGO, kind: "image", label: "Logo" }, { id: "doc-1", kind: "document", label: "Deck" }]; },
          async update(_c: unknown, patch: unknown) { patches.push(patch); return { projectId: "p1", changed: ["design"] }; },
        },
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore(), approvals: { async isAllowed() { return true; } } as never },
    });
    const result = await tool.execute({ context: CONTEXT, input, idempotencyKey: `k-${patches.length}-${JSON.stringify(input).length}`, approval: { interactionId: "i1" } } as never);
    return { patches, result };
  };

  it("saves the theme and drops an invented logo, saying so", async () => {
    const { patches, result } = await run({ styleKit: { themeId: "dark-tech", headingFont: "Inter", logoAssetId: "00000000-0000-0000-0000-000000000000" } });
    expect(patches).toEqual([{ design: { themeId: "dark-tech", headingFont: "Inter" } }]);
    expect(result).toMatchObject({ ok: true, data: { note: expect.stringContaining("not one of this project's images") } });
  });

  it("keeps a logo that is one of the project's images, and refuses a document as one", async () => {
    expect((await run({ styleKit: { logoAssetId: LOGO } })).patches).toEqual([{ design: { logoAssetId: LOGO } }]);
    expect((await run({ styleKit: { logoAssetId: "doc-1", radius: 8 } })).patches).toEqual([{ design: { radius: 8 } }]);
  });

  it("keeps only the reference photos that exist", async () => {
    const { patches } = await run({ avatar: { name: "Luna", referenceAssetIds: [LOGO, "made-up"] } });
    expect(patches).toEqual([{ avatar: { name: "Luna", referenceAssetIds: [LOGO] } }]);
  });

  it("tells the model to send only the sections it was asked to change", () => {
    const tool = updateProjectTool.build({ services: {} as never, deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() } });
    expect(tool.descriptor.description).toContain("Send ONLY the sections the person asked to change");
    expect(tool.descriptor.description).toContain("never fill in values the person did not give");
  });
});

describe("propose_project_setup", () => {
  it("writes nothing and hands back what the card offers", async () => {
    const tool = proposeProjectSetupTool.build({
      services: { projects: { async current() { return PROJECT; } } } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() },
    });
    const result = await tool.execute({ context: CONTEXT, input: { instructions: "Warm.", styleKit: { colors: ["#3B2416"] }, sources: ["https://cafeluna.de"] }, idempotencyKey: "k2" });
    expect(result).toMatchObject({ ok: true, data: { projectId: "p1", proposal: { instructions: "Warm.", design: { colors: ["#3B2416"] } }, sources: ["https://cafeluna.de"], status: "awaiting_person" } });
  });
});

describe("remember_project_rule's store", () => {
  const sqlWith = (existing: string | null, count: number) => {
    const inserts: unknown[][] = [];
    return {
      inserts,
      sql: {
        async query<Row>(text: string, params: unknown[] = []): Promise<Row[]> {
          if (text.includes("from public.project_conversations")) return [{ ...PROJECT }] as Row[];
          if (text.includes("select id, text from public.project_memories")) return [] as Row[];
          if (text.includes("lower(regexp_replace")) return (existing === null ? [] : [{ id: existing }]) as Row[];
          if (text.includes("count(*)")) return [{ n: String(count) }] as Row[];
          if (text.includes("insert into public.project_memories")) {
            inserts.push(params);
            return [{ id: "m-new" }] as Row[];
          }
          throw new Error(`unexpected query ${text.slice(0, 60)}`);
        },
      },
    };
  };

  it("stores a rule with the conversation it came from", async () => {
    const { sql, inserts } = sqlWith(null, 0);
    const out = await createPostgresProjectService({ sql: sql as never }).remember(CONTEXT, { text: "  Never say  'revolutionary'. " });
    expect(out).toEqual({ memoryId: "m-new", duplicate: false });
    expect(inserts[0]).toEqual(["p1", WS, "Never say 'revolutionary'.", "conv-1", USER]);
  });

  it("keeps one copy of the same rule", async () => {
    const { sql, inserts } = sqlWith("m-old", 3);
    expect(await createPostgresProjectService({ sql: sql as never }).remember(CONTEXT, { text: "never say 'revolutionary'." })).toEqual({ memoryId: "m-old", duplicate: true });
    expect(inserts).toEqual([]);
  });

  it("refuses past the limit and says what to do", async () => {
    const { sql } = sqlWith(null, MEMORY_LIMIT);
    await expect(createPostgresProjectService({ sql: sql as never }).remember(CONTEXT, { text: "One more rule." })).rejects.toMatchObject({ code: "conflict" });
  });

  it("reaches every turn of the project through its section", () => {
    const body = projectSectionBody({ ...PROJECT, memories: [{ text: "Never say 'revolutionary'." }] });
    expect(body).toContain("What this project has learned");
    expect(body).toContain("- Never say 'revolutionary'.");
    expect(body).toContain("remember_project_rule");
  });
});
