/**
 * The deployment's own decisions, shared by the API host and the worker — retinue REQ-041 (#190).
 *
 * These were in `module.ts` until the worker needed them too. `engine.ts` importing them from there
 * would have made the module graph circular — `module.ts` loads the engine, the engine loads the
 * module — which ESM tolerates and nobody should have to reason about. They are not host-specific, so
 * they moved to a file both can import.
 *
 * Every one of them either works or refuses by name. That is the whole design: the first version of
 * this module passed `undefined as never` for four dependencies, which typechecked and would have
 * produced a container that booted, reported healthy, and failed on the first turn touching a
 * connector, the web or the model.
 */

import { optionalEnv } from "./env.js";
import { AgentPlatformError, type AuthorizationPolicy, type ExecutionContext } from "@retinue/agentkit";
import type { RecordToolUsage } from "./tool-usage.js";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import type { ConnectorDeps } from "../adapters/postgres/connectors.js";
import type { ConnectionSetup } from "../services/index.js";
import type { StructuredGenerate } from "../adapters/model/generator.js";
import type { WorkspaceModelResolver } from "../adapters/model/workspace-model.js";
import type { ShareFlowAdapterConfig } from "../adapters/index.js";
import type { InternalWebApp } from "./internal.js";

/**
 * Every principal may do everything, and the name says so.
 *
 * A single-tenant deployment where the web app has already authenticated and scoped the request, so a
 * policy here would be a second, weaker copy of a decision already made. Named `PLACEHOLDER` so a
 * reader cannot mistake it for a decision — it is the one thing in this deployment that must change
 * before a second tenant shares it.
 *
 * **All three methods, and no cast.** The first version implemented `can` alone and was cast through
 * `as unknown as AuthorizationPolicy`. It typechecked, the host booted, and the first real turn died in
 * the worker with `config.authorization.filterTools is not a function` — the third time in this file
 * that a cast hid a missing member, after `ConnectorDeps.setup` (an object where a function was wanted)
 * and the app module's own `engine` (a promise where an object was wanted). The pattern is the lesson:
 * a cast to an interface is a promise the compiler stops checking, and every one of these was found by
 * running the thing rather than by building it.
 */
/**
 * The roles that may change things. Everything else is read-only.
 *
 * An **allowlist of writing roles**, not a denylist of read-only ones, and the difference is not
 * stylistic. The first version of this asked whether every role was literally `"viewer"`, which meant
 * a role id this code had never heard of — one added by a later migration, a typo in a seed, a
 * `creator` or `client` from the marketplace phases — was not-a-viewer and therefore got write access.
 * A test for an unrecognised role caught it, and the comment above that version already claimed the
 * opposite behaviour, which is its own lesson: the claim was right and the code was not.
 *
 * So the question is "is this caller known to be allowed to write", and an unknown answer is no. A new
 * role now arrives read-only and someone has to decide to widen it.
 *
 * `some`, because a person who is read-only in one capacity and an editor in another is an editor.
 */
const WRITING_ROLES: ReadonlySet<string> = new Set(["editor"]);

const isReadOnly = (roleIds: readonly string[]): boolean =>
  !roleIds.some((role) => WRITING_ROLES.has(role.toLowerCase()));

export const PLACEHOLDER_AUTHORIZATION: AuthorizationPolicy = {
  /**
   * A read-only caller may not perform a write action — #406.
   *
   * `filterTools` keeps the write tools out of the model's hands, and this is the check behind it: a
   * name the model already knew, a resumed run, or a `POST /api/tools/:name` from the product all
   * reach `execute` without passing through the catalogue. A filter the model can see is a nicer
   * experience; this is the part that holds.
   */
  async can(context, action) {
    if (isReadOnly(context.roleIds) && action !== "read") {
      return { allow: false, reason: "This workspace role can read but not change anything." };
    }
    return { allow: true };
  },

  /**
   * Read-only callers are handed the read-only tools — #406.
   *
   * This returned every tool unfiltered, on the reasoning in the header above: the web app has already
   * authenticated and scoped the request, so a policy here would be a weaker second copy. That was
   * true of the *tenant* and false of the *role*. Membership was the only thing checked, so a VIEWER
   * reached this with the same catalogue as an owner.
   *
   * Filtered here rather than refused at execution, because the two are different experiences. A
   * model that is handed `publish_post_now` and refused has spent a turn and tells the user something
   * went wrong; a model that never sees it says "I can draft this for you, but publishing needs an
   * editor" — which is the true sentence.
   *
   * `effect` is the discriminator rather than a list of tool names, for the same reason the approval
   * gate uses it: `defineTool` derives it once per tool, and a hand-kept list of "the safe ones" is
   * the artefact that goes on saying yes after somebody relabels an effect. A viewer gets `read`;
   * everything that writes, publishes or deletes is withheld.
   *
   * Note what this does *not* do: it is not the enforcement boundary on its own. `execute` still
   * re-checks, the approval gate still gates, and RLS still applies on the user-scoped paths. It is
   * the first of those layers and the only one the model can see.
   */
  async filterTools(context, tools) {
    if (!isReadOnly(context.roleIds)) return tools;
    return tools.filter((tool) => tool.effect === "read" || tool.category === "meta");
  },

  /**
   * No row filter, with the tenant carried through.
   *
   * `filter` is deliberately absent rather than `{}`: the field is what a retrieval layer applies
   * before a search, and an empty object is a filter that matches nothing in some query builders and
   * everything in others. Absent has one meaning.
   */
  async scope(context) {
    return { tenantId: String(context.tenantId), roleIds: [...context.roleIds] };
  },
};

