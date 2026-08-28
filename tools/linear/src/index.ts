/**
 * Linear tools — REQ-052 (#224), task #226.
 *
 * ## Why this file has a GraphQL envelope reader and `tools-jira` does not
 *
 * Linear is GraphQL-only, and GraphQL reports application errors with **HTTP 200** and `{ data: null, errors:
 * [...] }`. Every status check passes; a client that stops there hands the tool a null `data`, the tool reads a
 * field off it, and the model is told "internal error" about a problem described precisely in a field nobody
 * looked at. This is the same lesson as Slack's `ok: false` (#214) and GitHub's Projects v2 (#223) — and it is
 * per-vendor rather than in `createVendorTransport`, because only the vendor knows the envelope's shape.
 *
 * ## Why there is no `linear_transition_issue`
 *
 * Jira needed one because its status moves along a workflow whose legal moves depend on the issue. Linear has
 * no such constraint: a state is a field, and any state on the team may be set. So state belongs in
 * `linear_update_issue`, and inventing a second tool would be a confusable near-duplicate — which #210 measured
 * costing real accuracy.
 *
 * What Linear *does* share with Jira is that states are **per team** and addressed by uuid. So
 * `linear_list_states` is not optional, and every tool here takes human identifiers — a team key, an issue
 * identifier like `ENG-123`, a state *name* — and resolves ids internally.
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
import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";

const CATEGORY = "project";

const API = "https://api.linear.app";
const DEFAULT_RESULTS = 25;
const MAX_RESULTS = 100;

export type LinearToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  /** Defaults to `https://api.linear.app`. */
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/**
 * A GraphQL call whose **envelope is read** — AC-3.
 *
 * `data` absent or null with no `errors` is also a failure: a successful GraphQL response always carries
 * `data`, so that shape means something changed and guessing would report a wrong answer as a right one.
 */
export const graphqlVia = async <T = Json>(
  transport: VendorTransport,
  context: ExecutionContext,
  query: string,
  variables: Json,
): Promise<T> => {
  const envelope = (await transport.json(context, "/graphql", { method: "POST", body: { query, variables } })) as {
    data?: unknown;
    errors?: unknown;
  } | undefined;
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
  if (errors.length > 0) {
    const first = errors[0] as { message?: unknown; extensions?: { code?: unknown; type?: unknown } };
    const message = typeof first.message === "string" ? first.message : "Linear returned a GraphQL error";
    const code = first.extensions?.code ?? first.extensions?.type;
    throw new AgentPlatformError({
      // Linear reports permission failures inside the envelope rather than as a status, so the distinction the
      // model needs — is retrying pointless — exists only here.
      code: code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN" ? "unauthorized" : "provider_error",
      message: errors.length > 1 ? `${message} (and ${errors.length - 1} more GraphQL error(s))` : message,
      retryable: false,
    });
  }
  if (envelope?.data === undefined || envelope.data === null) {
    throw new AgentPlatformError({
      code: "provider_error",
      message: "Linear returned no data and no errors, which is not a shape this understands",
      retryable: false,
    });
  }
  return envelope.data as T;
};

/**
 * `ENG-123` — the identifier a person pastes, which is not the uuid the API takes.
 */
export const parseIdentifier = (identifier: string): { team: string; number: number } => {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
  if (match === null) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `"${identifier}" is not a Linear issue identifier. Write it as TEAM-number, for example ENG-123.`,
      retryable: false,
    });
  }
  return { team: (match[1] as string).toUpperCase(), number: Number(match[2]) };
};

const ISSUE_FIELDS = `id identifier title description priority url createdAt updatedAt
  state { id name type }
  team { id key name }
  assignee { id name displayName }
  labels { nodes { name } }`;

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  state?: { id: string; name: string; type: string } | null;
  team?: { id: string; key: string; name: string } | null;
  assignee?: { id: string; name?: string; displayName?: string } | null;
  labels?: { nodes: { name: string }[] };
};

