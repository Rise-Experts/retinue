/**
 * The thread rail's page, newest-touched first.
 *
 * ## What these tests are for, and what they are not
 *
 * The defect was a **query nobody ran**: `ORDER BY created_at, id` — ascending — behind a sidebar that
 * every layer's comment described as newest-first. A test with a fake `sql` cannot catch that class of
 * thing, because a fake built from the call site can only ever agree with the caller. So the ordering
 * itself was verified against a real Postgres, with forty conversations at the real page size of 30:
 *
 *     adapter page, first 8:  #0 #1 #2 #3 #4 #5 #6 #7     (oldest-created, oldest first)
 *     wrapped page, first 8:  #3 #11 #26 #0 #31 #19 #39 #6 (most recently touched first)
 *     paged 2 pages -> 40 rows, 40 distinct, strictly descending: true
 *
 * What is tested here is the part that is this file's own logic rather than Postgres's: the SQL it
 * emits, the cursor it mints and reads, the row mapping it reproduces, and the `limit + 1` arithmetic.
 * The query-text assertion is deliberately literal — it is weak evidence of correctness and strong
 * evidence of a regression, and a silent return to ascending order is exactly the regression that took
 * this long to notice.
 */
import { describe, expect, it } from "vitest";

import { withNewestFirstConversations } from "../newest-first-conversations.js";

type Query = { readonly text: string; readonly params: readonly unknown[] };

const row = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: "t1",
  title: `title ${id}`,
  version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: updatedAt,
  archived_at: null,
  deleted_at: null,
  ...extra,
});

/**
 * The wrapper's own surface, typed — `as never` on the fake would make `wrapped.list` inaccessible.
 *
 * Written out rather than imported: `ConversationStore` is the platform's interface and this file is
 * about the two methods the wrapper touches. Typing the fake as the full interface would mean stubbing
 * six methods that have nothing to do with the ordering.
 */
type Wrapped = {
  list(input: { readonly tenantId: string; readonly limit: number; readonly cursor?: string }): Promise<{
    readonly items: readonly { readonly id: string; readonly updatedAt: string }[];
    readonly nextCursor?: string;
  }>;
  create(): Promise<unknown>;
};

const store = (rows: readonly unknown[]) => {
  const queries: Query[] = [];
  const sql = {
    async query(text: string, params: readonly unknown[]) {
      queries.push({ text, params });
      return rows;
    },
  } as never;
  const delegated: string[] = [];
  const inner = {
    async list() {
      delegated.push("list");
      return { items: [] };
    },
    async create() {
      delegated.push("create");
      return { id: "made" };
    },
  } as never;
  return {
    queries,
    delegated,
    wrapped: withNewestFirstConversations(inner, sql) as unknown as Wrapped,
  };
};

describe("the query", () => {
  it("orders by updated_at descending, which is the column the rail labels rows with", async () => {
    /**
     * Both halves matter and both were wrong. Descending, because the adapter's ascending order put
     * the thirty oldest conversations in the sidebar. And `updated_at` rather than `created_at`,
     * because `groupFor` and `threadStamp` both read `updatedAt` — ordering by one field and labelling
     * with another puts a conversation replied to this morning wherever it began.
     */
    const { queries, wrapped } = store([]);
    await wrapped.list({ tenantId: "t1", limit: 30 });

    expect(queries[0]?.text).toContain("ORDER BY updated_at DESC, id DESC");
    expect(queries[0]?.text).not.toContain("ORDER BY created_at");
  });

  it("asks for one row more than the limit, so there is no second count query", async () => {
    const { queries, wrapped } = store([]);
    await wrapped.list({ tenantId: "t1", limit: 30 });
    expect(queries[0]?.params).toEqual(["t1", 31]);
  });

  it("keeps the deleted_at filter, so a deleted conversation stays gone", async () => {
    // The one predicate that is not about ordering. Dropping it while rewriting the query would
    // resurrect deleted threads in the sidebar — a data-exposure bug wearing a sorting bug's clothes.
    const { queries, wrapped } = store([]);
    await wrapped.list({ tenantId: "t1", limit: 5 });
    expect(queries[0]?.text).toContain("deleted_at IS NULL");
  });

  it("scopes to the tenant, always", async () => {
    const { queries, wrapped } = store([]);
    await wrapped.list({ tenantId: "t1", limit: 5 });
    expect(queries[0]?.text).toContain("tenant_id = $1");
  });
});

