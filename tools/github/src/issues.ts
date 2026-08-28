/**
 * Group A — issues and pull requests. Twelve new tools for task #223, plus the four from #214.
 *
 * The design rule this group exists to demonstrate: **one verb per object**. #210 measured a model choosing
 * `archive_accounts` over `list_accounts` with both resident, so a near-duplicate is not free — it is a wrong
 * call waiting for a plausible prompt. There is no `github_set_labels` beside `github_update_issue`; labels are
 * one of the fields `github_update_issue` takes.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";

import { DEFAULT_PER_PAGE, MAX_PER_PAGE, type Json, type Transport } from "./transport.js";

const CATEGORY = "project";

/** A repository coordinate, spelled once. */
type Repo = { owner: string; repo: string };

const search = async (
  transport: Transport,
  context: Parameters<Transport["call"]>[0],
  kind: "issue" | "pr",
  query: string,
  limit: number,
): Promise<Json> => {
  // `is:issue` / `is:pr` appended rather than trusted from the caller: the two tools differ only by this, and a
  // model that omits it gets the other kind mixed in and reports it as an answer.
  const q = `${query} is:${kind}`;
  const result = (await transport.call(
    context,
    `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, MAX_PER_PAGE)}`,
  )) as Json;
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    total: result.total_count ?? 0,
    // GitHub's search caps at 1000 regardless of the total it reports, and `incomplete_results` means it gave
    // up early. Both are the honest-truncation rule from #214 — a count the model trusts must say when it lies.
    truncated: result.incomplete_results === true || items.length < (result.total_count as number ?? 0),
    items: items.map((row) => {
      const issue = row as Json;
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        repository: typeof issue.repository_url === "string" ? issue.repository_url.split("/repos/")[1] : undefined,
        url: issue.html_url,
      };
    }),
  };
};

