/**
 * Personal memory against a real Postgres — #621.
 *
 * The unit tests run the service over agentkit's in-memory store; this runs it over the **Postgres** store and
 * the table agentkit's own migrations create (`0011_principal_memory_blobs`), in a throwaway schema, so the
 * round trip is the one production makes: put, dedupe, disable, the provider's retrieval, forget, delete, and
 * isolation between principals and workspaces.
 *
 * Skipped unless `RETINUE_TEST_AGENTKIT_PG_URL` is set, e.g. the local agentkit test container:
 *
 *     RETINUE_TEST_AGENTKIT_PG_URL=postgres://postgres:agentkit@127.0.0.1:55433/agentkit \
 *       npx vitest run src/adapters/postgres/__tests__/personalMemory.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";

import { createPersonalMemoryService } from "../../personal-memory.js";
import { createPersonalMemoryContextProvider } from "../../../context/personal-memory.js";

const URL_ = process.env["RETINUE_TEST_AGENTKIT_PG_URL"];
const SCHEMA = `sf_memory_test_${process.pid}_${Date.now()}`;
const ctx = (tenantId: string, principalId: string) => ({ tenantId, principalId, roleIds: ["editor"] }) as unknown as ExecutionContext;

describe.skipIf(URL_ === undefined)("personal memory on agentkit's principal_memory table", () => {
  let pool: { end(): Promise<void>; query(text: string): Promise<unknown> } | undefined;
  let sql: import("@retinue/agentkit/adapters/postgres").SqlExecutor;
  let store: import("@retinue/agentkit/context").PrincipalMemoryStore;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    const admin = new Pool({ connectionString: URL_ });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    const scoped = new Pool({ connectionString: URL_, options: `-c search_path=${SCHEMA}` });
    pool = scoped;
    const { createPgExecutor, createPostgresPrincipalMemoryStore, migrate, appliedMigrationIds } = await import("@retinue/agentkit/adapters/postgres");
    sql = createPgExecutor(scoped as never);
    await migrate(sql);
    expect((await appliedMigrationIds(sql)).has("0011_principal_memory_blobs")).toBe(true);
    store = createPostgresPrincipalMemoryStore(sql);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (URL_ === undefined) return;
    const { Pool } = await import("pg");
    const admin = new Pool({ connectionString: URL_ });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  it("round-trips: remember, dedupe, disable, retrieve, forget, delete — for one principal only", async () => {
    const service = createPersonalMemoryService({ store });
    const me = ctx("ws-a", "user-1");
    const colleague = ctx("ws-a", "user-2");
    const meElsewhere = ctx("ws-b", "user-1");

    const first = await service.remember(me, { text: "Writes in British English." });
    expect(first.duplicate).toBe(false);
    expect((await service.remember(me, { text: "  writes in british   English. " })).duplicate).toBe(true);
    const second = await service.remember(me, { text: "Prefers captions without emoji." });
    await service.remember(colleague, { text: "Writes in German." });
    await service.remember(meElsewhere, { text: "Uses emoji freely." });

    expect((await service.list(me)).map((m) => m.text)).toEqual(["Writes in British English.", "Prefers captions without emoji."]);

    // Switched off: listed, but not in the prompt.
    await service.setEnabled(me, { id: second.memory.id, enabled: false });
    const [section] = await createPersonalMemoryContextProvider({ store }).provide(me);
    expect(section!.body).toContain("Writes in British English.");
    expect(section!.body).not.toContain("without emoji");
    expect(section!.body).not.toContain("German");
    expect(section!.body).not.toContain("emoji freely");

    // Another principal cannot touch it by id.
    await expect(service.forget(colleague, { id: first.memory.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await service.remove(meElsewhere, { id: first.memory.id })).deleted).toBe(false);

    expect((await service.forget(me, { text: "british" })).forgotten.map((m) => m.id)).toEqual([first.memory.id]);
    expect((await service.remove(me, { id: second.memory.id })).deleted).toBe(true);
    expect(await service.list(me)).toEqual([]);
    expect((await service.list(colleague)).map((m) => m.text)).toEqual(["Writes in German."]);
    expect((await service.list(meElsewhere)).map((m) => m.text)).toEqual(["Uses emoji freely."]);
  });

  it("the table enforces the 1,000-character bound itself", async () => {
    await expect(
      store.put({ tenantId: "ws-a", principalId: "user-3", text: "x".repeat(1_001) } as never),
    ).rejects.toThrow();
  });
});
