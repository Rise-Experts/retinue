/**
 * Where ShareFlow's agent manifests live (AC-5).
 *
 * docs/07: *"Initial user-facing experience exposes one primary Social Assistant."* docs/01 puts the
 * product's branding in the display name and keeps the id neutral and stable — so the id is
 * `social-assistant` and the name is `Social Assistant`.
 *
 * **Instructions are a required argument, not a default.** A manifest builder that supplied
 * placeholder prose would eventually ship it: a manifest is stored, versioned and executed, and
 * "TODO: write the system prompt" reads exactly like a working assistant until someone uses it. The
 * policy fields — which tool categories, which context providers, which skills — are filled in here,
 * because those are #114's decisions and getting them consistent is the point of the closed sets they
 * come from.
 */
import type { AgentManifest, ExecutionLimits, ModelPolicy, ResponseFormat } from "@retinue/agentkit";
import { AgentPlatformError } from "@retinue/agentkit";
import { SHAREFLOW_CONTEXT_PROVIDER_IDS } from "../context/index.js";
import { SHAREFLOW_TOOL_CATEGORIES, type ShareFlowToolCategory } from "../tools/index.js";

/** Neutral and stable, per docs/01's naming rules. Referenced by runs; never renamed. */
export const SOCIAL_ASSISTANT_ID = "social-assistant";

/**
 * Preloaded tools: the smallest set that lets the assistant start work without a discovery round trip.
 *
 * Everything else is found through `learn_tools`. Kept short on purpose — every preloaded tool's schema
 * sits in context for the whole run, which is the cost the lazy catalog exists to avoid. These are the
 * two tool *names* #115 and #117 must define; nothing can check that from here, so it is stated as a
 * requirement on those SPECs rather than pretended to be enforced.
 */
export const SOCIAL_ASSISTANT_PRELOADED_TOOLS = ["list_accounts", "list_post_drafts"] as const;

export type SocialAssistantInput = {
  /** Bumped on every change to any field. A run records the version it executed. */
  readonly version: number;
  /** The system prompt. Required — see the note above. */
  readonly instructions: string;
  readonly modelPolicy: ModelPolicy;
  readonly authorizationPolicyId: string;
  readonly limits: ExecutionLimits;
  /** Defaults to text. A structured format is a deliberate choice, not a default. */
  readonly responseFormat?: ResponseFormat;
  /**
   * Narrow the tool surface. Defaults to every ShareFlow category.
   *
   * Present because docs/07's Workflow 5 and 6 are read-only and analytical: an analytics-only
   * deployment should not carry the publishing tools, and the way to express that is here rather than
   * by adding a second hard-coded manifest.
   */
  readonly categories?: readonly ShareFlowToolCategory[];
  /** Whether tenant-authored skills may layer over the built-in set. Defaults to allowed. */
  readonly allowTenantSkills?: boolean;
};

/** Build the Social Assistant manifest. */
export const socialAssistantManifest = (input: SocialAssistantInput): AgentManifest => {
  if (input.instructions.trim() === "")
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "the Social Assistant manifest requires instructions",
      retryable: false,
    });
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "agent manifest version must be a positive integer",
      retryable: false,
    });

  return {
    id: SOCIAL_ASSISTANT_ID,
    version: input.version,
    name: "Social Assistant",
    description:
      "Plans, drafts, validates and publishes social content across connected destinations, and explains measured performance.",
    instructions: input.instructions,
    modelPolicy: input.modelPolicy,
    responseFormat: input.responseFormat ?? { kind: "text" },
    toolPolicy: {
      preloaded: [...SOCIAL_ASSISTANT_PRELOADED_TOOLS],
      categories: [...(input.categories ?? SHAREFLOW_TOOL_CATEGORIES)],
      excluded: [],
    },
    skillPolicy: {
      assigned: [],
      allowTenantSkills: input.allowTenantSkills ?? true,
    },
    authorizationPolicyId: input.authorizationPolicyId,
    contextProviderIds: [...SHAREFLOW_CONTEXT_PROVIDER_IDS],
    limits: input.limits,
  };
};
