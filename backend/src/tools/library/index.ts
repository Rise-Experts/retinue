/**
 * The first-party tool library — REQ-039 (#188).
 *
 * The platform used to ship **zero** tools: a tool contract and an empty registry, so a customer's first day was
 * spent writing a web fetch. This is the set that makes a useful agent buildable on day one.
 *
 * ## Wiring is the toggle
 *
 * `createStandardToolProvider` returns only the tools whose dependencies it was given. There is no `enableSql`
 * flag next to a `sqlQuery` function, because two switches for one decision is how a deployment ends up with a
 * tool that is enabled and unwired — the "built, tested and unreachable" defect this repo keeps finding. Pass a
 * read-only query function and `sql_query` exists; pass nothing and it does not. The four pure tools —
 * `parse_csv`, `query_json`, `now`, `calculate` — need nothing and are always present unless excluded.
 *
 * ## What a caller still has to get right
 *
 * `deps` carries the approval gate and the idempotency store. `http_write` is `external-write`, so with either of
 * them missing it is **refused at execution** rather than silently performed — the registry reports
 * `capability_unavailable` naming the unwired field. That is deliberate: an outbound write with no approval and no
 * replay protection is the failure this envelope exists to prevent, and a deployment should hear about it the
 * first time rather than after.
 */

import { createCalculateTool, createNowTool } from "./compute.js";
import { createParseCsvTool, createQueryJsonTool, createSqlQueryTool, createSqlSchemaTool } from "./data.js";
import { createHttpRequestTool, createHttpWriteTool } from "./http.js";
import { createSearchKnowledgeTool } from "./knowledge.js";
import { createFetchJsonTool, createFetchUrlTool, createWebSearchTool } from "./web.js";
import { createHttpClient } from "../../toolkit/http.js";
import { createFetchJson, createFetchPage, createWebSearch } from "../../toolkit/web.js";
import { createSqlQuery, createSqlSchema } from "../../toolkit/data.js";
import { createReadAttachmentTool, createListAttachmentsTool } from "../../files/read-tool.js";
import { createReadDocumentTool } from "../../documents/read-tool.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool, ToolProvider } from "../index.js";
import type { ExecutionContext } from "../../core/context.js";
import type { ExtractionService } from "../../documents/extraction.js";
import type { FileService } from "../../files/index.js";
import type { HttpClient, HttpClientConfig, ReadOnlyQuery, SearchProvider } from "../../toolkit/index.js";
import type { KnowledgeRetriever } from "./knowledge.js";
import type { RetrievalMode } from "../../knowledge/retrieval.js";

/**
 * Every tool this library can produce.
 *
 * A closed list so `exclude` is checked against it: a typo in an exclusion is otherwise a tool that stays enabled
 * and a deployment that believes it is off.
 */
export const STANDARD_TOOL_NAMES = [
  "fetch_url",
  "fetch_json",
  "web_search",
  "http_request",
  "http_write",
  "parse_csv",
  "query_json",
  "sql_query",
  "sql_schema",
  "search_knowledge",
  "read_attachment",
  "list_attachments",
  "read_document",
  "now",
  "calculate",
] as const;

export type StandardToolName = (typeof STANDARD_TOOL_NAMES)[number];

/**
 * The categories these tools use.
 *
 * Exported because a host that preloads *by category* -- which is what a preload list is for -- otherwise has to
 * keep its own copy of this list, and a copy that misses one category silently hides every tool in it. That is
 * not hypothetical: the example app preloaded `["assistant", "mcp:…"]`, so all fifteen of these were registered,
 * authorized and invisible to the model, and the only symptom was the model declining to do things it appeared
 * to have tools for.
 */
export const STANDARD_TOOL_CATEGORIES = ["web", "data", "knowledge", "general", "files"] as const;

export type StandardToolsConfig = {
  /** Authorisation, the approval gate, idempotency and the shadow recorder. */
  readonly deps: DelegatingToolDeps;
  /**
   * Outbound HTTP. Supplying this enables `fetch_url`, `fetch_json`, `http_request` and `http_write`.
   *
   * Pass a `client` to share one with the rest of an application — the egress policy is then decided in exactly
   * one place, which is the point of the type.
   */
  readonly http?: HttpClientConfig & { readonly client?: HttpClient };
  /** A search provider. Without one there is no `web_search` at all, rather than one that always refuses. */
  readonly search?: SearchProvider;
  /**
   * A **read-only** database connection, and the schemas the model may see.
   *
   * `readOnly: true` has to be typed out. Nothing here can make a connection read-only; the acknowledgement
   * exists so that wiring a read-write one into a model-driven tool is a decision somebody made and a reviewer
   * can see. `schemas` enables `sql_schema`; without it the model is guessing table names.
   */
  readonly sql?: { readonly query: ReadOnlyQuery; readonly readOnly: true; readonly schemas?: readonly string[]; readonly maxRows?: number };
  readonly knowledge?: {
    readonly retriever: KnowledgeRetriever;
    readonly authSubjects: (context: ExecutionContext) => readonly string[] | Promise<readonly string[]>;
    readonly mode?: RetrievalMode;
  };
  /** Enables `read_attachment` and, where the context has a conversation, `list_attachments`. */
  readonly files?: FileService;
  /** Enables `read_document`. */
  readonly documents?: ExtractionService;
  /** Injected so a test can pin `now`. */
  readonly clock?: () => Date;
  readonly exclude?: readonly StandardToolName[];
  readonly providerId?: string;
};