export const issueTools = (transport: Transport): readonly Tool[] => [
  // ── From #214. Moved here rather than left in `index.ts`, which is now assembly only.
  defineTool({
    name: "github_list_issues",
    label: "List issues",
    description:
      "List issues in a repository, optionally filtered by state and label. Paginates and reports when truncated.",
    category: CATEGORY,
    execute: async (input: Repo & { state?: "open" | "closed" | "all"; perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/issues?state=${input.state ?? "open"}`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return { issues: items, truncated };
    },
  }),
  confirms({
    name: "github_create_issue",
    label: "Open an issue",
    description: "Open a new issue in a repository. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { title: string; body?: string }, context) => {
      const issue = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues`, {
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
    category: CATEGORY,
    execute: async (input: Repo & { number: number; body: string }, context) => {
      const comment = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`, {
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
    category: CATEGORY,
    execute: async (input: Repo & { number: number; method?: "merge" | "squash" | "rebase" }, context) => {
      const merged = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`, {
        method: "PUT",
        body: { merge_method: input.method ?? "merge" },
      })) as Json;
      return { merged: merged.merged === true, sha: merged.sha };
    },
  }),
  // ── New in #223.
  defineTool({
    name: "github_search_issues",
    label: "Search issues",
    description:
      "Search issues across repositories using GitHub's query syntax, for example `repo:owner/name state:open label:bug`. Returns the number, title, state and repository of each match. Reports `truncated` when GitHub did not return everything it counted.",
    category: CATEGORY,
    execute: async (input: { query: string; limit?: number }, context) =>
      search(transport, context, "issue", input.query, input.limit ?? 10),
  }),
  defineTool({
    name: "github_get_issue",
    label: "Read an issue",
    description:
      "Read one issue: body, state, labels, assignees, milestone and how many comments it has. The comments themselves are not included — list them separately if the count says they matter.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number }, context) => {
      const issue = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}`)) as Json;
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        stateReason: issue.state_reason,
        labels: (Array.isArray(issue.labels) ? issue.labels : []).map((l) => (l as Json).name),
        assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a) => (a as Json).login),
        milestone: issue.milestone === null ? null : (issue.milestone as Json | undefined)?.title,
        comments: issue.comments,
        url: issue.html_url,
      };
    },
  }),
  confirms({
    name: "github_update_issue",
    label: "Update an issue",
    description:
      "Change an issue's title, body, labels, assignees or milestone. Only the fields supplied are changed; the rest are left alone. Labels and assignees **replace** the existing ones rather than adding to them. Requires approval.",
    category: CATEGORY,
    execute: async (
      input: Repo & { number: number; title?: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null },
      context,
    ) => {
      const body: Json = {};
      if (input.title !== undefined) body.title = input.title;
      if (input.body !== undefined) body.body = input.body;
      if (input.labels !== undefined) body.labels = input.labels;
      if (input.assignees !== undefined) body.assignees = input.assignees;
      if (input.milestone !== undefined) body.milestone = input.milestone;
      if (Object.keys(body).length === 0) {
        // Refused rather than sent. An empty PATCH succeeds at GitHub and changes nothing, so the model is told
        // the update worked — the shape of failure this repository keeps finding.
        throw new Error("github_update_issue was called with nothing to change. Supply at least one field.");
      }
      const issue = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}`, {
        method: "PATCH",
        body,
      })) as Json;
      return { number: issue.number, url: issue.html_url, changed: Object.keys(body) };
    },
  }),
  confirms({
    name: "github_close_issue",
    label: "Close an issue",
    description:
      "Close an issue, saying why: `completed` if the work was done, `not_planned` if it will not be. The reason is recorded on the issue and is the difference between a decision and a disappearance. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number; reason: "completed" | "not_planned"; comment?: string }, context) => {
      // The comment first, deliberately: if closing succeeds and commenting then fails, the issue is closed with
      // no explanation. This order can leave a comment on an open issue, which is the recoverable half.
      if (input.comment !== undefined) {
        await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments`, {
          method: "POST",
          body: { body: input.comment },
        });
      }
      const issue = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: input.reason },
      })) as Json;
      return { number: issue.number, state: issue.state, stateReason: issue.state_reason, url: issue.html_url };
    },
  }),
  confirms({
    name: "github_reopen_issue",
    label: "Reopen an issue",
    description: "Reopen a closed issue. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number }, context) => {
      const issue = (await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}`, {
        method: "PATCH",
        // `state_reason: null` clears `not_planned`. Reopening without clearing it leaves an open issue that
        // still says it was not planned, which reads as a contradiction to whoever looks next.
        body: { state: "open", state_reason: null },
      })) as Json;
      return { number: issue.number, state: issue.state, url: issue.html_url };
    },
  }),
  defineTool({
    name: "github_list_pull_requests",
    label: "List pull requests",
    description:
      "List pull requests in a repository, filtered by state and optionally by base branch. Paginates and reports when truncated.",
    category: CATEGORY,
    execute: async (input: Repo & { state?: "open" | "closed" | "all"; base?: string; perPage?: number }, context) => {
      const filters = [`state=${input.state ?? "open"}`];
      if (input.base !== undefined) filters.push(`base=${encodeURIComponent(input.base)}`);
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/pulls?${filters.join("&")}`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        pullRequests: items.map((row) => {
          const pr = row as Json;
          return { number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, head: (pr.head as Json | undefined)?.ref, base: (pr.base as Json | undefined)?.ref, url: pr.html_url };
        }),
        truncated,
      };
    },
  }),
  defineTool({
    name: "github_get_pull_request",
    label: "Read a pull request",
    description:
      "Read one pull request: title, body, state, mergeability, and the list of changed files with their addition and deletion counts. The diff itself is not included — it is unbounded, and a file list is what decides whether reading one is worth it.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number }, context) => {
      const pr = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}`)) as Json;
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/pulls/${input.number}/files`,
        MAX_PER_PAGE,
      );
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        draft: pr.draft,
        // `mergeable` is null while GitHub computes it, and null is not false. Reported as-is with the state,
        // so "not yet known" cannot be read as "cannot be merged".
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        head: (pr.head as Json | undefined)?.ref,
        base: (pr.base as Json | undefined)?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        files: items.map((row) => {
          const file = row as Json;
          return { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions };
        }),
        filesTruncated: truncated,
        url: pr.html_url,
      };
    },
  }),
  defineTool({
    name: "github_search_pull_requests",
    label: "Search pull requests",
    description:
      "Search pull requests across repositories using GitHub's query syntax, for example `repo:owner/name is:open review:required`. Reports `truncated` when GitHub did not return everything it counted.",
    category: CATEGORY,
    execute: async (input: { query: string; limit?: number }, context) =>
      search(transport, context, "pr", input.query, input.limit ?? 10),
  }),
  confirms({
    name: "github_create_pull_request",
    label: "Open a pull request",
    description:
      "Open a pull request from a head branch into a base branch. Open it as a draft when the work is not ready for review. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { head: string; base: string; title: string; body?: string; draft?: boolean }, context) => {
      const pr = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls`, {
        method: "POST",
        body: {
          head: input.head,
          base: input.base,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          draft: input.draft ?? false,
        },
      })) as Json;
      return { number: pr.number, url: pr.html_url, draft: pr.draft };
    },
  }),
  confirms({
    name: "github_update_pull_request",
    label: "Update a pull request",
    description:
      "Change a pull request's title, body or base branch, or mark a draft ready for review. Only the fields supplied are changed. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number; title?: string; body?: string; base?: string; draft?: boolean }, context) => {
      const body: Json = {};
      if (input.title !== undefined) body.title = input.title;
      if (input.body !== undefined) body.body = input.body;
      if (input.base !== undefined) body.base = input.base;
      if (input.draft !== undefined) body.draft = input.draft;
      if (Object.keys(body).length === 0) {
        throw new Error("github_update_pull_request was called with nothing to change. Supply at least one field.");
      }
      const pr = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}`, {
        method: "PATCH",
        body,
      })) as Json;
      return { number: pr.number, url: pr.html_url, changed: Object.keys(body) };
    },
  }),
  confirms({
    name: "github_review_pull_request",
    label: "Review a pull request",
    description:
      "Submit a review on a pull request: `APPROVE`, `REQUEST_CHANGES` or `COMMENT`. Approving is a human act — do not approve unless you were asked to in those words. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }, context) => {
      if (input.event !== "APPROVE" && (input.body ?? "").trim() === "") {
        // GitHub rejects this itself with a 422, but saying so here names the field instead of returning a
        // validation blob the model has to interpret.
        throw new Error(`A ${input.event} review needs a body explaining it.`);
      }
      const review = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`, {
        method: "POST",
        body: { event: input.event, ...(input.body === undefined ? {} : { body: input.body }) },
      })) as Json;
      return { id: review.id, state: review.state, url: review.html_url };
    },
  }),
  confirms({
    name: "github_close_pull_request",
    label: "Close a pull request",
    description:
      "Close a pull request without merging it. This is not a merge: nothing from the branch reaches the base. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number }, context) => {
      const pr = (await transport.call(context, `/repos/${input.owner}/${input.repo}/pulls/${input.number}`, {
        method: "PATCH",
        body: { state: "closed" },
      })) as Json;
      return { number: pr.number, state: pr.state, merged: pr.merged === true, url: pr.html_url };
    },
  }),
];
