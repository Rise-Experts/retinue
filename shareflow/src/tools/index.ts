/**
 * Where ShareFlow's tools live, and the provider that serves them (AC-5).
 *
 * This is composition only — no capability is defined here. #115–#120 and #123–#125 register
 * factories; the pieces that must be identical across all of them live here so they are decided once:
 * the category vocabulary, the services a factory receives, and the checks that run before a provider
 * can exist.
 *
 * Nothing in this directory performs I/O — R7 in `scripts/check-boundaries.mjs` fails the build if it
 * tries. A ShareFlow tool is the envelope from #113 over a service method; the service does the work.
 */
import type { DelegatingToolDeps, ExecutionContext, ToolProvider } from "@retinue/agentkit";
import { AgentPlatformError } from "@retinue/agentkit";
import type { ShareFlowServices } from "../services/index.js";
import type { ShareFlowServiceName, ShareFlowToolFactory } from "./factory.js";
import { ACCOUNT_TOOL_FACTORIES, ACCOUNT_TOOL_NAMES } from "./accounts.js";
import { ARTIFACT_TOOL_FACTORIES, ARTIFACT_TOOL_NAMES } from "./artifacts.js";
import { ANALYTICS_TOOL_FACTORIES, ANALYTICS_TOOL_NAMES } from "./analytics.js";
import { CAMPAIGN_TOOL_FACTORIES, CAMPAIGN_TOOL_NAMES } from "./campaigns.js";
import { ENGAGEMENT_TOOL_FACTORIES, ENGAGEMENT_TOOL_NAMES } from "./engagement.js";
import { GENERATE_TOOL_FACTORIES, GENERATE_TOOL_NAMES } from "./generate.js";
import { LEAD_TOOL_FACTORIES, LEAD_TOOL_NAMES } from "./leads.js";
import { MEDIA_TOOL_FACTORIES, MEDIA_TOOL_NAMES } from "./media.js";
import { POSTS_TOOL_FACTORIES, POSTS_TOOL_NAMES } from "./posts.js";
import { PUBLISHING_TOOL_FACTORIES, PUBLISHING_TOOL_NAMES } from "./publishing.js";
import { RESEARCH_TOOL_FACTORIES, RESEARCH_TOOL_NAMES } from "./research.js";

/**
 * The closed category vocabulary, from docs/07's tool-provider table.
 *
 * Closed on purpose. `ToolDescriptor.category` is a bare `string`, and an agent manifest selects tools
 * *by* category — so a typo in either place produces an agent that silently has fewer tools than
 * intended, which looks like a model failure rather than a configuration one. A closed set turns both
 * halves of that mistake into a build error.
 */
export const SHAREFLOW_TOOL_CATEGORIES = [
  "posts",
  "artifacts",
  "accounts",
  "publishing",
  "campaigns",
  "media",
  "analytics",
  "engagement",
  "leads",
  "research",
] as const;

export type ShareFlowToolCategory = (typeof SHAREFLOW_TOOL_CATEGORIES)[number];

const CATEGORIES: ReadonlySet<string> = new Set(SHAREFLOW_TOOL_CATEGORIES);

export const isShareFlowToolCategory = (value: string): value is ShareFlowToolCategory =>
  CATEGORIES.has(value);

const invalid = (message: string) =>
  new AgentPlatformError({ code: "invalid_input", message, retryable: false });

/**
 * Build the ShareFlow tool provider.
 *
 * Validation happens **here, at construction**, not in `listTools`. A duplicate name or an unknown
 * category is a wiring mistake, and a wiring mistake should stop the process starting rather than
 * surface as a confusing catalog on someone's first conversation.
 */
