import { describe, expect, it, vi } from "vitest";

import { withJsonClause, jsonFromReply } from "../deployment.js";

/**
 * Structured generation against an OpenAI-compatible endpoint — #469.
 *
 * Reported as "compose failed to create a post with AI", and the endpoint's own words were the whole
 * diagnosis:
 *
 *     'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.
 *
 * Where a provider supports structured output natively — Google, Anthropic, OpenAI's `json_schema` —
 * the schema rides on the request and this never arises. An OpenAI-compatible endpoint has no such
 * mode, so the AI SDK falls back to `response_format: { type: "json_object" }`, which that API refuses
 * unless the word appears in the messages.
 *
 * **Not one of the fourteen generator prompts contained it** — `grep -c json` over `generator.ts`
 * returned 0 — so every structured generation for a workspace on a self-hosted provider failed. Which
 * is every generation those workspaces do: captions, alternatives, campaigns, repurposing, scripts,
 * hashtags, vision.
 *
 * Reproduced against production before the fix: `generate_content` returned 422 carrying that sentence.
 */

describe("the JSON clause", () => {
  it("describes the schema, which is what the compatible adapter dropped", async () => {
    /**
     * The defect the second failure exposed. `json_object` mode carries no schema, so unless the
     * prompt contains one the model invents a shape — measured as
     * `No object generated: response did not match schema.`
     */
    const { zodSchema } = await import("ai");
    const { z } = await import("zod");
    const schema = z.object({ versions: z.array(z.object({ platformId: z.string(), caption: z.string() })) });
    const out = withJsonClause("You write captions.", schema, zodSchema as never);

    expect(out.startsWith("You write captions.")).toBe(true);
    expect(/json/i.test(out), "the endpoint would refuse this request").toBe(true);
    // The actual field names have to be in there — that is the whole point.
    expect(out).toMatch(/platformId/);
    expect(out).toMatch(/caption/);
    expect(out).toMatch(/versions/);
  });

  it("falls back to the bare instruction when there is no schema to show", async () => {
    // Unguided beats refused: `json_object` rejects a request whose messages never say "json".
    const out = withJsonClause("You propose distinct strategic angles for a social post.");
    expect(/json/i.test(out)).toBe(true);
  });

  it("leaves a prompt that already says JSON alone, when there is no schema", async () => {
    const system = "Answer as JSON with a `captions` array.";
    expect(withJsonClause(system)).toBe(system);
  });

  it("omits a schema it cannot convert rather than failing the generation", async () => {
    /**
     * A caller may hand over something that is not a zod schema. Losing the description is a worse
     * answer; throwing would be a broken one.
     */
    const out = withJsonClause("You write captions.", {}, (() => {
      throw new Error("not a zod schema");
    }) as never);
    expect(/json/i.test(out)).toBe(true);
    expect(out.startsWith("You write captions.")).toBe(true);
  });

  it("reaches the model — the clause is on the request, not merely computed", async () => {
    /**
     * The seam, and the reason this is not a pure-function test alone. A helper that produced a
     * perfect string and was never passed to `generateObject` would leave every self-hosted workspace
     * exactly as broken, and would look correct in every unit test — the shape of defect this codebase
     * keeps finding.
     *
     * So the `ai` module is mocked and the assertion is on the `system` that `generateObject`
     * actually received.
     */
    let seen: { system?: string } | undefined;
    vi.resetModules();
    vi.doMock("ai", async () => {
      const real = await vi.importActual<Record<string, unknown>>("ai");
      return {
        ...real,
        generateObject: async (options: { system?: string }) => {
          seen = options;
          return { object: { ok: true } };
        },
      };
    });
    vi.doMock("@retinue/agentkit/providers", () => ({
      createProviderFactory: () => ({ languageModel: () => ({}) }),
    }));

    const { structuredGenerateFrom: fresh } = await import("../deployment.js");
    const { z } = await import("zod");
    const generate = await fresh({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "openai" });
    await generate({
      context: { tenantId: "w", principalId: "u" } as never,
      /**
       * A system prompt that shares **no word** with the schema, deliberately.
       *
       * This test first used "You write captions." with a `caption` field, and the assertion passed
       * against the prompt itself rather than the injected schema — so it stayed green with the schema
       * argument removed. A test that cannot fail for the reason it names is worse than no test.
       */
      system: "Write something short.",
      prompt: "a post about coffee",
      schema: z.object({ zzTopLevelMarker: z.string() }) as never,
    });

    expect(seen?.system, "generateObject was called without the clause").toMatch(/json/i);
    expect(seen?.system?.startsWith("Write something short.")).toBe(true);
    // The schema reaches the model, not merely the word "json".
    expect(seen?.system, "the schema never reached the prompt").toMatch(/zzTopLevelMarker/);

    vi.doUnmock("ai");
    vi.doUnmock("@retinue/agentkit/providers");
    vi.resetModules();
  });

  it("covers every generator prompt, because none of them says JSON on its own", async () => {
    /**
     * A ratchet on the source rather than a restatement of it. If somebody adds a fifteenth prompt,
     * it inherits the clause automatically — this asserts the reason that matters: the generator is
     * not where the word lives, so no prompt can forget it.
     */
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../adapters/model/generator.ts", import.meta.url), "utf8");
    const mentions = source.match(/json/gi) ?? [];
    expect(
      mentions.length,
      "a generator prompt now mentions JSON — harmless, but the clause is what guarantees it for the rest",
    ).toBe(0);
  });
});

describe("jsonFromReply — the repair for a reply that is not only JSON", () => {
  // qwen3.5-omni-flash on production: "No object generated: could not parse the response."
  it("takes the object out of a ```json fence", () => {
    expect(jsonFromReply('Here you go:\n```json\n{"caption":"Hi"}\n```')).toBe('{"caption":"Hi"}');
  });

  it("takes the outermost braces out of prose", () => {
    expect(jsonFromReply('Sure! {"caption":"Hi","tags":{"a":1}} Hope that helps.')).toBe('{"caption":"Hi","tags":{"a":1}}');
  });

  it("returns null rather than inventing an object", () => {
    expect(jsonFromReply("I cannot help with that.")).toBeNull();
    expect(jsonFromReply("{ not json }")).toBeNull();
  });
});
