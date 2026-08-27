/**
 * GitHub tools — REQ-047 (#206), task #214.
 *
 * The first sibling toolkit, and therefore the pattern the other twenty copy. Everything unusual about this file
 * is a decision about that pattern rather than about GitHub.
 *
 * ## Why this is not inside `@retinue/agentkit`
 *
 * A vendor API change must not be a runtime release. GitHub deprecating an endpoint should bump this package and
 * nothing else — and the runtime's root, which reaches nothing third-party, stays that way. The runtime is a
 * `peerDependency`: this package needs *a* runtime, not its own copy of one.
 *
 * ## Why there is no token in this file
 *
 * A `credentialRef` and a resolver, both supplied by the host, resolved **per call**. `process.env.GITHUB_TOKEN`
 * would work perfectly for one tenant and would be copied into twenty more packages before anybody noticed that
 * a second customer needs a second token for the same tool.
 *
 * ## Why every write says `confirms` or `destroys`
 *
 * Those set effect, approval policy and idempotency together, and the type forbids overriding them. `effect:
 * "read"` on `create_issue` would skip the approval gate and carry no idempotency key, and nothing in a build
 * can notice — `read` is a valid value and the compiler cannot know what the function does.
 */

import {
  confirms,
  createHttpClient,
  defineTool,
  destroys,
  type CredentialRef,
  type CredentialResolver,
  type HttpOutcome,
  type Tool,
  type ToolProvider,
} from "@retinue/agentkit/tools";
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

export type GitHubToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** Defaults to `https://api.github.com`. Set for GitHub Enterprise. */
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

const API = "https://api.github.com";

/** GitHub's own cap. Asking for more silently returns 100, which reads as "there were only 100". */
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 30;
/** A ceiling on pagination, so one call cannot walk an entire repository's history. */
const MAX_PAGES = 5;

type Json = Record<string, unknown>;

/**
 * A failed HTTP outcome, turned into something a model can act on.
 *
 * **429 and 403-with-a-reset are rate limits, not errors**, and saying so matters: a model told "forbidden"
 * retries with different arguments, which is wrong. Told "rate limited, retry after N seconds", it waits or
 * stops. GitHub signals its limit as 403 with `x-ratelimit-remaining: 0`, which is the detail everybody misses.
 */
const describeFailure = (outcome: Extract<HttpOutcome, { ok: false }>): never => {
  const rateLimited = outcome.status === 429 || /rate limit/i.test(outcome.reason);
  /**
   * `AgentPlatformError`, not a decorated `Error`.
   *
   * `toPlatformError` maps anything else to `{ code: "internal", retryable: false }` — so a rate limit thrown as
   * `Object.assign(new Error(...), { retryable: true })` arrives at the model as a permanent internal failure,
   * and the model retries with different arguments instead of waiting. The extra properties simply vanish, and
   * nothing warns you. Caught by the test that asserts a 429 is retryable.
   */
  /**
   * The code comes from the platform's closed union, not from a word that reads well.
   *
   * `upstream_error` was the obvious name and is not a code — caught by `tsc -b`, and *not* by the tests, because
   * vitest transpiles without typechecking. `provider_unavailable` for a transport failure the caller can retry,
   * `provider_error` for one it cannot: the model reads these to decide whether trying again is sensible.
   */
  const transport = outcome.kind === "timeout" || outcome.kind === "unreachable";
  throw new AgentPlatformError({
    code: rateLimited ? "rate_limited" : transport ? "provider_unavailable" : "provider_error",
    message: rateLimited
      ? `GitHub rate limit reached: ${outcome.reason}`
      : `GitHub request failed (${outcome.kind}): ${outcome.reason}`,
    retryable: rateLimited || transport,
  });
};

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub returned a body that is not JSON");
  }
};

