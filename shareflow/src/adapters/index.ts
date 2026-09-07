/**
 * Wiring the three implemented services — REQ-041 (#190).
 *
 * `content`, `brand`, `generator` and `publishing` are built. The other six members of `ShareFlowServices` —
 * `connectors`, `media`, `engagement`, `leads`, `research`, `analytics` — are still ports with no adapter, and
 * this file is careful about what that means.
 *
 * `publishing` is the one that changes what a shadow run measures: it is the first adapter whose methods are
 * `external-write`, so it is the first whose suppressed writes are not an empty list.
 *
 * ## Why this returns three services and not a `ShareFlowServices`
 *
 * The tempting shape is a full ten-member object whose seven unimplemented members throw
 * `capability_unavailable`. It is wrong, and not on principle — on evidence.
 *
 * `backend/src/context/assembler.ts:35` is one line:
 *
 * ```ts
 * for (const provider of providers) sections.push(...(await provider.provide(context)));
 * ```
 *
 * No `try`, no `allSettled`. A context provider that throws aborts the assembly, which aborts the turn — and
 * `createAccountsContextProvider` calls `services.connectors.listAccounts` on **every** turn. So a
 * declare-and-throw object plus the standard base providers is a deployment where nothing works at all,
 * failing before the model is even called. That is strictly worse than a deployment that does not offer
 * publishing.
 *
 * It is also the mistake #255 spent its time removing: a declared capability that throws. The conclusion there
 * was to make the union honest rather than to apologise at runtime, and the equivalent here is a narrower type.
 *
 * ## What a caller does with this
 *
 * Hands it to `createShareFlowApp` with a factory list those three services can serve. That works because
 * every `ShareFlowToolFactory` now declares its `requires`, so `createShareFlowToolProvider` refuses at
 * construction when a registered capability needs a service this deployment does not have — the property that
 * file's docstring already claimed, that *"a wiring mistake should stop the process starting rather than
 * surface as a confusing catalogue on someone's first conversation"*.
 *
 * Seventeen of the thirty-seven capabilities read only these four: five post tools, five campaign tools, two
 * generation tools and five publishing tools. Adding, say, `MEDIA_TOOL_FACTORIES` to that list is refused by
 * name rather than failing when somebody asks for an image to be attached.
 */

import type { ContextProvider } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createModelContentGenerator, type StructuredGenerate } from "./model/generator.js";
import { createPostgresBrandService } from "./postgres/brand.js";
import { createPostgresContentService } from "./postgres/content.js";
import { createPostgresPublishingService, type PublishingDeps } from "./postgres/publishing.js";
import {
  createAudienceContextProvider,
  createBrandContextProvider,
  createClaimsContextProvider,
} from "../context/providers.js";
import type { ShareFlowServices } from "../services/index.js";

/**
 * The members that have an adapter. A `Pick`, so adding a fourth is one edit and the type follows.
 *
 * Named rather than inlined because the *complement* is the interesting half: a reader wants to know what is
 * missing, and `BACKED_SERVICES` / `UNBACKED_SERVICES` below say so in a form a test can assert.
 */
export type BackedShareFlowServices = Pick<ShareFlowServices, "brand" | "content" | "generator" | "publishing">;

/** What this file can build. */
export const BACKED_SERVICES = ["brand", "content", "generator", "publishing"] as const;

/**
 * What it cannot, listed so the gap is data rather than a comment.
 *
 * A test asserts these two arrays together account for exactly the ten members of `ShareFlowServices`, which
 * is what stops this list going stale the day an eighth service is written.
 */
export const UNBACKED_SERVICES = ["analytics", "connectors", "engagement", "leads", "media", "research"] as const;

export type ShareFlowAdapterConfig = {
  /** ShareFlow's own database. The three adapters share one executor; none of them opens a connection. */
  readonly sql: SqlExecutor;
  /**
   * Structured generation, already resolved through the host's `ModelPolicy`.
   *
   * A function rather than a model id, for the reason the generator gives: the host resolves role,
   * capabilities, residency and cost ceiling, and a generator that took an id would bypass all four.
   */
  readonly generate: StructuredGenerate;
  /**
   * A transaction runner, **required because `publishing` is**.
   *
   * `scheduled_items` has no unique constraint on `(post_id, social_account_id)`, so publish-once rests on a
   * row lock taken across two statements on one connection — which `SqlExecutor` alone cannot express. A
   * deployment that cannot supply this should not be publishing, so it is not optional.
   */
  readonly transaction: TransactionRunner;
  /** Optional: hand a scheduled item to ShareFlow's queue immediately instead of waiting for its sweep. */
  readonly enqueue?: PublishingDeps["enqueue"];
};

/**
 * Builds the three services over ShareFlow's tables and the host's model.
 *
 * The generator's `brand` dependency is wired to the brand service **here**, which is the one composition
 * decision this function makes. The generator does not look it up itself — it would read the profile once per
 * variant, and a workflow producing five variants across three platforms would make fifteen identical queries
 * for text that cannot change during a turn.
 */
export const createShareFlowServices = (config: ShareFlowAdapterConfig): BackedShareFlowServices => {
  const brand = createPostgresBrandService(config.sql);
  const content = createPostgresContentService(config.sql);
  return {
    brand,
    content,
    generator: createModelContentGenerator({
      generate: config.generate,
      brand: (context) => brand.getBrandProfile(context),
    }),
    /**
     * `validateContent` is handed over rather than reimplemented, and that is the second composition decision
     * this function makes.
     *
     * `platform_rules` is workspace-overridable, so two readings of it would be two answers to "is this
     * caption publishable" — and `PublishingService.validate` runs *before* the approval gate precisely so a
     * human is never asked to approve something that cannot succeed. The two disagreeing would defeat that.
     */
    publishing: createPostgresPublishingService({
      sql: config.sql,
      transaction: config.transaction,
      validateContent: (context, input) => content.validateContent(context, input),
      ...(config.enqueue === undefined ? {} : { enqueue: config.enqueue }),
    }),
  };
};

/**
 * The context providers that read only from the three backed services.
 *
 * The tool side of this is checked by the compiler and by the provider; the context side is not, because
 * `ContextProvider` has no `requires` and adding one would be a platform change rather than a ShareFlow one.
 * So this list is maintained by hand and asserted in the tests by actually running each provider.
 *
 * `shareFlowBaseContextProviders` is the full list and includes `accounts`, which calls
 * `services.connectors.listAccounts`. With no connector adapter that provider throws, and per
 * `assembler.ts:35` a throwing provider takes the turn down with it — so this is the base list **minus that
 * one**, and the omission is the point rather than an oversight.
 *
 * The consequence is worth stating plainly for whoever reads a transcript: an assistant wired this way does
 * not know which destinations the workspace has connected, so it may propose posting somewhere the workspace
 * cannot post to. That is a visibly incomplete assistant, which is the honest state of a partial rollout —
 * and it is a better one than an assistant that cannot answer at all.
 */
export const backedContextProviders = (services: BackedShareFlowServices): readonly ContextProvider[] => [
  // No cast: these three now accept `Pick<ShareFlowServices, "brand">`, which is what they actually use.
  createBrandContextProvider(services),
  createClaimsContextProvider(services),
  createAudienceContextProvider(services),
];

export * from "./model/generator.js";
export * from "./postgres/brand.js";
export * from "./postgres/content.js";
export * from "./postgres/publishing.js";
