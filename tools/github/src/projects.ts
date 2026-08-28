/**
 * Group C — Projects v2. Six tools, task #223.
 *
 * The whole point of this file is stated once: **no opaque ids in a schema.**
 *
 * Projects v2 addresses everything by node id — the owner, the project, each item, each field, and each option
 * of a single-select field. All five are base64 blobs, and none of them is knowable to a model that was asked
 * to "move issue 42 to Done". A toolkit that takes them has not integrated Projects v2; it has published the
 * GraphQL API with extra steps, and every call needs three prior calls the model has to invent.
 *
 * So every tool here takes human identifiers — a login, a project number, `owner/repo#number`, a field called
 * `Status`, a value called `Done` — and resolves ids internally. That resolution is the real work of this
 * group, and it is where its risk is.
 *
 * The second rule follows from the first: **when a name does not match, say what would have.** A model given
 * "no such option" retries with another guess. Given "no such option; the options are Todo, In Progress,
 * Done", it picks one. That is the difference between a tool that can be used and one that can be attempted.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";
import type { ExecutionContext } from "@retinue/agentkit";

import type { Json, Transport } from "./transport.js";

const CATEGORY = "project";

/** Enough for any board a person maintains by hand; `truncated` is reported rather than the limit hidden. */
const FIELD_PAGE = 50;
const ITEM_PAGE = 100;

type ProjectNode = { id: string; number: number; title: string; url: string; closed: boolean };

type FieldNode = {
  __typename: string;
  id: string;
  name: string;
  dataType?: string;
  options?: readonly { id: string; name: string }[];
};

type ItemNode = {
  id: string;
  content: { __typename?: string; number?: number; title?: string; repository?: { nameWithOwner?: string } } | null;
};

/**
 * A reference like `owner/repo#42`, which is how a person names an issue.
 *
 * Parsed here rather than taken as three fields, because it is one string in every changelog, review comment
 * and standup note a model will have read.
 */
export const parseIssueRef = (ref: string): { owner: string; repo: string; number: number } => {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(ref.trim());
  if (match === null) {
    throw new Error(`"${ref}" is not an issue reference. Write it as owner/repo#number, for example octocat/hello#42.`);
  }
  return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) };
};

/**
 * The one place a login becomes an owner id, asking both ways at once — see `tolerateNotFound`.
 */
const OWNER_QUERY = `query($login: String!) {
  organization(login: $login) { id }
  user(login: $login) { id }
}`;

const PROJECT_QUERY = `query($login: String!, $number: Int!, $fields: Int!, $items: Int!) {
  organization(login: $login) { projectV2(number: $number) { ...P } }
  user(login: $login) { projectV2(number: $number) { ...P } }
}
fragment P on ProjectV2 {
  id
  number
  title
  url
  closed
  fields(first: $fields) {
    totalCount
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
  items(first: $items) {
    totalCount
    nodes {
      id
      content {
        __typename
        ... on Issue { number title repository { nameWithOwner } }
        ... on PullRequest { number title repository { nameWithOwner } }
        ... on DraftIssue { title }
      }
    }
  }
}`;

type ResolvedProject = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly closed: boolean;
  readonly fields: readonly FieldNode[];
  readonly fieldsTruncated: boolean;
  readonly items: readonly ItemNode[];
  readonly itemsTruncated: boolean;
};

