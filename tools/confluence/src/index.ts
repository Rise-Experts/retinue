/**
 * Confluence Cloud tools — REQ-052 (#224), task #225.
 *
 * ## Why an update needs a version number
 *
 * The design decision this package exists to get right. Confluence pages are versioned, and its v2 API takes
 * the version you believe you are editing. Send the current one and the edit lands; send a stale one and
 * Confluence refuses.
 *
 * The tempting shortcut is to read the current version inside `confluence_update_page` and send that — which
 * *always succeeds*, and is exactly the bug. Between an agent reading a page and writing it back, a person may
 * have edited it, and a self-fetched version number turns that person's work into a silent overwrite. Nobody
 * gets an error; the paragraph is simply gone.
 *
 * So the version is a **required input**, taken from `confluence_get_page`, and a stale one is a `conflict` the
 * model is told to resolve by re-reading. One extra field buys the guarantee that no edit can destroy an edit
 * it never saw.
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

import { markdownToStorage, storageToMarkdown } from "./storage.js";

export { markdownToStorage, storageToMarkdown } from "./storage.js";

const CATEGORY = "knowledge";

const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 25;

export type ConfluenceToolkitConfig = {
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
 * `409` is the one this package is about — see the file header. Non-retryable on purpose: the runtime's retry
 * replays the identical call, which would carry the same stale version and conflict again. The message says
 * what to do instead, because "conflict" alone does not tell a model that re-reading is the fix.
 */
const classify = (failure: VendorFailure) => {
  if (failure.status === 409) {
    return {
      code: "conflict" as const,
      message:
        "Confluence refused the edit: the version supplied is not the page's current version, so somebody " +
        "else has changed it since it was read. Call confluence_get_page again and re-apply the change to the " +
        "current text and version. Retrying this call unchanged will fail the same way.",
      retryable: false,
    };
  }
  if (failure.status === 404) {
    return {
      code: "provider_error" as const,
      message: `Confluence returned 404: ${failure.reason}. Either it does not exist or this credential cannot see it — Confluence answers the same way for both.`,
      retryable: false,
    };
  }
  return undefined;
};