export const createShareFlowToolProvider = (input: {
  readonly id?: string;
  /**
   * What this deployment has. **Partial**, because a rollout does not necessarily have all ten.
   *
   * A missing service is not an error here — it is an error only if a registered factory needs it,
   * which is the check below. A deployment serving analytics and nothing else is a legitimate
   * configuration, and the previous signature made it unrepresentable.
   */
  readonly services: Partial<ShareFlowServices>;
  readonly deps: DelegatingToolDeps;
  readonly factories: readonly ShareFlowToolFactory[];
}): ToolProvider => {
  /**
   * Build first, then check — and the order is deliberate rather than convenient.
   *
   * A factory reads its services inside the delegate closure, at execute time, so building one whose
   * service is absent is safe and yields the tool's *name*. That name is what makes the refusal
   * legible: "get_post_metrics needs analytics" is actionable where "factory 14 needs analytics" is
   * not.
   *
   * The assumption — that no factory touches a service while building — is not left to trust: a test
   * builds all 40 against a services object whose every property throws on access.
   */
  const built = input.factories.map((factory) => ({
    factory,
    tool: factory.build({ services: input.services as ShareFlowServices, deps: input.deps }),
  }));

  /**
   * Every unmet requirement, reported together.
   *
   * Aggregated rather than thrown on the first one, because a deployment adding a service at a time
   * needs the whole list to decide what to wire next — failing one at a time turns one fix into
   * several restarts.
   */
  const unmet = built
    .map(({ factory, tool }) => ({
      name: tool.descriptor.name,
      missing: factory.requires.filter((service: ShareFlowServiceName) => input.services[service] === undefined),
    }))
    .filter((entry) => entry.missing.length > 0);

  if (unmet.length > 0) {
    const services = [...new Set(unmet.flatMap((entry) => entry.missing))].sort();
    throw invalid(
      `these ShareFlow tools need services this deployment does not provide: ` +
        `${unmet.map((entry) => `${entry.name} (${entry.missing.join(", ")})`).join("; ")}. ` +
        `Supply ${services.join(", ")}, or leave those factories out of the list — a rollout serves ` +
        `the workflows whose services exist, and a tool that is registered without one would fail in ` +
        `the middle of a conversation instead of here.`,
    );
  }

  const tools = built.map((entry) => entry.tool);

  const seen = new Set<string>();
  for (const tool of tools) {
    const { name, category } = tool.descriptor;
    if (seen.has(name)) throw invalid(`duplicate ShareFlow tool name: ${name}`);
    seen.add(name);
    if (!isShareFlowToolCategory(category)) {
      throw invalid(
        `ShareFlow tool ${name} has category "${category}", which is not one of: ${SHAREFLOW_TOOL_CATEGORIES.join(", ")}`,
      );
    }
  }

  return {
    id: input.id ?? "shareflow",
    async listTools(_context: ExecutionContext) {
      // Unfiltered. Permission filtering belongs to the registry's `AuthorizationPolicy`, which
      // applies to every provider — a provider that filtered on its own would be a second, divergent
      // permission model, and the registry re-authorises at execution anyway.
      return tools;
    },
  };
};

export * from "./factory.js";
export * from "./posts.js";
export * from "./campaigns.js";
export * from "./accounts.js";
export * from "./media.js";
export * from "./publishing.js";
export * from "./engagement.js";
export * from "./leads.js";
export * from "./duplication.js";
export * from "./generate.js";
export * from "./research.js";
export * from "./analytics.js";


/**
 * Every ShareFlow tool factory, in one list — REQ-041 AC-1 (#190).
 *
 * Added because two callers were maintaining their own copy of it by hand: `layout.test.ts` spread the ten
 * category constants, and the inventory needed the same set to check that a `replacement` names a tool that
 * exists. Two hand-written copies of a list of ten is a list that will be nine somewhere the day an eleventh
 * category is added — and the failure is silent in the worst direction, because a test that builds fewer tools
 * passes.
 *
 * Declared here rather than in a category file because this module is the composition point, and the same
 * reason keeps it free of cycles: the category files import from `./factory.js`, never from here.
 */
export const SHAREFLOW_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  ...ACCOUNT_TOOL_FACTORIES,
  ...ANALYTICS_TOOL_FACTORIES,
  ...ARTIFACT_TOOL_FACTORIES,
  ...CAMPAIGN_TOOL_FACTORIES,
  ...ENGAGEMENT_TOOL_FACTORIES,
  ...GENERATE_TOOL_FACTORIES,
  ...LEAD_TOOL_FACTORIES,
  ...MEDIA_TOOL_FACTORIES,
  ...POSTS_TOOL_FACTORIES,
  ...PUBLISHING_TOOL_FACTORIES,
  ...RESEARCH_TOOL_FACTORIES,
];

/**
 * Every tool name the new runtime serves.
 *
 * From the per-category constants each of which is already pinned by its own test, rather than from building
 * the factories — a name list should not need a `DelegatingToolDeps` to exist.
 */
export const SHAREFLOW_TOOL_NAMES: readonly string[] = [
  ...ACCOUNT_TOOL_NAMES,
  ...ANALYTICS_TOOL_NAMES,
  ...ARTIFACT_TOOL_NAMES,
  ...CAMPAIGN_TOOL_NAMES,
  ...ENGAGEMENT_TOOL_NAMES,
  ...GENERATE_TOOL_NAMES,
  ...LEAD_TOOL_NAMES,
  ...MEDIA_TOOL_NAMES,
  ...POSTS_TOOL_NAMES,
  ...PUBLISHING_TOOL_NAMES,
  ...RESEARCH_TOOL_NAMES,
];
export * from "./artifacts.js";
