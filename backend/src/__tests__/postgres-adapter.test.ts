import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  VECTOR_MIGRATIONS,
  createPostgresConversationStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { conversationStoreConformance } from "../testing/conformance.js";
import type { ConversationId, TenantId } from "../index.js";

const pgliteExecutor = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/** A fresh, migrated in-memory Postgres per store (migration runs lazily on first query). */
const freshStore = () => {
  let ready: Promise<SqlExecutor> | null = null;
  const init = () =>
    (ready ??= (async () => {
      const sql = pgliteExecutor(new PGlite());
      await migrate(sql);
      return sql;
    })());
  const lazy: SqlExecutor = { async query(text, params) { return (await init()).query(text, params); } };
  return createPostgresConversationStore(lazy);
};

// The Postgres adapter must pass the exact same suite as the in-memory adapter.
conversationStoreConformance(freshStore);

/**
 * COVERAGE, STATED PLAINLY (#91): `ConversationStore` is the **only** port with a Postgres
 * implementation today — `MIGRATIONS` contains just `0001_conversations`, and
 * `createPostgresConversationStore` is the only store factory in `src/adapters/postgres/`. The other
 * 18 harnesses in the widened suite therefore have nothing to run against here yet; they activate
 * one by one as REQ-010→014 land (#93 onward), each of which adds a factory and a line below.
 *
 * This comment exists because the previous state of this file — one harness, no note — read as
 * "the Postgres adapter passes the conformance suite", which is how #20 could close green against
 * the criterion "passes the full conformance suite" with a single table implemented. The
 * adapter × port matrix in #92 makes this machine-checkable; until then, it is written down.
 */

describe("postgres migrations + delete semantics", () => {
  const t1 = "t1" as TenantId;
  const c1 = "c1" as ConversationId;

  it("migrates up, rolls back (table gone), and re-migrates", async () => {
    const sql = pgliteExecutor(new PGlite());
    await migrate(sql);
    await sql.query("SELECT 1 FROM conversations LIMIT 1"); // table exists
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM conversations LIMIT 1")).rejects.toThrow(); // gone
    await migrate(sql); // reversible: up again works
    await sql.query("SELECT 1 FROM conversations LIMIT 1");
  });

  it("optimistic concurrency: a stale expectedVersion is rejected", async () => {
    const sql = pgliteExecutor(new PGlite());
    await migrate(sql);
    const store = createPostgresConversationStore(sql);
    await store.create({ tenantId: t1, id: c1, title: "v1" });
    const v2 = await store.update({ tenantId: t1, id: c1, expectedVersion: 1, patch: { title: "v2" } });
    expect(v2.version).toBe(2);
    await expect(
      store.update({ tenantId: t1, id: c1, expectedVersion: 1, patch: { title: "stale" } }),
    ).rejects.toThrow(/stale/);
  });

  it("soft delete hides the row but leaves it physically present", async () => {
    const sql = pgliteExecutor(new PGlite());
    await migrate(sql);
    const store = createPostgresConversationStore(sql);
    await store.create({ tenantId: t1, id: c1, title: "bye" });
    await store.softDelete({ tenantId: t1, id: c1 });
    expect(await store.findById({ tenantId: t1, id: c1 })).toBeNull(); // hidden
    const raw = await sql.query<{ id: string }>("SELECT id FROM conversations WHERE id = $1", [c1]);
    expect(raw).toHaveLength(1); // soft, not hard — row is retained with deleted_at set
  });
});

describe("migration ids (#139)", () => {
  /**
   * Unique across **both** lists.
   *
   * `MIGRATIONS` and `VECTOR_MIGRATIONS` are applied separately, so a duplicate number is not a compile error
   * and not a runtime error either — it is a deployment recording one migration as applied and skipping the
   * other. Caught by writing `0017_usage_rollups` next to `0017_knowledge_chunks`, which nothing would have
   * flagged.
   */
  it("are unique across the main and vector lists", () => {
    const all = [...MIGRATIONS, ...VECTOR_MIGRATIONS].map((m) => m.id);
    expect(new Set(all).size, `duplicate migration id in ${all.join(", ")}`).toBe(all.length);
  });

  it("use a unique numeric prefix, since that is what a human compares", () => {
    // Two migrations with the same number and different names read as the same migration in a changelog and in
    // a review, whatever the ids technically are.
    const numbers = [...MIGRATIONS, ...VECTOR_MIGRATIONS].map((m) => m.id.split("_")[0]);
    expect(new Set(numbers).size, `duplicate migration number in ${numbers.join(", ")}`).toBe(numbers.length);
  });

  it("keeps the main list in ascending order, so a reader can find the newest", () => {
    const numbers = MIGRATIONS.map((m) => Number(m.id.split("_")[0]));
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
  });

  it("gives every migration a down for every up", () => {
    // Not one-to-one — an ALTER with three ADD COLUMNs is one down with three DROPs — but a migration with no
    // down at all is one nobody can roll back, which is only discovered during an incident.
    for (const migration of [...MIGRATIONS, ...VECTOR_MIGRATIONS]) {
      expect(migration.up.length, `${migration.id} has no up`).toBeGreaterThan(0);
      expect(migration.down.length, `${migration.id} has no down`).toBeGreaterThan(0);
    }
  });
});

