/**
 * One composition of the ShareFlow application, for its two consumers — retinue REQ-041 (#190).
 *
 * The API host calls `deps` and the worker calls `engine`. Both need the manifest, the services and the
 * tool registry, and building them twice is how a deployment ends up with two assistants:
 *
 * **This is not hypothetical.** Wiring the engine found `deps` composing its own manifest with a
 * three-sentence prompt while `instructions.ts` held the transcribed one, and limits that disagreed
 * with the engine's on five of nine fields. Whichever the model actually got would have depended on
 * which process was serving — the GraphQL surface's catalogue describing one agent and the worker
 * executing another, with nothing to see but odd behaviour.
 *
 * So the manifest is defined once here, and both paths take it.
 */

import { createToolRegistry, createToolSearch } from "@retinue/agentkit/tools";
import { createSkillBodyLoader, createSkillResolver } from "@retinue/agentkit/context";
import { createPostgresSkillStore } from "@retinue/agentkit/adapters/postgres";
import type { ApprovalCheck, AuthorizationPolicy, ToolRegistry } from "@retinue/agentkit";
import type { SkillResolver } from "@retinue/agentkit/context";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { SHAREFLOW_BUILT_IN_SKILLS } from "../skills/index.js";

import { createShareFlowApp } from "./index.js";
import { socialAssistantInstructions } from "./instructions.js";

/**
 * The manifest version a run records.
 *
 * **Bumped by hand whenever the manifest or the prompt changes**, because a run stores the version it
 * executed and history is replayed against it. Leaving it while the prompt changes makes two different
 * assistants share one version number, and a parity comparison across that change would be comparing
 * runs it believes are identical.
 */
export const SOCIAL_ASSISTANT_VERSION = 1;

/**
 * What one turn may cost.
 *
 * Transcribed from the old runtime rather than chosen, because a cutover that quietly changed a ceiling
 * would change the behaviour the parity comparison is meant to hold still. `ai_backend`'s generalist
 * ran at `tool_call_limit=18` because *"a grounded post is search → read one or two pages → generate →
 * create → publish, and fixing an incompatible file adds check → convert → check_conversion (twice,
 * since video is queued) → replace"*.
 *
 * `costCeilingMinorUnits: 200` is the old runtime's too. Note it only binds where pricing is known —
 * see `PRICING` in `model.ts`, and the warning an unpriced model emits at boot.
 */
export const SOCIAL_ASSISTANT_LIMITS = {
  maxToolCalls: 18,
  maxSteps: 24,
  wallClockTimeoutMs: 180_000,
  maxInputTokens: 120_000,
  maxOutputTokens: 8_000,
  costCeilingMinorUnits: 200,
} as const;

export type ComposeInput = {
  readonly sql: SqlExecutor;
  readonly runner: TransactionRunner;
  readonly authorization: AuthorizationPolicy;
  /**
   * The approval gate, **for the registry** — not the same wiring as `deps.approvals`.
   *
   * `ToolRegistryConfig.approval` is what "makes approval unbypassable: a policy-classified tool cannot
   * execute directly without a grant." Absent, the registry refuses every tool whose `approvalPolicy`
   * is `always` with a message that says so out loud:
   *
   *   Tool publish_post_now has approvalPolicy "always" and no approval check is configured
   *   (ToolRegistryConfig.approval), so it can never run. This is a wiring error, not a refusal.
   *
   * That is what a user got when they asked the assistant to publish a post — the single most important
   * action the product has — while a gate *was* constructed a few lines away and handed to the tool
   * deps, where the registry never looks. Optional here only because the host composes without one for
   * the read-only surface; the worker always supplies it.
   */
  readonly approval?: ApprovalCheck;
  readonly services: Parameters<typeof createShareFlowApp>[0]["services"];
  readonly deps: Parameters<typeof createShareFlowApp>[0]["deps"];
  readonly factories: Parameters<typeof createShareFlowApp>[0]["factories"];
};

