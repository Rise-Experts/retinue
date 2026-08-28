/**
 * Reddit — REQ-053 (#227), task #230.
 *
 * ## Two things Reddit will punish you for, and this package handles
 *
 * **1. The `User-Agent` is not optional.** Reddit answers a missing or generic one with a `429` that looks
 * exactly like a rate limit and is not — so a client backs off, retries, is refused again, and concludes the
 * API is overloaded. Reddit's own guidance asks for `platform:app-id:version (by /u/username)`, and this
 * package requires the app id and contact rather than defaulting to something anonymous.
 *
 * **2. Subreddit rules are not machine-readable.** Every subreddit has its own posting rules, karma
 * thresholds, account-age gates and flair requirements, and none of them is in the API. A submission that
 * violates one is removed by a moderator or an automod minutes later, and the API reported success. This
 * package cannot fix that; what it can do is refuse to pretend, so the tool's description and the integration
 * page both say the operator owns it.
 *
 * ## Why comment trees are bounded
 *
 * A Reddit thread is a tree that can hold tens of thousands of comments, arriving as nested `Listing` objects
 * with `more` placeholders that need further requests. Reading one unbounded is both a request storm and more
 * text than a context window holds — so the walk is bounded by depth and count, and **says which bound it
 * hit**.
 */

import {
  confirms,
  createVendorTransport,
  defineTool,
  type CredentialRef,
  type CredentialResolver,
  type Tool,
  type ToolProvider,
  type ToolkitAuth,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

const API = "https://oauth.reddit.com";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Bounds on a comment tree — AC-5. */
export const MAX_COMMENT_DEPTH = 4;
export const MAX_COMMENTS = 200;

export type RedditToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /**
   * The `User-Agent` Reddit requires — AC-4.
   *
   * Required rather than defaulted. A shared default would make every deployment of this package look like one
   * client to Reddit's rate limiter, which is precisely what the requirement exists to prevent, and a generic
   * one earns the opaque `429` described in the file header.
   */
  readonly userAgent: { readonly appId: string; readonly version: string; readonly contact: string };
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/** Reddit's requested format: `platform:app-id:version (by /u/username)`. */
export const userAgentString = (parts: RedditToolkitConfig["userAgent"]): string => {
  for (const [name, value] of Object.entries(parts)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          `createRedditToolkit needs a non-empty userAgent.${name}. Reddit answers a missing or generic ` +
          "User-Agent with a 429 that looks like a rate limit and is not, so this is required rather than " +
          "defaulted.",
        retryable: false,
      });
    }
  }
  const contact = parts.contact.startsWith("/u/") || parts.contact.includes("@") ? parts.contact : `/u/${parts.contact}`;
  return `retinue:${parts.appId}:${parts.version} (by ${contact})`;
};

type Comment = { author: string; body: string; score: number; at: number; replies: Comment[] };

/**
 * Reddit's nested `Listing` shape, flattened and bounded — AC-5.
 *
 * Exported for its own test: the shape is `{ kind: "Listing", data: { children: [{ kind: "t1", data: {…} }] } }`
 * with `more` placeholders mixed in, and a walker that mishandles either returns a plausible-looking partial
 * tree with no indication that it stopped.
 */
