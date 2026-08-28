/**
 * Group D — releases, workflows, labels and milestones. Twelve tools, task #223.
 *
 * Three of these were declined in #214 and are included now, each for a stated reason rather than because the
 * list grew:
 *
 * - `github_create_release` — declined as "release publishing". It announces; it does not deploy, and a release
 *   can be deleted. What it is *not* is a publish to strangers under the operator's brand: a release on a
 *   private repository is private. See the #228 decision in `docs/23`.
 * - `github_dispatch_workflow` — declined for running arbitrary CI. Included because unlike `shell_exec` its
 *   blast radius is a workflow file somebody reviewed and merged, and it is gated like any other write.
 * - `github_get_workflow_run_logs` — declined for size. Included with a byte ceiling and honest truncation,
 *   because reading the logs is the whole task after a red build.
 */

import { confirms, defineTool, type Tool } from "@retinue/agentkit/tools";

import { DEFAULT_PER_PAGE, type Json, type Transport } from "./transport.js";

const CATEGORY = "project";

/**
 * A ceiling on log text, and it says when it cut.
 *
 * A workflow log is unbounded — a matrix build's is megabytes — and a tool that returns all of it fills the
 * context window with the same npm progress bar. The **tail**, not the head: a failure is at the end.
 */
const MAX_LOG_BYTES = 60_000;

type Repo = { owner: string; repo: string };

