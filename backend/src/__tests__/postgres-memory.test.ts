/**
 * Postgres `PrincipalMemoryStore` / `BlobStore` — adapter-specific cases (#102).
 *
 * The two that matter most are both privacy properties rather than correctness niceties:
 *
 * - **A disabled entry must never be a retrieval candidate.** The port says disabled entries are
 *   never retrieved for prompts. A user switching off a memory about themselves and having it keep
 *   shaping answers is the failure this prevents.
 * - **Cross-principal isolation on every method.** Not one spot check — the harness covers the happy
 *   path, so what is worth asserting here is that *no* method leaks, including the ones where a
 *   forgotten predicate would be easiest to miss.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { BlobRef, PrincipalId, TenantId } from "../core/ids.js";
import { MEMORY_LIMITS } from "../principal-memory/index.js";
import {
  createPostgresBlobStore,
  createPostgresPrincipalMemoryStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-mem-t1");
const T2 = asId<TenantId>("pg-mem-t2");
const P1 = asId<PrincipalId>("pg-mem-p1");
const P2 = asId<PrincipalId>("pg-mem-p2");

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const migrated = async (): Promise<SqlExecutor> => {
  const { sql } = await freshPgliteSchema();
  return sql;
};

describe("migration 0011", () => {
  it("migrates up, rolls back, and re-migrates", async () => {
    const sql = await migrated();
    for (const t of ["principal_memory", "blobs"]) await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM principal_memory LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM principal_memory LIMIT 1");
  });

  it("carries the four columns the SPEC omitted, and not the one it invented", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'principal_memory' AND table_schema = current_schema()`,
    );
    const names = new Set(cols.map((c) => c.column_name));

    // The SPEC had `content text, source text` and nothing else. `content` is `text`, and `source`
    // has no field on PrincipalMemoryEntry to populate it.
    expect(names.has("content")).toBe(false);
    expect(names.has("source")).toBe(false);
    expect(names.has("text")).toBe(true);
    // All four omissions are load-bearing: without salience, retrieve cannot order "most salient
    // first"; without version, update's optimistic guard cannot exist; without disabled_at there is
    // nowhere to record that a user switched a memory off.
    for (const required of ["tags", "salience", "version", "disabled_at"]) {
      expect(names.has(required), `principal_memory needs ${required}`).toBe(true);
    }
  });

  it("stores the blob value, not a pointer — because that is what the port returns", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'blobs' AND table_schema = current_schema()`,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    // `get(ref)` must hand back what `put(value)` was given, so a metadata-and-pointer row could not
    // serve it — there is nothing in the port to fetch bytes with. The SPEC's storage_key /
    // content_type / byte_size / conversation_id design belongs to FileMetadataStore (#129) or
    // ArtifactStore (#133), which exist as deliberate method-less placeholders.
    expect(byName.get("value")).toBe("jsonb");
    for (const absent of ["storage_key", "content_type", "byte_size", "conversation_id"]) {
      expect(byName.has(absent), `blobs should not have ${absent}`).toBe(false);
    }
  });

  it("enforces MEMORY_LIMITS against a direct insert, not only through the store", async () => {
    const sql = await migrated();
    const insert = (text: string, tags: string) =>
      sql.query(
        `INSERT INTO principal_memory
           (tenant_id, principal_id, id, text, tags, salience, version, created_at, updated_at)
         VALUES ($1, $2, 'm-bad', ${text}, ${tags}::jsonb, 1, 1, now(), now())`,
        [T1, P1],
      );
    expect(MEMORY_LIMITS.textMaxLength).toBe(1_000);
    expect(MEMORY_LIMITS.maxTagsPerEntry).toBe(8);
    // The extraction gate enforces these too, but that is application code and this is not.
    await expect(insert(`repeat('x', ${MEMORY_LIMITS.textMaxLength + 1})`, "'[]'")).rejects.toThrow();
    await expect(insert("''", "'[]'")).rejects.toThrow();
    await expect(
      insert("'ok'", `'${JSON.stringify(Array.from({ length: 9 }, (_, i) => `t${i}`))}'`),
    ).rejects.toThrow();
    await expect(insert("'ok'", `'{"not":"an array"}'`)).rejects.toThrow();
  });
});

/** AC-2. Structural, and worth checking on every method rather than one. */
describe("cross-principal isolation on every method", () => {
  it("never returns another principal's memory from any read path", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const mine = await store.put({ tenantId: T1, principalId: P1, text: "I prefer concise replies" });

    // Every read, with the same id but the wrong principal. A single forgotten predicate in any one
    // of these would leak one user's memory into another's prompts.
    expect(await store.get({ tenantId: T1, principalId: P2, id: mine.id })).toBeNull();
    expect((await store.list({ tenantId: T1, principalId: P2, limit: 10 })).items).toHaveLength(0);
    expect(await store.retrieve({ tenantId: T1, principalId: P2, limit: 10 })).toHaveLength(0);
    // ...and the same across tenants, with the same principal id.
    expect(await store.get({ tenantId: T2, principalId: P1, id: mine.id })).toBeNull();
    expect(await store.retrieve({ tenantId: T2, principalId: P1, limit: 10 })).toHaveLength(0);
  });

  it("cannot update or delete another principal's memory", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const mine = await store.put({ tenantId: T1, principalId: P1, text: "remember this" });

    // An update from the wrong principal must not succeed *and* must not report a version conflict,
    // which would confirm the entry exists.
    const error = await store
      .update({ tenantId: T1, principalId: P2, id: mine.id, expectedVersion: 1, patch: { text: "hijacked" } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe("not_found");

    // A delete from the wrong principal is a no-op, not a silent success that removes the row.
    await store.delete({ tenantId: T1, principalId: P2, id: mine.id });
    expect(await store.get({ tenantId: T1, principalId: P1, id: mine.id })).not.toBeNull();
  });
});