export const flattenComments = (
  listing: unknown,
  bounds: { depth?: number; count?: number } = {},
): { comments: Comment[]; truncated: boolean; stoppedBy: "depth" | "count" | "more" | null; read: number } => {
  const maxDepth = bounds.depth ?? MAX_COMMENT_DEPTH;
  const maxCount = bounds.count ?? MAX_COMMENTS;
  let read = 0;
  let stoppedBy: "depth" | "count" | "more" | null = null;

  const walk = (node: unknown, depth: number): Comment[] => {
    const data = ((node as Json | undefined)?.data ?? {}) as Json;
    const children = Array.isArray(data.children) ? data.children : [];
    const out: Comment[] = [];
    for (const raw of children) {
      const child = raw as Json;
      if (child.kind === "more") {
        // A `more` placeholder means Reddit withheld a branch. Recording it is the difference between "that is
        // the whole thread" and "there is more that was not fetched".
        stoppedBy = stoppedBy ?? "more";
        continue;
      }
      if (child.kind !== "t1") continue;
      if (read >= maxCount) {
        stoppedBy = "count";
        return out;
      }
      read += 1;
      const comment = (child.data ?? {}) as Json;
      const replies =
        depth + 1 > maxDepth
          ? ((): Comment[] => {
              if (comment.replies !== undefined && comment.replies !== "") stoppedBy = stoppedBy ?? "depth";
              return [];
            })()
          : comment.replies === undefined || comment.replies === ""
            ? []
            : walk(comment.replies, depth + 1);
      out.push({
        author: String(comment.author ?? "[deleted]"),
        body: String(comment.body ?? ""),
        score: Number(comment.score ?? 0),
        at: Number(comment.created_utc ?? 0),
        replies,
      });
    }
    return out;
  };

  const comments = walk(listing, 0);
  return { comments, truncated: stoppedBy !== null, stoppedBy, read };
};

const summarisePost = (post: Json): Json => ({
  id: post.name ?? (post.id === undefined ? undefined : `t3_${String(post.id)}`),
  title: post.title,
  author: post.author,
  subreddit: post.subreddit,
  score: post.score,
  comments: post.num_comments,
  url: post.permalink === undefined ? post.url : `https://reddit.com${String(post.permalink)}`,
  // A self post's body; a link post's target. Both matter and they are different fields.
  ...(post.is_self === true ? { body: post.selftext } : { link: post.url }),
  postedAt: post.created_utc,
  flair: post.link_flair_text ?? null,
});

