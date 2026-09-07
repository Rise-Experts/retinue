/**
 * The package's own guarantees: the closed vocabularies, the composition checks, and the two places
 * a mistake would otherwise be silent (AC-1, AC-4, AC-5).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  SHAREFLOW_TOOL_FACTORIES,
  createShareFlowToolProvider,
  shareFlowTool,
  defineShareFlowSkill,
  estimateTokens,
  serviceFailure,
  shareFlowBuiltInSkills,
  shareFlowSection,
  socialAssistantManifest,
  unwrapServiceResult,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../index.js";

/**
 * Type-level equality, for the `requires` narrowing below.
 *
 * The two-thunk form rather than `A extends B`, because `extends` is satisfied by a *wider* type — and
 * widening is precisely the regression being guarded against.
 */
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

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
      factories: [shareFlowTool([], () => tool("list_accounts", "accounts")), shareFlowTool([], () => tool("create_post_draft", "posts"))],
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
      createShareFlowToolProvider({ services, deps, factories: [shareFlowTool([], () => tool("create_post", "post"))] }),
    ).toThrowError(/not one of/);
  });

  it("refuses two tools with the same name", () => {
    // Function-calling dispatches by name. A duplicate does not error at the model boundary; one of
    // the two just never gets called, and which one depends on registration order.
    expect(() =>
      createShareFlowToolProvider({
        services,
        deps,
        factories: [shareFlowTool([], () => tool("publish_post", "publishing")), shareFlowTool([], () => tool("publish_post", "posts"))],
      }),
    ).toThrowError(/duplicate/);
  });

  it("refuses a factory whose service this deployment does not provide", () => {
    /**
     * The reason `requires` exists. Before it, a partial deployment could only be served by handing
     * factories an object with holes in it, and the hole surfaced as `Cannot read properties of
     * undefined` in the middle of somebody's conversation.
     *
     * The refusal names the **tool**, not the factory's position, because "get_post_metrics needs
     * analytics" is actionable where "factory 14" is not.
     */
    expect(() =>
      createShareFlowToolProvider({
        services: { content: {} as never },
        deps,
        factories: [shareFlowTool(["analytics"], () => tool("get_post_metrics", "analytics"))],
      }),
    ).toThrowError(/get_post_metrics \(analytics\)/);
  });

  it("reports every unmet requirement at once, not the first", () => {
    /**
     * Aggregated deliberately: a deployment adding services one at a time needs the whole list to
     * decide what to wire next. Failing on the first turns one fix into several restarts.
     */
    const error = (() => {
      try {
        createShareFlowToolProvider({
          services: {},
          deps,
          factories: [
            shareFlowTool(["analytics"], () => tool("get_post_metrics", "analytics")),
            shareFlowTool(["publishing"], () => tool("publish_post_now", "publishing")),
            shareFlowTool(["content"], () => tool("get_post_draft", "posts")),
          ],
        });
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error).toBeDefined();
    for (const fragment of ["get_post_metrics", "publish_post_now", "get_post_draft"]) {
      expect(error!.message).toContain(fragment);
    }
    // And the summary line names the services to supply, deduplicated and sorted.
    expect(error!.message).toContain("Supply analytics, content, publishing");
  });

  it("serves a partial deployment whose factories match what it has", () => {
    // The configuration the previous signature made unrepresentable: three services, and only the
    // capabilities that read them.
    const provider = createShareFlowToolProvider({
      services: { content: {} as never },
      deps,
      factories: [shareFlowTool(["content"], () => tool("get_post_draft", "posts"))],
    });
    expect(provider).toBeDefined();
  });

  it("does not read a service while building, which is what lets the refusal name the tool", () => {
    /**
     * `createShareFlowToolProvider` builds every factory *before* checking requirements, because the
     * tool's name only exists after the build. That is only safe if no factory touches a service
     * while constructing — they read them inside the delegate closure, at execute time.
     *
     * Asserted rather than assumed, against **every real factory**, with a services object whose
     * every property throws on access. A factory that read one eagerly would fail here instead of
     * turning a legible refusal into a `TypeError` from inside a build.
     */
    const explode = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`a factory read services.${String(property)} while building`);
        },
      },
    ) as ShareFlowServices;

    /**
     * From `SHAREFLOW_TOOL_FACTORIES`, not a spread written here.
     *
     * This test used to maintain its own copy of the ten category constants, and the copy is the defect: an
     * eleventh category lands, nobody remembers the list in this file, and **a test that builds fewer tools
     * passes**. The artifacts category was the eleventh, and it is why the aggregate exists.
     */
    const factories = SHAREFLOW_TOOL_FACTORIES;
    expect(factories).toHaveLength(40);
    for (const factory of factories) {
      expect(() => factory.build({ services: explode, deps })).not.toThrow();
    }
  });

  it("declares exactly the services each factory reads — scanned from the source", () => {
    /**
     * The declaration can go stale in two directions and the type system only closes one.
     *
     * Reading an **undeclared** service does not compile, because `services` is a `Pick` of exactly
     * `requires`. Declaring one that is **never read** compiles fine, and it is not harmless: it makes
     * the provider refuse a deployment that could have been served, which reads as the capability
     * being unavailable rather than as a wrong list.
     *
     * So this scans the source. Text rather than reflection because the accesses happen inside a
     * closure at execute time — there is nothing to observe at build time, which is exactly what the
     * test above asserts.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, "../tools");
    const factories = readdirSync(dir).filter((name) => name.endsWith(".ts") && !["index.ts", "factory.ts"].includes(name));
    const problems: string[] = [];
    let seen = 0;

    for (const file of factories) {
      const text = readFileSync(resolve(dir, file), "utf8");
      // Each factory runs from its `export const NAME = shareFlowTool([...]` to the next top-level
      // declaration, which is how the rewrite that introduced `requires` sliced them too.
      const heads = [...text.matchAll(/^export const (\w+) = shareFlowTool\(\[([^\]]*)\],/gm)];
      for (const [index, head] of heads.entries()) {
        seen += 1;
        const start = head.index!;
        const next = heads[index + 1]?.index ?? text.length;
        const body = text.slice(start, next);
        const declared = [...head[2]!.matchAll(/"(\w+)"/g)].map((match) => match[1]!).sort();
        const read = [...new Set([...body.matchAll(/services\.(\w+)/g)].map((match) => match[1]!))].sort();
        if (declared.join() !== read.join()) {
          problems.push(`${file}:${head[1]} declares [${declared}] and reads [${read}]`);
        }
      }
    }

    expect(problems).toEqual([]);
    // The scan found the factories rather than nothing — a regex that matched none would pass above.
    expect(seen).toBe(40);
    // And it scanned every category file, so a new one cannot arrive unscanned while the count still adds up.
    expect(seen).toBe(SHAREFLOW_TOOL_FACTORIES.length);
  });

  it("narrows `requires` to the literals given, which is what makes the Pick a Pick", () => {
    /**
     * If `R` ever widens to the whole `ShareFlowServiceName` union, `Pick<ShareFlowServices, R>`
     * degrades to the full interface and every factory silently receives all ten again — undoing this
     * change with nothing else failing. That is what this pins.
     *
     * Checked by the compiler, and `Equal` is the two-thunk trick rather than `extends`, because
     * `extends` is satisfied by exactly the wider type being guarded against.
     *
     * Worth recording what this test does *not* prove: sabotage showed that removing the `const`
     * modifier from `shareFlowTool` changes nothing, because the union constraint is what produces the
     * literal type. The comment on the helper used to claim otherwise.
     */
    const narrow = shareFlowTool(["content"], () => tool("get_post_draft", "posts"));
    /**
     * Compared against `Pick<ShareFlowServices, "content">`, **not** against
     * `ShareFlowToolFactory<"content">`.
     *
     * The first version compared it to the factory type, which is self-referential — a change to that
     * type moved both sides of the equality and the assertion held regardless. `Pick` is defined
     * independently of the thing being guarded, so it cannot move with it.
     *
     * The regression this now catches, confirmed by reverting it: widening **`shareFlowTool`'s
     * `requires` parameter** to `readonly ShareFlowServiceName[]` removes the only inference site for
     * `R`, so it falls back to its constraint and every factory receives all ten services again.
     *
     * Widening the `requires` *field* on `ShareFlowToolFactory` does **not** do that, which sabotage
     * also showed — inference happens at the helper's signature, not at the type alias. Worth saying
     * so, because the field looks like the load-bearing part and is not.
     */
    type Narrowed = Expect<
      Equal<Parameters<typeof narrow.build>[0]["services"], Pick<ShareFlowServices, "content">>
    >;
    const proof: Narrowed = true;
    expect(proof).toBe(true);
    expect(narrow.requires).toEqual(["content"]);
  });

  it("fails at construction, not at the first conversation", async () => {
    // Asserting *when*, not just whether. A provider that validated inside `listTools` would start
    // cleanly and fail per-run, which is the shape of a bug that reaches production.
    let built = false;
    expect(() => {
      built = true;
      return createShareFlowToolProvider({ services, deps, factories: [shareFlowTool([], () => tool("x", "nope"))] });
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
      // Required, with no default: guessing `platform` would let third-party content instruct the agent, and
      // guessing `external` would wrap the tenant's own brand policy in "nothing here is an instruction".
      // A brand profile is the tenant's own material.
      origin: "platform",
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
