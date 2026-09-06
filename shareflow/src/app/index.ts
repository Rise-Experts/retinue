/**
 * The ShareFlow agentkit application — Rise-Experts/retinue#128.
 *
 * `packages/shareflow` has always been an **app module**: manifests, tools, context providers and skills, with
 * nothing that runs. The client built in `social_share@ea8a6bb2` needs something to talk to, and this is it.
 *
 * ## Why the platform's GraphQL host is not that thing
 *
 * `retinue serve` exposes `sendMessage(conversationId, runId)`, which takes **no message content** and **does
 * not create the run row** — it coordinates the conversation's slot and enqueues a job. A remote caller gets
 * `started` back and nothing executes, because the worker claims a job whose run does not exist. The reference
 * app records having made exactly that mistake.
 *
 * So an application is required, not optional: it owns the store, so it can write the message and the run.
 * This is the ShareFlow equivalent of `examples/src/index.ts`.
 *
 * ## What this deliberately does not include
 *
 * `ShareFlowServices` is a **parameter**, not something built here. Its ten services are the domain — post
 * drafts, campaigns, publishing, engagement, leads, brand, generation, research, analytics — and implementing
 * them over the ShareFlow database is REQ-041's parity work, not this shell's.
 *
 * Separating them is what lets the two proceed independently: shadow capture can start on the first workflow
 * whose services exist, rather than waiting for all ten. A shell that also implemented the services would have
 * made this issue depend on that one.
 */

import type {
  AgentManifest,
  AuthorizationPolicy,
  ExecutionContext,
  ToolProvider,
} from "@retinue/agentkit";
import type { DelegatingToolDeps } from "@retinue/agentkit/tools";

import { createShareFlowToolProvider, type ShareFlowToolFactory } from "../tools/index.js";
import { SHAREFLOW_ASSIGNED_SKILLS } from "../skills/index.js";
import { SOCIAL_ASSISTANT_ID, socialAssistantManifest, type SocialAssistantInput } from "../manifests/index.js";
import type { ShareFlowServices } from "../services/index.js";

/**
 * The identifier the application answers with, and the reason it exists.
 *
 * The client checks for this header on every response. A bare `retinue serve` does not set it, which is how
 * pointing `ASSISTANT_AGENTKIT_URL` at one is caught at the first call — rather than as turns that admit and
 * never answer, which reads as a slow assistant rather than a misconfiguration.
 */
export const APPLICATION_HEADER = "x-retinue-application";
export const APPLICATION_NAME = "shareflow";

export type ShareFlowAppConfig = {
  readonly services: ShareFlowServices;
  /**
   * The tool factories this deployment ships.
   *
   * A parameter rather than a fixed list, because which tools a workspace gets is a rollout decision: the
   * cutover moves workflows one at a time, and an application that always offered all of them would give the
   * new runtime capabilities the old one is still serving.
   */
  readonly factories: readonly ShareFlowToolFactory[];
  readonly deps: DelegatingToolDeps;
  readonly authorization: AuthorizationPolicy;
  /**
   * The manifest's own fields, passed through rather than defaulted here.
   *
   * `instructions` is the house voice, `modelPolicy` is a cost and residency decision, `limits` is a spend
   * ceiling and `authorizationPolicyId` names the roles. Every one of them is a deployment's to make, and a
   * default in a shared shell would be this package quietly choosing how much a customer spends.
   *
   * `categories` narrows the tool surface, which is how the cutover moves workflows one at a time: an
   * analytics-only rollout carries no publishing tools rather than carrying them and refusing.
   */
  readonly manifest: Omit<SocialAssistantInput, "version"> & { readonly version?: number };
  /** Extra providers — the integration toolkits a workspace has connected. */
  readonly extraProviders?: readonly ToolProvider[];
};

export type ShareFlowApp = {
  readonly manifest: AgentManifest;
  readonly providers: readonly ToolProvider[];
  readonly assignedSkills: readonly string[];
};

/**
 * Composes the app module into something a host can serve.
 *
 * Validation happens **here, at construction**, for the reason `createShareFlowToolProvider` gives: a wiring
 * mistake should stop the process starting rather than surface as a confusing catalogue on somebody's first
 * conversation.
 */
export const createShareFlowApp = (config: ShareFlowAppConfig): ShareFlowApp => {
  const manifest = socialAssistantManifest({ ...config.manifest, version: config.manifest.version ?? 1 });

  const shareflow = createShareFlowToolProvider({
    services: config.services,
    deps: config.deps,
    factories: config.factories,
  });

  return {
    manifest,
    /**
     * ShareFlow's own tools first, then whatever the deployment connected.
     *
     * Order is not authority — the registry drops a duplicated name rather than picking a provider, which is
     * the right call because both choices are defensible and neither is visible. It is legibility: a
     * catalogue read in order shows the domain before the integrations.
     */
    providers: [shareflow, ...(config.extraProviders ?? [])],
    assignedSkills: SHAREFLOW_ASSIGNED_SKILLS,
  };
};

/**
 * A context for one turn, with shadow mode as an explicit flag.
 *
 * `shadow` reaches the delegating envelope, which suppresses **gated** effects — `external-write` and
 * `destructive` — before the approval gate. That ordering matters and is the platform's, not this
 * application's: a shadow run must not ask a human to approve something that will not happen, because doing so
 * teaches people that approving is meaningless.
 *
 * Worth restating where an operator will read it: **an internal write still happens in shadow mode.** A shadow
 * run does create real drafts. It measures everything up to the external write and nothing after it, because
 * what an agent does *after* publishing cannot be observed without publishing.
 */
export const turnContext = (input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly roleIds: readonly string[];
  readonly conversationId?: string;
  readonly runId?: string;
  readonly requestId: string;
  readonly shadow?: boolean;
}): ExecutionContext =>
  ({
    tenantId: input.tenantId,
    principalId: input.principalId,
    roleIds: input.roleIds,
    locale: "en",
    timezone: "UTC",
    requestId: input.requestId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.shadow === true ? { shadow: true } : {}),
  }) as unknown as ExecutionContext;

export { SOCIAL_ASSISTANT_ID };