/**
 * The transaction scope, from whatever the caller can offer.
 *
 * **Required, not optional**, because `publish-once` rests on `SELECT … FOR UPDATE` held across two
 * statements on one connection and the conversation slot does the same: `scheduled_items` has no unique
 * constraint on `(post_id, social_account_id)`, so without a real transaction a concurrent retry
 * publishes twice. `sql.query` cannot express it — it takes a different connection per call.
 *
 * It used to *refuse* when the caller supplied none, which was right when nothing could derive one and
 * wrong as soon as something could. The worker calls both `deps({config, sql})` and
 * `engine({config, sql})` with no runner — reasonably, since a runner is not something a generic
 * entrypoint has — and refusing meant the worker could not start at all. `config` carries the URL and
 * the schema, so a runner is derivable, and deriving one is strictly better than declining to run.
 *
 * **Memoised per connection**, so the two calls in one worker share a pool rather than opening two. The
 * key includes the schema: two runners on the same URL and different schemas are not interchangeable —
 * one would hold a lock on a table in the wrong namespace, which is not an error, just a lock on a row
 * that is not there.
 */
const RUNNERS = new Map<string, TransactionRunner>();

export const runnerFor = async (input: {
  readonly runner?: TransactionRunner | undefined;
  readonly config?: { readonly databaseUrl?: string; readonly databaseSchema?: string } | undefined;
}): Promise<TransactionRunner> => {
  if (input.runner !== undefined) return input.runner;

  const url = input.config?.databaseUrl;
  if (url === undefined || url === "") {
    throw new Error(
      "A TransactionRunner is required: publish-once and the conversation slot both rest on a real " +
        "transaction, and a pooled executor cannot express one. Supply `runner`, or `config.databaseUrl` " +
        "so one can be opened.",
    );
  }

  const schema = input.config?.databaseSchema;
  const searchPath = schema === undefined || schema === "" ? undefined : `${schema},public`;
  const key = `${url}::${searchPath ?? ""}`;
  const existing = RUNNERS.get(key);
  if (existing !== undefined) return existing;

  const { Pool } = await import("pg");
  const { createPoolOpener, createTransactionScope } = await import("@retinue/agentkit/adapters/postgres");
  const pool = new Pool({
    connectionString: url,
    // The startup parameter, not a `SET`: it applies before the connection is usable, and a space after
    // the comma would make libpq read `public` as a separate option and Postgres refuse the connection.
    ...(searchPath === undefined ? {} : { options: `-c search_path=${searchPath}` }),
  });

  /**
   * An idle client's error must not take the process down.
   *
   * `pg` emits `'error'` on the **pool** when a client that is sitting idle in the pool fails — a
   * database restart, a pooler recycling connections, a network blip. `EventEmitter`'s contract is that
   * an `'error'` event with no listener is re-thrown as an uncaught exception, so a pool with no
   * listener turns a routine reconnect into a dead worker. `pg` removes the broken client from the pool
   * on its own; the only thing missing was somewhere for the event to go.
   *
   * Logged rather than swallowed silently: this is the signal that the database went away, and a worker
   * that recovered without saying so is a worker whose restarts have no explanation.
   */
  pool.on("error", (error) => {
    console.error(`[shareflow] idle postgres client failed; pg will discard it: ${String(error)}`);
  });

  /**
   * `createTransactionScope(...).runner`, **not the opener cast to a runner.**
   *
   * This line read `createPoolOpener(pool, searchPath) as unknown as TransactionRunner`, and the two
   * types are not the same thing at all:
   *
   *     ConnectionOpener    <T>(fn: (sql) => Promise<T>) => Promise<T>     — a function
   *     TransactionRunner   { transaction<T>(fn: (sql) => Promise<T>) }    — an object with a method
   *
   * So every adapter that opens a transaction called `.transaction(...)` on a *function* and threw
   * `deps.transaction.transaction is not a function`. Observed live, from the app: an approved
   * `reply_to_comment` failed with exactly that message after the user had already said yes — the
   * worst possible moment, because the approval is spent and the row is claimed.
   *
   * Every transactional path in the worker had this: replying, publish-once, the conversation slot.
   * `main.ts` builds the scope correctly, which is why the HTTP surface never showed it, and the cast
   * is the reason the compiler never asked. Nothing here is cast now.
   */
  const scope = createTransactionScope(createPoolOpener(pool, searchPath));

  if (searchPath !== undefined) {
    /**
     * The same boot check `main.ts` does, which this path did not.
     *
     * `options: -c search_path=...` is a startup parameter, and a pooler in front of Postgres can drop
     * it. When that happens every connection sits on the default path, every table this process touches
     * is the wrong one, and there is nothing at all to see — reads return empty and writes land
     * somewhere nobody looks. One round trip converts that into a boot failure that names its own
     * cause. `main.ts` had this from the start, which is exactly why the HTTP surface never showed the
     * problem and the worker would have carried it silently.
     */
    const { createPgExecutor } = await import("@retinue/agentkit/adapters/postgres");
    const probe = scope.scoped(createPgExecutor(pool));

    /**
     * A *reachability* failure is not this check's business.
     *
     * The question here is narrow — "did the pooler pass my `options` through?" — and it can only be
     * answered by a connection that succeeded. `main.ts` runs the same check at boot, where refusing to
     * start is right. This one runs inside a lazily memoised factory in a long-lived worker, so
     * throwing on a connect error would turn a database restart into a dead worker instead of a
     * retried job, and it would report "search_path" for a problem that is really DNS or a closed port.
     * The first real query says that far better.
     */
    let reported: string | undefined;
    try {
      const [row] = await probe.query<{ readonly search_path: string }>("SHOW search_path");
      reported = row?.search_path ?? "";
    } catch (error) {
      console.warn(
        `[shareflow] could not verify search_path against "${schema}" — the database was unreachable ` +
          `during setup: ${String(error)}. Continuing; the first query will report the real problem.`,
      );
    }

    if (reported !== undefined && !reported.includes(schema as string)) {
      throw new Error(
        `RETINUE_DATABASE_SCHEMA is "${schema}" but this connection reports search_path "${reported}". The ` +
          `connection options were not applied — a pooler in front of Postgres may be dropping them.`,
      );
    }
  }

  /**
   * Only `runner` is kept, and `scope.scoped` is deliberately dropped here.
   *
   * `scoped` wraps an executor so a read inside `transaction(...)` uses that transaction's connection
   * rather than a fresh one from the pool. This function's callers supply their own `sql`
   * (`module.ts` passes `input.sql` straight through), so there is nothing here to wrap — and the
   * worker's `sql` is therefore *not* transaction-aware. No service body currently reads via
   * `deps.sql` inside a transaction, so nothing is wrong today; one that did would silently read
   * pre-transaction state. Written down because it is invisible at both ends: the caller cannot see
   * that its executor is unscoped, and the adapter cannot see which executor it was given.
   */
  const runner = scope.runner;
  RUNNERS.set(key, runner);
  return runner;
};

