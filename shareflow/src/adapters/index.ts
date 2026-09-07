/**
 * Wiring the three implemented services — REQ-041 (#190).
 *
 * **All ten are built.** Which retires the argument this file opened with — that a narrower type was the only
 * honest shape while seven of them were ports — and the retirement is worth recording rather than deleting:
 * the type narrowed to what existed at each step, and the last step happens to be everything.
 *
 * What has not changed is the rule that got it here. Where a method needs something outside a ShareFlow table
 * — a platform connector, a media converter, a storage probe, a search provider, a suppression list — it is a
 * **dependency**, and where a deployment cannot supply one the method **refuses** rather than approximating.
 * Six of them do: `checkHealth`, `reply`, `convert`, `checkStorage`, and `search`/`readSource` through their
 * required providers.
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
 * All thirty-seven capabilities are now servable, so `createShareFlowToolProvider` will accept the complete
 * factory list. The refusal it performs is not obsolete: a deployment may still register a narrower set, and
 * `requires` is what keeps that a checked decision rather than a hopeful one.
 */

import type { ContextProvider } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createModelContentGenerator, type StructuredGenerate } from "./model/generator.js";
import { createPostgresBrandService } from "./postgres/brand.js";
import { createPostgresContentService } from "./postgres/content.js";
import { createPostgresAnalyticsService } from "./postgres/analytics.js";
import { createPostgresConnectorService, type ConnectorDeps } from "./postgres/connectors.js";
import { createPostgresEngagementService, type EngagementDeps } from "./postgres/engagement.js";
import { createPostgresLeadService, type LeadDeps } from "./postgres/leads.js";
import { createPostgresMediaService, type MediaDeps } from "./postgres/media.js";
import { createWebResearchService, type ResearchDeps } from "./web/research.js";
import { createPostgresPublishingService, type PublishingDeps } from "./postgres/publishing.js";
import {
  createAccountsContextProvider,
  createAudienceContextProvider,
  createBrandContextProvider,
  createClaimsContextProvider,
} from "../context/providers.js";
import { shareFlowBaseContextProviders } from "../context/providers.js";
import type { ShareFlowServices } from "../services/index.js";

/**
 * The members that have an adapter. A `Pick`, so adding a fourth is one edit and the type follows.
 *
 * Named rather than inlined because the *complement* is the interesting half: a reader wants to know what is
 * missing, and `BACKED_SERVICES` / `UNBACKED_SERVICES` below say so in a form a test can assert.
 */
/**
 * Every member. The `Pick` is gone because there is nothing left to pick from — this now builds all ten.
 *
 * Kept as an alias rather than replaced by `ShareFlowServices` at the call sites, so the shape of the previous
 * six months of comments still reads: `backedContextProviders` and `createShareFlowServices` were narrower
 * than the interface for a reason, and the reason has been discharged rather than forgotten.
 */
export type BackedShareFlowServices = ShareFlowServices;

/** What this file can build: all ten. */
export const BACKED_SERVICES = [
  "analytics",
  "brand",
  "connectors",
  "content",
  "engagement",
  "generator",
  "leads",
  "media",
  "publishing",
  "research",
] as const;

/**
 * What it cannot, listed so the gap is data rather than a comment.
 *
 * A test asserts these two arrays together account for exactly the ten members of `ShareFlowServices`, which
 * is what stops this list going stale the day an eighth service is written.
 */