export const createProjectResolver = (transport: Transport) => {
  const ownerId = async (context: ExecutionContext, login: string): Promise<string> => {
    const data = await transport.graphql<{ organization: { id: string } | null; user: { id: string } | null }>(
      context,
      OWNER_QUERY,
      { login },
      { tolerateNotFound: true },
    );
    const id = data.organization?.id ?? data.user?.id;
    if (id === undefined) throw new Error(`No GitHub user or organisation called "${login}".`);
    return id;
  };

  const project = async (context: ExecutionContext, login: string, number: number): Promise<ResolvedProject> => {
    const data = await transport.graphql<{
      organization: { projectV2: (ProjectNode & { fields: { totalCount: number; nodes: FieldNode[] }; items: { totalCount: number; nodes: ItemNode[] } }) | null } | null;
      user: { projectV2: (ProjectNode & { fields: { totalCount: number; nodes: FieldNode[] }; items: { totalCount: number; nodes: ItemNode[] } }) | null } | null;
    }>(context, PROJECT_QUERY, { login, number, fields: FIELD_PAGE, items: ITEM_PAGE }, { tolerateNotFound: true });
    const found = data.organization?.projectV2 ?? data.user?.projectV2;
    if (found === undefined || found === null) {
      throw new Error(`${login} has no project number ${number}. Use github_list_projects to see which numbers exist.`);
    }
    return {
      id: found.id,
      number: found.number,
      title: found.title,
      url: found.url,
      closed: found.closed,
      fields: found.fields.nodes,
      fieldsTruncated: found.fields.totalCount > found.fields.nodes.length,
      items: found.items.nodes,
      itemsTruncated: found.items.totalCount > found.items.nodes.length,
    };
  };

  /**
   * A field by name, and on a miss **the available names**.
   *
   * Case-insensitive because "status" and "Status" are the same field to everyone except GraphQL.
   */
  const fieldNamed = (resolved: ResolvedProject, name: string): FieldNode => {
    const field = resolved.fields.find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase());
    if (field === undefined) {
      const available = resolved.fields.map((candidate) => candidate.name);
      throw new Error(
        `Project "${resolved.title}" has no field called "${name}". ` +
          (available.length === 0
            ? "It has no fields at all."
            : `Its fields are: ${available.join(", ")}.`) +
          (resolved.fieldsTruncated ? " More fields exist than were listed." : ""),
      );
    }
    return field;
  };

  /** An item by `owner/repo#number`, and on a miss what the board actually holds. */
  const itemFor = (resolved: ResolvedProject, ref: string): ItemNode => {
    const { owner, repo, number } = parseIssueRef(ref);
    const wanted = `${owner}/${repo}`;
    const item = resolved.items.find(
      (candidate) => candidate.content?.number === number && candidate.content?.repository?.nameWithOwner === wanted,
    );
    if (item === undefined) {
      const present = resolved.items
        .filter((candidate) => candidate.content?.number !== undefined)
        .map((candidate) => `${candidate.content?.repository?.nameWithOwner}#${candidate.content?.number}`);
      throw new Error(
        `${ref} is not on project "${resolved.title}". ` +
          (present.length === 0
            ? "The project has no issues or pull requests on it."
            : `It holds: ${present.slice(0, 20).join(", ")}${present.length > 20 ? ", …" : ""}.`) +
          (resolved.itemsTruncated ? " More items exist than were listed — this may be one of them." : "") +
          " Use github_add_project_item to put it there first.",
      );
    }
    return item;
  };

  return { ownerId, project, fieldNamed, itemFor };
};

/**
 * A field name and a human value, turned into the `ProjectV2FieldValue` GraphQL insists on.
 *
 * Single-select is the case that matters: the API wants `singleSelectOptionId`, a base64 blob, and the model
 * has the word "Done". On a miss this names every option, which is the second rule of this file.
 *
 * Exported for its own test — the mapping from five field types to a one-key union is the part most likely to
 * be silently wrong, and a wrong key here typechecks and does nothing.
 */
export const fieldValueFor = (field: FieldNode, value: string): Json => {
  if (field.__typename === "ProjectV2SingleSelectField" || field.options !== undefined) {
    const options = field.options ?? [];
    const option = options.find((candidate) => candidate.name.toLowerCase() === value.trim().toLowerCase());
    if (option === undefined) {
      throw new Error(
        `"${value}" is not an option for the field "${field.name}". ` +
          (options.length === 0
            ? "It has no options."
            : `Its options are: ${options.map((candidate) => candidate.name).join(", ")}.`),
      );
    }
    return { singleSelectOptionId: option.id };
  }
  switch (field.dataType) {
    case "NUMBER": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`The field "${field.name}" takes a number, and "${value}" is not one.`);
      return { number: parsed };
    }
    case "DATE": {
      // GitHub wants `YYYY-MM-DD` and rejects anything else with a validation error naming no field. Checked
      // here so the message names the field and the format.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        throw new Error(`The field "${field.name}" takes a date as YYYY-MM-DD, and "${value}" is not.`);
      }
      return { date: value.trim() };
    }
    case "TEXT":
      return { text: value };
    default:
      // ITERATION needs an iteration id, which is not a name anybody has. Refused rather than guessed.
      throw new Error(
        `The field "${field.name}" is of type ${field.dataType ?? field.__typename}, which this tool cannot set. ` +
          "Text, number, date and single-select fields can be set.",
      );
  }
};