/**
 * Who is calling, from the headers the web app already sends.
 *
 * **The header names are the application's, not this package's.** An earlier version of this read
 * `x-chorus-workspace-id` and `x-chorus-user-id`, which appear **nowhere** in the web app or the Python
 * backend — I invented them. Every turn the web app sent would have returned 401, from two contracts
 * that were each tested against their own assumptions and never against each other.
 *
 * The real convention is `serviceHeaders()` in `web/src/lib/assistant/client.ts`, which the Python
 * backend reads and documents: *"Workspace scoping here relies solely on the trusted X-Workspace-Id
 * header … the shared X-API-Secret from the authenticated, secret-gated Next.js web"*. So:
 *
 *   X-API-Secret     the shared secret, proving the caller is the web app
 *   X-Workspace-Id   the tenant, trusted *because* the secret proved the caller
 *   X-User-Id        the principal, for attribution and authorisation
 *
 * `x-internal-secret` is accepted as a synonym for the secret only, because compose passes
 * `SHARED_API_SECRET` and both names are in use for it across this deployment. The workspace and user
 * names have exactly one spelling each — a second spelling is a second thing to keep in step, and the
 * one that drifts is the one nobody tests.
 *
 * The ids are **never** taken from a body. A caller that can set the workspace in a JSON payload can
 * set somebody else's, and the whole point of the secret is that these headers are then trustworthy.
 */
export const createAuthenticator = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const secret = env["SHARED_API_SECRET"];
  return (request: Request): ExecutionContext | null => {
    /**
     * An unset secret means **deny**, never "use a well-known default".
     *
     * `serviceHeaders` makes the same choice and says why: "No committed fallback: if
     * SHARED_API_SECRET is unset the backend gate fails closed rather than both sides silently
     * agreeing on a public value." A backend that served an open API to whoever forgot to configure it
     * is unrecoverable.
     */
    if (secret === undefined || secret === "") return null;
    const provided = request.headers.get("x-api-secret") ?? request.headers.get("x-internal-secret");
    if (provided !== secret) return null;

    const tenantId = request.headers.get("x-workspace-id");
    const principalId = request.headers.get("x-user-id");
    // Both, not either. A tenant with no principal cannot be authorised against and a principal with no
    // tenant cannot be scoped — and defaulting either one is how a request ends up acting as somebody
    // else.
    if (tenantId === null || tenantId === "" || principalId === null || principalId === "") return null;

    /**
     * The role is required, and a missing one is a refusal — #406.
     *
     * This read `?? "editor"`, and the web proxy sent no `x-roles` header at all, so **every assistant
     * turn ran as an editor whatever the caller was**: a VIEWER could ask the assistant to publish and
     * it would, because the publish then goes through an internal route on a service-role client that
     * never consults RLS.
     *
     * The same defect was already found and fixed in the worker, and `worker-context.ts` states the
     * rule this now follows: *"a hardcoded `roleIds: ["editor"]` gave a viewer editor rights ...
     * refused rather than substituted ... guessing is what produced both bugs."* Defaulting an
     * identity is the bug; the friendliest default is the worst one.
     *
     * Refusing rather than falling back to `viewer` is deliberate too. A silent downgrade would make a
     * version skew between the two deployments look like a permissions bug in the product — an
     * assistant that has suddenly lost its tools — whereas a refusal names the header.
     */
    const roles = (request.headers.get("x-roles") ?? "")
      .split(",")
      .map((role) => role.trim().toLowerCase())
      .filter((role) => role !== "");
    if (roles.length === 0) return null;

    return {
      tenantId,
      principalId,
      roleIds: roles,
      locale: request.headers.get("x-content-language") ?? "en",
      timezone: request.headers.get("x-timezone") ?? "UTC",
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    } as unknown as ExecutionContext;
  };
};

