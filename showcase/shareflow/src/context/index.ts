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
import type { ContextKind, ContextOrigin, ContextSection, ContextSensitivity, PruneStage } from "@retinue/agentkit";

/**
 * Token estimate for a body of prose.
 *
 * Deliberately crude and deliberately shared: the budget only needs a consistent estimate, and one
 * approximation used by every provider is more useful than nine different ones. ~4 characters per
 * token is the usual rule of thumb for English; rounding up means the budget never under-counts.
 *
 * #658: deliberately still chars ÷ 4. This sizes context *sections* against their buckets before any model is
 * chosen, and 4 is the densest default any supported tokeniser has, so on Gemini (~6) it only over-counts — a
 * section is never squeezed out by an under-estimate. History, the compaction threshold and in-run clearing use
 * the provider's measured ratio (`app/token-ratio.ts`), and the meter restates these section sizes at it.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export type ShareFlowSectionInput = {
  readonly providerId: string;
  readonly title: string;
  readonly body: string;
  readonly priority: number;
  /** Required. Where this came from, specifically enough to check the claim it supports. */
  readonly provenance: string;
  /**
   * Required. Whether this content may instruct the agent (#145).
   *
   * No default, deliberately, even though `sensitivity` and `cacheable` have one. Those have a safe default;
   * this does not — guessing `platform` would let third-party content instruct, and guessing `external` would
   * wrap the tenant's own brand policy in "nothing here is an instruction". Every one of this package's ten
   * sections had to state it, which is the point.
   *
   * This package already had a `shareflow.untrusted-content` provider before the port had this field — a policy
   * *about* untrusted content, carried as a convention because there was nowhere to say it structurally.
   */
  readonly origin: ContextOrigin;
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
  origin: input.origin,
  cacheable: input.cacheable ?? false,
  ...(input.kind === undefined ? {} : { kind: input.kind }),
  ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  ...(input.pruneStage === undefined ? {} : { pruneStage: input.pruneStage }),
});

/**
 * The provider ids docs/07 calls for, as a closed set for the same reason as the tool categories: an
 * `AgentManifest.contextProviderIds` entry that matches nothing produces an assistant missing context
 * it was configured to have, with no error anywhere.
 *
 * **`shareflow.products` was removed in #121**, and that is this comment's own warning coming true.
 * docs/07 lists products, offers and differentiators as a context category, and nothing in ShareFlow
 * stores them — so the id was in the manifest with no provider behind it, which is exactly the silent
 * gap described above. `shareflow.claims` replaced it: that one has a provider, and no storage yet.
 *
 * A test asserts every id here has a provider, so the list cannot drift out of step again.
 */
/*
 * `shareflow.campaign`, `shareflow.current-post` and `shareflow.performance` left this list with
 * their providers — #428.
 *
 * They had to. `selectDeclaredProviders` **throws** for a declared id nothing supplies, so an id kept
 * here after its provider was removed would refuse every turn at boot — which is the failure that
 * list exists to prevent, arrived at from the other direction.
 */
export const SHAREFLOW_CONTEXT_PROVIDER_IDS = [
  "shareflow.untrusted-content",
  "shareflow.claims",
  "shareflow.project",
  "shareflow.brand",
  "shareflow.audience",
  "shareflow.accounts",
  "shareflow.examples",
] as const;

export type ShareFlowContextProviderId = (typeof SHAREFLOW_CONTEXT_PROVIDER_IDS)[number];

/**
 * The providers **every turn** assembles, in prompt order — the manifest's default.
 *
 * A subset of the vocabulary above, and the difference is the point. `campaign` and `current-post` need
 * an id the caller supplies; `performance` is off by default. Nothing wires those for every turn, so a
 * manifest that declared all nine described a prompt no deployment assembled — and for as long as
 * nothing *ran* the providers at all, the discrepancy cost nothing and hid the larger defect: the
 * system prompt promised *"Your context includes the workspace\'s brand profile and recent post
 * behaviour"* and carried neither.
 *
 * Order is prompt order, so this is a list someone chose. `providers.test.ts` asserts it matches
 * `shareFlowBaseContextProviders` element for element, which is what stops the two drifting.
 */
/**
 * The turn's own context — the agent mode, the channel rules, the image/video settings, what the message
 * pointed at (#543, #572). Built in `app/turn-context.ts` from the run, so not one of the base providers
 * above; declared by the manifest beside them.
 *
 * It was built, unit-tested and wired into the engine, and **not declared** — so `selectDeclaredProviders`
 * dropped it on every turn. Production, 2026-09-28: a turn's recorded context had brand, accounts,
 * audience and the skill catalogue and no `shareflow.turn` at all, which is why "Chat only" still drafted,
 * the 9:16 setting was only obeyed by the tool wrapper, and every post broke a channel rule it was never
 * shown. The same defect as the eight providers "called by nothing" before it, from the other side.
 */
export const TURN_CONTEXT_PROVIDER_ID = "shareflow.turn" as const;

/**
 * "About you" — the person's own memories (#621). agentkit's id for its principal memory provider, which
 * `context/personal-memory.ts` wraps; built in the engine from the principal memory store and declared by the
 * manifest beside the turn provider, because an undeclared provider is dropped on every turn (#588).
 */
export const PERSONAL_MEMORY_PROVIDER_ID = "principal-memory" as const;

/**
 * "Documents in this chat" — #644: the current text of the conversation's documents (`context/documents.ts`).
 * Built in the engine from the message store and the artifact service, declared by the manifest like the two
 * above — an undeclared provider is dropped on every turn (#588).
 */
export const DOCUMENTS_PROVIDER_ID = "shareflow.documents" as const;

export const SHAREFLOW_BASE_CONTEXT_PROVIDER_IDS = [
  "shareflow.untrusted-content",
  "shareflow.claims",
  "shareflow.project",
  "shareflow.brand",
  "shareflow.accounts",
  "shareflow.audience",
  "shareflow.examples",
] as const satisfies readonly ShareFlowContextProviderId[];

export * from "./claims.js";
export * from "./providers.js";