describe("paging", () => {
  it("mints a cursor from the last row of a full page", async () => {
    const rows = [row("a", "2026-03-03T00:00:00.000Z"), row("b", "2026-03-02T00:00:00.000Z")];
    const { wrapped } = store(rows);

    const page = await wrapped.list({ tenantId: "t1", limit: 1 });

    expect(page.items).toHaveLength(1);
    const decoded = JSON.parse(Buffer.from(page.nextCursor as string, "base64").toString("utf8"));
    expect(decoded).toEqual({ u: "2026-03-03T00:00:00.000Z", i: "a" });
  });

  it("gives no cursor when the page is the end of the list", async () => {
    // Otherwise the client pages forever, asking for rows after the last one.
    const { wrapped } = store([row("a", "2026-03-03T00:00:00.000Z")]);
    expect((await wrapped.list({ tenantId: "t1", limit: 30 })).nextCursor).toBeUndefined();
  });

  it("compares the cursor row-wise, so a shared timestamp neither skips nor repeats", async () => {
    /**
     * Two conversations touched in the same millisecond is not hypothetical here: before the clock was
     * fixed, every conversation this deployment created was dated `2020-01-01` with a counter in the
     * milliseconds, and that data is still in the database. Comparing the two fields separately —
     * `updated_at < $3 OR (updated_at = $3 AND id < $4)` written as two ANDed predicates — is the
     * classic form of this bug.
     */
    const cursor = Buffer.from(JSON.stringify({ u: "2026-03-03T00:00:00.000Z", i: "b" })).toString("base64");
    const { queries, wrapped } = store([]);

    await wrapped.list({ tenantId: "t1", limit: 30, cursor });

    expect(queries[0]?.text).toContain("(updated_at, id) < ($3, $4)");
    expect(queries[0]?.params).toEqual(["t1", 31, "2026-03-03T00:00:00.000Z", "b"]);
  });

  it("restarts from the newest on a cursor it did not mint, rather than erroring", async () => {
    /**
     * The platform's cursor is `{ c, i }` over `created_at`; this one is `{ u, i }` over `updated_at`.
     * A stale cursor in a client's memory, or a mangled URL, must not produce a page ordered by
     * neither. Undefined means "start at the newest", which for a sidebar is the top of the list —
     * the right answer, and one the next scroll pages correctly from.
     */
    const platformCursor = Buffer.from(JSON.stringify({ c: "2026-01-05T00:00:00.000Z", i: "c4" })).toString("base64");
    const { queries, wrapped } = store([]);

    await wrapped.list({ tenantId: "t1", limit: 30, cursor: platformCursor });

    expect(queries[0]?.text).not.toContain("(updated_at, id) <");
    expect(queries[0]?.params).toEqual(["t1", 31]);
  });

  it("survives a cursor that is not base64, not JSON, or the wrong shape", async () => {
    for (const cursor of ["", "not-base64!!", Buffer.from("nonsense").toString("base64"),
                          Buffer.from(JSON.stringify({ u: 4, i: null })).toString("base64")]) {
      const { wrapped } = store([]);
      await expect(wrapped.list({ tenantId: "t1", limit: 5, cursor })).resolves.toEqual({ items: [] });
    }
  });
});

describe("the rows it returns", () => {
  it("maps a row to the shape the adapter produces, field for field", async () => {
    const { wrapped } = store([row("a", "2026-03-03T00:00:00.000Z")]);
    const page = await wrapped.list({ tenantId: "t1", limit: 30 });

    expect(page.items[0]).toEqual({
      id: "a",
      tenantId: "t1",
      title: "title a",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("omits archivedAt when null and carries it when set, because the hook filters on it", async () => {
    /**
     * `ConversationSummary` distinguishes an absent `archivedAt` from a null one, and
     * `useConversations({ includeArchived })` reads it. A mapping that emitted `archivedAt: null`
     * would make every conversation look archived — or none.
     */
    const { wrapped } = store([row("a", "2026-03-03T00:00:00.000Z")]);
    expect((await wrapped.list({ tenantId: "t1", limit: 30 })).items[0]).not.toHaveProperty("archivedAt");

    const archived = store([row("b", "2026-03-03T00:00:00.000Z", { archived_at: "2026-03-04T00:00:00.000Z" })]);
    expect((await archived.wrapped.list({ tenantId: "t1", limit: 30 })).items[0]).toMatchObject({
      archivedAt: "2026-03-04T00:00:00.000Z",
    });
  });

  it("normalises a Date column to an ISO string, as the adapter does", async () => {
    // `pg` returns `timestamptz` as a `Date`; the API contract is a string. Handing a `Date` to
    // `JSON.stringify` happens to produce the right text, which is why this would look fine until
    // something compared the value rather than printing it.
    const { wrapped } = store([row("a", new Date("2026-03-03T00:00:00.000Z") as never)]);
    expect((await wrapped.list({ tenantId: "t1", limit: 30 })).items[0]).toMatchObject({
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});

describe("what it does not touch", () => {
  it("delegates every other method, so an adapter that grows one keeps working", async () => {
    /**
     * Spread rather than a re-declared interface. A wrapper that enumerated the methods would silently
     * drop the next one added — which is the same defect family as the rest of this sweep: something
     * built, and then unreachable through the layer in front of it.
     */
    const { delegated, wrapped } = store([]);
    await wrapped.create();
    expect(delegated).toEqual(["create"]);
  });

  it("does not delegate list, which is the whole point", async () => {
    const { delegated, wrapped } = store([]);
    await wrapped.list({ tenantId: "t1", limit: 5 });
    expect(delegated).toEqual([]);
  });
});
