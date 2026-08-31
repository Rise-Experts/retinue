/**
 * The integration toolkits, wired into the reference app — REQ-047 (#206), task #214, AC-7.
 *
 * "Built, tested and unreachable" is this repository's most repeated defect: six times a feature has been
 * finished, unit-tested and then reachable from nowhere. Three shipping packages with nothing importing them
 * would have been the seventh, so this file is the thing that makes them real — and
 * `toolkits.test.ts` asserts the tools arrive in the app's own registry rather than in a fixture.
 *
 * ## Wiring is the toggle
 *
 * A toolkit whose credential is absent contributes **no tools at all**, rather than tools that always answer
 * "not configured". The second kind costs the model a turn to discover and reads, in a transcript, exactly like
 * a broken integration. Same rule the standard library already follows for `web_search`.
 *
 * ## Credentials are read here, and only here
 *
 * `process.env` appears in this file and in no toolkit. That is the whole point of AC-5: the *host* knows where
 * its secrets live, and a tool that read the environment itself could never serve two tenants — one process, one
 * token, whoever is calling. Here it is one deployment's own token, which is what an example app is.
 */

import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createAzureToolkit } from "@retinue/tools-azure";
import { createEmailToolkit, httpProvider, smtpProvider } from "@retinue/tools-email";
import { createGoogleToolkit } from "@retinue/tools-google";
import { createScrapeToolkit, firecrawl, jinaReader } from "@retinue/tools-scrape";
import { createConfluenceToolkit } from "@retinue/tools-confluence";
import { createDiscordToolkit } from "@retinue/tools-discord";
import { createGitHubToolkit } from "@retinue/tools-github";
import { createJiraToolkit } from "@retinue/tools-jira";
import { createLinearToolkit } from "@retinue/tools-linear";
import { createMetaToolkit } from "@retinue/tools-meta";
import { createNotionToolkit } from "@retinue/tools-notion";
import { createRedditToolkit } from "@retinue/tools-reddit";
import { createTelegramToolkit } from "@retinue/tools-telegram";
import { createXToolkit } from "@retinue/tools-x";
import { createSlackToolkit } from "@retinue/tools-slack";
import { braveSearch, searxngSearch, serperSearch, tavilySearch } from "@retinue/tools-search";
import type { SearchProvider, ToolProvider } from "@retinue/agentkit";

/** The environment, narrowed to what this file reads, so a test can supply one without touching the process. */
export type ToolkitEnv = Readonly<Record<string, string | undefined>>;

/**
 * The search provider, chosen by configuration — the "one contract, several providers" rule, exercised.
 *
 * Note what does *not* change when this returns a different adapter: not the tool, not its schema, not the
 * prompt, not this app's registry. The model never learns which vendor answered, because choosing a vendor is
 * the deployment's decision and not a decision a model should be spending a tool call on.
 */
export const searchProviderFrom = (env: ToolkitEnv): SearchProvider | undefined => {
  const named = env.RETINUE_SEARCH_PROVIDER;
  if (named === "brave" && env.BRAVE_API_KEY !== undefined) return braveSearch({ apiKey: env.BRAVE_API_KEY });
  if (named === "tavily" && env.TAVILY_API_KEY !== undefined) return tavilySearch({ apiKey: env.TAVILY_API_KEY });
  if (named === "serper" && env.SERPER_API_KEY !== undefined) return serperSearch({ apiKey: env.SERPER_API_KEY });
  // No key, and no default instance: a self-hosted URL is the only thing that makes SearXNG a sensible choice.
  if (named === "searxng" && env.SEARXNG_URL !== undefined) return searxngSearch({ baseUrl: env.SEARXNG_URL });
  return undefined;
};

/**
 * Every configured toolkit, as tool providers for the app's registry.
 *
 * One call per toolkit, and **no change to `backend/`** — which is AC-2. The third of these was added after the
 * runtime was frozen for release, and the diff to the runtime was empty. That is the claim the sibling-package
 * shape exists to make good on: a vendor changing its API is a patch to one small package, not a release of the
 * platform.
 */
