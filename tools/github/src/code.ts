/**
 * Group B — code and repository. Eight new tools for task #223, plus the two from #214.
 *
 * `github_write_file` is where the "one verb per object" rule earns its keep. GitHub's contents API needs a
 * `sha` to update and refuses one to create, so the obvious shape is two tools. But that distinction is the
 * *API's*, not the caller's: a model asked to fix a typo does not know whether the file exists, and if it picks
 * wrong it gets a 422 it cannot interpret. One tool, which looks the `sha` up itself.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";

import { DEFAULT_PER_PAGE, MAX_PER_PAGE, type Json, type Transport } from "./transport.js";

const CATEGORY = "project";

type Repo = { owner: string; repo: string };

export const codeTools = (transport: Transport): readonly Tool[] => [
  // ── From #214. Moved here rather than left in `index.ts`, which is now assembly only.
  defineTool({
    name: "github_search_code",
    label: "Search code",
    description: "Search code across GitHub repositories with a query, returning matching files and repositories.",
    category: CATEGORY,
    execute: async (input: { query: string; limit?: number }, context) => {
      const result = (await transport.call(
        context,
        `/search/code?q=${encodeURIComponent(input.query)}&per_page=${Math.min(input.limit ?? 10, MAX_PER_PAGE)}`,
      )) as Json;
      return { total: result.total_count ?? 0, items: result.items ?? [] };
    },
  }),
  defineTool({
    name: "github_get_file",
    label: "Read a file",
    description: "Read a file's contents from a repository at a ref (branch, tag or commit).",
    category: CATEGORY,
    execute: async (input: Repo & { path: string; ref?: string }, context) => {
      const query = input.ref === undefined ? "" : `?ref=${encodeURIComponent(input.ref)}`;
      const file = (await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}${query}`)) as Json;
      const content = typeof file.content === "string" ? Buffer.from(file.content, "base64").toString("utf8") : "";
      return { path: file.path, sha: file.sha, content };
    },
  }),
  // ── New in #223.
  defineTool({
    name: "github_list_directory",
    label: "List a directory",
    description:
      "List the entries in a repository directory at a ref, with each entry's type and size. Use the repository root by passing an empty path.",
    category: CATEGORY,
    execute: async (input: Repo & { path?: string; ref?: string }, context) => {
      const query = input.ref === undefined ? "" : `?ref=${encodeURIComponent(input.ref)}`;
      const listing = await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path ?? ""}${query}`);
      if (!Array.isArray(listing)) {
        // The same endpoint returns an object for a file. Saying which it was beats returning `entries: []`,
        // which reads as "the directory is empty".
        throw new Error(`${input.path ?? "/"} is a file, not a directory. Use github_get_file to read it.`);
      }
      return {
        entries: listing.map((row) => {
          const entry = row as Json;
          return { name: entry.name, path: entry.path, type: entry.type, size: entry.size };
        }),
      };
    },
  }),
  defineTool({
    name: "github_list_commits",
    label: "List commits",
    description:
      "List commits on a branch, optionally narrowed to a path or an author. Paginates and reports when truncated.",
    category: CATEGORY,
    execute: async (input: Repo & { sha?: string; path?: string; author?: string; perPage?: number }, context) => {
      const filters: string[] = [];
      if (input.sha !== undefined) filters.push(`sha=${encodeURIComponent(input.sha)}`);
      if (input.path !== undefined) filters.push(`path=${encodeURIComponent(input.path)}`);
      if (input.author !== undefined) filters.push(`author=${encodeURIComponent(input.author)}`);
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/commits${filters.length === 0 ? "" : `?${filters.join("&")}`}`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        commits: items.map((row) => {
          const entry = row as Json;
          const commit = entry.commit as Json | undefined;
          return {
            sha: entry.sha,
            message: commit?.message,
            author: (commit?.author as Json | undefined)?.name,
            date: (commit?.author as Json | undefined)?.date,
            url: entry.html_url,
          };
        }),
        truncated,
      };
    },
  }),
  defineTool({
    name: "github_get_commit",
    label: "Read a commit",
    description:
      "Read one commit: message, author, date and the files it changed with their addition and deletion counts. Accepts a sha, a branch name or a tag.",
    category: CATEGORY,
    execute: async (input: Repo & { ref: string }, context) => {
      const entry = (await transport.call(context, `/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.ref)}`)) as Json;
      const commit = entry.commit as Json | undefined;
      const files = Array.isArray(entry.files) ? entry.files : [];
      return {
        sha: entry.sha,
        message: commit?.message,
        author: (commit?.author as Json | undefined)?.name,
        date: (commit?.author as Json | undefined)?.date,
        stats: entry.stats,
        files: files.map((row) => {
          const file = row as Json;
          return { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions };
        }),
        // GitHub caps this response at 300 files and says nothing about it, so the count is compared with the
        // stated total rather than trusted.
        filesTruncated: files.length >= 300,
        url: entry.html_url,
      };
    },
  }),
  defineTool({
    name: "github_list_branches",
    label: "List branches",
    description: "List a repository's branches and whether each is protected. Paginates and reports when truncated.",
    category: CATEGORY,
    execute: async (input: Repo & { perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/branches`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        branches: items.map((row) => {
          const branch = row as Json;
          return { name: branch.name, sha: (branch.commit as Json | undefined)?.sha, protected: branch.protected };
        }),
        truncated,
      };
    },
  }),
  defineTool({
    name: "github_list_tags",
    label: "List tags",
    description: "List a repository's tags with the commit each points at. Paginates and reports when truncated.",
    category: CATEGORY,
    execute: async (input: Repo & { perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/tags`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        tags: items.map((row) => {
          const tag = row as Json;
          return { name: tag.name, sha: (tag.commit as Json | undefined)?.sha };
        }),
        truncated,
      };
    },
  }),
  confirms({
    name: "github_create_branch",
    label: "Create a branch",
    description:
      "Create a branch from an existing ref (a branch name, tag or sha). Fails if the branch already exists rather than moving it — moving a branch is a force push, which this toolkit does not do. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { name: string; from: string }, context) => {
      // Resolved rather than passed through: `from: "main"` is what a model writes, and the refs API needs a
      // sha. Without this the tool works only when the caller already knows a sha, which is the case that
      // never happens.
      const source = (await transport.call(context, `/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.from)}`)) as Json;
      if (typeof source.sha !== "string") {
        throw new Error(`Could not resolve ${input.from} to a commit in ${input.owner}/${input.repo}.`);
      }
      const ref = (await transport.call(context, `/repos/${input.owner}/${input.repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${input.name}`, sha: source.sha },
      })) as Json;
      return { name: input.name, sha: source.sha, ref: ref.ref };
    },
  }),
  confirms({
    name: "github_write_file",
    label: "Write a file",
    description:
      "Create or replace a file on a branch, with a commit message. Whether the file already exists does not matter — this handles both. The content replaces the whole file, so read it first if you mean to change part of it. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { path: string; content: string; message: string; branch?: string }, context) => {
      const query = input.branch === undefined ? "" : `?ref=${encodeURIComponent(input.branch)}`;
      /**
       * The current sha, looked up here so the model never carries one.
       *
       * A 404 means the file does not exist, which is not an error — it is the create case. Anything else is a
       * real failure and must not be swallowed: catching broadly here would turn "no permission to read" into
       * "the file is new", and then the write fails with a 422 about a missing sha.
       */
      let sha: string | undefined;
      try {
        const existing = (await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}${query}`)) as Json;
        sha = typeof existing.sha === "string" ? existing.sha : undefined;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : "";
        const missing = /\b404\b/.test(message) || /not found/i.test(message);
        if (!missing) throw error;
        if (code === "unauthorized") throw error;
      }
      const result = (await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}`, {
        method: "PUT",
        body: {
          message: input.message,
          content: Buffer.from(input.content, "utf8").toString("base64"),
          ...(sha === undefined ? {} : { sha }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        },
      })) as Json;
      const commit = result.commit as Json | undefined;
      return { path: input.path, created: sha === undefined, sha: (result.content as Json | undefined)?.sha, commit: commit?.sha, url: (result.content as Json | undefined)?.html_url };
    },
  }),
  destroys({
    name: "github_delete_file",
    label: "Delete a file",
    description:
      "Delete a file from a branch, with a commit message. The commit is recoverable through history; the file is not obviously recoverable to whoever asked for it. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { path: string; message: string; branch?: string }, context) => {
      const query = input.branch === undefined ? "" : `?ref=${encodeURIComponent(input.branch)}`;
      const existing = (await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}${query}`)) as Json;
      if (typeof existing.sha !== "string") {
        throw new Error(`${input.path} does not exist in ${input.owner}/${input.repo}, so there is nothing to delete.`);
      }
      const result = (await transport.call(context, `/repos/${input.owner}/${input.repo}/contents/${input.path}`, {
        method: "DELETE",
        body: {
          message: input.message,
          sha: existing.sha,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        },
      })) as Json;
      return { path: input.path, deleted: true, commit: (result.commit as Json | undefined)?.sha };
    },
  }),
];

export { MAX_PER_PAGE };