/** The privacy property: a disabled memory stops influencing prompts, immediately. */
describe("disabled entries", () => {
  it("disappears from retrieve but stays visible to its owner", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const entry = await store.put({ tenantId: T1, principalId: P1, text: "I live in Berlin" });

    const disabled = await store.update({
      tenantId: T1,
      principalId: P1,
      id: entry.id,
      expectedVersion: 1,
      patch: { disabled: true },
    });
    expect(disabled.disabledAt).toBeDefined();

    // Never a retrieval candidate — the index it would come from is partial on active, so it cannot
    // even be returned by accident.
    expect(await store.retrieve({ tenantId: T1, principalId: P1, limit: 10 })).toHaveLength(0);
    // But still listable and readable, because "view and delete my own memory" needs it visible.
    expect(await store.get({ tenantId: T1, principalId: P1, id: entry.id })).not.toBeNull();
    expect((await store.list({ tenantId: T1, principalId: P1, limit: 10 })).items).toHaveLength(1);
  });

  it("re-enabling clears the timestamp and restores retrieval", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const entry = await store.put({ tenantId: T1, principalId: P1, text: "I live in Berlin" });
    const off = await store.update({
      tenantId: T1, principalId: P1, id: entry.id, expectedVersion: 1, patch: { disabled: true },
    });
    const on = await store.update({
      tenantId: T1, principalId: P1, id: entry.id, expectedVersion: off.version, patch: { disabled: false },
    });
    // `disabled: false` must clear the stamp, not leave it — a COALESCE would have left it set.
    expect(on.disabledAt).toBeUndefined();
    expect(await store.retrieve({ tenantId: T1, principalId: P1, limit: 10 })).toHaveLength(1);
  });

  it("an omitted disabled flag leaves the current state alone", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const entry = await store.put({ tenantId: T1, principalId: P1, text: "I live in Berlin" });
    const off = await store.update({
      tenantId: T1, principalId: P1, id: entry.id, expectedVersion: 1, patch: { disabled: true },
    });
    // Patching only the text must not silently re-enable a memory the user switched off.
    const patched = await store.update({
      tenantId: T1, principalId: P1, id: entry.id, expectedVersion: off.version, patch: { text: "I moved" },
    });
    expect(patched.text).toBe("I moved");
    expect(patched.disabledAt).toBeDefined();
  });
});

