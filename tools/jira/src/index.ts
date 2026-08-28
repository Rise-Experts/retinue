/**
 * Jira Cloud tools — REQ-052 (#224), task #225.
 *
 * ## Why a transition is not an update
 *
 * The design decision this package exists to get right. Jira's status is not a field: it moves along a
 * **workflow**, and which moves are legal depends on the project's workflow, the issue's type and its current
 * status. So `jira_update_issue` never touches status, and `jira_transition_issue` takes a *transition id* —
 * which is why `jira_list_transitions` is not optional.
 *
 * The tempting shortcut is to accept a status name and look it up. It is refused, deliberately: transition
 * names and status names are different vocabularies that overlap confusingly ("Done" is usually a status and
 * sometimes a transition), a fuzzy match picks the wrong one silently, and the wrong one *succeeds* — the issue
 * moves somewhere nobody asked for. A refusal that names `jira_list_transitions` costs one extra call and
 * cannot be wrong.
 *
 * ## Why there is no token in this file
 *
 * A `credentialRef` and a resolver, both supplied by the host, resolved per call. Atlassian authenticates with
 * an account email plus an API token as HTTP Basic, which `credentialHeader` builds from a `basic` credential —
 * so this file contains no base64 and no environment read.
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
  type VendorFailure,
  type VendorTransport,
} from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import { adfToMarkdown, EMPTY_ADF, markdownToAdf } from "./adf.js";

export { adfToMarkdown, markdownToAdf, EMPTY_ADF } from "./adf.js";
export type { AdfDocument, AdfNode } from "./adf.js";

const CATEGORY = "project";

/** Jira's own cap on a search page. Asking for more returns this many and reads as "there were only 100". */
const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 25;
/** A ceiling on comment bodies read back, so one issue cannot fill a context window. */
const MAX_COMMENTS = 20;

export type JiraToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** The site, for example `https://acme.atlassian.net`. */
  readonly siteUrl: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/**
 * What Atlassian's failures mean, where they differ from the default.
 *
 * `404` is the one worth spelling out. Jira answers `404` both for an issue that does not exist and for one the
 * credential cannot see, and it is the *same response* — so reporting "not found" sends a model looking for a
 * different key when the real problem is permission. Saying both is the honest answer.
 */
const classify = (failure: VendorFailure) => {
  if (failure.status === 404) {
    return {
      code: "provider_error" as const,
      message: `Jira returned 404: ${failure.reason}. Either it does not exist or this credential cannot see it — Jira answers the same way for both.`,
      retryable: false,
    };
  }
  /**
   * `409` and `412` are edit conflicts, and they are retryable **only after re-reading**.
   *
   * Marked non-retryable because the runtime's retry replays the identical call, which would conflict again.
   * The message says what to do instead.
   */
  if (failure.status === 409 || failure.status === 412) {
    return {
      code: "conflict" as const,
      message: `Jira refused the edit as conflicting (${failure.status}): ${failure.reason}. Re-read the issue and apply the change to the current version.`,
      retryable: false,
    };
  }
  return undefined;
};

/** The fields worth reading back, named so Jira does not return every custom field in the instance. */
const ISSUE_FIELDS = "summary,description,status,assignee,reporter,issuetype,priority,labels,project,created,updated,comment";

const summarise = (issue: Json): Json => {
  const fields = (issue.fields ?? {}) as Json;
  const comments = ((fields.comment ?? {}) as Json).comments;
  return {
    key: issue.key,
    summary: fields.summary,
    // ADF in, markdown out — a model cannot read a JSON document tree.
    description: adfToMarkdown(fields.description),
    status: ((fields.status ?? {}) as Json).name,
    // `statusCategory` is what tells a model whether "In Review" counts as done, which the name alone does not.
    statusCategory: (((fields.status ?? {}) as Json).statusCategory as Json | undefined)?.name,
    type: ((fields.issuetype ?? {}) as Json).name,
    assignee: ((fields.assignee ?? {}) as Json)?.displayName ?? null,
    reporter: ((fields.reporter ?? {}) as Json)?.displayName ?? null,
    priority: ((fields.priority ?? {}) as Json)?.name ?? null,
    labels: fields.labels ?? [],
    project: ((fields.project ?? {}) as Json).key,
    created: fields.created,
    updated: fields.updated,
    ...(Array.isArray(comments)
      ? {
          commentCount: comments.length,
          comments: comments.slice(-MAX_COMMENTS).map((row) => {
            const comment = row as Json;
            return {
              author: ((comment.author ?? {}) as Json).displayName,
              created: comment.created,
              body: adfToMarkdown(comment.body),
            };
          }),
          commentsTruncated: comments.length > MAX_COMMENTS,
        }
      : {}),
  };
};

