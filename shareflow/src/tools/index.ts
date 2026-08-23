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
import type { DelegatingToolDeps, ExecutionContext, Tool, ToolProvider } from "@agentkit/backend";
import { AgentPlatformError } from "@agentkit/backend";
import type { ShareFlowServices } from "../services/index.js";

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

/**
 * Everything a capability is built from.
 *
 * `deps` was missing from the first version of this type (#114), and writing the first capability
 * (#115) is what surfaced it: every ShareFlow tool is a `defineDelegatingTool`, and that needs the
 * authorization policy, the approval gate and the idempotency store. A factory that received only the
 * services could not build one — so each capability would have closed over its own copy of the deps,
 * which is precisely the "applied in one place, in one order" property the envelope exists to have.
 */
export type ShareFlowToolContext = {
  readonly services: ShareFlowServices;
  readonly deps: DelegatingToolDeps;
};

/**
 * How a capability is registered: a function from the services and deps to a tool.
 *
 * A factory rather than a constructed tool, so a capability is written against the seam and the
 * concrete services are supplied once at wiring time. It is also what keeps a capability testable —
 * pass a stub service, get a tool.
 */
export type ShareFlowToolFactory = (context: ShareFlowToolContext) => Tool;

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
  readonly services: ShareFlowServices;
  readonly deps: DelegatingToolDeps;
  readonly factories: readonly ShareFlowToolFactory[];
}): ToolProvider => {
  const context: ShareFlowToolContext = { services: input.services, deps: input.deps };
  const tools = input.factories.map((factory) => factory(context));

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

