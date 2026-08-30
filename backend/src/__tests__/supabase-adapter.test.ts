import { PGlite } from "@electric-sql/pglite";
import type { RealtimeBroadcaster } from "../adapters/supabase/realtime.js";
import { describe, expect, it } from "vitest";
import { type RunEvent } from "../index.js";
import { applyRls, setTenantContext } from "../entries/adapters-postgres.js";
import { createSupabaseConversationStore, createSupabaseRealtimePublisher, migrate, type SqlExecutor } from "../entries/adapters-postgres.js";
import { conversationStoreConformance } from "../testing/conformance.js";

const pgliteSql = (db: PGlite): SqlExecutor => ({
  query: (text, params) => db.query(text, params ? [...params] : undefined).then((r) => r.rows as never),
});

// The Supabase store is the Postgres store — it must pass the same conformance suite.
const freshStore = () => {
  let ready: Promise<SqlExecutor> | null = null;
  const init = () =>
    (ready ??= (async () => {
      const sql = pgliteSql(new PGlite());
      await migrate(sql);
      return sql;
    })());
  const lazy: SqlExecutor = { async query(text, params) { return (await init()).query(text, params); } };
  return createSupabaseConversationStore(lazy);
};
conversationStoreConformance(freshStore);

describe("supabase RLS + realtime", () => {
  it("RLS denies cross-tenant reads at the database, with no app-level WHERE", async () => {
    const db = new PGlite();
    const sql = pgliteSql(db);
    await migrate(sql);
    // Seed both tenants as the superuser (RLS is bypassed for the owner).
    await db.query(
      `INSERT INTO conversations (tenant_id, id, title, version, created_at, updated_at)
       VALUES ('t1','c1','a',1,now(),now()), ('t2','c2','b',1,now(),now())`,
    );
    await applyRls(sql);
    // Supabase connects as a non-superuser role; simulate that so RLS actually applies.
    await db.exec(`CREATE ROLE app_user NOSUPERUSER; GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO app_user;`);

    await setTenantContext(sql, "t1");
    await db.exec(`SET ROLE app_user;`);
    const seenAsT1 = await sql.query<{ id: string }>(`SELECT id FROM conversations`); // deliberately no WHERE
    expect(seenAsT1.map((r) => r.id)).toEqual(["c1"]);

    await db.exec(`RESET ROLE;`);
    await setTenantContext(sql, "t2");
    await db.exec(`SET ROLE app_user;`);
    const seenAsT2 = await sql.query<{ id: string }>(`SELECT id FROM conversations`);
    expect(seenAsT2.map((r) => r.id)).toEqual(["c2"]);
  });

  it("realtime publisher forwards run events to the broadcaster", async () => {
    const calls: Array<{ channel: string; event: string; payload: unknown }> = [];
    const broadcaster: RealtimeBroadcaster = {
      send: (channel, event, payload) => {
        calls.push({ channel, event, payload });
      },
    };
    const publisher = createSupabaseRealtimePublisher(broadcaster);
    const event = { type: "run.started", runId: "r1", sequence: 1, occurredAt: "t" } as unknown as RunEvent;
    await publisher.publish("conversation:1", event);
    expect(calls).toEqual([{ channel: "conversation:1", event: "run.started", payload: event }]);
  });
});
