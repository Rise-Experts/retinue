/**
 * Structured data — REQ-039 (#188).
 *
 * Envelopes over `toolkit/data.ts`. `parse_csv` and `query_json` are pure and take their input as text, which is
 * the deliberate shape: a tool that took a *path* or a *URL* would be a file read or a fetch wearing a parser's
 * name, and the authorisation for those belongs to `read_attachment` and `fetch_url`. So the model reads with one
 * tool and parses with another, and each one is checked by the thing that should check it.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import type { CsvResult, JsonQueryResult, SchemaResult, SqlResult } from "../../toolkit/index.js";
import { parseCsv, queryJson } from "../../toolkit/data.js";

const csvSchema = z
  .object({
    text: z.string().min(1).max(2_000_000),
    delimiter: z.string().length(1).default(","),
  })
  .strict();

export const createParseCsvTool = (deps: DelegatingToolDeps): Tool =>
  defineDelegatingTool(deps, {
    name: "parse_csv",
    label: "Parse CSV",
    description:
      "Turn CSV text into rows. Quoted fields, embedded commas and newlines are handled. Every value comes back " +
      "as a string — no type guessing, so a leading zero survives. Rows are capped; check `truncated`.",
    category: "data",
    effect: "read",
    inputSchema: csvSchema,
    delegatesTo: "toolkit/data.parseCsv",
    delegate: (input: z.infer<typeof csvSchema>): CsvResult => parseCsv(input.text, { delimiter: input.delimiter }),
  });

const jsonSchema = z
  .object({
    json: z.string().min(1).max(2_000_000),
    path: z.string().min(1).max(500).describe("A dotted path: `a.b`, `items.0.name`, `items[0].name`, or `items.*.id`."),
  })
  .strict();

export const createQueryJsonTool = (deps: DelegatingToolDeps): Tool =>
  defineDelegatingTool(deps, {
    name: "query_json",
    label: "Read a value out of JSON",
    description:
      "Pull one value or a list of values out of a JSON document by path, so a large payload does not have to be " +
      "read in full. `*` matches every element or value at that level. An empty `matches` means the path found " +
      "nothing — it does not mean the document is empty.",
    category: "data",
    effect: "read",
    inputSchema: jsonSchema,
    delegatesTo: "toolkit/data.queryJson",
    delegate: (input: z.infer<typeof jsonSchema>): JsonQueryResult => {
      let document: unknown;
      try {
        document = JSON.parse(input.json);
      } catch (error) {
        // A parse failure is a fact about the input, returned so the model can fix it. Throwing would read as
        // "the tool is broken" and invite the identical retry.
        return { ok: false, path: input.path, reason: `That is not valid JSON: ${(error as Error).message}` };
      }
      return queryJson(document, input.path);
    },
  });

const sqlSchema = z
  .object({
    sql: z.string().min(1).max(10_000).describe("One SELECT statement. No semicolons."),
  })
  .strict();

export const createSqlQueryTool = (deps: DelegatingToolDeps, run: (sql: string) => Promise<SqlResult>): Tool =>
  defineDelegatingTool(deps, {
    name: "sql_query",
    label: "Query the database",
    description:
      "Run one read-only SELECT and return rows. Only SELECT and WITH … SELECT are accepted, one statement at a " +
      "time. Call sql_schema first if you do not know the tables. Rows are capped; check `truncated`.",
    category: "data",
    /**
     * `read`, and this is only honest because the connection is read-only.
     *
     * `createSqlQuery` requires a `readOnly: true` acknowledgement from whoever wires it, for exactly this reason:
     * the effect classification of this tool is a claim about the *connection*, and the keyword scan inside it is
     * a second line of defence rather than the control. Wire a read-write connection here and the classification
     * becomes a lie no test can catch.
     */
    effect: "read",
    inputSchema: sqlSchema,
    delegatesTo: "toolkit/data.createSqlQuery",
    delegate: (input: z.infer<typeof sqlSchema>) => run(input.sql),
  });

export const createSqlSchemaTool = (deps: DelegatingToolDeps, describe: () => Promise<SchemaResult>): Tool =>
  defineDelegatingTool(deps, {
    name: "sql_schema",
    label: "List queryable tables",
    description: "List the tables and columns available to sql_query. Call this before writing a query.",
    category: "data",
    effect: "read",
    inputSchema: z.object({}).strict(),
    delegatesTo: "toolkit/data.createSqlSchema",
    delegate: () => describe(),
  });
