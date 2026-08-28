/**
 * Notion tools — REQ-052 (#224), task #226.
 *
 * ## The two things this package exists to get right
 *
 * **1. Notion silently ignores a property it does not recognise.** `PATCH /pages/{id}` with
 * `{"Staus": {...}}` returns `200`, changes nothing, and reports success. That is the exact defect shape this
 * repository keeps finding — a wrong field name that typechecks and does nothing — except here it reaches the
 * model as a confirmed edit. So `notion_create_page` and `notion_update_page` **fetch the database schema and
 * validate property names locally, before the call**, and a miss names the properties that exist.
 *
 * **2. An empty search means one of two very different things.** Notion's search only ever returns pages the
 * integration has been *explicitly shared with* — a workspace can have ten thousand pages and a new
 * integration sees none of them. The API cannot distinguish "no matches" from "nothing is shared", and
 * reporting "no results" sends people to rewrite a query when the fix is three clicks in Notion's UI. So an
 * empty result says so.
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

import { flattenBlocks, markdownToBlocks, richTextToMarkdown, type Block } from "./blocks.js";

export { flattenBlocks, markdownToBlocks, richTextToMarkdown, blockToMarkdown, MAX_BLOCKS, MAX_CHARS, MAX_DEPTH } from "./blocks.js";
export type { Block, FlattenResult, RichText } from "./blocks.js";

const CATEGORY = "knowledge";

const API = "https://api.notion.com";
/** Pinned, because Notion's API is versioned by header and an unpinned client breaks on their schedule. */
const NOTION_VERSION = "2022-06-28";
const DEFAULT_RESULTS = 25;
const MAX_RESULTS = 100;