/**
 * `ConnectionSetup` — what a person needs in order to connect an account.
 *
 * Deployment-specific by definition: the redirect URL is this deployment's, the credential entries are the
 * *names* of its environment variables, and the console URLs are each platform's. The port refuses a default
 * for that reason, so this is built from `PUBLIC_APP_URL` and refuses without it — a setup naming the wrong
 * redirect URL sends a person to a console to paste a value that will never match, which is worse than
 * saying the deployment is unconfigured.
 *
 * **Never a credential value, only a name.** `credentialVariables` is what `check_account_health` and
 * `get_connection_setup` surface, and `assertNoSecrets` in the accounts tools exists because a setup carrying
 * a real secret would put it in a tool result, which is persisted in the run event log.
 */
export const connectionSetupFrom = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectorDeps["setup"] => {
  const appUrl = env["PUBLIC_APP_URL"];
  if (appUrl === undefined || appUrl === "") {
    throw new Error(
      "PUBLIC_APP_URL is required: the connection setup tells a person which redirect URL to paste into a " +
        "platform's developer console, and a wrong one fails at consent with no explanation.",
    );
  }
  const origin = appUrl.replace(/\/$/, "");
  /**
   * The redirect URL is **per platform**, and this said `/api/connect/callback` — a path no route serves.
   *
   * The web app's callback lives at `/api/connect/[platform]/callback`
   * (`web/src/app/api/connect/[platform]/callback/route.ts`), and `[platform]/route.ts` builds the
   * `redirect_uri` it sends to the provider as `new URL(`/api/connect/${platform}/callback`, publicBase)`.
   * With one shared path the value handed to the user matched nothing: they pasted it into LinkedIn's
   * console, completed consent, and `[platform]` matched the single segment `callback`,
   * `isConnectablePlatform("callback")` was false, and the browser landed on
   * `/accounts?error=Unsupported%20platform:%20callback`. No account could ever connect by following the
   * assistant's own instructions.
   *
   * `connectionSetupFrom`'s docstring names this exact failure — *"a setup naming the wrong redirect URL
   * sends a person to a console to paste a value that will never match"* — which is what makes it worth
   * writing down: the risk was understood, described, and then the value was built wrong anyway. Nothing
   * checked the string against the routes, because nothing can: it is a URL in one package and a
   * directory name in another.
   */
  const redirectFor = (platformId: string): string => `${origin}/api/connect/${platformId}/callback`;

  /**
   * A real condition the type asks about: every platform refuses a plain-http redirect outside localhost, so
   * connecting cannot work until the deployment's URL is fixed. Saying so here is the difference between a
   * person understanding why consent failed and them re-pasting a correct-looking URL forever.
   */
  const insecure = origin.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(origin);
  const setup: ConnectionSetup = {
    // The general form. Each platform below carries its own concrete URL, which is what gets pasted.
    redirectUrl: redirectFor("{platform}"),
    credentialsPageUrl: `${origin}/settings`,
    ...(insecure
      ? {
          warning:
            `PUBLIC_APP_URL is plain http (${origin}). Every platform below refuses a non-https redirect ` +
            `outside localhost, so connecting will fail at consent until the deployment is served over https.`,
        }
      : {}),
    /**
     * The platforms this deployment's web app actually has connect routes for. Names only — the values live
     * in the web app's environment and must never reach a tool result.
     */
    platforms: [
      {
        platformId: "linkedin",
        label: "LinkedIn",
        consoleUrl: "https://www.linkedin.com/developers/apps",
        credentialVariables: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
        consoleFields: [{ label: "Authorized redirect URL", url: redirectFor("linkedin") }],
        scopes: ["w_member_social", "r_basicprofile"],
      },
      {
        platformId: "instagram",
        label: "Instagram",
        consoleUrl: "https://developers.facebook.com/apps",
        credentialVariables: ["META_APP_ID", "META_APP_SECRET"],
        consoleFields: [{ label: "Valid OAuth Redirect URI", url: redirectFor("instagram") }],
        scopes: ["instagram_content_publish", "pages_show_list"],
      },
      {
        platformId: "tiktok",
        label: "TikTok",
        consoleUrl: "https://developers.tiktok.com/apps",
        credentialVariables: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
        consoleFields: [{ label: "Redirect URI", url: redirectFor("tiktok") }],
        scopes: ["video.publish"],
      },
      /*
       * The other eight — #423.
       *
       * `CONNECTABLE_PLATFORMS` has eleven, each with a built connector, and this list named three.
       * Asked how to connect Reddit or YouTube the assistant could not name the console, the scopes
       * or the credentials, which is the entire purpose of the tool: it answered the one question it
       * exists for with "I don't know" for eight of eleven platforms.
       *
       * Every value below is transcribed from `docs/CREDENTIALS.md`, which documents all eleven and
       * is the repo's own record of what was registered. Nothing here is inferred from a platform's
       * public documentation — an invented scope or console URL sends someone to paste a value that
       * will never match, which is exactly the failure the redirect-URL comment above records.
       */
      {
        platformId: "x",
        label: "X (Twitter)",
        consoleUrl: "https://developer.x.com/en/portal/dashboard",
        credentialVariables: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
        consoleFields: [{ label: "Callback URI / Redirect URL", url: redirectFor("x") }],
        scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      },
      {
        platformId: "facebook",
        label: "Facebook",
        consoleUrl: "https://developers.facebook.com/apps",
        credentialVariables: ["META_APP_ID", "META_APP_SECRET", "META_FACEBOOK_CONFIG_ID"],
        consoleFields: [{ label: "Valid OAuth Redirect URI", url: redirectFor("facebook") }],
        scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "business_management"],
      },
      {
        platformId: "threads",
        label: "Threads",
        consoleUrl: "https://developers.facebook.com/apps",
        credentialVariables: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
        consoleFields: [{ label: "Redirect Callback URL", url: redirectFor("threads") }],
        scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies"],
      },
      {
        platformId: "reddit",
        label: "Reddit",
        consoleUrl: "https://www.reddit.com/prefs/apps",
        credentialVariables: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_DEFAULT_SUBREDDIT"],
        consoleFields: [{ label: "redirect uri", url: redirectFor("reddit") }],
        scopes: ["identity", "submit", "read", "privatemessages"],
      },
      {
        platformId: "youtube",
        label: "YouTube",
        consoleUrl: "https://console.cloud.google.com/apis/credentials",
        credentialVariables: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        consoleFields: [{ label: "Authorised redirect URI", url: redirectFor("youtube") }],
        scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
      },
      {
        platformId: "pinterest",
        label: "Pinterest",
        consoleUrl: "https://developers.pinterest.com/apps",
        credentialVariables: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
        consoleFields: [{ label: "Redirect URI", url: redirectFor("pinterest") }],
        scopes: ["boards:read", "pins:read", "pins:write", "user_accounts:read"],
      },
      /*
       * The two that are not OAuth at all, and say so.
       *
       * Telegram is a bot token from a chat with @BotFather, and WhatsApp is a system-user token
       * generated in Business Settings. Neither has a console to register a redirect URL with, and
       * neither has scopes. Listing them with an empty `consoleFields` is the honest answer: the
       * question "what redirect URL do I paste" has no answer for these two, and an invented one
       * would be worse than saying there is none.
       */
      {
        platformId: "telegram",
        label: "Telegram",
        consoleUrl: "https://t.me/BotFather",
        credentialVariables: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_DEFAULT_CHAT_ID"],
        consoleFields: [],
        scopes: [],
      },
      {
        platformId: "whatsapp",
        label: "WhatsApp",
        consoleUrl: "https://developers.facebook.com/apps",
        credentialVariables: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_DEFAULT_RECIPIENT"],
        consoleFields: [],
        scopes: [],
      },
    ],
  };

  /**
   * A **function**, because that is what `ConnectorDeps.setup` is — `createPostgresConnectorService` calls
   * `deps.setup(context)`. The first version of this returned the object above cast through
   * `as unknown as ConnectorDeps["setup"]`: it typechecked, and the first person to ask how to connect
   * LinkedIn would have got `deps.setup is not a function`. The cast was the whole defect, so there is none
   * now — the annotation on `setup` is checked, and the return type is inferred against the real one.
   */
  return () => setup;
};

