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

  return providers;
};
