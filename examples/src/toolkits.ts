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
import { createGitHubToolkit } from "@retinue/tools-github";
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

  return providers;
};