/**
 * The web toolkit, from the platform — never a second fetcher.
 *
 * `createFetchPage` is where the egress policy, the redirect refusal and the body ceiling live. Writing one
 * here would be a second egress policy, and the one that mattered would be whichever the caller happened to
 * use.
 *
 * **Search degrades rather than refuses.** With no provider configured `createWebSearch` returns
 * `{ searched: false, reason: "not-configured" }`, which `ResearchService` passes straight through — and that
 * is the whole point of the port: the old runtime's `websearch.py` was *"deliberately fail-soft: network
 * errors, timeouts, or a missing package yield an empty result list"*, and an empty list is
 * indistinguishable from "nothing out there", which invites a model to answer from what it believes. A
 * refusal with a reason is usable; an empty list is a lie.
 */
export const webToolkitFrom = async (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const { createWebSearch, createFetchPage } = await import("@retinue/agentkit/tools");
  const { searchProviderFrom } = await import("../adapters/web/search-providers.js");

  /**
   * A **named** provider, defaulting to the keyless one.
   *
   * This block used to build one generic GET provider and only when `RETINUE_SEARCH_API_KEY` *and*
   * `RETINUE_SEARCH_ENDPOINT` were both set — while compose passed the key and a
   * `RETINUE_SEARCH_PROVIDER` nothing read, and never passed the endpoint. So `search_web` was
   * registered and refused every call as "not configured", which reads as a broken tool rather than an
   * unset variable. It also assumed `Authorization: Bearer` and `?q=&count=`, which is the wrong shape
   * for three of the five providers anyone actually uses.
   *
   * `search-providers.ts` holds the table. The default is DuckDuckGo, which needs no key, because that
   * is what the deployment had before the cutover: search works with nothing configured, and a key
   * upgrades the index rather than switching the feature on.
   */
  const choice = searchProviderFrom(env);
  if (!choice.ok) {
    // Reported, because the alternative is an assistant that offers to research and then cannot, and
    // the reason living only in an unset environment variable.
    console.warn(`[shareflow] web search is unavailable: ${choice.why}`);
  }

  return {
    search: createWebSearch(choice.ok ? { provider: choice.provider as never, ...searchEgressFor(choice.name, env) } : {}),
    fetchPage: createFetchPage(),
  };
};

/**
 * The egress policy for a self-hosted search instance — production, 2026-09-28.
 *
 * agentkit's HTTP client defaults to https only and no private networks, which is right for anything a
 * model can point at, and refused the internal SearXNG (`http://searxng:8080`) before a packet left:
 * every search answered `unavailable`. The endpoint is configuration, never model input, so the widening
 * is scoped to exactly that host — `allowedHttpHosts` keeps every other http or private address refused.
 * The hosted providers keep the default.
 */
export const searchEgressFor = (
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): { policy?: { allowedSchemes: string[]; allowPrivateNetworks: boolean; allowedHttpHosts: string[] } } => {
  const endpoint = optionalEnv("RETINUE_SEARCH_ENDPOINT", env);
  if (name !== "searxng" || endpoint === undefined) return {};
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return {};
  }
  if (host === "") return {};
  return { policy: { allowedSchemes: ["https", "http"], allowPrivateNetworks: true, allowedHttpHosts: [host] } };
};

