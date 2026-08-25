/**
 * Structured data — REQ-039 (#188).
 *
 * CSV, JSON and read-only SQL. All three are functions the library's tool envelopes delegate to; the SQL one
 * takes its executor as an argument rather than importing a driver, which is both boundary rule R4 and the reason
 * this file has no dependencies at all.
 */

import { AgentPlatformError } from "../core/errors.js";

export const MAX_CSV_ROWS = 500;
export const MAX_SQL_ROWS = 200;
export const MAX_CELL_CHARS = 1_000;

export type CsvResult =
  | {
      readonly ok: true;
      readonly columns: readonly string[];
      readonly rows: readonly Readonly<Record<string, string>>[];
      readonly rowCount: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse CSV.
 *
 * Handles the part people get wrong -- quoted fields containing commas, newlines and escaped quotes -- and
 * nothing else. No type inference: a column of `01234` is a zip code and a column of `1-2` is not a date, and a
 * parser that guesses produces data a model then reasons about incorrectly. Everything comes back as a string,
 * which is what it was.
 */
export const parseCsv = (
  text: string,
  options: { readonly delimiter?: string; readonly maxRows?: number } = {},
): CsvResult => {
  const delimiter = options.delimiter ?? ",";
  if (delimiter.length !== 1) return { ok: false, reason: "The delimiter must be a single character." };
  const maxRows = options.maxRows ?? MAX_CSV_ROWS;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let index = 0;

  const endField = () => {
    record.push(field.length > MAX_CELL_CHARS ? `${field.slice(0, MAX_CELL_CHARS)}…` : field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A trailing newline produces one empty field, which is not a row. Anything else is kept, including rows that
    // are genuinely all-empty in the middle of a file -- those are data.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      endRecord();
      index += 1;
      /**
       * Stop reading once there is one row more than the ceiling.
       *
       * `maxRows + 1` and not `maxRows`, and the difference is the whole truncation flag: `records` includes the
       * header, so stopping at `maxRows` leaves exactly `maxRows` data rows and no way to tell "the file ended"
       * from "the file did not". The extra row is the evidence, and it is discarded immediately below.
       */
      if (records.length > maxRows + 1) break;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) return { ok: false, reason: "A quoted field is never closed, so the row boundaries are unknowable." };
  if (field !== "" || record.length > 0) endRecord();

  const [header, ...body] = records;
  if (header === undefined) return { ok: false, reason: "There is no data here — not even a header row." };

  const columns = header.map((name, position) => (name.trim() === "" ? `column_${position + 1}` : name.trim()));
  const truncated = body.length > maxRows;
  const rows = body.slice(0, maxRows).map((values) =>
    Object.fromEntries(columns.map((name, position) => [name, values[position] ?? ""])),
  );
  return { ok: true, columns, rows, rowCount: rows.length, truncated };
};

export type JsonQueryResult =
  | { readonly ok: true; readonly path: string; readonly matches: readonly unknown[] }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Read a value out of a JSON document by path.
 *
 * A deliberately small path language -- `a.b`, `a.0.b`, `a[0].b`, and `*` for "every element or value here" --
 * because the alternatives are a JSONPath dependency or `eval`, and one of those is a remote code execution in a
 * tool whose argument comes from a model.
 *
 * The point of the tool is that a model can pull one field out of a 200KB payload without the payload passing
 * through its context. A tool that returns the whole document on a bad path defeats that, so a path matching
 * nothing returns no matches and says so.
 */
export const queryJson = (document: unknown, path: string): JsonQueryResult => {
  const trimmed = path.trim();
  if (trimmed === "") return { ok: false, path, reason: "The path is empty." };

  const segments = trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\$\.?/, "")
    .split(".")
    .filter((segment) => segment !== "");

  let current: unknown[] = [document];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if (segment === "*") {
        if (Array.isArray(value)) next.push(...value);
        else if (typeof value === "object") next.push(...Object.values(value as Record<string, unknown>));
        continue;
      }
      if (Array.isArray(value)) {
        const position = Number(segment);
        if (Number.isInteger(position) && position >= 0 && position < value.length) next.push(value[position]);
        continue;
      }
      if (typeof value === "object" && segment in (value as Record<string, unknown>)) {
        next.push((value as Record<string, unknown>)[segment]);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return { ok: true, path: trimmed, matches: current };
};

/** The one shape the SQL tool needs. Supplied by the host, so this file imports no driver (R4, R7). */
export type ReadOnlyQuery = <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<readonly T[]>;

export type SqlResult =
  | {
      readonly ok: true;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly rowCount: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Statements this refuses to send.
 *
 * Read the caveat before trusting this list. A keyword scan over SQL a model wrote is a **second** line of
 * defence, not the control: comments, string literals, dollar quoting and dialect extensions all give a
 * determined author room, and this is not a parser. **The control is the connection** -- `createSqlQuery` requires
 * a `readOnly: true` acknowledgement precisely so that wiring one is a decision somebody makes rather than a
 * default they inherit. What the scan buys is catching the ordinary case early, with a message a model can act on,
 * instead of a permission error from the database that reads like a bug.
 */
const WRITE_KEYWORDS = [
  "insert", "update", "delete", "drop", "truncate", "alter", "create", "grant", "revoke",
  "copy", "vacuum", "reindex", "call", "do", "merge", "replace", "set", "reset", "listen", "notify",
];

export const createSqlQuery = (config: {
  readonly query: ReadOnlyQuery;
  /**
   * An explicit acknowledgement that the connection cannot write.
   *
   * Not a flag that *makes* it read-only -- nothing here can do that. It exists so that wiring a read-write
   * connection into a model-driven tool has to be typed out, and so a reviewer can see whether it was.
   */
  readonly readOnly: true;
  readonly maxRows?: number;
  readonly statementTimeoutMs?: number;
}) => {
  const maxRows = config.maxRows ?? MAX_SQL_ROWS;

  return async (sql: string): Promise<SqlResult> => {
    const statement = sql.trim().replace(/;+\s*$/, "");
    if (statement === "") return { ok: false, reason: "The query is empty." };

    // One statement only. A batch is how a SELECT smuggles something else along behind it.
    if (statement.includes(";")) {
      return { ok: false, reason: "Send one statement at a time — no semicolons inside the query." };
    }
    const lowered = statement.toLowerCase();
    if (!/^(select|with)\b/.test(lowered)) {
      return { ok: false, reason: "Only SELECT queries are allowed here. Start with SELECT, or WITH … SELECT." };
    }
    const offending = WRITE_KEYWORDS.find((keyword) => new RegExp(`\\b${keyword}\\b`).test(lowered));
    if (offending !== undefined) {
      return { ok: false, reason: `This query contains \`${offending}\`, which is not allowed in a read-only query.` };
    }

    try {
      // `maxRows + 1` so "there is more" is a fact rather than a guess. A LIMIT equal to the ceiling cannot tell
      // the difference between exactly enough and too many.
      const rows = await config.query<Record<string, unknown>>(`SELECT * FROM (${statement}) AS q LIMIT $1`, [maxRows + 1]);
      const truncated = rows.length > maxRows;
      return {
        ok: true,
        rows: rows.slice(0, maxRows).map(boundRow),
        rowCount: Math.min(rows.length, maxRows),
        truncated,
      };
    } catch (error) {
      // The database's own message, and only its message. It says which column does not exist, which is exactly
      // what a model needs to fix the query -- but a stack trace names our internals.
      const message = error instanceof AgentPlatformError ? error.message : (error as Error).message;
      return { ok: false, reason: `The query failed: ${message}` };
    }
  };
};

/** Long text cells are the usual way a bounded row count is still an unbounded payload. */
const boundRow = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" && value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value,
    ]),
  );

export type SchemaResult =
  | { readonly ok: true; readonly tables: readonly { readonly table: string; readonly columns: readonly string[] }[] }
  | { readonly ok: false; readonly reason: string };

/**
 * What the model may query.
 *
 * Without this, `sql_query` is a tool whose first five calls are guesses at table names. Restricted to the schemas
 * the deployment names -- not `current_schema()`, because a connection's search path is not a statement about what
 * a model should be shown.
 */
export const createSqlSchema = (config: { readonly query: ReadOnlyQuery; readonly schemas: readonly string[] }) => {
  return async (): Promise<SchemaResult> => {
    if (config.schemas.length === 0) return { ok: false, reason: "No schemas are exposed to this tool." };
    try {
      const rows = await config.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = ANY($1) ORDER BY table_name, ordinal_position`,
        [config.schemas],
      );
      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        const columns = grouped.get(row.table_name) ?? [];
        columns.push(row.column_name);
        grouped.set(row.table_name, columns);
      }
      return { ok: true, tables: [...grouped].map(([table, columns]) => ({ table, columns })) };
    } catch (error) {
      return { ok: false, reason: `Could not read the schema: ${(error as Error).message}` };
    }
  };
};