export const actionTools = (transport: Transport): readonly Tool[] => [
  defineTool({
    name: "github_list_releases",
    label: "List releases",
    description: "List a repository's releases, newest first, with their tag, name and whether each is a draft or prerelease.",
    category: CATEGORY,
    execute: async (input: Repo & { perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/releases`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        releases: items.map((row) => {
          const release = row as Json;
          return { tag: release.tag_name, name: release.name, draft: release.draft, prerelease: release.prerelease, publishedAt: release.published_at, url: release.html_url };
        }),
        truncated,
      };
    },
  }),
  defineTool({
    name: "github_get_release",
    label: "Read a release",
    description:
      "Read one release by tag, or the latest if no tag is given. Includes the release notes and the list of attached assets.",
    category: CATEGORY,
    execute: async (input: Repo & { tag?: string }, context) => {
      const path =
        input.tag === undefined
          ? `/repos/${input.owner}/${input.repo}/releases/latest`
          : `/repos/${input.owner}/${input.repo}/releases/tags/${encodeURIComponent(input.tag)}`;
      const release = (await transport.call(context, path)) as Json;
      return {
        tag: release.tag_name,
        name: release.name,
        body: release.body,
        draft: release.draft,
        prerelease: release.prerelease,
        publishedAt: release.published_at,
        assets: (Array.isArray(release.assets) ? release.assets : []).map((row) => {
          const asset = row as Json;
          return { name: asset.name, size: asset.size, downloads: asset.download_count };
        }),
        url: release.html_url,
      };
    },
  }),
  confirms({
    name: "github_create_release",
    label: "Create a release",
    description:
      "Create a release for a tag, with notes. Create it as a draft when it should not be visible yet. The tag must already exist unless a target commit is given. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { tag: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; target?: string }, context) => {
      const release = (await transport.call(context, `/repos/${input.owner}/${input.repo}/releases`, {
        method: "POST",
        body: {
          tag_name: input.tag,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.target === undefined ? {} : { target_commitish: input.target }),
          draft: input.draft ?? false,
          prerelease: input.prerelease ?? false,
        },
      })) as Json;
      return { tag: release.tag_name, draft: release.draft, url: release.html_url };
    },
  }),
  defineTool({
    name: "github_list_workflow_runs",
    label: "List workflow runs",
    description:
      "List a repository's workflow runs, newest first, optionally filtered by workflow file name, branch or status. Each run's id is what the run tools take.",
    category: CATEGORY,
    execute: async (
      input: Repo & { workflow?: string; branch?: string; status?: string; perPage?: number },
      context,
    ) => {
      const filters: string[] = [];
      if (input.branch !== undefined) filters.push(`branch=${encodeURIComponent(input.branch)}`);
      if (input.status !== undefined) filters.push(`status=${encodeURIComponent(input.status)}`);
      const path =
        input.workflow === undefined
          ? `/repos/${input.owner}/${input.repo}/actions/runs`
          : `/repos/${input.owner}/${input.repo}/actions/workflows/${encodeURIComponent(input.workflow)}/runs`;
      const query = filters.length === 0 ? "" : `?${filters.join("&")}`;
      const result = (await transport.call(
        context,
        `${path}${query}${query === "" ? "?" : "&"}per_page=${input.perPage ?? DEFAULT_PER_PAGE}`,
      )) as Json;
      const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs : [];
      return {
        runs: runs.map((row) => {
          const run = row as Json;
          return { id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, branch: run.head_branch, event: run.event, createdAt: run.created_at, url: run.html_url };
        }),
        // This endpoint reports a total independent of the page, so truncation is knowable exactly rather than
        // inferred from a short page.
        truncated: typeof result.total_count === "number" && result.total_count > runs.length,
      };
    },
  }),
  defineTool({
    name: "github_get_workflow_run",
    label: "Read a workflow run",
    description:
      "Read one workflow run: its status, conclusion, and the status and conclusion of every job in it. A run that failed names which job did.",
    category: CATEGORY,
    execute: async (input: Repo & { runId: number }, context) => {
      const run = (await transport.call(context, `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}`)) as Json;
      const jobs = (await transport.call(context, `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/jobs`)) as Json;
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.head_branch,
        event: run.event,
        jobs: (Array.isArray(jobs.jobs) ? jobs.jobs : []).map((row) => {
          const job = row as Json;
          return {
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            // The failing *step* is what somebody actually wants after a red build, and it is one level deeper
            // than every summary shows.
            failedStep: (Array.isArray(job.steps) ? job.steps : [])
              .map((s) => s as Json)
              .find((step) => step.conclusion === "failure")?.name,
          };
        }),
        url: run.html_url,
      };
    },
  }),
  defineTool({
    name: "github_get_workflow_run_logs",
    label: "Read workflow run logs",
    description:
      "Read the log of one job in a workflow run. Returns the **end** of the log, where a failure is, and says so when it was truncated. Read github_get_workflow_run first to find which job failed.",
    category: CATEGORY,
    execute: async (input: Repo & { jobId: number }, context) => {
      /**
       * `transport.text`, not `call`. GitHub answers this one with a 302 to a signed blob URL holding **plain
       * text**; `fetch` follows the redirect, so what arrives is a log, not an envelope.
       *
       * The first version used `call` and caught its "not JSON" failure, returning a placeholder — which threw
       * the log away and reported `{"__raw":true}` as a success on every call. It typechecked and the tool was
       * entirely non-functional. That is why `text` exists.
       */
      const text = await transport.text(context, `/repos/${input.owner}/${input.repo}/actions/jobs/${input.jobId}/logs`);
      const bytes = new TextEncoder().encode(text);
      const truncated = bytes.length > MAX_LOG_BYTES;
      return {
        jobId: input.jobId,
        log: truncated ? new TextDecoder().decode(bytes.slice(bytes.length - MAX_LOG_BYTES)) : text,
        truncated,
        ...(truncated ? { note: `Showing the last ${MAX_LOG_BYTES} bytes of ${bytes.length}.` } : {}),
      };
    },
  }),
  confirms({
    name: "github_rerun_workflow",
    label: "Re-run a workflow",
    description:
      "Re-run a workflow run, either entirely or only the jobs that failed. Re-running does not change the code — if the failure was real it will fail again. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { runId: number; failedOnly?: boolean }, context) => {
      const path = input.failedOnly === true ? "rerun-failed-jobs" : "rerun";
      await transport.call(context, `/repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/${path}`, { method: "POST" });
      // GitHub answers 201 with an empty body, so there is nothing to report back but what was asked. Saying
      // `queued` rather than `rerun: true` keeps the model from concluding the run has finished.
      return { runId: input.runId, queued: true, scope: input.failedOnly === true ? "failed jobs" : "all jobs" };
    },
  }),
  confirms({
    name: "github_dispatch_workflow",
    label: "Run a workflow",
    description:
      "Trigger a workflow that accepts manual dispatch, on a branch or tag, with its inputs. The workflow must already declare `workflow_dispatch` or this fails. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { workflow: string; ref: string; inputs?: Record<string, string> }, context) => {
      await transport.call(
        context,
        `/repos/${input.owner}/${input.repo}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
        { method: "POST", body: { ref: input.ref, ...(input.inputs === undefined ? {} : { inputs: input.inputs }) } },
      );
      /**
       * 204 with no body, and **no run id**. GitHub does not tell you what it started.
       *
       * Saying so is the honest answer: a tool that invented a run id, or reported one from a subsequent list
       * call, would sometimes name a different run that started in between.
       */
      return {
        workflow: input.workflow,
        ref: input.ref,
        dispatched: true,
        note: "GitHub does not return the run id for a dispatch. Use github_list_workflow_runs to find it.",
      };
    },
  }),
  defineTool({
    name: "github_list_labels",
    label: "List labels",
    description:
      "List the labels a repository defines, with their colour and description. Read this before adding a label — adding one that does not exist creates it.",
    category: CATEGORY,
    execute: async (input: Repo & { perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/labels`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        labels: items.map((row) => {
          const label = row as Json;
          return { name: label.name, color: label.color, description: label.description };
        }),
        truncated,
      };
    },
  }),
  confirms({
    name: "github_add_labels",
    label: "Add labels",
    description:
      "Add labels to an issue or pull request, leaving the existing ones in place. **A label that does not exist in the repository is created**, so read github_list_labels first rather than inventing a name. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number; labels: string[] }, context) => {
      if (input.labels.length === 0) throw new Error("github_add_labels was called with no labels.");
      const result = await transport.call(context, `/repos/${input.owner}/${input.repo}/issues/${input.number}/labels`, {
        method: "POST",
        body: { labels: input.labels },
      });
      return {
        number: input.number,
        added: input.labels,
        labels: (Array.isArray(result) ? result : []).map((row) => (row as Json).name),
      };
    },
  }),
  confirms({
    name: "github_remove_label",
    label: "Remove a label",
    description:
      "Remove one label from an issue or pull request. One at a time on purpose: removing every label is not something anybody means, and this way a wrong call costs one label. Requires approval.",
    category: CATEGORY,
    execute: async (input: Repo & { number: number; label: string }, context) => {
      const result = await transport.call(
        context,
        `/repos/${input.owner}/${input.repo}/issues/${input.number}/labels/${encodeURIComponent(input.label)}`,
        { method: "DELETE" },
      );
      return {
        number: input.number,
        removed: input.label,
        labels: (Array.isArray(result) ? result : []).map((row) => (row as Json).name),
      };
    },
  }),
  defineTool({
    name: "github_list_milestones",
    label: "List milestones",
    description:
      "List a repository's milestones with their due date and how many issues are open and closed in each. The number is what github_update_issue takes as `milestone`.",
    category: CATEGORY,
    execute: async (input: Repo & { state?: "open" | "closed" | "all"; perPage?: number }, context) => {
      const { items, truncated } = await transport.paginate(
        context,
        `/repos/${input.owner}/${input.repo}/milestones?state=${input.state ?? "open"}`,
        input.perPage ?? DEFAULT_PER_PAGE,
      );
      return {
        milestones: items.map((row) => {
          const milestone = row as Json;
          return { number: milestone.number, title: milestone.title, state: milestone.state, dueOn: milestone.due_on, openIssues: milestone.open_issues, closedIssues: milestone.closed_issues };
        }),
        truncated,
      };
    },
  }),
];