const summarise = (issue: IssueNode): Json => ({
  identifier: issue.identifier,
  title: issue.title,
  // Linear stores descriptions and comments as markdown natively, so there is no conversion here — which is
  // the whole reason this package has no equivalent of Jira's ADF module.
  description: issue.description ?? "",
  state: issue.state?.name ?? null,
  // `type` is what tells a model whether a custom state like "In Review" counts as done; the name alone cannot.
  stateType: issue.state?.type ?? null,
  team: issue.team?.key ?? null,
  assignee: issue.assignee?.displayName ?? issue.assignee?.name ?? null,
  priority: issue.priority ?? null,
  labels: (issue.labels?.nodes ?? []).map((label) => label.name),
  url: issue.url,
  updatedAt: issue.updatedAt,
});

export const createLinearToolkit = (config: LinearToolkitConfig): ToolProvider => {
  const transport = createVendorTransport({
    vendor: "Linear",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? API,
    headers: { accept: "application/json", "content-type": "application/json" },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const graphql = <T = Json>(context: ExecutionContext, query: string, variables: Json): Promise<T> =>
    graphqlVia<T>(transport, context, query, variables);

  /** A team's uuid from its key, and on a miss **the keys that exist**. */
  const teamIdFor = async (context: ExecutionContext, key: string): Promise<{ id: string; key: string }> => {
    const data = await graphql<{ teams: { nodes: { id: string; key: string }[] } }>(
      context,
      `query { teams(first: 100) { nodes { id key } } }`,
      {},
    );
    const wanted = key.trim().toUpperCase();
    const team = data.teams.nodes.find((candidate) => candidate.key.toUpperCase() === wanted);
    if (team === undefined) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          `No Linear team with the key "${key}". ` +
          (data.teams.nodes.length === 0
            ? "This credential can see no teams at all."
            : `The keys are: ${data.teams.nodes.map((candidate) => candidate.key).join(", ")}.`),
        retryable: false,
      });
    }
    return team;
  };

  /** A state's uuid from its name, within one team, and on a miss **the names that exist**. */
  const stateIdFor = async (context: ExecutionContext, teamId: string, name: string): Promise<string> => {
    const data = await graphql<{ team: { states: { nodes: { id: string; name: string; type: string }[] } } | null }>(
      context,
      `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
      { teamId },
    );
    const states = data.team?.states.nodes ?? [];
    const state = states.find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase());
    if (state === undefined) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          `"${name}" is not a workflow state on this team. ` +
          (states.length === 0
            ? "The team has no states."
            : `Its states are: ${states.map((candidate) => candidate.name).join(", ")}.`) +
          " States are per team — use linear_list_states to see them.",
        retryable: false,
      });
    }
    return state.id;
  };

  /** An issue's uuid from `ENG-123`. */
  const issueFor = async (context: ExecutionContext, identifier: string): Promise<IssueNode> => {
    const { team, number } = parseIdentifier(identifier);
    const data = await graphql<{ issues: { nodes: IssueNode[] } }>(
      context,
      `query($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) { nodes { ${ISSUE_FIELDS} } }
}`,
      { team, number },
    );
    const issue = data.issues.nodes[0];
    if (issue === undefined) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: `No Linear issue ${identifier}. Either it does not exist or this credential cannot see its team.`,
        retryable: false,
      });
    }
    return issue;
  };

  const tools: readonly Tool[] = [
    defineTool({
      name: "linear_search_issues",
      label: "Search issues",
      description:
        "Search Linear issues by text, optionally narrowed to a team key, a workflow state name or an assignee. Returns each issue's identifier (like ENG-123), title, state and assignee.",
      category: CATEGORY,
      execute: async (input: { query?: string; team?: string; state?: string; assignee?: string; limit?: number }, context) => {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
        const filter: Json = {};
        if (input.team !== undefined) filter.team = { key: { eq: input.team.trim().toUpperCase() } };
        // By name rather than by id: a filter is a read, so a name that matches nothing yields no results
        // rather than a wrong answer, and requiring a uuid here would make the tool uncallable.
        if (input.state !== undefined) filter.state = { name: { eqIgnoreCase: input.state } };
        if (input.assignee !== undefined) filter.assignee = { displayName: { containsIgnoreCase: input.assignee } };
        const data = await graphql<{ issues: { nodes: IssueNode[]; pageInfo?: { hasNextPage?: boolean } } }>(
          context,
          `query($filter: IssueFilter, $first: Int!, $q: String) {
  issues(filter: $filter, first: $first, ${""}orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage } }
}`,
          { filter, first: limit, q: input.query ?? null },
        );
        const nodes = data.issues.nodes;
        const query = (input.query ?? "").trim().toLowerCase();
        /**
         * Text filtered here rather than in the query.
         *
         * Linear's `IssueFilter` has no free-text field — full-text search is a separate `searchIssues`
         * connection with a different shape. Filtering the fetched page is honest about what it is: a
         * narrowing of what was retrieved, reported as `truncated` when there was more.
         */
        const matched =
          query === ""
            ? nodes
            : nodes.filter(
                (issue) =>
                  issue.title.toLowerCase().includes(query) || (issue.description ?? "").toLowerCase().includes(query),
              );
        return {
          issues: matched.map(summarise),
          truncated: data.issues.pageInfo?.hasNextPage === true,
          ...(query === ""
            ? {}
            : {
                note: `Text matching was applied to the ${nodes.length} most recently updated issue(s) that matched the filters, not to every issue in the workspace.`,
              }),
        };
      },
    }),
    defineTool({
      name: "linear_get_issue",
      label: "Read an issue",
      description:
        "Read one Linear issue by its identifier, for example ENG-123. Returns the description as markdown, plus state, team, assignee, priority and labels.",
      category: CATEGORY,
      execute: async (input: { identifier: string }, context) => summarise(await issueFor(context, input.identifier)),
    }),
    defineTool({
      name: "linear_list_teams",
      label: "List teams",
      description: "List the Linear teams this credential can see, with the key that every other tool takes.",
      category: CATEGORY,
      execute: async (_input: Record<string, never>, context) => {
        const data = await graphql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(
          context,
          `query { teams(first: 100) { nodes { id key name } } }`,
          {},
        );
        return { teams: data.teams.nodes.map((team) => ({ key: team.key, name: team.name })) };
      },
    }),
    defineTool({
      name: "linear_list_states",
      label: "List workflow states",
      description:
        "List a team's workflow states, by team key. **States are per team**, so a state name that exists on one team may not exist on another — read this before setting one. Each state's `type` says whether it counts as started, completed or cancelled.",
      category: CATEGORY,
      execute: async (input: { team: string }, context) => {
        const team = await teamIdFor(context, input.team);
        const data = await graphql<{ team: { states: { nodes: { name: string; type: string; position: number }[] } } | null }>(
          context,
          `query($teamId: String!) { team(id: $teamId) { states { nodes { name type position } } } }`,
          { teamId: team.id },
        );
        const states = [...(data.team?.states.nodes ?? [])].sort((a, b) => a.position - b.position);
        return { team: team.key, states: states.map((state) => ({ name: state.name, type: state.type })) };
      },
    }),
    confirms({
      name: "linear_create_issue",
      label: "Create an issue",
      description:
        "Create a Linear issue on a team, naming the team by its key. The description is markdown, which Linear stores natively. Requires approval.",
      category: CATEGORY,
      execute: async (
        input: { team: string; title: string; description?: string; state?: string; priority?: number; assigneeId?: string },
        context,
      ) => {
        const team = await teamIdFor(context, input.team);
        const stateId = input.state === undefined ? undefined : await stateIdFor(context, team.id, input.state);
        const data = await graphql<{ issueCreate: { success: boolean; issue: IssueNode | null } }>(
          context,
          `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          {
            input: {
              teamId: team.id,
              title: input.title,
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(stateId === undefined ? {} : { stateId }),
              ...(input.priority === undefined ? {} : { priority: input.priority }),
              ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
            },
          },
        );
        /**
         * `success: false` with no `errors` is a real Linear shape, and it is a failure.
         *
         * The envelope reader above cannot catch it — the GraphQL call succeeded. Without this the tool reports
         * a created issue that does not exist.
         */
        if (!data.issueCreate.success || data.issueCreate.issue === null) {
          throw new AgentPlatformError({
            code: "provider_error",
            message: "Linear reported the issue was not created, without saying why.",
            retryable: false,
          });
        }
        return summarise(data.issueCreate.issue);
      },
    }),
    confirms({
      name: "linear_update_issue",
      label: "Update an issue",
      description:
        "Change a Linear issue's title, description, workflow state, priority or assignee, by identifier. Only the fields supplied are changed. Unlike Jira, moving between states is an update — there is no separate transition. Requires approval.",
      category: CATEGORY,
      execute: async (
        input: { identifier: string; title?: string; description?: string; state?: string; priority?: number; assigneeId?: string | null },
        context,
      ) => {
        const issue = await issueFor(context, input.identifier);
        const patch: Json = {};
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.priority !== undefined) patch.priority = input.priority;
        // `null` unassigns, which is a real thing somebody means — distinguished from "not supplied".
        if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
        if (input.state !== undefined) {
          if (issue.team === null || issue.team === undefined) {
            throw new AgentPlatformError({
              code: "provider_error",
              message: `Linear did not report a team for ${input.identifier}, so its states cannot be resolved.`,
              retryable: false,
            });
          }
          patch.stateId = await stateIdFor(context, issue.team.id, input.state);
        }
        if (Object.keys(patch).length === 0) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "linear_update_issue was called with nothing to change. Supply at least one field.",
            retryable: false,
          });
        }
        const data = await graphql<{ issueUpdate: { success: boolean; issue: IssueNode | null } }>(
          context,
          `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          { id: issue.id, input: patch },
        );
        if (!data.issueUpdate.success || data.issueUpdate.issue === null) {
          throw new AgentPlatformError({
            code: "provider_error",
            message: `Linear reported ${input.identifier} was not updated, without saying why.`,
            retryable: false,
          });
        }
        return { ...summarise(data.issueUpdate.issue), changed: Object.keys(patch) };
      },
    }),
    confirms({
      name: "linear_comment",
      label: "Comment on an issue",
      description: "Add a comment to a Linear issue by identifier. The body is markdown, which Linear stores natively. Requires approval.",
      category: CATEGORY,
      execute: async (input: { identifier: string; body: string }, context) => {
        const issue = await issueFor(context, input.identifier);
        const data = await graphql<{ commentCreate: { success: boolean; comment: { id: string; url?: string } | null } }>(
          context,
          `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
          { input: { issueId: issue.id, body: input.body } },
        );
        if (!data.commentCreate.success || data.commentCreate.comment === null) {
          throw new AgentPlatformError({
            code: "provider_error",
            message: `Linear reported the comment on ${input.identifier} was not created, without saying why.`,
            retryable: false,
          });
        }
        return { identifier: issue.identifier, id: data.commentCreate.comment.id, url: data.commentCreate.comment.url };
      },
    }),
  ];

  return {
    id: "linear",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Linear accepts — #260 AC-2.
 *
 * `custom-header`, not `bearer`. A Linear personal API key goes in `Authorization` **without** the `Bearer`
 * prefix, and sending `Bearer lin_api_…` fails with an authentication error that does not say why. This is the
 * clearest case yet for `schemes` being its own axis: the header name is the standard one and the format is not.
 *
 * Linear's OAuth tokens *are* bearers, which is a second mode and is not offered yet.
 */
export const LINEAR_AUTH: ToolkitAuth = { modes: ["token"], schemes: ["custom-header"] };

export const LINEAR_TOOL_NAMES = [
  "linear_search_issues",
  "linear_get_issue",
  "linear_list_teams",
  "linear_list_states",
  "linear_create_issue",
  "linear_update_issue",
  "linear_comment",
] as const;
