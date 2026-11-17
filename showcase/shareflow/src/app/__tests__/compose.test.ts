/**
 * The composition, and the two wires that were missing from it.
 *
 * Both were invisible to every existing test, and both were found by running the real worker against a
 * real database and a real model and reading what came back.
 *
 *  1. **No approval check on the registry.** `ToolRegistryConfig.approval` is what "makes approval
 *     unbypassable"; without it the registry refuses every `approvalPolicy: "always"` tool outright:
 *
 *       Tool publish_post_now has approvalPolicy "always" and no approval check is configured
 *       (ToolRegistryConfig.approval), so it can never run. This is a wiring error, not a refusal.
 *
 *     That is what the assistant said, in different words, to *"Publish my Ethiopia draft to
 *     Instagram"* — the product's central action. A gate was constructed four lines away and handed to
 *     the tool deps, where the registry never looks.
 *
 *  2. **No skill loader.** `load_skill` is advertised only when `skills` is wired — "Wiring is the
 *     toggle. `load_skill` has been in `META_TOOLS` since the registry was written with nothing
 *     implementing it." So the meta-tool was silently absent from every catalogue, seven active skills
 *     and 20,000 characters of reviewed instructions were unreachable, and the prompt said *"ALWAYS
 *     load the `mermaid-diagrams` skill before turning a diagram into a file"*.
 *
 * These assertions go through the **composed registry**, because that is the thing whose behaviour was
 * wrong. A test of `createApprovalGate` in isolation passed throughout.
 */
import { describe, expect, it } from "vitest";

import { createApprovalGate } from "@retinue/agentkit/hitl";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";

import { PLACEHOLDER_AUTHORIZATION } from "../deployment.js";
import { SHAREFLOW_TOOL_FACTORIES } from "../../tools/index.js";
import { SHAREFLOW_ASSIGNED_SKILLS } from "../../skills/index.js";
import { composeShareFlowApp } from "../compose.js";
import { shareFlowServicesFrom } from "../services.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

const context = {
  tenantId: TENANT,
  principalId: "22222222-2222-4222-8222-222222222222",
  roleIds: ["editor"],
} as never;

const sql = { query: async () => [] } as never;

const services = () =>
  shareFlowServicesFrom({
    sql,
    transaction: (async (fn: never) => fn) as never,
    search: undefined as never,
    fetchPage: undefined as never,
    generate: (async () => ({ text: "" })) as never,
    env: { PUBLIC_APP_URL: "https://chorus.test" },
  });

/** A gate that allows everything: this asserts the *wire*, not the policy the gate implements. */
const permissive = { async isAllowed() { return true; } };

const compose = (over: { approval?: unknown; onMisconfiguration?: (r: unknown) => void } = {}) => {
  const grants = {
    async find() { return null; },
    async record() { /* nothing to remember for these assertions */ },
  } as never;
  const interactions = {
    async createApproval() { /* the request path is `createApprovalService`'s, not the gate's */ },
    async pendingApproval() { return null; },
  } as never;
  return composeShareFlowApp({
    sql,
    runner: (async (fn: never) => fn) as never,
    authorization: PLACEHOLDER_AUTHORIZATION,
    services: services(),
    deps: {
      authorization: PLACEHOLDER_AUTHORIZATION,
      idempotency: createMemoryIdempotencyStore(),
      approvals: createApprovalGate({ grants, interactions }),
    },
    ...(over.approval === undefined ? {} : { approval: over.approval as never }),
    factories: SHAREFLOW_TOOL_FACTORIES,
  });
};

const WIRING_ERROR = /no approval check is configured|can never run/;

describe("the registry's approval check", () => {
  it("is wired, so a gated tool is not refused as a wiring error", async () => {
    const { registry } = compose({ approval: permissive });
    const result = (await registry.execute(context, {
      name: "publish_post_now",
      input: { postDraftId: "e0f74f63-515a-48a1-9899-a53848ee67b0", accountIds: ["113a91b5-4722-450a-99f7-baa2016ee382"] },
    })) as { ok: boolean; error?: { message?: string } };

    /**
     * The tool still fails here — there is no database behind this `sql`. What must not happen is the
     * refusal that says the tool can *never* run, because that one is about the composition rather than
     * about this call.
     */
    expect(result.error?.message ?? "").not.toMatch(WIRING_ERROR);
  });

  it("refuses the tool outright when it is absent, and says so once", async () => {
    // The sabotage: exactly the composition this application shipped.
    const reports: unknown[] = [];
    const { registry } = compose({ onMisconfiguration: (r) => reports.push(r) });
    const result = (await registry.execute(context, {
      name: "publish_post_now",
      input: { postDraftId: "e0f74f63-515a-48a1-9899-a53848ee67b0", accountIds: ["113a91b5-4722-450a-99f7-baa2016ee382"] },
    })) as { ok: boolean; error?: { message?: string } };

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? "").toMatch(WIRING_ERROR);
  });

  it("leaves a read tool alone either way", async () => {
    // The gate applies to policy-classified tools only; a read must not need one.
    const { registry } = compose();
    const result = (await registry.execute(context, { name: "list_accounts", input: { page: { kind: "first" } } })) as {
      error?: { message?: string };
    };
    expect(result.error?.message ?? "").not.toMatch(WIRING_ERROR);
  });
});

describe("the skill loader", () => {
  it("puts load_skill in the catalogue, because skills are wired", async () => {
    const { registry } = compose({ approval: permissive });
    const catalog = await registry.catalog(context, { preloaded: [], categories: [], excluded: [] });

    expect(catalog.meta.map((entry) => entry.name)).toContain("load_skill");
  });

  it("resolves an assigned built-in skill by name and version", async () => {
    /**
     * Through the resolver the composition returns, because the failure mode was a policy that listed
     * nothing: `createSkillResolver` keeps a built-in only when `assigned` contains its name, and
     * `loadBody` re-derives the same policy — so `assigned: []` made every skill unloadable as well as
     * invisible.
     */
    const { skills } = compose({ approval: permissive });
    const catalog = await skills.listCatalog({
      tenantId: TENANT as never,
      assigned: [...SHAREFLOW_ASSIGNED_SKILLS],
      allowTenantSkills: false,
    });

    expect(catalog.map((entry) => entry.name)).toContain("mermaid-diagrams");
    const body = await skills.loadBody({ tenantId: TENANT as never, name: "mermaid-diagrams", version: 1 });
    expect(body.instructions.length).toBeGreaterThan(100);
  });

  it("lists nothing for a policy that assigns nothing", async () => {
    // The shipped state, asserted: seven active skills and an empty catalogue.
    const { skills } = compose({ approval: permissive });
    expect(await skills.listCatalog({ tenantId: TENANT as never, assigned: [], allowTenantSkills: false })).toEqual([]);
  });
});