/**
 * Structured generation over the configured model.
 *
 * `generateObject` rather than prose parsing, for `ContentGenerator`'s own reason: asking for prose and
 * parsing it fails the day a model writes "Here are three angles:" before the list, and that failure looks
 * like the model being bad at the task rather than the adapter being bad at reading.
 *
 * Pricing is zeroed deliberately — a cost derived from invented prices is worse than an obvious zero, and the
 * usage ledger showing 0 is readable as "not priced" where a plausible wrong number is not.
 */
/**
 * `prompt` or `messages` — **never both**, which is why this is a function rather than a spread.
 *
 * The `ai` SDK rejects a call carrying both, and that failure has no test to catch it: the deployment's
 * generate needs a real provider, so nothing exercises it locally. Extracted so the *choice* is testable
 * even though the call is not — a mutation adding `prompt` back alongside `messages` now fails a unit
 * test instead of the first vision call in production.
 *
 * Without an image the `prompt` string is passed through exactly as before: it is the well-trodden path,
 * and the one a real model call exercised (the since-removed `scripts/shadow-turn.mjs`).
 */
export const promptOrMessages = (
  prompt: string,
  image?: { readonly bytes: Uint8Array; readonly mime: string },
): Record<string, unknown> =>
  image === undefined
    ? { prompt }
    : {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              /**
               * A **`file`** part, not an `image` one, and raw bytes rather than a `data:` URL.
               *
               * Both halves were measured against a real Gemini call. `{ type: "image", image: bytes }`
               * works — and logs *"The 'image' content part type is deprecated. Use a 'file' part with
               * mediaType"*. That is the fourth time on this project that a deprecated spelling has
               * worked well enough to ship silently; a warning nobody reads is how it survives to the
               * release that removes it.
               *
               * Raw bytes because the SDK encodes them itself: a `data:` URL would be a second encoding
               * of the same thing, and the media type would then have to agree in two places.
               */
              { type: "file", data: image.bytes, mediaType: image.mime },
            ],
          },
        ],
      };

/**
 * Reading one of the workspace's own media assets as bytes.
 *
 * Three steps, and the order is the tenant boundary: the asset's **path** is read from
 * `generated_assets` scoped by `workspace_id`, the web app signs that path (checking the workspace
 * prefix again on its side), and the signed URL is fetched through the same guarded reader a linked file
 * goes through.
 *
 * The path never leaves this function. `MediaService` does not return one and neither does any tool —
 * *"a signed URL in a tool result is persisted in the run event log and readable by anyone who can read
 * the conversation"* — and the same is true of the object key it is signed from.
 *
 * Two lookups rather than one because the two checks answer different questions: the query proves the
 * asset belongs to this workspace, and the endpoint proves the *path* does. Either alone would be
 * enough today; both means a mistake in one is not a leak.
 */