export const confluenceTools = (transport: VendorTransport): readonly Tool[] => [
  defineTool({
    name: "confluence_search",
    label: "Search pages",
    description:
      "Search Confluence with CQL, for example `space = ENG AND text ~ \"retry budget\"`. Returns each result's page id, title and space — the id is what confluence_get_page takes.",
    category: CATEGORY,
    execute: async (input: { cql: string; limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
      const result = (await transport.json(
        context,
        `/wiki/rest/api/search?cql=${encodeURIComponent(input.cql)}&limit=${limit}`,
      )) as Json;
      const results = Array.isArray(result.results) ? result.results : [];
      return {
        results: results.map((row) => {
          const hit = row as Json;
          const content = (hit.content ?? {}) as Json;
          return {
            id: content.id ?? hit.id,
            title: content.title ?? hit.title,
            type: content.type,
            space: ((hit.resultGlobalContainer ?? {}) as Json).title,
            excerpt: typeof hit.excerpt === "string" ? hit.excerpt.replace(/<[^>]+>/g, "") : undefined,
            lastModified: hit.lastModified,
          };
        }),
        // `totalSize` is the count CQL matched, which is often larger than one page of results.
        total: result.totalSize ?? results.length,
        truncated: typeof result.totalSize === "number" && result.totalSize > results.length,
      };
    },
  }),
  defineTool({
    name: "confluence_get_page",
    label: "Read a page",
    description:
      "Read one Confluence page by id: its title, space, body as markdown, and **its current version number** — which confluence_update_page requires, so read the page before editing it.",
    category: CATEGORY,
    execute: async (input: { id: string }, context) => {
      const page = (await transport.json(
        context,
        `/wiki/api/v2/pages/${encodeURIComponent(input.id)}?body-format=storage`,
      )) as Json;
      const body = ((page.body ?? {}) as Json).storage as Json | undefined;
      return {
        id: page.id,
        title: page.title,
        spaceId: page.spaceId,
        parentId: page.parentId ?? null,
        status: page.status,
        // Named `version` and returned at the top level rather than nested, because it is an *input* to the
        // next call and a model has to find it without reading a shape.
        version: ((page.version ?? {}) as Json).number,
        body: storageToMarkdown(body?.value),
        url: ((page._links ?? {}) as Json).webui,
      };
    },
  }),
  defineTool({
    name: "confluence_list_spaces",
    label: "List spaces",
    description: "List the Confluence spaces this credential can see, with the key and id that search and create take.",
    category: CATEGORY,
    execute: async (input: { limit?: number }, context) => {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
      const result = (await transport.json(context, `/wiki/api/v2/spaces?limit=${limit}`)) as Json;
      const results = Array.isArray(result.results) ? result.results : [];
      return {
        spaces: results.map((row) => {
          const space = row as Json;
          return { id: space.id, key: space.key, name: space.name, type: space.type };
        }),
        // v2 paginates by cursor; the presence of a `next` link is the only honest truncation signal.
        truncated: ((result._links ?? {}) as Json).next !== undefined,
      };
    },
  }),
  confirms({
    name: "confluence_create_page",
    label: "Create a page",
    description:
      "Create a Confluence page in a space, with a markdown body that is converted for you. Pass a parentId to nest it under an existing page. Requires approval.",
    category: CATEGORY,
    execute: async (input: { spaceId: string; title: string; body: string; parentId?: string }, context) => {
      const page = (await transport.json(context, "/wiki/api/v2/pages", {
        method: "POST",
        body: {
          spaceId: input.spaceId,
          status: "current",
          title: input.title,
          body: { representation: "storage", value: markdownToStorage(input.body) },
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        },
      })) as Json;
      return {
        id: page.id,
        title: page.title,
        version: ((page.version ?? {}) as Json).number,
        url: ((page._links ?? {}) as Json).webui,
      };
    },
  }),
  confirms({
    name: "confluence_update_page",
    label: "Update a page",
    description:
      "Replace a Confluence page's title and body. **The version number is required** and must be the one confluence_get_page returned: it is how Confluence knows nobody else has edited the page since you read it. If it is stale the edit is refused rather than overwriting their work — read the page again and re-apply your change. The body is markdown and replaces the whole page.",
    category: CATEGORY,
    execute: async (input: { id: string; title: string; body: string; version: number }, context) => {
      /**
       * Checked here rather than left to Confluence. AC-4.
       *
       * A missing or non-numeric version would otherwise be sent, and Confluence's own error names no field —
       * so a model would see a validation blob about a request it cannot inspect. This says which field and why
       * the field exists.
       *
       * There is deliberately **no fallback that reads the current version**. That version of this tool always
       * succeeds and silently overwrites whatever changed since the page was read, which is the failure the
       * required input exists to prevent.
       */
      if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            `confluence_update_page needs the page's current version number, and received ` +
            `${JSON.stringify(input.version)}. Call confluence_get_page and pass the \`version\` it returns. ` +
            "This tool will not look the version up itself: doing so would overwrite any edit made since the " +
            "page was read.",
          retryable: false,
        });
      }
      const page = (await transport.json(context, `/wiki/api/v2/pages/${encodeURIComponent(input.id)}`, {
        method: "PUT",
        body: {
          id: input.id,
          status: "current",
          title: input.title,
          body: { representation: "storage", value: markdownToStorage(input.body) },
          // The **next** version, which is what v2 expects — it is the version being created, not the one being
          // replaced. Sending the current number is refused as a conflict, which reads as somebody else editing
          // and is in fact an off-by-one.
          version: { number: input.version + 1 },
        },
      })) as Json;
      return {
        id: page.id,
        title: page.title,
        version: ((page.version ?? {}) as Json).number,
        url: ((page._links ?? {}) as Json).webui,
      };
    },
  }),
  confirms({
    name: "confluence_comment",
    label: "Comment on a page",
    description:
      "Add a footer comment to a Confluence page. The body is markdown and is converted for you. Requires approval.",
    category: CATEGORY,
    execute: async (input: { pageId: string; body: string }, context) => {
      const comment = (await transport.json(context, "/wiki/api/v2/footer-comments", {
        method: "POST",
        body: { pageId: input.pageId, body: { representation: "storage", value: markdownToStorage(input.body) } },
      })) as Json;
      return { pageId: input.pageId, id: comment.id, version: ((comment.version ?? {}) as Json).number };
    },
  }),
];

export const createConfluenceToolkit = (config: ConfluenceToolkitConfig): ToolProvider => {
  const transport = createVendorTransport({
    vendor: "Confluence",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.siteUrl,
    headers: { accept: "application/json", "content-type": "application/json" },
    classify,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  const tools = confluenceTools(transport);
  return {
    id: "confluence",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Confluence accepts — #260 AC-2.
 *
 * Identical to Jira's, and that is the reason these two packages ship together: one Atlassian account email
 * plus one API token authenticates both, against the same site host. A deployment wires one credential and
 * registers two providers.
 */
export const CONFLUENCE_AUTH: ToolkitAuth = { modes: ["token"], schemes: ["basic"] };

export const CONFLUENCE_TOOL_NAMES = [
  "confluence_search",
  "confluence_get_page",
  "confluence_list_spaces",
  "confluence_create_page",
  "confluence_update_page",
  "confluence_comment",
] as const;