describe("versioning, retrieval and durability", () => {
  it("rejects a stale update and names the current version", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const entry = await store.put({ tenantId: T1, principalId: P1, text: "v1" });
    await store.update({ tenantId: T1, principalId: P1, id: entry.id, expectedVersion: 1, patch: { text: "v2" } });

    const error = await store
      .update({ tenantId: T1, principalId: P1, id: entry.id, expectedVersion: 1, patch: { text: "v2 again" } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((error as AgentPlatformError).code).toBe("conflict");
    expect((error as Error).message).toContain("current 2");
    // The losing write left nothing behind.
    expect((await store.get({ tenantId: T1, principalId: P1, id: entry.id }))?.text).toBe("v2");
  });

  it("re-putting the same id bumps the version and keeps created_at", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql, { clock: () => "2020-01-01T00:00:00.000Z" });
    const first = await store.put({ tenantId: T1, principalId: P1, id: "m1", text: "first" });
    const second = await store.put({ tenantId: T1, principalId: P1, id: "m1", text: "second" });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("orders retrieval by salience and honours the limit", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    await store.put({ tenantId: T1, principalId: P1, text: "low", salience: 1 });
    await store.put({ tenantId: T1, principalId: P1, text: "high", salience: 9 });
    await store.put({ tenantId: T1, principalId: P1, text: "middle", salience: 5 });
    // Most salient first, because retrieval is budget-limited — the entries that get dropped are the
    // ones the user cares least about.
    expect((await store.retrieve({ tenantId: T1, principalId: P1, limit: 2 })).map((e) => e.text)).toEqual([
      "high",
      "middle",
    ]);
  });

  it("matches a query against text and against tags", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    await store.put({ tenantId: T1, principalId: P1, text: "Prefers dark mode", tags: ["ui"] });
    await store.put({ tenantId: T1, principalId: P1, text: "Allergic to shellfish", tags: ["health", "food"] });

    expect(await store.retrieve({ tenantId: T1, principalId: P1, query: "DARK", limit: 10 })).toHaveLength(1);
    expect(await store.retrieve({ tenantId: T1, principalId: P1, query: "food", limit: 10 })).toHaveLength(1);
    expect(await store.retrieve({ tenantId: T1, principalId: P1, query: "nothing", limit: 10 })).toHaveLength(0);
  });

  it("treats a query containing wildcards as literal text", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    await store.put({ tenantId: T1, principalId: P1, text: "Prefers dark mode" });
    // A bare `%` would match everything if the query were interpolated rather than bound. It is a
    // parameter, so this is a literal search for a percent sign — and finds nothing.
    expect(await store.retrieve({ tenantId: T1, principalId: P1, query: "%", limit: 10 })).toHaveLength(0);
  });

  it("hard-deletes, so a removed fact cannot resurface", async () => {
    const sql = await migrated();
    const store = createPostgresPrincipalMemoryStore(sql);
    const entry = await store.put({ tenantId: T1, principalId: P1, text: "forget me" });
    await store.delete({ tenantId: T1, principalId: P1, id: entry.id });

    expect(await store.get({ tenantId: T1, principalId: P1, id: entry.id })).toBeNull();
    expect(await store.retrieve({ tenantId: T1, principalId: P1, limit: 10 })).toHaveLength(0);
    // Asserted against the table too: a soft delete would leave the text on disk after a user asked
    // for it to be gone, which is the opposite of what they asked for.
    expect(await sql.query(`SELECT 1 FROM principal_memory`)).toHaveLength(0);
  });

  it("survives a new store instance and applies in a later conversation", async () => {
    const sql = await migrated();
    await createPostgresPrincipalMemoryStore(sql).put({
      tenantId: T1,
      principalId: P1,
      text: "Always sign off as Alex",
      tags: ["voice"],
      salience: 7,
    });
    // AC-1. A new store over the same database is what "survives a restart" means; reusing the same
    // instance would pass even for a pure in-memory implementation.
    const reopened = createPostgresPrincipalMemoryStore(sql);
    expect(await reopened.retrieve({ tenantId: T1, principalId: P1, query: "sign off", limit: 5 })).toMatchObject([
      { text: "Always sign off as Alex", tags: ["voice"], salience: 7 },
    ]);
  });

  it("pages list by a stable cursor without repeating or dropping", async () => {
    const sql = await migrated();
    let n = 0;
    const store = createPostgresPrincipalMemoryStore(sql, {
      clock: () => `2020-01-01T00:00:0${n}.000Z`,
    });
    for (n = 1; n <= 5; n += 1) await store.put({ tenantId: T1, principalId: P1, id: `m${n}`, text: `t${n}` });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({
        tenantId: T1,
        principalId: P1,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});

describe("blob store", () => {
  it("round-trips nested JSON under deep equality", async () => {
    const sql = await migrated();
    const store = createPostgresBlobStore(sql);
    const value = { rows: [{ id: 1, tags: ["a"] }], nested: { ok: true, note: null } };
    const ref = await store.put({ tenantId: T1, value });
    expect(await store.get({ tenantId: T1, ref })).toEqual(value);
  });

  it("issues distinct refs and keeps values distinct", async () => {
    const sql = await migrated();
    const store = createPostgresBlobStore(sql);
    const a = await store.put({ tenantId: T1, value: { v: "a" } });
    const b = await store.put({ tenantId: T1, value: { v: "b" } });
    expect(a).not.toBe(b);
    expect(await store.get({ tenantId: T1, ref: a })).toEqual({ v: "a" });
  });

  it("never resolves a ref across tenants", async () => {
    const sql = await migrated();
    const store = createPostgresBlobStore(sql);
    const ref = await store.put({ tenantId: T1, value: { secret: true } });
    // The port's docstring calls this out specifically: a ref from one tenant must never resolve
    // another's bytes, even if it is guessed or leaks into a log.
    expect(await store.get({ tenantId: T2, ref })).toBeNull();
  });

  it("returns null for a ref that was never issued", async () => {
    const sql = await migrated();
    expect(
      await createPostgresBlobStore(sql).get({ tenantId: T1, ref: asId<BlobRef>("blob:pg-mem-t1:99999") }),
    ).toBeNull();
  });

  it("keeps refs unique across store instances, unlike a process-local counter", async () => {
    const sql = await migrated();
    // The reference adapter counts in-process, which after a restart would hand out a ref that
    // already belongs to someone else's value. A sequence is why that cannot happen here.
    const first = await createPostgresBlobStore(sql).put({ tenantId: T1, value: { v: 1 } });
    const second = await createPostgresBlobStore(sql).put({ tenantId: T1, value: { v: 2 } });
    expect(first).not.toBe(second);
    expect(await createPostgresBlobStore(sql).get({ tenantId: T1, ref: first })).toEqual({ v: 1 });
  });
});
