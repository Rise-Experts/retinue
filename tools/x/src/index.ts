/**
 * X (Twitter) API v2 — REQ-053 (#227), task #230.
 *
 * ## The thing this package exists to get right: two limits that look identical
 *
 * X enforces **two** rate limits on the same endpoints and reports both as `429`:
 *
 * - a **per-15-minute burst limit**, reported in `x-rate-limit-remaining` / `x-rate-limit-reset`, and
 * - a **24-hour cap** on posts and reads, reported in `x-user-limit-24hour-remaining` / `-reset`.
 *
 * A naive `429` handler treats them the same, so a run that exhausts its daily cap sits in exponential backoff
 * against a limit that resets *tomorrow* — burning the run's whole budget waiting for something that cannot
 * happen. That is the specific failure mode here, and it is why `classifyRateLimit` reads the headers rather
 * than the status: a burst limit is retryable, a daily cap is not.
 *
 * ## Why the read tools report their tier
 *
 * X's free tier cannot search at all, Basic searches only the last 7 days, and only Pro reaches the full
 * archive. An empty result therefore means "nothing matched", "your tier cannot see back that far", or "your
 * tier cannot do this" — and the API does not distinguish them. Saying so beats a model concluding a topic was
 * never discussed.
 */

import {
  confirms,
  createVendorTransport,
  defineTool,
  destroys,
  type CredentialRef,
  type CredentialResolver,
  type Tool,
  type ToolProvider,
  type ToolkitAuth,
  type VendorFailure,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

const API = "https://api.x.com";
const DEFAULT_LIMIT = 10;
/** X's own floor and ceiling for these endpoints. Asking for 5 is an error, not a smaller page. */
const MIN_RESULTS = 10;
const MAX_RESULTS = 100;

/** X's hard limit on a post. Counted in code points, which is not what `String.length` returns. */
export const MAX_POST_LENGTH = 280;

export type XToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /**
   * What the deployment pays for. Reported in read results so an empty answer is interpretable, and used to
   * refuse a search the tier cannot perform rather than letting X return an opaque 403.
   */
  readonly tier?: "free" | "basic" | "pro" | "enterprise";
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/** How far back each tier can search. `null` means the tier cannot search at all. */
const SEARCH_WINDOW: Readonly<Record<string, string | null>> = {
  free: null,
  basic: "the last 7 days",
  pro: "the full archive",
  enterprise: "the full archive",
};

/**
 * Which of X's two rate limits was hit — the distinction AC-3 is about.
 *
 * Exported because it is the interesting logic in this file and deserves a direct test: a header shape is easy
 * to get subtly wrong, and the consequence of getting it wrong is invisible until a run wastes an hour.
 */
export const classifyRateLimit = (
  failure: VendorFailure,
): { code: "rate_limited"; message: string; retryable: boolean; retryAfterMs?: number } | undefined => {
  if (failure.status !== 429) return undefined;
  const headers = failure.headers ?? {};
  const dailyRemaining = headers["x-user-limit-24hour-remaining"] ?? headers["x-app-limit-24hour-remaining"];
  const dailyReset = headers["x-user-limit-24hour-reset"] ?? headers["x-app-limit-24hour-reset"];

  if (dailyRemaining !== undefined && Number(dailyRemaining) <= 0) {
    /**
     * The daily cap. **Not retryable**, and that is the whole point of this function.
     *
     * Marking it retryable makes the runtime back off against a limit that resets tomorrow, which consumes the
     * run's entire budget waiting for something that cannot happen inside it. `retryAfterMs` is deliberately
     * *not* set: a delay this long is not a delay, it is a different day.
     */
    const resetAt = Number(dailyReset);
    const when = Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toISOString() : "in under 24 hours";
    return {
      code: "rate_limited",
      message:
        `X's 24-hour cap for this endpoint is exhausted; it resets ${when}. This is not a burst limit and ` +
        "waiting will not help within this run — stop, and try again after the reset.",
      retryable: false,
    };
  }

  // The 15-minute burst window. Genuinely retryable, and X says exactly when.
  const reset = Number(headers["x-rate-limit-reset"]);
  const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(reset * 1000 - Date.now(), 0) : undefined;
  return {
    code: "rate_limited",
    message: `X's 15-minute rate limit is exhausted${waitMs === undefined ? "" : `; it resets in ${Math.ceil(waitMs / 1000)}s`}.`,
    retryable: true,
    ...(waitMs === undefined
      ? failure.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: failure.retryAfterMs }
      : { retryAfterMs: waitMs }),
  };
};