export const createRedditToolkit = (config: RedditToolkitConfig): ToolProvider => {
  // Built at construction, so a missing part fails at boot rather than at the first turn that needed it.
  const agent = userAgentString(config.userAgent);
  const transport: VendorTransport = createVendorTransport({
    vendor: "Reddit",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? API,
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": agent },
    classify: (failure) => {
      if (failure.status === 429) {
        return {
          code: "rate_limited" as const,
          message:
            `Reddit rate limit reached: ${failure.reason}. Note that Reddit also answers 429 for a missing or ` +
            `generic User-Agent — this client sends "${agent}", so if this repeats immediately it is a genuine limit.`,
          retryable: true,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        };
      }
      if (failure.status === 403) {
        return {
          code: "unauthorized" as const,
          message:
            `Reddit refused this request (403): ${failure.reason}. On a subreddit this usually means it is ` +
            "private, quarantined, or restricts posting by karma or account age — none of which the API exposes.",
          retryable: false,
        };
      }
      return undefined;
    },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const tools: readonly Tool[] = [
    defineTool({
      name: "reddit_search",
      label: "Search Reddit",
      description:
        "Search Reddit by text, across the site or within one subreddit. Returns each result's id, title, subreddit, score and comment count.",
      category: "communication",
      execute: async (input: { query: string; subreddit?: string; sort?: "relevance" | "hot" | "top" | "new"; limit?: number }, context) => {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const scope = input.subreddit === undefined ? "" : `/r/${encodeURIComponent(input.subreddit)}`;
        const restrict = input.subreddit === undefined ? "" : "&restrict_sr=1";
        const payload = (await transport.json(
          context,
          `${scope}/search?q=${encodeURIComponent(input.query)}&sort=${input.sort ?? "relevance"}&limit=${limit}${restrict}`,
        )) as Json | undefined;
        const data = (payload?.data ?? {}) as Json;
        const children = (Array.isArray(data.children) ? data.children : []) as Json[];
        return {
          posts: children.map((child) => summarisePost((child.data ?? {}) as Json)),
          truncated: data.after !== null && data.after !== undefined,
        };
      },
    }),
    defineTool({
      name: "reddit_get_post",
      label: "Read a post and its comments",
      description:
        "Read one Reddit post with a bounded slice of its comment tree. Deep or very large threads are truncated, and the result says which limit stopped it — a thread can hold tens of thousands of comments.",
      category: "communication",
      execute: async (input: { id: string; sort?: "confidence" | "top" | "new"; maxDepth?: number }, context) => {
        // Reddit's article id is the `t3_`-less form; accepting either spares the caller a rule.
        const article = input.id.replace(/^t3_/, "");
        const payload = await transport.json(
          context,
          `/comments/${encodeURIComponent(article)}?sort=${input.sort ?? "confidence"}&limit=${MAX_COMMENTS}&depth=${MAX_COMMENT_DEPTH}`,
        );
        // This endpoint answers with a two-element array: the post, then its comments.
        const [postListing, commentListing] = Array.isArray(payload) ? payload : [undefined, undefined];
        const postChildren = ((((postListing as Json | undefined)?.data ?? {}) as Json).children ?? []) as Json[];
        const post = ((postChildren[0]?.data ?? {}) as Json) ?? {};
        const flattened = flattenComments(commentListing, {
          ...(input.maxDepth === undefined ? {} : { depth: input.maxDepth }),
        });
        return {
          post: summarisePost(post),
          comments: flattened.comments,
          commentsRead: flattened.read,
          truncated: flattened.truncated,
          ...(flattened.truncated ? { truncatedBy: flattened.stoppedBy } : {}),
        };
      },
    }),
    defineTool({
      name: "reddit_list_subreddit",
      label: "List a subreddit",
      description: "List a subreddit's posts by hot, new, top or rising.",
      category: "communication",
      execute: async (input: { subreddit: string; sort?: "hot" | "new" | "top" | "rising"; limit?: number }, context) => {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const payload = (await transport.json(
          context,
          `/r/${encodeURIComponent(input.subreddit)}/${input.sort ?? "hot"}?limit=${limit}`,
        )) as Json | undefined;
        const data = (payload?.data ?? {}) as Json;
        const children = (Array.isArray(data.children) ? data.children : []) as Json[];
        return {
          subreddit: input.subreddit,
          posts: children.map((child) => summarisePost((child.data ?? {}) as Json)),
          truncated: data.after !== null && data.after !== undefined,
        };
      },
    }),
    defineTool({
      name: "reddit_get_user",
      label: "Read a user",
      description: "Read a Reddit user's public profile: their karma, account age and whether the account is verified.",
      category: "communication",
      execute: async (input: { username: string }, context) => {
        const payload = (await transport.json(context, `/user/${encodeURIComponent(input.username.replace(/^\/?u\//, ""))}/about`)) as Json | undefined;
        const user = (payload?.data ?? {}) as Json;
        return {
          username: user.name,
          // Karma matters here in a way it does not elsewhere: many subreddits gate posting on it, and this is
          // the only place the number is visible before a submission is refused.
          postKarma: user.link_karma,
          commentKarma: user.comment_karma,
          createdAt: user.created_utc,
          verified: user.verified,
        };
      },
    }),
    confirms({
      name: "reddit_submit_post",
      label: "Submit a post",
      description:
        "Submit a link or self post to a subreddit. **This is public.** Subreddit rules — flair requirements, karma and account-age thresholds, self-promotion limits — are not exposed by the API and are not checked here: a submission that breaks one is accepted and then removed by a moderator, so read the subreddit's rules before calling this. Requires approval.",
      category: "publishing",
      execute: async (input: { subreddit: string; title: string; text?: string; url?: string; flairId?: string }, context) => {
        if ((input.text === undefined) === (input.url === undefined)) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "reddit_submit_post needs exactly one of text (a self post) or url (a link post).",
            retryable: false,
          });
        }
        if (input.title.trim() === "" || input.title.length > 300) {
          // Reddit's own limit, refused here because its error names no field.
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `A Reddit title must be between 1 and 300 characters, and this one is ${input.title.length}.`,
            retryable: false,
          });
        }
        const payload = (await transport.json(context, "/api/submit", {
          method: "POST",
          body: {
            sr: input.subreddit,
            title: input.title,
            kind: input.url === undefined ? "self" : "link",
            ...(input.url === undefined ? { text: input.text } : { url: input.url }),
            ...(input.flairId === undefined ? {} : { flair_id: input.flairId }),
            api_type: "json",
          },
        })) as Json | undefined;
        /**
         * Reddit answers `200` with its errors inside `json.errors`, which a status check misses entirely —
         * the same envelope lesson as Slack's `ok: false`. `SUBREDDIT_NOTALLOWED` and `NO_TEXT` arrive this way.
         */
        const json = (payload?.json ?? {}) as Json;
        const errors = (Array.isArray(json.errors) ? json.errors : []) as unknown[][];
        if (errors.length > 0) {
          const [code, explanation] = (errors[0] ?? []) as string[];
          throw new AgentPlatformError({
            code: "provider_error",
            message:
              `Reddit refused the submission (${code ?? "unknown"}): ${explanation ?? "no explanation given"}. ` +
              "This is usually a subreddit rule — karma, account age, flair or a posting restriction — which the API does not expose in advance.",
            retryable: false,
          });
        }
        const data = (json.data ?? {}) as Json;
        return { subreddit: input.subreddit, id: data.name ?? data.id, url: data.url };
      },
    }),
    confirms({
      name: "reddit_comment",
      label: "Comment on a post",
      description:
        "Reply publicly to a Reddit post or comment, naming its full id (`t3_…` for a post, `t1_…` for a comment). Requires approval.",
      category: "publishing",
      execute: async (input: { parentId: string; text: string }, context) => {
        if (!/^t[13]_[a-z0-9]+$/i.test(input.parentId.trim())) {
          // A bare id silently comments on the wrong thing — `t1_` and `t3_` are different objects and Reddit
          // will happily accept whichever the prefix names.
          throw new AgentPlatformError({
            code: "invalid_input",
            message:
              `"${input.parentId}" is not a Reddit fullname. Use t3_ followed by a post id, or t1_ followed by ` +
              "a comment id — reddit_get_post returns both.",
            retryable: false,
          });
        }
        const payload = (await transport.json(context, "/api/comment", {
          method: "POST",
          body: { thing_id: input.parentId.trim(), text: input.text, api_type: "json" },
        })) as Json | undefined;
        const json = (payload?.json ?? {}) as Json;
        const errors = (Array.isArray(json.errors) ? json.errors : []) as unknown[][];
        if (errors.length > 0) {
          const [code, explanation] = (errors[0] ?? []) as string[];
          throw new AgentPlatformError({
            code: "provider_error",
            message: `Reddit refused the comment (${code ?? "unknown"}): ${explanation ?? "no explanation given"}.`,
            retryable: false,
          });
        }
        const things = ((json.data ?? {}) as Json).things;
        const first = (Array.isArray(things) ? things[0] : undefined) as Json | undefined;
        return { parentId: input.parentId, id: ((first?.data ?? {}) as Json).name };
      },
    }),
  ];

  return {
    id: "reddit",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Reddit accepts — #260 AC-2.
 *
 * `oauth2` only: every Reddit API call needs an OAuth bearer, including the app-only "client credentials"
 * flow. **The refresh belongs to the resolver**, not to this package — AC-6. A module-level token cache here
 * would be shared by every tenant in the process, so one tenant's token would serve another's request, and the
 * failure would be invisible until an audit asked whose account posted.
 */
export const REDDIT_AUTH: ToolkitAuth = { modes: ["oauth2"], schemes: ["bearer"] };

export const REDDIT_TOOL_NAMES = [
  "reddit_search",
  "reddit_get_post",
  "reddit_list_subreddit",
  "reddit_get_user",
  "reddit_submit_post",
  "reddit_comment",
] as const;
