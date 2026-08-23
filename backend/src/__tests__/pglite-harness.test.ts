/**
 * The shared-PGlite test harness itself.
 *
 * Worth testing rather than trusting, because the entire Postgres and Supabase suite now depends on
 * it: if two callers ever shared a schema, tests would interfere in ways that look like flakiness in
 * whatever ran second. These cases pin the three properties the rest of the suite relies on.
 */

import { describe, expect, it } from "vitest";
import { freshPgliteSchema, lazyPgliteSchema, schemaExecutor } from "../testing/pglite.js";
import { asId } from "../core/ids.js";
import type { ConversationId, TenantId } from "../core/ids.js";
import { createPostgresConversationStore } from "../adapters/postgres/index.js";

const T = asId<TenantId>("harness-t1");

describe("schema isolation", () => {
  it("gives each caller an independent database", async () => {
    const a = await freshPgliteSchema();
    const b = await freshPgliteSchema();
    expect(a.schema).not.toBe(b.schema);

    await createPostgresConversationStore(a.sql).create({
      tenantId: T,
      id: asId<ConversationId>("only-in-a"),
      title: "a",
    });

    // Same tenant, same instance, different schema: b must see nothing. This is the property that
    // replaced "a fresh PGlite per test", so it carries all the isolation the suite used to get from
    // separate processes.
    expect((await createPostgresConversationStore(b.sql).list({ tenantId: T, limit: 10 })).items).toEqual([]);
    expect((await createPostgresConversationStore(a.sql).list({ tenantId: T, limit: 10 })).items).toHaveLength(1);
  });

  it("keeps an executor pinned to its schema after another one has run", async () => {
    const a = await freshPgliteSchema();
    const b = await freshPgliteSchema();

    await createPostgresConversationStore(a.sql).create({
      tenantId: T,
      id: asId<ConversationId>("c-a"),
      title: "a",
    });
    // b's executor moves `search_path` when it runs...
    await createPostgresConversationStore(b.sql).create({
      tenantId: T,
      id: asId<ConversationId>("c-b"),
      title: "b",
    });
    // ...and a's next query must still land in a's schema. Setting search_path once at creation would
    // make every test's isolation depend on execution order, which is the subtlest way to make a
    // suite flaky.
    const inA = await createPostgresConversationStore(a.sql).list({ tenantId: T, limit: 10 });
    expect(inA.items.map((c) => c.id)).toEqual(["c-a"]);
  });

  it("shares one instance rather than booting one per caller", async () => {
    const a = await freshPgliteSchema();
    const b = await freshPgliteSchema();
    // The point of the whole exercise: boot costs ~432ms and migrating a fresh schema costs ~20ms, so
    // a per-caller instance was roughly 95% overhead.
    expect(a.db).toBe(b.db);
  });

  it("defers work to the first query, so a store can be built synchronously", async () => {
    // The conformance harnesses call their factory inside each test and expect a usable executor back
    // immediately; the schema cannot be created up front.
    const sql = lazyPgliteSchema();
    const store = createPostgresConversationStore(sql);
    await store.create({ tenantId: T, id: asId<ConversationId>("lazy"), title: "lazy" });
    expect((await store.list({ tenantId: T, limit: 10 })).items).toHaveLength(1);
  });
});

/**
 * The caveat the shared instance introduces, asserted so it is discoverable rather than folklore.
 *
 * Every catalog query in the suite had to gain a schema predicate. This documents why: with one schema
 * per instance an unqualified `WHERE table_name = 'runs'` matched one table; with many schemas in one
 * instance it matches one per schema, and a test asserting a column is *absent* would still pass while
 * a test counting rows would silently see multiples.
 */
describe("catalog queries need a schema predicate", () => {
  it("sees other schemas' tables without one", async () => {
    const a = await freshPgliteSchema();
    await freshPgliteSchema();

    const unqualified = await a.sql.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables WHERE table_name = 'runs'`,
    );
    // More than one, because every schema created in this file has a `runs`.
    expect(unqualified.length).toBeGreaterThan(1);

    const qualified = await a.sql.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = 'runs' AND table_schema = current_schema()`,
    );
    expect(qualified).toHaveLength(1);
    expect(qualified[0]?.table_schema).toBe(a.schema);
  });

  it("resolves current_schema() to the executor's own schema", async () => {
    const a = await freshPgliteSchema();
    const b = await freshPgliteSchema();
    const currentIn = async (sql: typeof a.sql) =>
      (await sql.query<{ s: string }>(`SELECT current_schema() AS s`))[0]?.s;
    expect(await currentIn(a.sql)).toBe(a.schema);
    expect(await currentIn(b.sql)).toBe(b.schema);
  });
});

describe("schemaExecutor", () => {
  it("does not put public on the search path", async () => {
    const created = await freshPgliteSchema();
    // Deliberate: with `public` on the path, `CREATE TABLE IF NOT EXISTS` would see a same-named table
    // in `public` and skip creating it here, so one stray table would silently be shared by every
    // later schema.
    const path = await created.sql.query<{ s: string }>(`SHOW search_path`);
    expect(Object.values(path[0] ?? {})[0]).toBe(created.schema);
  });

  it("can be pointed at a schema explicitly", async () => {
    const created = await freshPgliteSchema();
    const direct = schemaExecutor(created.db, created.schema);
    await direct.query(`SELECT 1 FROM conversations LIMIT 1`);
    expect((await direct.query<{ s: string }>(`SELECT current_schema() AS s`))[0]?.s).toBe(created.schema);
  });
});