/** Code points, not UTF-16 units — an emoji is one character to X and two to `String.length`. */
export const postLength = (text: string): number => [...text].length;

const summarisePost = (post: Json, users: Map<string, Json>): Json => {
  const metrics = (post.public_metrics ?? {}) as Json;
  const author = typeof post.author_id === "string" ? users.get(post.author_id) : undefined;
  return {
    id: post.id,
    text: post.text,
    author: author === undefined ? post.author_id : `@${String(author.username)}`,
    postedAt: post.created_at,
    replies: metrics.reply_count,
    reposts: metrics.retweet_count,
    likes: metrics.like_count,
    ...(post.conversation_id === undefined ? {} : { conversationId: post.conversation_id }),
  };
};

const usersFrom = (payload: Json | undefined): Map<string, Json> => {
  const includes = (payload?.includes ?? {}) as Json;
  const users = Array.isArray(includes.users) ? includes.users : [];
  return new Map(users.map((raw) => [String((raw as Json).id), raw as Json]));
};

const POST_FIELDS = "tweet.fields=created_at,public_metrics,conversation_id,author_id&expansions=author_id&user.fields=username,name";

export const createXToolkit = (config: XToolkitConfig): ToolProvider => {
  const tier = config.tier ?? "basic";
  const transport: VendorTransport = createVendorTransport({
    vendor: "X",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? API,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify: (failure) =>
      classifyRateLimit(failure) ??
      (failure.status === 403
        ? {
            // X answers 403 both for a missing permission and for a tier that does not include the endpoint,
            // and the message rarely says which. Naming both beats a model retrying with different arguments.
            code: "unauthorized" as const,
            message:
              `X refused this request (403): ${failure.reason}. This is either a missing scope on the token or ` +
              `an endpoint your access tier (${tier}) does not include — the API does not distinguish them.`,
            retryable: false,
          }
        : undefined),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const tools: readonly Tool[] = [
    defineTool({
      name: "x_search_posts",
      label: "Search posts",
      description:
        "Search recent posts on X with a query. **How far back this reaches depends on the access tier** — the result says which window was searched, so an empty answer is not mistaken for 'nobody discussed this'.",
      category: "communication",
      execute: async (input: { query: string; limit?: number }, context) => {
        const window = SEARCH_WINDOW[tier] ?? null;
        if (window === null) {
          /**
           * Refused locally. X's free tier cannot search at all and answers `403` with a message about a
           * "client-not-enrolled" product — which a model reads as a transient permission problem and retries.
           */
          throw new AgentPlatformError({
            code: "capability_unavailable",
            message:
              "The X free tier cannot search posts at all. Searching needs at least the Basic tier (last 7 days) " +
              "or Pro (full archive). This is a subscription, not a permission, so no retry will help.",
            retryable: false,
          });
        }
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, MIN_RESULTS), MAX_RESULTS);
        const payload = (await transport.json(
          context,
          `/2/tweets/search/recent?query=${encodeURIComponent(input.query)}&max_results=${limit}&${POST_FIELDS}`,
        )) as Json | undefined;
        const posts = (Array.isArray(payload?.data) ? payload.data : []) as Json[];
        const users = usersFrom(payload);
        const meta = (payload?.meta ?? {}) as Json;
        return {
          posts: posts.map((post) => summarisePost(post, users)),
          // Stated rather than implied, every time — including when there were results.
          searched: window,
          tier,
          truncated: meta.next_token !== undefined,
        };
      },
    }),
    defineTool({
      name: "x_get_post",
      label: "Read a post",
      description: "Read one post by id, with its author and public metrics.",
      category: "communication",
      execute: async (input: { id: string }, context) => {
        const payload = (await transport.json(context, `/2/tweets/${encodeURIComponent(input.id)}?${POST_FIELDS}`)) as Json | undefined;
        const post = (payload?.data ?? {}) as Json;
        return summarisePost(post, usersFrom(payload));
      },
    }),
    defineTool({
      name: "x_get_user",
      label: "Read a user",
      description: "Read a user by handle (without the @) or by id: name, description, and follower counts.",
      category: "communication",
      execute: async (input: { handle?: string; id?: string }, context) => {
        if ((input.handle === undefined) === (input.id === undefined)) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "x_get_user needs exactly one of handle or id.",
            retryable: false,
          });
        }
        const path =
          input.handle === undefined
            ? `/2/users/${encodeURIComponent(input.id as string)}`
            : `/2/users/by/username/${encodeURIComponent(input.handle.replace(/^@/, ""))}`;
        const payload = (await transport.json(context, `${path}?user.fields=description,public_metrics,verified,created_at`)) as Json | undefined;
        const user = (payload?.data ?? {}) as Json;
        const metrics = (user.public_metrics ?? {}) as Json;
        return {
          id: user.id,
          handle: user.username === undefined ? undefined : `@${String(user.username)}`,
          name: user.name,
          description: user.description,
          followers: metrics.followers_count,
          following: metrics.following_count,
          posts: metrics.tweet_count,
        };
      },
    }),
    defineTool({
      name: "x_list_user_posts",
      label: "List a user's posts",
      description: "List a user's recent posts by their id — use x_get_user to turn a handle into one.",
      category: "communication",
      execute: async (input: { userId: string; limit?: number }, context) => {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 5), MAX_RESULTS);
        const payload = (await transport.json(
          context,
          `/2/users/${encodeURIComponent(input.userId)}/tweets?max_results=${limit}&${POST_FIELDS}`,
        )) as Json | undefined;
        const posts = (Array.isArray(payload?.data) ? payload.data : []) as Json[];
        const meta = (payload?.meta ?? {}) as Json;
        return { posts: posts.map((post) => summarisePost(post, usersFrom(payload))), truncated: meta.next_token !== undefined };
      },
    }),
    confirms({
      name: "x_post",
      label: "Publish a post",
      description:
        "Publish a post to X. **This is public and immediate** — visible to every follower and to search the moment it lands. Optionally a reply to an existing post. Requires approval.",
      category: "publishing",
      execute: async (input: { text: string; replyToId?: string }, context) => {
        const length = postLength(input.text);
        if (length === 0) {
          throw new AgentPlatformError({ code: "invalid_input", message: "x_post was called with no text.", retryable: false });
        }
        if (length > MAX_POST_LENGTH) {
          /**
           * Refused locally, and counted in **code points**.
           *
           * `String.length` counts UTF-16 units, so a post of 200 emoji measures 400 and would be refused
           * wrongly — while X counts what a person would call characters. Getting this wrong in either
           * direction produces a confusing failure about a post that looks the right length.
           */
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `A post may be at most ${MAX_POST_LENGTH} characters and this one is ${length}. Shorten it, or split it into a thread by replying to the first post.`,
            retryable: false,
          });
        }
        const payload = (await transport.json(context, "/2/tweets", {
          method: "POST",
          body: {
            text: input.text,
            ...(input.replyToId === undefined ? {} : { reply: { in_reply_to_tweet_id: input.replyToId } }),
          },
        })) as Json | undefined;
        const created = (payload?.data ?? {}) as Json;
        return { id: created.id, text: created.text, url: created.id === undefined ? undefined : `https://x.com/i/status/${String(created.id)}` };
      },
    }),
    /**
     * `destroys()`, and #228's decision does not change that — AC-2.
     *
     * The deletion is irreversible *and* public: followers who saw the post cannot unsee it, and a deleted post
     * is itself a visible act. `destroys()` sets effect, approval and idempotency together and the type forbids
     * overriding any of them.
     */
    destroys({
      name: "x_delete_post",
      label: "Delete a post",
      description:
        "Delete one of the account's own posts. **This cannot be undone**, and deletion is itself public — anyone who saw or archived the post still has it. Requires approval.",
      category: "publishing",
      execute: async (input: { id: string }, context) => {
        const payload = (await transport.json(context, `/2/tweets/${encodeURIComponent(input.id)}`, { method: "DELETE" })) as Json | undefined;
        const data = (payload?.data ?? {}) as Json;
        if (data.deleted !== true) {
          // X answers `200` with `{"data":{"deleted":false}}` when it declined, which a status check misses
          // entirely — the same envelope lesson as Slack's `ok: false`.
          throw new AgentPlatformError({
            code: "provider_error",
            message: `X reported that post ${input.id} was not deleted.`,
            retryable: false,
          });
        }
        return { id: input.id, deleted: true };
      },
    }),
  ];

  return {
    id: "x",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What X accepts — #260 AC-2.
 *
 * Both modes are bearers on the wire and are *not* interchangeable: an app-only bearer can read but cannot
 * post, because a post needs a user context. That is exactly the distinction `modes` exists to record, and it
 * is why a deployment that only reads can use the simpler credential.
 */
export const X_AUTH: ToolkitAuth = { modes: ["token", "oauth2"], schemes: ["bearer"] };

export const X_TOOL_NAMES = [
  "x_search_posts",
  "x_get_post",
  "x_get_user",
  "x_list_user_posts",
  "x_post",
  "x_delete_post",
] as const;
