/**
 * Where ShareFlow's context providers live, and the section builder they share (AC-5).
 *
 * docs/07 lists nine context providers (brand, audience, products, campaign, accounts, current post,
 * examples, performance insights). #121 writes them. What lives here is the part that must be
 * consistent across all nine, because getting it wrong is invisible:
 *
 * - **`provenance` is mandatory.** The platform's requirement is that "a claim in the output can be
 *   traced back". `ContextSection.provenance` is a plain string and nothing enforces that it is set to
 *   anything meaningful, so a provider that left it as `""` would produce untraceable context that
 *   still typechecks.
 * - **`sensitivity` defaults to `internal`, not `public`.** Brand claims, audience segments and
 *   campaign briefs are a tenant's commercial material. A default of `public` would be wrong for
 *   nearly every ShareFlow section, and wrong in the direction that leaks.
 * - **`estimatedTokens` is computed, not asserted.** A provider that under-reports its size defeats
 *   the prompt budget, and every provider guessing separately guarantees they disagree.
 */
import type { ContextKind, ContextSection, ContextSensitivity, PruneStage } from "@agentkit/backend";

/**
 * Token estimate for a body of prose.
 *
 * Deliberately crude and deliberately shared: the budget only needs a consistent estimate, and one
 * approximation used by every provider is more useful than nine different ones. ~4 characters per
 * token is the usual rule of thumb for English; rounding up means the budget never under-counts.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export type ShareFlowSectionInput = {
  readonly providerId: string;
  readonly title: string;
  readonly body: string;
  readonly priority: number;
  /** Required. Where this came from, specifically enough to check the claim it supports. */
  readonly provenance: string;
  readonly sensitivity?: ContextSensitivity;
  readonly kind?: ContextKind;
  readonly cacheable?: boolean;
  readonly expiresAt?: string;
  readonly pruneStage?: PruneStage;
};

/**
 * Build a `ContextSection` with ShareFlow's defaults.
 *
 * `cacheable` defaults to **false**. The safe default for a section built from live tenant data is
 * "do not reuse": a stale brand profile or a stale account-health section is worse than a slower
 * prompt, and a provider that genuinely is cacheable can say so.
 */
export const shareFlowSection = (input: ShareFlowSectionInput): ContextSection => ({
  providerId: input.providerId,
  title: input.title,
  body: input.body,
  priority: input.priority,
  estimatedTokens: estimateTokens(input.body),
  provenance: input.provenance,
  sensitivity: input.sensitivity ?? "internal",
  cacheable: input.cacheable ?? false,
  ...(input.kind === undefined ? {} : { kind: input.kind }),
  ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  ...(input.pruneStage === undefined ? {} : { pruneStage: input.pruneStage }),
});

/**
 * The provider ids docs/07 calls for, as a closed set for the same reason as the tool categories: an
 * `AgentManifest.contextProviderIds` entry that matches nothing produces an assistant missing context
 * it was configured to have, with no error anywhere.
 */
export const SHAREFLOW_CONTEXT_PROVIDER_IDS = [
  "shareflow.brand",
  "shareflow.audience",
  "shareflow.products",
  "shareflow.campaign",
  "shareflow.accounts",
  "shareflow.current-post",
  "shareflow.examples",
  "shareflow.performance",
] as const;

export type ShareFlowContextProviderId = (typeof SHAREFLOW_CONTEXT_PROVIDER_IDS)[number];