export const UNBACKED_SERVICES = [] as const;

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
  /**
   * What connecting a platform requires. **Required, because `connectors` is.**
   *
   * Redirect URLs, developer-console field labels, scopes and environment variable *names* are deployment
   * knowledge rather than database rows, and a default here would be this package asserting another
   * deployment's configuration — an assistant confidently naming a variable that deployment does not use.
   */
  readonly setup: ConnectorDeps["setup"];
  /**
   * Which platforms have working credentials, if the deployment can say.
   *
   * Absent means `not-configured` is never reported — not that everything is configured. ShareFlow decides it
   * with a runtime environment read in its own process, which this package cannot see.
   */
  readonly configuredPlatforms?: ConnectorDeps["configuredPlatforms"];
  /** A live per-account re-check. Absent means `checkHealth` refuses rather than answering from the store. */
  readonly probe?: ConnectorDeps["probe"];
  /**
   * Web search and page fetching, from the platform's guarded toolkit. **Required, because `research` is.**
   *
   * `createWebSearch` and `createFetchPage` are where the egress policy, the redirect refusal and the byte
   * ceiling live. A second fetcher in this package would be a second egress policy, and the one that mattered
   * would be whichever the caller happened to use.
   */
  readonly search: ResearchDeps["search"];
  readonly fetchPage: ResearchDeps["fetchPage"];
  /** Sends a reply on the platform. Absent means `EngagementService.reply` refuses, as the port asks. */
  readonly sendReply?: EngagementDeps["send"];
  /** Runs a media conversion. Absent means `MediaService.convert` refuses — no sweep would pick up a row. */
  readonly convertMedia?: MediaDeps["convert"];
  /** Proves the media path end to end. Absent means `checkStorage` refuses rather than reporting `ok`. */
  readonly checkMediaStorage?: MediaDeps["checkStorage"];
  /** The bucket post media lives in. Defaults to `media`, the bucket this schema ships. */
  readonly mediaBucket?: string;
  /** Whether an address must never be added as a lead. Absent means no lead is ever suppressed. */
  readonly isSuppressed?: LeadDeps["isSuppressed"];
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
    connectors: createPostgresConnectorService({
      sql: config.sql,
      setup: config.setup,
      ...(config.configuredPlatforms === undefined ? {} : { configuredPlatforms: config.configuredPlatforms }),
      ...(config.probe === undefined ? {} : { probe: config.probe }),
    }),
    publishing: createPostgresPublishingService({
      sql: config.sql,
      transaction: config.transaction,
      validateContent: (context, input) => content.validateContent(context, input),
      ...(config.enqueue === undefined ? {} : { enqueue: config.enqueue }),
    }),
    engagement: createPostgresEngagementService({
      sql: config.sql,
      transaction: config.transaction,
      ...(config.sendReply === undefined ? {} : { send: config.sendReply }),
    }),
    leads: createPostgresLeadService({
      sql: config.sql,
      ...(config.isSuppressed === undefined ? {} : { isSuppressed: config.isSuppressed }),
    }),
    media: createPostgresMediaService({
      sql: config.sql,
      transaction: config.transaction,
      ...(config.mediaBucket === undefined ? {} : { bucket: config.mediaBucket }),
      ...(config.convertMedia === undefined ? {} : { convert: config.convertMedia }),
      ...(config.checkMediaStorage === undefined ? {} : { checkStorage: config.checkMediaStorage }),
    }),
    analytics: createPostgresAnalyticsService({ sql: config.sql }),
    research: createWebResearchService({ search: config.search, fetchPage: config.fetchPage }),
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
  // No cast: these three accept `Pick<ShareFlowServices, "brand">`, which is what they actually use.
  createBrandContextProvider(services),
  createClaimsContextProvider(services),
  createAudienceContextProvider(services),
  /**
   * The accounts provider, which this list omitted until `ConnectorService` existed.
   *
   * It reads `services.connectors.listAccounts` on **every** turn, and `assembler.ts:35` runs providers in a
   * bare `for` loop with no `try` — so while there was no connector adapter, including it would have taken
   * every turn down before the model was called. That was the whole argument for a narrower type, and it is
   * now satisfied rather than worked around.
   */
  createAccountsContextProvider(services),
];

/**
 * Every context provider, now that every service exists.
 *
 * `shareFlowBaseContextProviders` is the platform-side list and this is the same set — kept as a separate
 * export because `backedContextProviders` is what the previous five commits' callers pass, and silently
 * widening it would change what a deployment assembles without anyone choosing to.
 */
export const allContextProviders = shareFlowBaseContextProviders;

export * from "./model/generator.js";
export * from "./postgres/brand.js";
export * from "./postgres/content.js";
export * from "./postgres/analytics.js";
export * from "./postgres/connectors.js";
export * from "./postgres/engagement.js";
export * from "./postgres/leads.js";
export * from "./postgres/media.js";
export * from "./postgres/publishing.js";
export * from "./web/research.js";