export const projectTools = (transport: Transport): readonly Tool[] => {
  const resolve = createProjectResolver(transport);

  return [
    defineTool({
      name: "github_list_projects",
      label: "List projects",
      description:
        "List the Projects v2 boards belonging to a user or organisation, with each project's number — which is what the other project tools take. Works for either kind of owner without being told which.",
      category: CATEGORY,
      execute: async (input: { owner: string; includeClosed?: boolean }, context) => {
        const data = await transport.graphql<{
          organization: { projectsV2: { totalCount: number; nodes: ProjectNode[] } } | null;
          user: { projectsV2: { totalCount: number; nodes: ProjectNode[] } } | null;
        }>(
          context,
          `query($login: String!, $first: Int!) {
  organization(login: $login) { projectsV2(first: $first) { totalCount nodes { id number title url closed } } }
  user(login: $login) { projectsV2(first: $first) { totalCount nodes { id number title url closed } } }
}`,
          { login: input.owner, first: FIELD_PAGE },
          { tolerateNotFound: true },
        );
        const container = data.organization?.projectsV2 ?? data.user?.projectsV2;
        if (container === undefined) throw new Error(`No GitHub user or organisation called "${input.owner}".`);
        const all = container.nodes.filter((project) => input.includeClosed === true || !project.closed);
        return {
          projects: all.map(({ number, title, url, closed }) => ({ number, title, url, closed })),
          truncated: container.totalCount > container.nodes.length,
        };
      },
    }),
    defineTool({
      name: "github_get_project",
      label: "Read a project",
      description:
        "Read a project board: its fields **with the options each single-select field allows**, and the issues and pull requests on it. Read this before setting a field — the option names it lists are the values github_set_project_field accepts.",
      category: CATEGORY,
      execute: async (input: { owner: string; number: number }, context) => {
        const found = await resolve.project(context, input.owner, input.number);
        return {
          number: found.number,
          title: found.title,
          url: found.url,
          closed: found.closed,
          fields: found.fields.map((field) => ({
            name: field.name,
            type: field.__typename === "ProjectV2SingleSelectField" ? "single-select" : (field.dataType ?? "unknown").toLowerCase(),
            ...(field.options === undefined ? {} : { options: field.options.map((option) => option.name) }),
          })),
          fieldsTruncated: found.fieldsTruncated,
          items: found.items.map((item) => ({
            ref:
              item.content?.repository?.nameWithOwner === undefined || item.content?.number === undefined
                ? undefined
                : `${item.content.repository.nameWithOwner}#${item.content.number}`,
            kind: item.content?.__typename,
            title: item.content?.title,
          })),
          itemsTruncated: found.itemsTruncated,
        };
      },
    }),
    confirms({
      name: "github_create_project",
      label: "Create a project",
      description:
        "Create a Projects v2 board owned by a user or organisation. Returns the project number the other tools take. Requires approval.",
      category: CATEGORY,
      execute: async (input: { owner: string; title: string }, context) => {
        const owner = await resolve.ownerId(context, input.owner);
        const data = await transport.graphql<{ createProjectV2: { projectV2: ProjectNode } }>(
          context,
          `mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { id number title url closed } }
}`,
          { ownerId: owner, title: input.title },
        );
        const created = data.createProjectV2.projectV2;
        return { number: created.number, title: created.title, url: created.url };
      },
    }),
    confirms({
      name: "github_add_project_item",
      label: "Add an issue to a project",
      description:
        "Put an existing issue or pull request on a project board, naming it as owner/repo#number. This adds it to the board; it does not change the issue. Requires approval.",
      category: CATEGORY,
      execute: async (input: { owner: string; number: number; issue: string }, context) => {
        const board = await resolve.project(context, input.owner, input.number);
        const { owner, repo, number } = parseIssueRef(input.issue);
        // The content id, from the human reference. Both kinds are asked for because `owner/repo#7` names an
        // issue or a pull request and the caller has no reason to know which — GitHub numbers them together.
        const content = await transport.graphql<{
          repository: { issueOrPullRequest: { id: string; __typename: string } | null } | null;
        }>(
          context,
          `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) { __typename ... on Issue { id } ... on PullRequest { id } }
  }
}`,
          { owner, repo, number },
        );
        const target = content.repository?.issueOrPullRequest;
        if (target === undefined || target === null) throw new Error(`${input.issue} does not exist.`);
        const data = await transport.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
          context,
          `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`,
          { projectId: board.id, contentId: target.id },
        );
        return { added: input.issue, kind: target.__typename, project: board.title, itemId: data.addProjectV2ItemById.item.id };
      },
    }),
    confirms({
      name: "github_set_project_field",
      label: "Set a project field",
      description:
        'Set a field on an item already on a project board — for example field "Status", value "Done". Both the field and the value are given by name. If either does not match, the failure names the valid ones. Requires approval.',
      category: CATEGORY,
      execute: async (input: { owner: string; number: number; issue: string; field: string; value: string }, context) => {
        const board = await resolve.project(context, input.owner, input.number);
        const field = resolve.fieldNamed(board, input.field);
        const item = resolve.itemFor(board, input.issue);
        const value = fieldValueFor(field, input.value);
        await transport.graphql(
          context,
          `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
    projectV2Item { id }
  }
}`,
          { projectId: board.id, itemId: item.id, fieldId: field.id, value },
        );
        return { issue: input.issue, field: field.name, value: input.value, project: board.title };
      },
    }),
    destroys({
      name: "github_remove_project_item",
      label: "Remove an issue from a project",
      description:
        "Take an issue or pull request off a project board. **This does not delete or close the issue** — the issue stays exactly as it is and only its place on the board is lost, along with every field value it had there. Requires approval.",
      category: CATEGORY,
      execute: async (input: { owner: string; number: number; issue: string }, context) => {
        const board = await resolve.project(context, input.owner, input.number);
        const item = resolve.itemFor(board, input.issue);
        await transport.graphql(
          context,
          `mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
}`,
          { projectId: board.id, itemId: item.id },
        );
        return { removedFromBoard: input.issue, project: board.title, issueStillExists: true };
      },
    }),
  ];
};