export const jiraTools = (transport: VendorTransport): readonly Tool[] => [
  defineTool({
    name: "jira_search_issues",
    label: "Search issues",
    description:
      "Search Jira with JQL, for example `project = ENG AND status != Done ORDER BY updated DESC`. Returns each issue's key, summary, status and assignee. Reports `truncated` when there were more than one page.",
    category: CATEGORY,
    execute: async (input: { jql: string; limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
      const result = (await transport.json(context, "/rest/api/3/search/jql", {
        method: "POST",
        // POST rather than GET: a JQL string with quotes and spaces in a query parameter is the single most
        // common way this call fails, and Atlassian's own docs now prefer the POST form.
        body: { jql: input.jql, maxResults: limit, fields: ["summary", "status", "assignee", "issuetype", "updated"] },
      })) as Json;
      const issues = Array.isArray(result.issues) ? result.issues : [];
      return {
        total: result.total ?? issues.length,
        issues: issues.map((row) => {
          const issue = row as Json;
          const fields = (issue.fields ?? {}) as Json;
          return {
            key: issue.key,
            summary: fields.summary,
            status: ((fields.status ?? {}) as Json).name,
            type: ((fields.issuetype ?? {}) as Json).name,
            assignee: ((fields.assignee ?? {}) as Json)?.displayName ?? null,
            updated: fields.updated,
          };
        }),
        // `isLast` when Jira sends it, otherwise inferred. Either way it is stated rather than implied.
        truncated: result.isLast === false || (typeof result.total === "number" && result.total > issues.length),
      };
    },
  }),
  defineTool({
    name: "jira_get_issue",
    label: "Read an issue",
    description:
      "Read one Jira issue by key: summary, description, status, type, assignee, labels and its most recent comments. Descriptions and comments come back as markdown.",
    category: CATEGORY,
    execute: async (input: { key: string }, context) => {
      const issue = (await transport.json(
        context,
        `/rest/api/3/issue/${encodeURIComponent(input.key)}?fields=${ISSUE_FIELDS}`,
      )) as Json;
      return summarise(issue);
    },
  }),
  defineTool({
    name: "jira_list_projects",
    label: "List projects",
    description: "List the Jira projects this credential can see, with the key each search and create call takes.",
    category: CATEGORY,
    execute: async (input: { limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_RESULTS);
      const result = (await transport.json(context, `/rest/api/3/project/search?maxResults=${limit}`)) as Json;
      const values = Array.isArray(result.values) ? result.values : [];
      return {
        projects: values.map((row) => {
          const project = row as Json;
          return { key: project.key, name: project.name, id: project.id, type: project.projectTypeKey };
        }),
        truncated: result.isLast === false,
      };
    },
  }),
  defineTool({
    name: "jira_list_transitions",
    label: "List transitions",
    description:
      "List the workflow transitions available on this issue **right now**, with the id each one needs. Status is not a field in Jira — it moves along a workflow — so this is how a status change is made: read the transitions, then call jira_transition_issue with an id from here.",
    category: CATEGORY,
    execute: async (input: { key: string }, context) => {
      const result = (await transport.json(
        context,
        `/rest/api/3/issue/${encodeURIComponent(input.key)}/transitions`,
      )) as Json;
      const transitions = Array.isArray(result.transitions) ? result.transitions : [];
      return {
        key: input.key,
        transitions: transitions.map((row) => {
          const transition = row as Json;
          return {
            id: transition.id,
            name: transition.name,
            // The status the issue *lands in*, which is what somebody actually means by "move it to Done" — and
            // is often not the transition's own name.
            to: ((transition.to ?? {}) as Json).name,
            toCategory: (((transition.to ?? {}) as Json).statusCategory as Json | undefined)?.name,
          };
        }),
      };
    },
  }),
  confirms({
    name: "jira_create_issue",
    label: "Create an issue",
    description:
      "Create a Jira issue in a project. The description is markdown and is converted for you. Requires approval.",
    category: CATEGORY,
    execute: async (
      input: {
        project: string;
        type: string;
        summary: string;
        description?: string;
        assigneeAccountId?: string;
        labels?: string[];
        priority?: string;
      },
      context,
    ) => {
      const created = (await transport.json(context, "/rest/api/3/issue", {
        method: "POST",
        body: {
          fields: {
            project: { key: input.project },
            issuetype: { name: input.type },
            summary: input.summary,
            description: input.description === undefined ? EMPTY_ADF : markdownToAdf(input.description),
            ...(input.assigneeAccountId === undefined ? {} : { assignee: { id: input.assigneeAccountId } }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.priority === undefined ? {} : { priority: { name: input.priority } }),
          },
        },
      })) as Json;
      return { key: created.key, id: created.id };
    },
  }),
  confirms({
    name: "jira_update_issue",
    label: "Update an issue",
    description:
      "Change a Jira issue's summary, description, assignee, labels or priority. Only the fields supplied are changed. **This cannot change status** — status moves along a workflow, so use jira_list_transitions and jira_transition_issue. Requires approval.",
    category: CATEGORY,
    execute: async (
      input: {
        key: string;
        summary?: string;
        description?: string;
        assigneeAccountId?: string | null;
        labels?: string[];
        priority?: string;
      },
      context,
    ) => {
      const fields: Json = {};
      if (input.summary !== undefined) fields.summary = input.summary;
      if (input.description !== undefined) fields.description = markdownToAdf(input.description);
      if (input.assigneeAccountId !== undefined) {
        // `null` unassigns, which is a real thing somebody means — distinguished from "not supplied" by the
        // union rather than lost to an `undefined` check.
        fields.assignee = input.assigneeAccountId === null ? null : { id: input.assigneeAccountId };
      }
      if (input.labels !== undefined) fields.labels = input.labels;
      if (input.priority !== undefined) fields.priority = { name: input.priority };
      if (Object.keys(fields).length === 0) {
        // Refused rather than sent. An empty PUT succeeds at Jira and changes nothing, so the model is told the
        // update worked.
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "jira_update_issue was called with nothing to change. Supply at least one field.",
          retryable: false,
        });
      }
      await transport.json(context, `/rest/api/3/issue/${encodeURIComponent(input.key)}`, {
        method: "PUT",
        body: { fields },
      });
      // Jira answers 204 with no body, so there is nothing to report but what was asked.
      return { key: input.key, changed: Object.keys(fields) };
    },
  }),
  confirms({
    name: "jira_transition_issue",
    label: "Transition an issue",
    description:
      "Move a Jira issue along its workflow, using a transition **id** from jira_list_transitions. A status name is not accepted: transition names and status names are different vocabularies, and guessing between them moves the issue somewhere nobody asked for. Requires approval.",
    category: CATEGORY,
    execute: async (input: { key: string; transitionId: string; comment?: string }, context) => {
      const id = String(input.transitionId ?? "").trim();
      /**
       * AC-3. A transition id is numeric in every Jira deployment, so anything else is a status name being
       * passed by a model that skipped `jira_list_transitions` — and **there is deliberately no fallback.**
       *
       * A fuzzy match here would be the worst kind of helpful: "Done" is a status in most workflows and a
       * transition in some, the two do not correspond, and a wrong guess *succeeds*. The issue lands in the
       * wrong state, the tool reports success, and nothing anywhere disagrees.
       */
      if (!/^\d+$/.test(id)) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `"${input.transitionId}" is not a transition id. Transition ids are numeric and specific to this ` +
            "issue's workflow — call jira_list_transitions to get the ids available right now, then pass one of " +
            "them. A status name is not a transition id, and this tool will not guess between them.",
          retryable: false,
        });
      }
      await transport.json(context, `/rest/api/3/issue/${encodeURIComponent(input.key)}/transitions`, {
        method: "POST",
        body: {
          transition: { id },
          ...(input.comment === undefined
            ? {}
            : { update: { comment: [{ add: { body: markdownToAdf(input.comment) } }] } }),
        },
      });
      // Read back rather than assumed: a transition can have a post-function that changes more than the status,
      // and reporting the requested id as though it were the outcome would hide that.
      const after = (await transport.json(
        context,
        `/rest/api/3/issue/${encodeURIComponent(input.key)}?fields=status`,
      )) as Json;
      const status = (((after.fields ?? {}) as Json).status ?? {}) as Json;
      return { key: input.key, transitionId: id, status: status.name, statusCategory: (status.statusCategory as Json | undefined)?.name };
    },
  }),
  confirms({
    name: "jira_comment",
    label: "Comment on an issue",
    description: "Add a comment to a Jira issue. The body is markdown and is converted for you. Requires approval.",
    category: CATEGORY,
    execute: async (input: { key: string; body: string }, context) => {
      const comment = (await transport.json(context, `/rest/api/3/issue/${encodeURIComponent(input.key)}/comment`, {
        method: "POST",
        body: { body: markdownToAdf(input.body) },
      })) as Json;
      return { key: input.key, id: comment.id, created: comment.created };
    },
  }),
];

export const createJiraToolkit = (config: JiraToolkitConfig): ToolProvider => {
  const transport = createVendorTransport({
    vendor: "Jira",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.siteUrl,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  const tools = jiraTools(transport);
  return {
    id: "jira",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Jira accepts — #260 AC-2.
 *
 * `basic` rather than `bearer`: Atlassian Cloud takes an account email and an API token as HTTP Basic. This is
 * exactly why `schemes` is separate from `modes` — the wire format is Basic and the way a tenant gets a token
 * is a manual visit to their Atlassian account page, not an OAuth dance. Atlassian's 3LO OAuth exists and is a
 * second mode, not offered yet because it needs a registered app.
 */
export const JIRA_AUTH: ToolkitAuth = { modes: ["token"], schemes: ["basic"] };

export const JIRA_TOOL_NAMES = [
  "jira_search_issues",
  "jira_get_issue",
  "jira_list_projects",
  "jira_list_transitions",
  "jira_create_issue",
  "jira_update_issue",
  "jira_transition_issue",
  "jira_comment",
] as const;