export type NotionToolkitConfig = {
  /** Resolved per call, by the host. Never read from the environment here. */
  readonly credentialRef: CredentialRef;
  readonly resolver: CredentialResolver;
  readonly baseUrl?: string;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/** The sentence AC-5 is about, said once so both tools say it identically. */
export const NOTHING_SHARED =
  "Notion only returns pages an integration has been explicitly shared with, so an empty result here means " +
  "either nothing matched or nothing has been shared with this integration — the API cannot tell them apart. " +
  "If this is unexpected, open the page or database in Notion, use its ••• menu → Connections, and add this " +
  "integration.";

/** A page's title, which lives in whichever property has type `title` and is never called "title". */
export const titleOf = (page: Json): string => {
  const properties = (page.properties ?? {}) as Record<string, { type?: string; title?: readonly { plain_text?: string }[] }>;
  for (const property of Object.values(properties)) {
    if (property.type === "title") return richTextToMarkdown(property.title);
  }
  return "";
};

/**
 * One property's value as something a model can read.
 *
 * Notion's property values are a tagged union of about twenty shapes, and the useful half is small. Anything
 * unhandled yields its JSON rather than being dropped, so a page never silently loses a field.
 */
export const propertyToPlain = (property: Json): unknown => {
  switch (property.type) {
    case "title":
      return richTextToMarkdown(property.title as never);
    case "rich_text":
      return richTextToMarkdown(property.rich_text as never);
    case "number":
      return property.number;
    case "select":
      return (property.select as { name?: string } | null)?.name ?? null;
    case "multi_select":
      return ((property.multi_select ?? []) as { name?: string }[]).map((option) => option.name);
    case "status":
      return (property.status as { name?: string } | null)?.name ?? null;
    case "date":
      return (property.date as { start?: string; end?: string } | null) ?? null;
    case "checkbox":
      return property.checkbox;
    case "url":
    case "email":
    case "phone_number":
      return property[property.type];
    case "people":
      return ((property.people ?? []) as { name?: string }[]).map((person) => person.name);
    case "created_time":
    case "last_edited_time":
      return property[property.type];
    case "relation":
      return ((property.relation ?? []) as { id?: string }[]).map((row) => row.id);
    case "formula":
      return (property.formula as Json | undefined)?.[(property.formula as Json | undefined)?.type as string] ?? null;
    default:
      return property[property.type as string] ?? null;
  }
};

export const createNotionToolkit = (config: NotionToolkitConfig): ToolProvider => {
  const transport: VendorTransport = createVendorTransport({
    vendor: "Notion",
    credentialRef: config.credentialRef,
    resolver: config.resolver,
    baseUrl: config.baseUrl ?? API,
    headers: { accept: "application/json", "content-type": "application/json", "notion-version": NOTION_VERSION },
    classify: (failure) => {
      if (failure.status === 404) {
        return {
          code: "provider_error" as const,
          message:
            `Notion returned 404: ${failure.reason}. This usually means the page or database has not been ` +
            "shared with this integration rather than that it does not exist — Notion answers the same way for both.",
          retryable: false,
        };
      }
      return undefined;
    },
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });

  const childrenOf = async (context: ExecutionContext, id: string): Promise<readonly Block[]> => {
    const result = (await transport.json(context, `/v1/blocks/${encodeURIComponent(id)}/children?page_size=100`)) as Json | undefined;
    return (Array.isArray(result?.results) ? result.results : []) as readonly Block[];
  };

  /**
   * A database's property schema, used to validate names before a write — AC-4.
   */
  const schemaOf = async (context: ExecutionContext, databaseId: string): Promise<Record<string, { type: string }>> => {
    const database = (await transport.json(context, `/v1/databases/${encodeURIComponent(databaseId)}`)) as Json | undefined;
    return (database?.properties ?? {}) as Record<string, { type: string }>;
  };

  /**
   * Every supplied property name must exist in the schema, and the title must be present on a create.
   *
   * The name check is the one that matters. Notion accepts an unknown property, returns `200`, changes
   * nothing, and says it succeeded — so without this a typo is reported to the model as a completed edit.
   */
  const validateProperties = (
    schema: Record<string, { type: string }>,
    supplied: Record<string, unknown>,
    options: { requireTitle: boolean },
  ): void => {
    const known = Object.keys(schema);
    const unknown = Object.keys(supplied).filter((name) => !(name in schema));
    if (unknown.length > 0) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          `This database has no propert${unknown.length === 1 ? "y" : "ies"} called ${unknown.map((name) => `"${name}"`).join(", ")}. ` +
          (known.length === 0 ? "It has no properties." : `Its properties are: ${known.join(", ")}.`) +
          " Notion would accept this write, change nothing, and report success — so it is refused here instead.",
        retryable: false,
      });
    }
    if (!options.requireTitle) return;
    const titleName = Object.entries(schema).find(([, property]) => property.type === "title")?.[0];
    if (titleName !== undefined && !(titleName in supplied)) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          `This database's title property is "${titleName}" and no value was supplied for it. A page created ` +
          "without it is untitled and effectively unfindable.",
        retryable: false,
      });
    }
  };

  const tools: readonly Tool[] = [
    defineTool({
      name: "notion_search",
      label: "Search Notion",
      description:
        "Search the pages and databases **shared with this integration** — not the whole workspace. Returns each result's id, title and type. An empty result says whether nothing matched or nothing is shared.",
      category: CATEGORY,
      execute: async (input: { query?: string; type?: "page" | "database"; limit?: number }, context) => {
        const result = (await transport.json(context, "/v1/search", {
          method: "POST",
          body: {
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.type === undefined ? {} : { filter: { property: "object", value: input.type } }),
            page_size: Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS),
          },
        })) as Json | undefined;
        const results = (Array.isArray(result?.results) ? result.results : []) as Json[];
        return {
          results: results.map((row) => ({
            id: row.id,
            type: row.object,
            title: row.object === "database" ? richTextToMarkdown(row.title as never) : titleOf(row),
            url: row.url,
            lastEdited: row.last_edited_time,
          })),
          truncated: result?.has_more === true,
          // AC-5. The two cases are indistinguishable from the API, so the answer names both rather than
          // implying the query was wrong.
          ...(results.length === 0 ? { note: NOTHING_SHARED } : {}),
        };
      },
    }),
    defineTool({
      name: "notion_get_page",
      label: "Read a page",
      description:
        "Read a Notion page: its properties, and its block tree flattened to markdown. Bounded in depth, block count and size — when it stops early it says so and which limit it hit.",
      category: CATEGORY,
      execute: async (input: { id: string; maxDepth?: number }, context) => {
        const page = (await transport.json(context, `/v1/pages/${encodeURIComponent(input.id)}`)) as Json | undefined;
        const roots = await childrenOf(context, input.id);
        const flattened = await flattenBlocks(roots, (id) => childrenOf(context, id), {
          ...(input.maxDepth === undefined ? {} : { depth: input.maxDepth }),
        });
        const properties = (page?.properties ?? {}) as Record<string, Json>;
        return {
          id: page?.id,
          title: titleOf(page ?? {}),
          url: page?.url,
          lastEdited: page?.last_edited_time,
          properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, propertyToPlain(value)])),
          body: flattened.markdown,
          truncated: flattened.truncated,
          ...(flattened.truncated ? { truncatedBy: flattened.stoppedBy, blocksRead: flattened.blocksRead } : {}),
        };
      },
    }),
    defineTool({
      name: "notion_query_database",
      label: "Query a database",
      description:
        "Query a Notion database with an optional filter and sort, returning each row's id and properties. A database is the closest thing Notion has to an issue list.",
      category: CATEGORY,
      execute: async (input: { databaseId: string; filter?: Json; sorts?: Json[]; limit?: number }, context) => {
        const result = (await transport.json(context, `/v1/databases/${encodeURIComponent(input.databaseId)}/query`, {
          method: "POST",
          body: {
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            ...(input.sorts === undefined ? {} : { sorts: input.sorts }),
            page_size: Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS),
          },
        })) as Json | undefined;
        const results = (Array.isArray(result?.results) ? result.results : []) as Json[];
        return {
          rows: results.map((row) => ({
            id: row.id,
            title: titleOf(row),
            url: row.url,
            properties: Object.fromEntries(
              Object.entries((row.properties ?? {}) as Record<string, Json>).map(([name, value]) => [name, propertyToPlain(value)]),
            ),
          })),
          truncated: result?.has_more === true,
          ...(results.length === 0 ? { note: NOTHING_SHARED } : {}),
        };
      },
    }),
    confirms({
      name: "notion_create_page",
      label: "Create a page",
      description:
        "Create a Notion page, either inside a parent page or as a row in a database. Property names are checked against the database's schema **before** the call, because Notion would otherwise accept an unknown name, change nothing and report success. The body is markdown. Requires approval.",
      category: CATEGORY,
      execute: async (
        input: { parentPageId?: string; databaseId?: string; title?: string; properties?: Record<string, unknown>; body?: string },
        context,
      ) => {
        if ((input.parentPageId === undefined) === (input.databaseId === undefined)) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "notion_create_page needs exactly one of parentPageId or databaseId — a page lives in one or the other.",
            retryable: false,
          });
        }
        let properties: Record<string, unknown>;
        let parent: Json;
        if (input.databaseId !== undefined) {
          const schema = await schemaOf(context, input.databaseId);
          const titleName = Object.entries(schema).find(([, property]) => property.type === "title")?.[0];
          const supplied: Record<string, unknown> = { ...(input.properties ?? {}) };
          // `title` is offered as a convenience because a database's title property is never actually called
          // "title" — it is "Name", or whatever somebody renamed it to.
          if (input.title !== undefined && titleName !== undefined && !(titleName in supplied)) {
            supplied[titleName] = { title: [{ type: "text", text: { content: input.title } }] };
          }
          validateProperties(schema, supplied, { requireTitle: true });
          properties = supplied;
          parent = { database_id: input.databaseId };
        } else {
          properties = { title: { title: [{ type: "text", text: { content: input.title ?? "" } }] } };
          parent = { page_id: input.parentPageId };
        }
        const page = (await transport.json(context, "/v1/pages", {
          method: "POST",
          body: {
            parent,
            properties,
            ...(input.body === undefined ? {} : { children: markdownToBlocks(input.body) }),
          },
        })) as Json | undefined;
        return { id: page?.id, title: titleOf(page ?? {}), url: page?.url };
      },
    }),
    confirms({
      name: "notion_update_page",
      label: "Update a page's properties",
      description:
        "Change a Notion page's properties. **This does not change the page's body** — use notion_append_blocks for that. Property names are checked against the database's schema first, because Notion would otherwise accept an unknown name and silently change nothing. Requires approval.",
      category: CATEGORY,
      execute: async (input: { id: string; properties: Record<string, unknown> }, context) => {
        if (input.properties === undefined || Object.keys(input.properties).length === 0) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "notion_update_page was called with no properties to change.",
            retryable: false,
          });
        }
        const page = (await transport.json(context, `/v1/pages/${encodeURIComponent(input.id)}`)) as Json | undefined;
        const parent = (page?.parent ?? {}) as { type?: string; database_id?: string };
        /**
         * Validated only when the page is in a database, because only a database has a schema.
         *
         * A page whose parent is another page has exactly one property — its title — and no schema to check
         * against, so there is nothing here that could be validated. Saying so beats a check that silently
         * does nothing for half its inputs.
         */
        if (parent.type === "database_id" && typeof parent.database_id === "string") {
          validateProperties(await schemaOf(context, parent.database_id), input.properties, { requireTitle: false });
        }
        const updated = (await transport.json(context, `/v1/pages/${encodeURIComponent(input.id)}`, {
          method: "PATCH",
          body: { properties: input.properties },
        })) as Json | undefined;
        return { id: updated?.id, title: titleOf(updated ?? {}), changed: Object.keys(input.properties), url: updated?.url };
      },
    }),
    confirms({
      name: "notion_append_blocks",
      label: "Append to a page",
      description:
        "Append markdown to the end of a Notion page as blocks. This adds; it does not replace, and there is no way to edit existing blocks in place. Requires approval.",
      category: CATEGORY,
      execute: async (input: { id: string; body: string }, context) => {
        const children = markdownToBlocks(input.body);
        if (children.length === 0) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "notion_append_blocks was called with nothing to append.",
            retryable: false,
          });
        }
        const result = (await transport.json(context, `/v1/blocks/${encodeURIComponent(input.id)}/children`, {
          method: "PATCH",
          body: { children },
        })) as Json | undefined;
        return { id: input.id, appended: (Array.isArray(result?.results) ? result.results : []).length };
      },
    }),
    confirms({
      name: "notion_comment",
      label: "Comment on a page",
      description: "Add a comment to a Notion page. Requires approval.",
      category: CATEGORY,
      execute: async (input: { pageId: string; body: string }, context) => {
        const comment = (await transport.json(context, "/v1/comments", {
          method: "POST",
          body: { parent: { page_id: input.pageId }, rich_text: [{ type: "text", text: { content: input.body } }] },
        })) as Json | undefined;
        return { pageId: input.pageId, id: comment?.id };
      },
    }),
  ];

  return {
    id: "notion",
    async listTools() {
      return tools;
    },
  };
};

/**
 * What Notion accepts — #260 AC-2.
 *
 * An internal integration secret is presented as a bearer. Notion's public integrations use OAuth and produce
 * a bearer too, which is a second mode and is not offered yet — the wire format would be identical, which is
 * exactly why `modes` and `schemes` are separate axes.
 */
export const NOTION_AUTH: ToolkitAuth = { modes: ["token", "oauth2"], schemes: ["bearer"] };

export const NOTION_TOOL_NAMES = [
  "notion_search",
  "notion_get_page",
  "notion_query_database",
  "notion_create_page",
  "notion_update_page",
  "notion_append_blocks",
  "notion_comment",
] as const;