export const exampleToolkits = (env: ToolkitEnv, fetchImpl?: typeof fetch): readonly ToolProvider[] => {
  const providers: ToolProvider[] = [];
  const wiring = fetchImpl === undefined ? {} : { fetchImpl };

  if (env.GITHUB_TOKEN !== undefined) {
    providers.push(
      createGitHubToolkit({
        credentialRef: "github",
        resolver: createStaticCredentialResolver({ github: env.GITHUB_TOKEN }),
        ...wiring,
      }),
    );
  }

  if (env.SLACK_BOT_TOKEN !== undefined) {
    providers.push(
      createSlackToolkit({
        credentialRef: "slack",
        resolver: createStaticCredentialResolver({ slack: env.SLACK_BOT_TOKEN }),
        ...wiring,
      }),
    );
  }

  /**
   * Jira and Confluence from **one** credential and one site host, which is why they ship together — REQ-052.
   *
   * Basic, not bearer: an account email plus an API token. The two toolkits are registered separately so a
   * deployment can wire one without the other, but neither works without the site URL, and a token with no
   * site is a configuration mistake rather than a partial one.
   */
  if (env.ATLASSIAN_EMAIL !== undefined && env.ATLASSIAN_API_TOKEN !== undefined && env.ATLASSIAN_SITE_URL !== undefined) {
    const atlassian = {
      credentialRef: "atlassian" as const,
      resolver: createStaticCredentialResolver({
        atlassian: { scheme: "basic" as const, username: env.ATLASSIAN_EMAIL, password: env.ATLASSIAN_API_TOKEN },
      }),
      siteUrl: env.ATLASSIAN_SITE_URL,
      ...wiring,
    };
    providers.push(createJiraToolkit(atlassian), createConfluenceToolkit(atlassian));
  }

  if (env.LINEAR_API_KEY !== undefined) {
    providers.push(
      createLinearToolkit({
        credentialRef: "linear",
        // Raw, with no `Bearer` prefix — Linear rejects the prefixed form with an error that does not say why.
        resolver: createStaticCredentialResolver({
          linear: { scheme: "custom-header", header: "Authorization", value: env.LINEAR_API_KEY },
        }),
        ...wiring,
      }),
    );
  }

  if (env.NOTION_TOKEN !== undefined) {
    providers.push(
      createNotionToolkit({
        credentialRef: "notion",
        resolver: createStaticCredentialResolver({ notion: env.NOTION_TOKEN }),
        ...wiring,
      }),
    );
  }

  /**
   * WhatsApp and Instagram — REQ-053 (#227). Each surface is toggled by its own id, so a deployment that has
   * cleared Meta's review for one and not the other gets exactly the tools it can use.
   */
  if (env.META_ACCESS_TOKEN !== undefined && (env.WHATSAPP_PHONE_NUMBER_ID !== undefined || env.INSTAGRAM_ACCOUNT_ID !== undefined)) {
    providers.push(
      createMetaToolkit({
        credentialRef: "meta",
        resolver: createStaticCredentialResolver({ meta: env.META_ACCESS_TOKEN }),
        ...(env.WHATSAPP_PHONE_NUMBER_ID === undefined ? {} : { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }),
        ...(env.WHATSAPP_BUSINESS_ACCOUNT_ID === undefined ? {} : { wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID }),
        ...(env.INSTAGRAM_ACCOUNT_ID === undefined ? {} : { instagramAccountId: env.INSTAGRAM_ACCOUNT_ID }),
        ...wiring,
      }),
    );
  }

  if (env.X_BEARER_TOKEN !== undefined) {
    providers.push(
      createXToolkit({
        credentialRef: "x",
        resolver: createStaticCredentialResolver({ x: env.X_BEARER_TOKEN }),
        // The tier is a fact about the subscription, so the deployment states it and reads report it.
        ...(env.X_TIER === undefined ? {} : { tier: env.X_TIER as "free" | "basic" | "pro" | "enterprise" }),
        ...wiring,
      }),
    );
  }

  /**
   * Reddit needs a `User-Agent` identifying *this* deployment, so it is configuration rather than a constant:
   * a shared default would make every deployment look like one client to Reddit's rate limiter.
   */
  if (env.REDDIT_ACCESS_TOKEN !== undefined && env.REDDIT_USER_AGENT_CONTACT !== undefined) {
    providers.push(
      createRedditToolkit({
        credentialRef: "reddit",
        resolver: createStaticCredentialResolver({ reddit: env.REDDIT_ACCESS_TOKEN }),
        userAgent: {
          appId: env.REDDIT_APP_ID ?? "retinue-example",
          version: env.REDDIT_APP_VERSION ?? "0.3.0",
          contact: env.REDDIT_USER_AGENT_CONTACT,
        },
        ...wiring,
      }),
    );
  }

  if (env.DISCORD_BOT_TOKEN !== undefined) {
    providers.push(
      createDiscordToolkit({
        credentialRef: "discord",
        // `Bot <token>` — the word is part of the value, and omitting it fails with a bare 401.
        resolver: createStaticCredentialResolver({
          discord: { scheme: "custom-header", header: "Authorization", value: `Bot ${env.DISCORD_BOT_TOKEN}` },
        }),
        ...wiring,
      }),
    );
  }

  if (env.TELEGRAM_BOT_TOKEN !== undefined) {
    providers.push(
      createTelegramToolkit({
        credentialRef: "telegram",
        resolver: createStaticCredentialResolver({ telegram: env.TELEGRAM_BOT_TOKEN }),
        ...wiring,
      }),
    );
  }

  /**
   * Google Workspace — REQ-054 (#232), tasks #234 and #235.
   *
   * **A static token here is a demonstration, not a pattern**, and the toolkit's own docstring says so: a
   * Google access token expires in about an hour, so a deployment needs `withRefreshingCredentials` (#233)
   * against the tenant's OAuth grant. This app has one deployment and one token, which is what an example is —
   * and the comment exists so nobody copies the shape into something that has to run past lunchtime.
   */
  if (env.GOOGLE_ACCESS_TOKEN !== undefined) {
    providers.push(
      createGoogleToolkit({
        credentialRef: "google",
        resolver: createStaticCredentialResolver({ google: env.GOOGLE_ACCESS_TOKEN }),
        ...wiring,
      }),
    );
  }

  /** Azure — REQ-054, task #236. Read-first: the only write is a tag, and the only destructive tool a restart. */
  if (env.AZURE_ACCESS_TOKEN !== undefined) {
    providers.push(
      createAzureToolkit({
        credentialRef: "azure",
        resolver: createStaticCredentialResolver({ azure: env.AZURE_ACCESS_TOKEN }),
        ...wiring,
      }),
    );
  }

  /**
   * Scraping — REQ-055 (#237), task #238. **Opt-in, even though it needs no credential.**
   *
   * This file's rule is "wiring is the toggle", and scraping is the one toolkit that could quietly break it:
   * the direct provider needs no account and no third party, so there is no absent credential to switch it off.
   * Wiring it unconditionally was the first thing I tried and the tests below refused it — correctly. Fetching
   * arbitrary URLs on a reader's machine is a capability worth asking for rather than one to arrive with, and
   * one uniform rule is worth more than a rule plus an exception.
   *
   * A hosted provider is an *upgrade* chosen the way a search provider is, and implies the opt-in: configuring
   * one is asking for this.
   */
  if (env.FIRECRAWL_API_KEY !== undefined || env.JINA_API_KEY !== undefined || env.RETINUE_ENABLE_SCRAPE === "1") {
    providers.push(
      createScrapeToolkit({
        ...(env.FIRECRAWL_API_KEY !== undefined
          ? { provider: firecrawl({ apiKey: env.FIRECRAWL_API_KEY }) }
          : env.JINA_API_KEY !== undefined
            ? { provider: jinaReader({ apiKey: env.JINA_API_KEY }) }
            : {}),
        // Identifies *this* deployment to the sites it fetches, for the reason Reddit's user agent does.
        ...(env.SCRAPE_USER_AGENT === undefined ? {} : { userAgent: env.SCRAPE_USER_AGENT }),
      }),
    );
  }

  /**
   * Mail — REQ-056 (#240), task #241. SMTP if a host is configured, otherwise an HTTP provider if a key is.
   *
   * `EMAIL_FROM` is required for both, and deliberately not defaulted: the sender is the field SPF and DKIM
   * align against, so guessing it produces mail that silently lands in spam. A toolkit with no `from` is a
   * misconfiguration, not a partial one.
   */
  if (env.EMAIL_FROM !== undefined) {
    if (env.SMTP_HOST !== undefined && env.SMTP_USERNAME !== undefined && env.SMTP_PASSWORD !== undefined) {
      providers.push(
        createEmailToolkit({
          provider: smtpProvider({
            host: env.SMTP_HOST,
            port: Number(env.SMTP_PORT ?? 587),
            credentialRef: "smtp",
            resolver: createStaticCredentialResolver({
              smtp: { scheme: "basic", username: env.SMTP_USERNAME, password: env.SMTP_PASSWORD },
            }),
          }),
          from: env.EMAIL_FROM,
          ...(env.EMAIL_REPLY_TO === undefined ? {} : { replyTo: env.EMAIL_REPLY_TO }),
        }),
      );
    } else if (env.RESEND_API_KEY !== undefined) {
      providers.push(
        createEmailToolkit({
          provider: httpProvider({
            name: "resend",
            credentialRef: "resend",
            resolver: createStaticCredentialResolver({ resend: env.RESEND_API_KEY }),
            ...wiring,
          }),
          from: env.EMAIL_FROM,
          ...(env.EMAIL_REPLY_TO === undefined ? {} : { replyTo: env.EMAIL_REPLY_TO }),
        }),
      );
    }
  }

  /**
   * `@retinue/tools-browser` is **deliberately not wired here**, and this note is the record of that decision.
   *
   * It requires a `BrowserDriver`, and the package ships none on purpose — `docs/30-browser-isolation.md`
   * argues that how a browser is launched and isolated is the operator's decision, and a toolkit that silently
   * spawned one it found on the PATH would be the "works on the machine where it was configured" shape with an
   * unusually large blast radius. Supplying a driver means choosing between a hosted service and a local
   * Chromium, which is a deployment decision this app cannot make on a reader's behalf.
   *
   * Left as an absence with a reason rather than a stub: a driver that pretended to work would teach exactly
   * the wrong thing about the one toolkit where isolation is the whole subject.
   */

  return providers;
};