export const createStandardToolProvider = (config: StandardToolsConfig): ToolProvider => {
  for (const name of config.exclude ?? []) {
    if (!(STANDARD_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `'${name}' is not a standard tool, so excluding it does nothing. One of: ${STANDARD_TOOL_NAMES.join(", ")}.`,
      );
    }
  }
  const excluded = new Set<string>(config.exclude ?? []);
  const { deps } = config;

  // Built once, not per call: an HTTP client per invocation is a fresh policy decision each time, and the whole
  // argument for one client is that there is one place to get it wrong.
  const client = config.http === undefined ? undefined : (config.http.client ?? createHttpClient(config.http));
  const fetchPage = client === undefined ? undefined : createFetchPage({ client });
  const fetchJson = client === undefined ? undefined : createFetchJson({ client });
  const search =
    client === undefined || config.search === undefined ? undefined : createWebSearch({ client, provider: config.search });
  const runSql =
    config.sql === undefined
      ? undefined
      : createSqlQuery({ query: config.sql.query, readOnly: config.sql.readOnly, ...(config.sql.maxRows === undefined ? {} : { maxRows: config.sql.maxRows }) });
  const describeSql =
    config.sql?.schemas === undefined ? undefined : createSqlSchema({ query: config.sql.query, schemas: config.sql.schemas });

  const fixed: readonly (readonly [StandardToolName, () => Tool])[] = [
    ["fetch_url", () => createFetchUrlTool(deps, fetchPage as NonNullable<typeof fetchPage>)],
    ["fetch_json", () => createFetchJsonTool(deps, fetchJson as NonNullable<typeof fetchJson>)],
    ["web_search", () => createWebSearchTool(deps, search as NonNullable<typeof search>)],
    ["http_request", () => createHttpRequestTool(deps, client as HttpClient)],
    ["http_write", () => createHttpWriteTool(deps, client as HttpClient)],
    ["parse_csv", () => createParseCsvTool(deps)],
    ["query_json", () => createQueryJsonTool(deps)],
    ["sql_query", () => createSqlQueryTool(deps, runSql as NonNullable<typeof runSql>)],
    ["sql_schema", () => createSqlSchemaTool(deps, describeSql as NonNullable<typeof describeSql>)],
    ["search_knowledge", () => createSearchKnowledgeTool(deps, config.knowledge as NonNullable<typeof config.knowledge>)],
    ["read_attachment", () => createReadAttachmentTool({ files: config.files as FileService })],
    ["read_document", () => createReadDocumentTool({ extraction: config.documents as ExtractionService })],
    ["now", () => createNowTool(deps, config.clock)],
    ["calculate", () => createCalculateTool(deps)],
  ];

  /** What each tool needs before it can exist. A tool with no entry needs nothing. */
  const wired: Partial<Record<StandardToolName, boolean>> = {
    fetch_url: fetchPage !== undefined,
    fetch_json: fetchJson !== undefined,
    web_search: search !== undefined,
    http_request: client !== undefined,
    http_write: client !== undefined,
    sql_query: runSql !== undefined,
    sql_schema: describeSql !== undefined,
    search_knowledge: config.knowledge !== undefined,
    read_attachment: config.files !== undefined,
    read_document: config.documents !== undefined,
  };

  const tools = fixed
    .filter(([name]) => !excluded.has(name) && (wired[name] ?? true))
    .map(([, build]) => build());

  return {
    id: config.providerId ?? "retinue.standard-tools",
    async listTools(context: ExecutionContext) {
      // `list_attachments` is the one tool that cannot be built once: it is scoped to a conversation, and a
      // headless automation has no conversation to scope it to. Resolved per call, from the context, which is
      // exactly why `listTools` takes one.
      if (config.files === undefined || excluded.has("list_attachments") || context.conversationId === undefined) {
        return tools;
      }
      return [...tools, createListAttachmentsTool({ files: config.files, conversationId: context.conversationId })];
    },
  };
};

export { createCalculateTool, createNowTool } from "./compute.js";
export { createParseCsvTool, createQueryJsonTool, createSqlQueryTool, createSqlSchemaTool } from "./data.js";
export { createHttpRequestTool, createHttpWriteTool } from "./http.js";
export { createSearchKnowledgeTool } from "./knowledge.js";
export type { KnowledgeRetriever } from "./knowledge.js";
export { createFetchJsonTool, createFetchUrlTool, createWebSearchTool } from "./web.js";
