/**
 * The package's own guarantees: the closed vocabularies, the composition checks, and the two places
 * a mistake would otherwise be silent (AC-1, AC-4, AC-5).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { asId, type ExecutionContext, type PrincipalId, type TenantId, type Tool } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { defineDelegatingTool, defineTool } from "@retinue/agentkit/tools";
import {
  SHAREFLOW_CONTEXT_PROVIDER_IDS,
  SHAREFLOW_TOOL_CATEGORIES,
  SHAREFLOW_BUILT_IN_SKILLS,
  SOCIAL_ASSISTANT_ID,
  createShareFlowToolProvider,
  defineShareFlowSkill,
  estimateTokens,
  serviceFailure,
  shareFlowBuiltInSkills,
  shareFlowSection,
  socialAssistantManifest,
  unwrapServiceResult,
  type ShareFlowServices,
} from "../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

/** Stub services. Nothing here reaches a network — that is the point of the seam. */
const services = {} as ShareFlowServices;

/** The delegating deps every ShareFlow capability is built from. */
const deps = { authorization: { async can() { return { allow: true }; } } as never };

const tool = (name: string, category: string): Tool =>
  defineTool({ name, description: `does ${name}`, category, execute: () => ({ ok: true }) });

describe("the tool provider", () => {
  it("serves every registered factory's tool", async () => {
    const provider = createShareFlowToolProvider({
      services,
      deps,
      factories: [() => tool("list_accounts", "accounts"), () => tool("create_post_draft", "posts")],
    });
    expect(provider.id).toBe("shareflow");
    expect((await provider.listTools(CONTEXT)).map((t) => t.descriptor.name)).toEqual([
      "list_accounts",
      "create_post_draft",
    ]);
  });

  it("refuses a category outside docs/07's vocabulary", () => {
    // The failure this prevents: `ToolDescriptor.category` is a bare string and an agent manifest
    // selects tools *by* category, so "post" instead of "posts" yields an assistant that silently has
    // fewer tools than configured — which reads as the model being unhelpful.
    expect(() =>
      createShareFlowToolProvider({ services, deps, factories: [() => tool("create_post", "post")] }),
    ).toThrowError(/not one of/);
  });

  it("refuses two tools with the same name", () => {
    // Function-calling dispatches by name. A duplicate does not error at the model boundary; one of
    // the two just never gets called, and which one depends on registration order.
    expect(() =>
      createShareFlowToolProvider({
        services,
        deps,
        factories: [() => tool("publish_post", "publishing"), () => tool("publish_post", "posts")],
      }),
    ).toThrowError(/duplicate/);
  });

  it("fails at construction, not at the first conversation", async () => {
    // Asserting *when*, not just whether. A provider that validated inside `listTools` would start
    // cleanly and fail per-run, which is the shape of a bug that reaches production.
    let built = false;
    expect(() => {
      built = true;
      return createShareFlowToolProvider({ services, deps, factories: [() => tool("x", "nope")] });
    }).toThrow();
    expect(built).toBe(true);
  });
});

describe("the service seam", () => {
  it("throws rather than returning a failure value", () => {
    // Load-bearing, and the reason is #113: the envelope writes the delegate's return value into the
    // idempotency store. A failure returned as a value would become that call's permanent answer.
    expect(() => unwrapServiceResult({ ok: false, code: "rate_limited", message: "slow down" })).toThrowError(
      /slow down/,
    );
    expect(unwrapServiceResult({ ok: true, value: 42 })).toBe(42);
  });

  it("decides retryability from the failure, not the caller", () => {
    expect(serviceFailure("rate_limited", "x").retryable).toBe(true);
    expect(serviceFailure("provider_unavailable", "x").retryable).toBe(true);
    expect(serviceFailure("invalid_input", "x").retryable).toBe(false);
    expect(serviceFailure("not_found", "x").retryable).toBe(false);
  });

  it("keeps a thrown service failure out of the idempotency store", async () => {
    // The concrete consequence, proven end to end rather than asserted in a comment: wrap a service
    // that fails once and then succeeds, and the second call must reach it again.
    let calls = 0;
    const delegating = defineDelegatingTool(
      {
        authorization: { async can() { return { allow: true }; } } as never,
        idempotency: createMemoryIdempotencyStore(),
      },
      {
        name: "get_draft",
        description: "reads a draft",
        category: "posts",
        delegatesTo: "ContentService.getDraft",
        delegate: () => {
          calls += 1;
          if (calls === 1) throw serviceFailure("provider_unavailable", "upstream down");
          return { id: "d1" };
        },
      },
    );

    const first = await delegating.execute({ context: CONTEXT, input: {}, idempotencyKey: "k1" });
    // Asserting the *code*, not just `ok === false`. The first version of this test asserted only the
    // flag, and passed while the tool was actually failing on a mis-stubbed authorization policy —
    // never reaching the delegate at all. That is the seventh time this session an outcome flag has
    // stood in for the effect.
    expect(first).toMatchObject({ ok: false, error: { code: "provider_unavailable", retryable: true } });
    expect(calls).toBe(1);
    const second = await delegating.execute({ context: CONTEXT, input: {}, idempotencyKey: "k1" });
    expect(second).toEqual({ ok: true, data: { id: "d1" } });
    expect(calls).toBe(2);
  });
});