export const mediaBytesFrom = (deps: {
  readonly sql: SqlExecutor;
  readonly internal: InternalWebApp;
  readonly fetchImpl?: typeof fetch;
}): NonNullable<ShareFlowAdapterConfig["readMediaBytes"]> =>
  async ({ context, assetId }) => {
    /*
     * #607: a `chorus-media:` reference names its path directly. It is still this workspace's only if it is
     * under the workspace's own folder — the same prefix `attachPathsToDraft` requires, checked again by the
     * app when it signs.
     */
    if (assetId.startsWith("chorus-media:")) {
      const path = assetId.slice("chorus-media:".length);
      // `%` and `\\` too: an encoded or backslashed `..` must not slip past the plain-text check.
      if (!path.startsWith(`${String(context.tenantId)}/`) || path.includes("..") || /[%\\]/.test(path)) {
        throw new AgentPlatformError({ code: "not_found", message: "That file is not in this workspace.", retryable: false });
      }
      const url = await deps.internal.signMediaUrl({ context, path });
      const { fetchGuardedBytes, MAX_IMAGE_BYTES, MAX_PDF_BYTES } = await import("../adapters/web/research.js");
      const bytes = await fetchGuardedBytes(url, {
        maxBytes: Math.max(MAX_PDF_BYTES, MAX_IMAGE_BYTES),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      return { bytes };
    }
    const rows = await deps.sql.query<{ storage_path: string; mime: string | null }>(
      "select storage_path, mime from public.generated_assets where workspace_id = $1::uuid and id = $2::uuid",
      [String(context.tenantId), assetId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AgentPlatformError({
        code: "not_found",
        message: `No media asset ${assetId} in this workspace.`,
        retryable: false,
      });
    }

    const url = await deps.internal.signMediaUrl({ context, path: row.storage_path });
    const { fetchGuardedBytes, MAX_IMAGE_BYTES, MAX_PDF_BYTES } = await import("../adapters/web/research.js");
    /**
     * The larger of the two caps, because this one function serves both readers.
     *
     * A tighter cap here would refuse a legitimate 20 MB PDF for `read_pdf`; the *image* ceiling is a
     * provider limit and is enforced where the provider is, in `readImage`.
     */
    const bytes = await fetchGuardedBytes(url, {
      maxBytes: Math.max(MAX_PDF_BYTES, MAX_IMAGE_BYTES),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    return { bytes, ...(row.mime === null || row.mime === "" ? {} : { mime: row.mime }) };
  };

/**
 * Telling the model the shape, because the provider may not have — #469.
 *
 * ## Two failures, one cause
 *
 * `generateObject` hands the AI SDK a schema, and ai@7 passes the adapter
 * `responseFormat: { type: "json", schema }`. What the adapter does with it is the adapter's business.
 * Where structured output is native — Google, Anthropic, OpenAI's `json_schema` — the schema reaches
 * the provider and is enforced. An **OpenAI-compatible** endpoint has no such mode, so the adapter
 * downgrades to `response_format: { type: "json_object" }` — **and the schema is dropped on the way**.
 *
 * Both failures this produced were measured against production, in order:
 *
 * 1. `'messages' must contain the word 'json' in some form, to use 'response_format' of type
 *    'json_object'.` — the API refuses a `json_object` request whose messages never say "json", which
 *    is a real guard: such a request reliably comes back as prose. None of the fourteen generator
 *    prompts contained the word (`grep -c json` returned 0).
 * 2. With the word added: `No object generated: response did not match schema.` — the request was
 *    accepted, and the model invented a shape, because **nothing had told it what the schema was**.
 *
 * The first was the symptom people saw; the second is the actual defect, and fixing only the first
 * moves the error one layer down without making generation work.
 *
 * ## So the schema goes in the prompt
 *
 * Converted with the SDK's own `zodSchema(...).jsonSchema` rather than a second converter: it is what
 * `generateObject` itself would have sent, so the description the model reads and the shape the
 * validator enforces cannot drift apart.
 *
 * Applied for **every** provider, not only the compatible ones. Whether an adapter forwards or drops
 * the schema is a fact about that adapter's version, and a fix conditioned on the provider name would
 * silently stop covering the next one that downgrades. For a provider that does enforce natively this
 * is a redundant instruction agreeing with the enforcement, which costs a few tokens and no
 * correctness.
 */
type ZodToJsonSchema = (schema: never) => { jsonSchema?: unknown };

const describeSchema = (schema: unknown, toJsonSchema: ZodToJsonSchema): string | undefined => {
  try {
    const converted = toJsonSchema(schema as never);
    const shape = JSON.stringify(converted.jsonSchema);
    /**
     * Omitted rather than truncated when it is implausibly large.
     *
     * A cut-off schema is invalid JSON describing a shape that does not exist, which is worse than no
     * description at all — the model would follow it. Nothing here comes close to this; the guard is
     * for the schema somebody adds later.
     */
    return shape === undefined || shape.length > 20_000 ? undefined : shape;
  } catch {
    // A caller may hand over something that is not a zod schema. Losing the description is a worse
    // answer, not a broken one.
    return undefined;
  }
};

/**
 * The system prompt the model actually receives.
 *
 * Exported so the seam is testable: the whole failure was a prompt that did not say something, and a
 * helper that computes the right string and is never passed to `generateObject` would leave every
 * affected workspace exactly as broken.
 */
export const withJsonClause = (system: string, schema?: unknown, toJsonSchema?: ZodToJsonSchema): string => {
  const shape =
    schema === undefined || toJsonSchema === undefined ? undefined : describeSchema(schema, toJsonSchema);
  if (shape !== undefined) {
    return (
      `${system}\n\nRespond with a single JSON object matching this schema exactly, and with nothing ` +
      `else — no prose, no code fence:\n${shape}`
    );
  }
  /**
   * No schema to show, so at least satisfy the API's rule. `json_object` refuses a request whose
   * messages never say "json", and a refused request is a worse outcome than an unguided one.
   */
  return /json/i.test(system)
    ? system
    : `${system}\n\nRespond with a single JSON object that matches the requested schema exactly, and with nothing else.`;
};

/**
 * The JSON object inside a reply that is not only JSON — the SDK's `repairText` hook.
 *
 * `draft_post_for_channels` on qwen3.5-omni-flash (production, 2026-09-28) failed with `No object
 * generated: could not parse the response.` while the same call on gpt-4.1-mini succeeded. Told to answer
 * with bare JSON, an OpenAI-compatible model still wraps it in a ```json fence or a sentence. The object is
 * there; this takes it: a fenced block first, else the outermost braces. It never invents one — no
 * parseable object, `null`, and the SDK reports the original failure.
 */
export const jsonFromReply = (text: string): string | null => {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced !== undefined) candidates.push(fenced.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next shape.
    }
  }
  return null;
};

export const structuredGenerateFrom = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: {
    /**
     * The workspace's own provider, looked up per call — the BYO wire (#462).
     *
     * Optional, and absent means every workspace is served by this deployment's model, which is what
     * this function did unconditionally before. Optional rather than required because two callers
     * build a generator and only those with a `SqlExecutor` can supply one; a required parameter would
     * have made the composition lie about what it has.
     */
    readonly workspaceModel?: WorkspaceModelResolver;
    /** #499: where a tool's model call lands on the usage ledger. Absent, nothing is recorded. */
    readonly recordUsage?: RecordToolUsage;
  } = {},
): Promise<StructuredGenerate> => {
  /**
   * Through the shared selection in `model.ts`, not a second copy.
   *
   * This used to read `RETINUE_MODEL_PROVIDER`, `RETINUE_MODEL_ID` and the key itself. The engine then
   * needed the same three, and two readings of the same variables agree by coincidence until one gains
   * a default the other does not — a deployment drafting with one vendor and conversing with another,
   * both working, on one key, with nothing to see.
   */
  const { modelSelectionFrom } = await import("./model.js");
  const selection = await modelSelectionFrom(env);
  const { createProviderFactory } = await import("@retinue/agentkit/providers");
  const { generateObject, zodSchema } = await import("ai");

  /**
   * One provider client per distinct credential, not one per call.
   *
   * The comment in `main.ts` that defends resolving the model at boot — *"resolving per request would
   * open a provider client per turn"* — is about **this** cost, and it survives BYO intact: the
   * *lookup* is now per call, because a revoked key must stop working at once, but the *client* is
   * still built once per credential and reused for every generation that resolves to it.
   *
   * Keyed on the credential itself so that rotating a workspace's key produces a new client rather
   * than reusing one holding the old secret — keying on the tenant id would have been the bug where a
   * rotated key keeps working until the process restarts. The map holds decrypted keys in memory for
   * the life of the process, which is already true of this deployment's own key, and is never logged
   * or serialised.
   */
  const factories = new Map<string, ReturnType<typeof createProviderFactory>>();
  const factoryFor = (provider: string, apiKey: string | undefined, baseURL: string | undefined) => {
    const cacheKey = `${provider}\u0000${apiKey ?? ""}\u0000${baseURL ?? ""}`;
    const existing = factories.get(cacheKey);
    if (existing !== undefined) return existing;
    const built = createProviderFactory({
      credentials: {
        [provider]: {
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(baseURL === undefined ? {} : { baseURL }),
          name: "shareflow",
        },
      },
    } as never);
    factories.set(cacheKey, built);
    return built;
  };

  /**
   * The definition, for whichever model is being used this call.
   *
   * `pricing` is zero here for the deployment's model and for a workspace's alike, unchanged from
   * before. That is not an oversight and it is not a measurement: structured generation does not go
   * through the engine's usage ledger at all, so there is no figure being under-reported — there is no
   * figure. Where a BYO model *is* concerned the honest cost is zero to this platform by definition,
   * because the tokens are billed to the customer's own account, which is the entire point of the
   * feature.
   */
  const definitionFor = (provider: string, modelId: string) => ({
    id: modelId,
    provider,
    modelId,
    displayName: modelId,
    capabilities: { tools: true, streaming: true, structuredOutput: true },
    limits: { contextWindow: 0, maxOutputTokens: 0 },
    pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 },
  });

  const platform = {
    factory: factoryFor(selection.provider, selection.apiKey, undefined),
    definition: definitionFor(selection.provider, selection.modelId),
  };

  return (async ({ context, system, prompt, schema, image, modelId }) => {
    /**
     * The workspace's model if it has one, this deployment's otherwise — decided per call.
     *
     * `context` was already a required field of `StructuredGenerate`, documented as being there
     * because *"`StructuredGenerate` needs a context to resolve the model, its credentials and its cost
     * ceiling"*. It was accepted and then thrown away: every call resolved the same env-derived model
     * regardless of whose workspace was generating. That is the whole of the defect this fixes, and it
     * is one destructured field wide.
     *
     * A resolver that throws must not take generation down with it, so it is guarded here as well as
     * internally — the fallback is always this deployment's model, never a failed generation.
     */
    // #657: a small model on the deployment's key, when the caller asks for one (thread summaries).
    let chosen =
      modelId === undefined || modelId === selection.modelId ? platform : { factory: platform.factory, definition: definitionFor(selection.provider, modelId) };
    let ranOnWorkspaceModel = false;
    if (deps.workspaceModel !== undefined) {
      let workspace: Awaited<ReturnType<WorkspaceModelResolver>>;
      try {
        workspace = await deps.workspaceModel(context);
      } catch (error) {
        console.warn(
          `[shareflow] resolving the BYO provider for workspace ${String(context.tenantId)} threw (${
            error instanceof Error ? error.message : String(error)
          }) — using this deployment's model.`,
        );
        workspace = undefined;
      }
      if (workspace !== undefined) {
        ranOnWorkspaceModel = true;
        chosen = {
          factory: factoryFor(workspace.provider, workspace.apiKey, workspace.baseUrl),
          definition: definitionFor(workspace.provider, workspace.modelId),
        };
      }
    }

    /**
     * The options object is cast, and the reason is the overload rather than the behaviour.
     *
     * This exact call — `generateObject({ model, system, prompt, schema })` — is what
     * the since-removed `scripts/shadow-turn.mjs` ran against a real model, so the call shape is known to
     * work. The script is `.mjs` and therefore untyped; typed, this `ai` version's `generateObject`
     * resolves to an overload whose options do not admit `schema` in that position.
     *
     * So the cast records "the types disagree with a call that demonstrably works", not "I do not know what
     * this returns". The narrow alternative — restating the whole option union — would be a second copy of
     * a vendor's types to keep in step, and it would be the copy that went stale.
     */
    const result = await generateObject({
      model: (chosen.factory as unknown as { languageModel: (d: unknown) => never }).languageModel(
        chosen.definition,
      ),
      system: withJsonClause(system, schema, zodSchema as unknown as ZodToJsonSchema),
      ...promptOrMessages(prompt, image),
      schema,
      // Runs on a parse or a schema failure. Valid JSON comes back unchanged and fails the schema again, as it should.
      repairText: async ({ text }: { text: string }) => jsonFromReply(text),
    } as never);
    /*
     * The tokens the SDK reports, onto the ledger — #499. Awaited but never allowed to fail the call:
     * a caption the person asked for is worth more than a usage row about it.
     */
    if (deps.recordUsage !== undefined) {
      const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }).usage;
      try {
        await deps.recordUsage(context, {
          modelId: chosen.definition.modelId,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          ...(usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
          ranOnWorkspaceModel,
        });
      } catch (error) {
        console.warn(`[shareflow] a tool's model usage was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return (result as { object: unknown }).object;
  }) as StructuredGenerate;
};
