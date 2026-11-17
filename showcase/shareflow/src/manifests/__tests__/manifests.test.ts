/**
 * Every gated tool must be preloaded, because a gated tool reached through `execute_tool` can never
 * be approved.
 *
 * ## The defect this exists to prevent
 *
 * The platform's approval wrapper resolves a call's descriptor before deciding anything:
 *
 * ```js
 * const [descriptor] = await deps.tools.learn(ctx, [call.name]);
 * if (!descriptor) return { outcome: "result", result: await deps.tools.execute(ctx, call) };
 * ```
 *
 * (`@retinue/agentkit/dist/hitl/approved-execution.js`.) `execute_tool` is a meta-tool and is not in
 * `learn`'s corpus, so every call the model routes through it takes that early return and skips the
 * approval machinery entirely. The registry's own `approval` check still fires — it is unbypassable,
 * by design — but its `approval_required` comes back as an ordinary tool result, and the engine turns
 * an unexpected result into a thrown error. The user gets a failed run reading "Tool delete_post
 * requires approval" with no card to approve and nothing pending. The approval is not merely
 * awkward to reach; it is unreachable.
 *
 * So the two halves have to agree: `effect` derives `approvalPolicy`, and `approvalPolicy: "always"`
 * requires the direct declaration path. Nothing in the type system says so, and no behavioural test
 * would notice — the gate works, the tool works, and only the *composition* of "gated" and
 * "discovery-only" is broken.
 *
 * ## Why it is a rule and not three names
 *
 * `repost_post`, `delete_post` and `check_media_storage` were moved behind discovery by narrowing
 * `toolPolicy.categories` to `[]`. That narrowing was correct — passing every category preloaded all
 * 58 tools and cost most of a context window — but it silently changed those three from "asks for
 * approval" to "cannot be approved". The other four gated tools kept the direct path only because
 * the prompt or a skill happened to name them.
 *
 * Written as an invariant over the built descriptors, a fifth gated tool added later fails here
 * rather than shipping an action nobody can authorize. `approvalPolicy` is read off the descriptor
 * `defineTool` derives from `effect` — never from a hand-kept list beside it, which is the artefact
 * that would go on saying yes after someone relabelled an effect.
 */
import { describe, expect, it } from "vitest";

import { SHAREFLOW_TOOL_FACTORIES } from "../../tools/index.js";
import { SOCIAL_ASSISTANT_PRELOADED_TOOLS, socialAssistantManifest } from "../index.js";
import type { ShareFlowServices } from "../../services/index.js";

/** Built descriptors, the way `layout.test.ts` and `inventory/manifest.test.ts` build them. */
const descriptors = (() => {
  const deps = { authorization: { async can() { return { allow: true }; } } } as never;
  const explode = new Proxy(
    {},
    { get(_target, property) { throw new Error(`read services.${String(property)} while building`); } },
  ) as ShareFlowServices;
  return SHAREFLOW_TOOL_FACTORIES.map((factory) => factory.build({ services: explode, deps }).descriptor);
})();

describe("preloaded tools", () => {
  it("includes every tool whose effect derives an approval", () => {
    /**
     * The invariant. `approvalPolicy` is not written anywhere by hand — `defineTool` derives it from
     * `effect`, so relabelling a tool `destructive` moves it into this set automatically and the test
     * demands the declaration to match.
     */
    const gated = descriptors
      .filter((descriptor) => descriptor.approvalPolicy === "always" || descriptor.approvalPolicy === "policy")
      .map((descriptor) => descriptor.name);

    expect(gated.length).toBeGreaterThan(0); // A filter that matches nothing would pass vacuously.

    const preloaded = new Set<string>(SOCIAL_ASSISTANT_PRELOADED_TOOLS);
    const unapprovable = gated.filter((name) => !preloaded.has(name)).sort();

    expect(unapprovable).toEqual([]);
  });

  it("names only tools that exist", () => {
    // The other direction: a typo here is a declaration for a function the registry cannot build.
    const names = new Set(descriptors.map((descriptor) => descriptor.name));
    expect([...SOCIAL_ASSISTANT_PRELOADED_TOOLS].filter((name) => !names.has(name))).toEqual([]);
  });

  it("stays far short of the whole catalogue, which is what the lazy tier is for", () => {
    /**
     * Not a style preference. Preloading everything is the empty-answer bug: 58 declarations put
     * Gemini over a limit it reports by returning a candidate with no `parts` at all, and the run
     * completes with no text and no error. This is the boundary that regression has to cross to come
     * back, so it is written down as a number.
     */
    expect(SOCIAL_ASSISTANT_PRELOADED_TOOLS.length).toBeLessThan(descriptors.length / 2);
  });

  it("is what the manifest actually declares, not a list beside it", () => {
    // Otherwise this whole file tests a constant nothing reads.
    expect(socialAssistantManifest({
      version: 1,
      instructions: "x",
      modelPolicy: { primary: { provider: "google", model: "m" } },
      authorizationPolicyId: "p",
      limits: { maxSteps: 8, maxDurationMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    } as never).toolPolicy?.preloaded).toEqual([...SOCIAL_ASSISTANT_PRELOADED_TOOLS]);
  });
});