/** The manifest both paths use. Its prompt is assembled in `instructions.ts`. */
export const shareFlowManifest = () =>
  ({
    version: SOCIAL_ASSISTANT_VERSION,
    instructions: socialAssistantInstructions(),
    /**
     * A **role**, which is what a `ModelPolicy` is.
     *
     * This was `{ modelId: process.env["RETINUE_MODEL_ID"] ?? "gpt-4o" }` behind an `as unknown as`
     * cast, and the cast hid two things: `ModelPolicy` has no `modelId` field at all, and its one
     * required field — `role` — was missing. The platform is explicit about why: *"Agents never name a
     * model, so re-pointing a role here changes no agent code."*
     *
     * It is inert today, because this app always passes its own `resolveModel` (see
     * `resolveModelForTurn`, which is where the concrete model and its pricing are named) and the
     * platform only falls back to `registry.resolve(manifest.modelPolicy)` when nothing supplies one.
     * Inert is not harmless: the day a path forgets `resolveModel`, that fallback would resolve a policy
     * with no role.
     *
     * `smart` rather than `fast`: every turn writes copy a person will publish.
     */
    modelPolicy: { role: "smart" },
    authorizationPolicyId: "shareflow-workspace-member",
    limits: SOCIAL_ASSISTANT_LIMITS as unknown as Parameters<typeof createShareFlowApp>[0]["manifest"]["limits"],
  }) satisfies Parameters<typeof createShareFlowApp>[0]["manifest"];

/**
 * Compose the app and its registry.
 *
 * **One registry**, because two would be two answers to "which tools does this principal have": the
 * catalogue a client renders and the tools the model is handed. They diverge on the first change to
 * either, and the symptom is a tool the UI offers and the assistant says it does not have.
 */
export const composeShareFlowApp = (
  input: ComposeInput,
): {
  readonly app: ReturnType<typeof createShareFlowApp>;
  readonly registry: ToolRegistry;
  readonly skills: SkillResolver;
} => {
  const app = createShareFlowApp({
    manifest: shareFlowManifest(),
    services: input.services,
    deps: input.deps,
    authorization: input.authorization,
    factories: input.factories,
  });

  /**
   * Skills, wired — which they were not, and the omission was total.
   *
   * `createToolRegistry` advertises `load_skill` **only** when `skills` is present: "Wiring is the
   * toggle. `load_skill` has been in `META_TOOLS` since the registry was written with nothing
   * implementing it." So with this absent the meta-tool was silently dropped from every catalogue — a
   * recorded Gemini request from the real worker declared `learn_tools`, `find_tools` and
   * `execute_tool` and no fourth — while the system prompt said *"ALWAYS load the `mermaid-diagrams`
   * skill before turning a diagram into a file"* and six of the seven active skills named tools of
   * their own. Seven skills, 20,000 characters of reviewed instructions, reachable by nothing.
   *
   * `engine.ts` imported `SHAREFLOW_BUILT_IN_SKILLS` and never used the import, which is as close to a
   * written confession as a module graph gets.
   *
   * The policy comes from `app.manifest`, not from a second literal here: `createSkillBodyLoader`
   * re-derives the catalogue before loading, so `assigned` gates loading as well as listing, and a
   * policy that filtered one and not the other would be no policy at all.
   */
  const skills = createSkillResolver({
    builtIn: SHAREFLOW_BUILT_IN_SKILLS,
    store: createPostgresSkillStore(input.sql),
  });
  const skillPolicy = {
    assigned: app.manifest.skillPolicy?.assigned ?? [],
    allowTenantSkills: app.manifest.skillPolicy?.allowTenantSkills ?? false,
  };

  const registry = createToolRegistry({
    providers: app.providers,
    authorization: input.authorization,
    search: createToolSearch(),
    skills: createSkillBodyLoader({ resolver: skills, policy: skillPolicy }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    /**
     * Where "this tool can never run" is reported, so the *first* such call is visible rather than the
     * hundredth. The refusal happens either way; this is the difference between noticing a wiring bug
     * and reading the same refusal in a hundred transcripts.
     */
    onMisconfiguration: (report) => {
      console.error(`[shareflow] tool misconfiguration (${report.kind}): ${JSON.stringify(report)}`);
    },
  });

  return { app, registry, skills };
};
