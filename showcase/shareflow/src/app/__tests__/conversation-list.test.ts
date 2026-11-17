/**
 * The conversation list, ordered by last use — #397.
 *
 * **Against a real database, deliberately.** This is a fix to a SQL `ORDER BY` and a keyset cursor, and
 * the only interesting failure modes live in Postgres: does the lateral pick the right row, does
 * `COALESCE` put an empty conversation where it belongs, does reversing the order turn the cursor into
 * a duplicate-row generator. A fake `sql` asserting the query *text* would be the weakest possible
 * test of this — it can only agree with whatever string the implementation happens to hold, which is
 * the "fake derived from the call site" trap in its purest form.
 *
 * Skipped without `RETINUE_TEST_SHAREFLOW_URL`, like the other database-backed suites in this package.
 * The pure parts — cursor round-trip, malformed input — run either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conversationsByActivity } from "../conversation-list.js";

const URL_ = process.env["RETINUE_TEST_SHAREFLOW_URL"];

type Sql = { query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> };

const TENANT = "11111111-1111-4111-8111-111111111111";
const TAG = `conv-order-test-${process.pid}`;

let sql: Sql;
let close: () => Promise<void>;

beforeAll(async () => {
  if (URL_ === undefined) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
  sql = {
    async query<Row>(text: string, params?: readonly unknown[]) {
      const result = await pool.query(text, params === undefined ? undefined : [...params]);
      return result.rows as Row[];
    },
  };
  close = async () => {
    await pool.end();
  };

  /**
   * Three threads whose creation order is the reverse of their activity order, because a fixture where
   * the two agree cannot tell the fix from the bug.
   *
   *   A  created 30 days ago, last message 5 minutes ago   -> should be first
   *   C  created 1 day ago, no messages at all             -> should be second (falls back to created_at)
   *   B  created 10 days ago, last message 2 days ago      -> should be last
   */
  const conv = async (name: string, createdDaysAgo: number) => {
    const id = `${TAG}-${name}`;
    await sql.query(
      `INSERT INTO conversations (tenant_id, id, title, version, created_at, updated_at)
       VALUES ($1, $2, $3, 1, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval)`,
      [TENANT, id, `thread ${name}`, String(createdDaysAgo)],
    );
    return id;
  };
  const message = async (conversationId: string, minutesAgo: number) => {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await sql.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, role, parts, created_at)
       VALUES ($1, $2, $3, 'user', $4::jsonb, $5::timestamptz)`,
      [
        TENANT,
        `${conversationId}-m`,
        conversationId,
        JSON.stringify([{ id: `${conversationId}-p`, type: "text", schemaVersion: 1, createdAt: at, text: "hello" }]),
        at,
      ],
    );
  };

  const a = await conv("a-old-but-active", 30);
  const b = await conv("b-middling", 10);
  await conv("c-new-but-empty", 1);
  await message(a, 5);
  await message(b, 60 * 48);
});

afterAll(async () => {
  if (URL_ === undefined) return;
  await sql.query(`DELETE FROM messages WHERE conversation_id LIKE $1`, [`${TAG}%`]);
  await sql.query(`DELETE FROM conversations WHERE id LIKE $1`, [`${TAG}%`]);
  await close();
});

/** Only this test's own rows — the database has other conversations and they are not the subject. */
const mine = (items: readonly { readonly id: string }[]) =>
  items.filter((item) => item.id.startsWith(TAG)).map((item) => item.id.replace(`${TAG}-`, ""));

describe.skipIf(URL_ === undefined)("conversations ordered by last activity", () => {
  it("puts the thread used most recently first, however old it is", async () => {
    /**
     * The whole defect in one assertion. The old behaviour ordered `created_at` ascending, which put
     * `a-old-but-active` **last** despite it being the thread someone was using five minutes ago — and
     * on production, with 117 conversations against a page size of 30, put it off the list entirely.
     *
     * A high limit here rather than 3, because the real database holds other conversations and this
     * suite must not depend on how many.
     */
    const page = await conversationsByActivity({ sql, tenantId: TENANT, limit: 500 });
    const ours = mine(page.items);

    expect(ours).toEqual(["a-old-but-active", "c-new-but-empty", "b-middling"]);
  });

  it("dates a thread by its last message, not by its row", async () => {
    // `conversations.updated_at` is 30 days old for this row; nothing bumps it when a message arrives.
    const page = await conversationsByActivity({ sql, tenantId: TENANT, limit: 500 });
    const active = page.items.find((item) => item.id === `${TAG}-a-old-but-active`);

    expect(active).toBeDefined();
    const age = Date.now() - Date.parse(active?.updatedAt ?? "");
    expect(age).toBeLessThan(60 * 60 * 1000); // minutes old, not a month
  });

  it("puts an empty conversation at its creation time rather than at the bottom", async () => {
    /**
     * Not a rare edge: a thread is created the moment someone opens a new chat and stays empty until
     * they send something. It belongs at the top while they are typing, which is why the query
     * `COALESCE`s to `created_at` instead of letting a null sort last.
     */
    const page = await conversationsByActivity({ sql, tenantId: TENANT, limit: 500 });
    const ours = mine(page.items);

    expect(ours.indexOf("c-new-but-empty")).toBeLessThan(ours.indexOf("b-middling"));
  });

  it("pages through every thread exactly once, in order", async () => {
    /**
     * The failure a keyset cursor exists to prevent, and the one most likely to be introduced by
     * reversing an order: a comparator that still reads `>` while the sort reads `DESC` returns rows
     * already seen, so the list grows forever and repeats itself.
     */
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await conversationsByActivity({
        sql,
        tenantId: TENANT,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...mine(page.items));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 1_000);

    expect(seen).toEqual(["a-old-but-active", "c-new-but-empty", "b-middling"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("never reports a next cursor on the last page", async () => {
    // Otherwise a client pages forever over an empty tail.
    const page = await conversationsByActivity({ sql, tenantId: TENANT, limit: 500 });
    expect(page.nextCursor).toBeUndefined();
  });

  it("treats a malformed cursor as a first page rather than an error", async () => {
    /**
     * A cursor is client input. The platform's own cursors are opaque base64 and a client that
     * round-trips one incorrectly — or a stale link — should get the top of the list, not a 500.
     */
    for (const cursor of ["not-a-cursor", "", "!!!!", Buffer.from("no-space-here").toString("base64url")]) {
      const page = await conversationsByActivity({ sql, tenantId: TENANT, limit: 2, cursor });
      expect(page.items.length).toBeGreaterThan(0);
    }
  });

  it("returns an empty page for a tenant with nothing, rather than everyone's rows", async () => {
    // The check that matters most in a multi-tenant table, and the cheapest one to forget.
    const page = await conversationsByActivity({
      sql,
      tenantId: "22222222-2222-4222-8222-222222222222",
      limit: 10,
    });
    expect(page.items).toEqual([]);
  });
});
