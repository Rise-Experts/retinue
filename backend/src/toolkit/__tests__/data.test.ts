/**
 * CSV, JSON paths and read-only SQL — REQ-039 (#188).
 */

import { describe, expect, it } from "vitest";
import { MAX_CSV_ROWS, createSqlQuery, createSqlSchema, parseCsv, queryJson } from "../data.js";

describe("parseCsv", () => {
  it("reads a plain file", () => {
    const result = parseCsv("name,age\nada,36\nlin,41\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual(["name", "age"]);
    expect(result.rows).toEqual([{ name: "ada", age: "36" }, { name: "lin", age: "41" }]);
  });

  it("handles the things people get wrong: quoted commas, newlines and doubled quotes", () => {
    const result = parseCsv('name,note\n"Smith, Ada","she said ""hello""\nand left"\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({ name: "Smith, Ada", note: 'she said "hello"\nand left' });
  });

  it("does not guess types, so a leading zero survives", () => {
    // The reason every value is a string: `01234` is a postcode and `1-2` is not a date, and a parser that
    // guesses hands a model data it then reasons about incorrectly.
    const result = parseCsv("zip,range\n01234,1-2\n");
    expect(result.ok && result.rows[0]).toEqual({ zip: "01234", range: "1-2" });
  });

  it("refuses a file whose quoting never closes, rather than guessing the rows", () => {
    const result = parseCsv('name\n"never closed\n');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("never closed");
  });

  it("caps the rows and says it did", () => {
    const rows = Array.from({ length: MAX_CSV_ROWS + 50 }, (_, i) => `r${i},${i}`).join("\n");
    const result = parseCsv(`name,n\n${rows}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(MAX_CSV_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("names an empty header column rather than producing a nameless field", () => {
    const result = parseCsv("name,,age\na,b,c\n");
    expect(result.ok && result.columns).toEqual(["name", "column_2", "age"]);
  });

  it("supports another delimiter, and refuses a multi-character one", () => {
    expect(parseCsv("a;b\n1;2\n", { delimiter: ";" }).ok).toBe(true);
    expect(parseCsv("a\n", { delimiter: "::" }).ok).toBe(false);
  });
});

describe("queryJson", () => {
  const doc = { items: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }], meta: { total: 2 } };

  it("reads a dotted path", () => {
    expect(queryJson(doc, "meta.total")).toEqual({ ok: true, path: "meta.total", matches: [2] });
  });

  it("reads array indexes in both spellings", () => {
    expect(queryJson(doc, "items.0.id").ok && queryJson(doc, "items.0.id")).toMatchObject({ matches: [1] });
    expect(queryJson(doc, "items[1].id")).toMatchObject({ matches: [2] });
  });

  it("expands a wildcard", () => {
    expect(queryJson(doc, "items.*.id")).toMatchObject({ matches: [1, 2] });
  });

  it("returns no matches for a path that finds nothing, not the whole document", () => {
    // The point of the tool is pulling one field out of a large payload without the payload reaching the
    // context. Returning the document on a miss would defeat exactly that.
    expect(queryJson(doc, "items.9.id")).toMatchObject({ matches: [] });
    expect(queryJson(doc, "nope.nope")).toMatchObject({ matches: [] });
  });

  it("does not evaluate the path", () => {
    // A path is data. If this were `eval` or `new Function`, the argument a model produced would be code.
    const result = queryJson(doc, "constructor.constructor('return 1')()");
    expect(result).toMatchObject({ ok: true, matches: [] });
  });
});

describe("createSqlQuery", () => {
  const capture = () => {
    const seen: { sql: string; params?: readonly unknown[] }[] = [];
    const query = (async (sql: string, params?: readonly unknown[]) => {
      seen.push({ sql, params });
      return [{ id: 1 }];
    }) as Parameters<typeof createSqlQuery>[0]["query"];
    return { seen, query };
  };

  it("runs a SELECT", async () => {
    const { seen, query } = capture();
    const result = await createSqlQuery({ query, readOnly: true })("SELECT id FROM users");
    expect(result.ok).toBe(true);
    expect(seen[0]?.sql).toContain("SELECT id FROM users");
  });

  it("bounds the rows in the query itself, not after", async () => {
    const { seen, query } = capture();
    await createSqlQuery({ query, readOnly: true, maxRows: 10 })("SELECT id FROM users");
    // maxRows + 1, so "there is more" is a fact rather than a guess.
    expect(seen[0]?.params).toEqual([11]);
  });

  const refused = [
    ["an INSERT", "INSERT INTO users VALUES (1)"],
    ["an UPDATE", "UPDATE users SET name = 'x'"],
    ["a DELETE", "DELETE FROM users"],
    ["a DROP", "DROP TABLE users"],
    ["a batch smuggled behind a SELECT", "SELECT 1; DROP TABLE users"],
    ["a write hidden in a CTE", "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x"],
    ["an empty query", "   "],
  ] as const;

  for (const [what, sql] of refused) {
    it(`refuses ${what} without reaching the database`, async () => {
      const { seen, query } = capture();
      const result = await createSqlQuery({ query, readOnly: true })(sql);
      expect(result.ok).toBe(false);
      // The database is never asked. A refusal that still sends the statement is not a refusal.
      expect(seen).toEqual([]);
    });
  }

  it("returns the database's own message, which is what fixes the query", async () => {
    const query = (async () => {
      throw new Error(`column "naem" does not exist`);
    }) as Parameters<typeof createSqlQuery>[0]["query"];
    const result = await createSqlQuery({ query, readOnly: true })("SELECT naem FROM users");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("naem");
  });
});

describe("createSqlSchema", () => {
  it("lists only the schemas it was given", async () => {
    let params: readonly unknown[] | undefined;
    const query = (async (_sql: string, p?: readonly unknown[]) => {
      params = p;
      return [
        { table_name: "users", column_name: "id" },
        { table_name: "users", column_name: "email" },
        { table_name: "orders", column_name: "id" },
      ];
    }) as Parameters<typeof createSqlSchema>[0]["query"];

    const result = await createSqlSchema({ query, schemas: ["app"] })();
    expect(result.ok).toBe(true);
    expect(result.ok && result.tables).toEqual([
      { table: "users", columns: ["id", "email"] },
      { table: "orders", columns: ["id"] },
    ]);
    // Not `current_schema()`: a connection's search path is not a statement about what a model should see.
    expect(params).toEqual([["app"]]);
  });

  it("refuses when no schema is exposed", async () => {
    const query = (async () => []) as Parameters<typeof createSqlSchema>[0]["query"];
    expect((await createSqlSchema({ query, schemas: [] })()).ok).toBe(false);
  });
});

describe("parseCsv row ceiling, at the boundary", () => {
  it("does not report truncation for a file that ends exactly at the ceiling", () => {
    // The off-by-one that the ceiling test alone could not see: an early break at `maxRows` leaves exactly the
    // ceiling in hand and no evidence either way, so `truncated` reads false for a file that had more *and*
    // for one that did not. Both directions are asserted, one here and one above.
    const rows = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `r${i},${i}`).join("\n");
    const result = parseCsv(`name,n\n${rows}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowCount).toBe(MAX_CSV_ROWS);
    expect(result.truncated).toBe(false);
  });
});