export const createGitHubToolkit = (config: GitHubToolkitConfig): ToolProvider => {
  const base = (config.baseUrl ?? API).replace(/\/$/, "");

  /**
   * One request, with the credential resolved now rather than at construction.
   *
   * Per call so a rotated token takes effect without a restart — a credential read once at startup is one that
   * survives its own rotation, and the failure looks like the vendor rejecting a token that "has not changed".
   *
   * The header goes in through `headersFor`, which the runtime calls with the *validated* hostname only: a token
   * issued for `api.github.com` cannot be sent to another host by asking for a URL that merely mentions it.
   */
  const call = async (context: ExecutionContext, path: string, init: { method?: string; body?: Json } = {}): Promise<unknown> => {
    const token = await config.resolver.resolve({ ref: config.credentialRef, context });
    const host = new URL(base).host;
    const client = createHttpClient({
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      headersFor: (requested) =>
        requested === host
          ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
          : undefined,
    });
    const outcome = await client.request({
      url: `${base}${path}`,
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Parsed here and never shown to the model verbatim, so the untrusted-content envelope would only corrupt
      // the JSON. Anything rendered as prose keeps the default fence.
      fence: false,
    });
    if (!outcome.ok) describeFailure(outcome);
    return parse((outcome as Extract<HttpOutcome, { ok: true }>).body);
  };

  /**
   * Every page up to a ceiling, and **it says when it stopped**.
   *
   * A tool that returns page one and says nothing about page two loses data silently: the model concludes there
   * were thirty issues. The ceiling exists because "all of them" against a large repository is a call that never
   * returns, and reporting `truncated` is what keeps the difference visible.
   */
  const paginate = async (context: ExecutionContext, path: string, perPage: number): Promise<{ items: unknown[]; truncated: boolean }> => {
    const size = Math.min(Math.max(perPage, 1), MAX_PER_PAGE);
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await call(context, `${path}${separator}per_page=${size}&page=${page}`);
      const rows = Array.isArray(batch) ? batch : [];
      items.push(...rows);
      if (rows.length < size) return { items, truncated: false };
    }
    return { items, truncated: true };
  };

  const tools: readonly Tool[] = [
    defineTool({
      name: "github_search_code",
      label: "Search code",
      description: "Search code across GitHub repositories with a query, returning matching files and repositories.",
      category: "project",
      execute: async (input: { query: string; limit?: number }, context) => {
        const result = (await call(context, `/search/code?q=${encodeURIComponent(input.query)}&per_page=${Math.min(input.limit ?? 10, MAX_PER_PAGE)}`)) as Json;
        return { total: result.total_count ?? 0, items: result.items ?? [] };
      },
    }),
    defineTool({
      name: "github_get_file",
      label: "Read a file",
      description: "Read a file's contents from a repository at a ref (branch, tag or commit).",
      category: "project",
      execute: async (input: { owner: string; repo: string; path: string; ref?: string }, context) => {
        const query = input.ref === undefined ? "" : `?ref=${encodeURIComponent(input.ref)}`;
        const file = (await call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}${query}`)) as Json;
        const content = typeof file.content === "string" ? Buffer.from(file.content, "base64").toString("utf8") : "";
        return { path: file.path, sha: file.sha, content };
      },
    }),
    defineTool({
      name: "github_list_issues",
      label: "List issues",
      description: "List issues in a repository, optionally filtered by state and label. Paginates and reports when truncated.",
      category: "project",
      execute: async (input: { owner: string; repo: string; state?: "open" | "closed" | "all"; perPage?: number }, context) => {
        const state = input.state ?? "open";
        const { items, truncated } = await paginate(context, `/repos/${input.owner}/${input.repo}/issues?state=${state}`, input.perPage ?? DEFAULT_PER_PAGE);
        return { issues: items, truncated };
      },
    }),
    confirms({
      name: "github_create_issue",
      label: "Open an issue",
      description: "Open a new issue in a repository. Requires approval.",
      category: "project",
      execute: async (input: { owner: string; repo: string; title: string; body?: string }, context) => {
        const issue = (await call(context, `/repos/${input.owner}/${input.repo}/issues`, {
          method: "POST",
          body: { title: input.title, ...(input.body === undefined ? {} : { body: input.body }) },
        })) as Json;
        return { number: issue.number, url: issue.html_url };
      },
    }),
    confirms({
      name: "github_comment",
      label: "Comment on an issue",
      description: "Add a comment to an issue or pull request. Requires approval.",
      category: "project",
      execute: async (input: { owner: string; repo: string; number: number; body: string }, context) => {
        const comment = (await call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`, {
          method: "POST",
          body: { body: input.body },
        })) as Json;
        return { id: comment.id, url: comment.html_url };
      },
    }),
    destroys({
      name: "github_merge_pull_request",
      label: "Merge a pull request",
      description: "Merge a pull request. This cannot be undone and requires approval.",
      category: "project",
      execute: async (input: { owner: string; repo: string; number: number; method?: "merge" | "squash" | "rebase" }, context) => {
        const merged = (await call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`, {
          method: "PUT",
          body: { merge_method: input.method ?? "merge" },
        })) as Json;
        return { merged: merged.merged === true, sha: merged.sha };
      },
    }),
  ];

  return {
    id: "github",
    async listTools() {
      return tools;
    },
  };
};

/** Every tool this toolkit offers, so a host can preload by name and `docs/23` can be checked against it. */
export const GITHUB_TOOL_NAMES = [
  "github_search_code",
  "github_get_file",
  "github_list_issues",
  "github_create_issue",
  "github_comment",
  "github_merge_pull_request",
] as const;