describe("context sections", () => {
  it("defaults to internal and uncacheable, and computes its own size", () => {
    const section = shareFlowSection({
      providerId: "shareflow.brand",
      title: "Brand",
      body: "x".repeat(400),
      priority: 90,
      provenance: "workspace_brand_profiles#w1",
    });
    // `internal`, not `public`: brand claims and campaign briefs are a tenant's commercial material,
    // and a wrong default here is wrong in the direction that leaks.
    expect(section.sensitivity).toBe("internal");
    // `false`: a stale account-health or brand section is worse than a slower prompt.
    expect(section.cacheable).toBe(false);
    expect(section.estimatedTokens).toBe(100);
    expect(estimateTokens("abc")).toBe(1);
  });

  it("names every provider docs/07 calls for", () => {
    expect(SHAREFLOW_CONTEXT_PROVIDER_IDS).toContain("shareflow.brand");
    expect(new Set(SHAREFLOW_CONTEXT_PROVIDER_IDS).size).toBe(SHAREFLOW_CONTEXT_PROVIDER_IDS.length);
  });
});

describe("built-in skills", () => {
  it("validates content at import time using the platform's own validator", () => {
    expect(() =>
      defineShareFlowSkill({
        name: "Not A Slug",
        description: "a description that is comfortably long enough",
        instructions: "do the thing",
        version: 1,
        authoredAt: "2026-08-23T00:00:00.000Z",
      }),
    ).toThrowError(/slug/);
    // Too short a description is the other half — the limit mirrors `workspace_agent_skills`.
    expect(() =>
      defineShareFlowSkill({
        name: "create-post",
        description: "short",
        instructions: "do the thing",
        version: 1,
        authoredAt: "2026-08-23T00:00:00.000Z",
      }),
    ).toThrowError(/description/);
  });

  it("rejects a duplicate name the resolver would silently shadow", () => {
    const skill = defineShareFlowSkill({
      name: "create-post",
      description: "how to draft a post for a specific channel and audience",
      instructions: "do the thing",
      version: 1,
      authoredAt: "2026-08-23T00:00:00.000Z",
    });
    expect(() => shareFlowBuiltInSkills([skill, skill])).toThrowError(/duplicate/);
  });

  it("ships the seven migrated skills, and nothing invented", () => {
    // #114 asserted this set was empty, on the grounds that an assistant shipping plausible-looking
    // prose nobody wrote on purpose is worse than one shipping none. #122 migrated the real bodies from
    // `ai_backend/skills`, so the assertion becomes what they are rather than that there are none.
    expect(SHAREFLOW_BUILT_IN_SKILLS.map((s) => s.name).sort()).toEqual([
      "analytics-reporting",
      "document-generation",
      "mermaid-diagrams",
      "platform-media-rules",
      "post-composition",
      "publishing-safety",
      "research-and-citation",
    ]);
    for (const skill of SHAREFLOW_BUILT_IN_SKILLS) {
      expect(skill.source, skill.name).toBe("built-in");
      expect(skill.version, skill.name).toBe(1);
    }
  });
});

describe("the Social Assistant manifest", () => {
  const base = {
    version: 1,
    modelPolicy: {} as never,
    authorizationPolicyId: "shareflow-default",
    limits: {} as never,
  };

  it("requires instructions, so no placeholder prompt can ship inside an agent", () => {
    expect(() => socialAssistantManifest({ ...base, instructions: "   " })).toThrowError(
      /requires instructions/,
    );
  });

  it("rejects a non-positive version, which a run would record as the text it executed", () => {
    expect(() => socialAssistantManifest({ ...base, version: 0, instructions: "x" })).toThrowError(
      /positive integer/,
    );
  });

  it("keeps the id neutral and the branding in the display name", () => {
    const manifest = socialAssistantManifest({ ...base, instructions: "You help with social content." });
    // docs/01: agent IDs are neutral and stable for referencing; the display name is where a product's
    // branding lives.
    expect(manifest.id).toBe(SOCIAL_ASSISTANT_ID);
    expect(manifest.id).not.toMatch(/shareflow|chorus/i);
    expect(manifest.name).toBe("Social Assistant");
    expect(manifest.toolPolicy.categories).toEqual([...SHAREFLOW_TOOL_CATEGORIES]);
    expect(manifest.contextProviderIds).toEqual([...SHAREFLOW_CONTEXT_PROVIDER_IDS]);
  });

  it("can narrow the tool surface for a read-only deployment", () => {
    const manifest = socialAssistantManifest({
      ...base,
      instructions: "You explain measured performance.",
      categories: ["analytics"],
    });
    expect(manifest.toolPolicy.categories).toEqual(["analytics"]);
  });
});

/** AC-4. */
describe("test discovery", () => {
  it("is confined to src/**, so a stale dist copy cannot be run twice", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const config = readFileSync(resolve(here, "../../vitest.config.ts"), "utf8");
    // Asserted against the file rather than against vitest's resolved config, because the failure this
    // guards is someone widening the glob — and that is a change to this file.
    expect(config).toMatch(/include:\s*\["src\/\*\*\/\*\.test\.ts"\]/);
    expect(config).toMatch(/exclude:.*dist\/\*\*/);
    // And the runtime half: this assertion fails if the file executing it was collected from `dist`,
    // which is the actual symptom — a suite that reports twice as many passing tests as it has, half
    // of them against a build from before the change under review.
    expect(import.meta.url).not.toContain("/dist/");
  });
});
