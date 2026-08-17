import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { createSchemaManager, provisionSchema, type SqlExecutor } from "../adapters/postgres/index.js";

const executor = (): SqlExecutor => {
  const db = new PGlite();
  return { query: (text, params) => db.query(text, params ? [...params] : undefined).then((r) => r.rows as never) };
};

const hasConversations = async (sql: SqlExecutor): Promise<boolean> => {
  try {
    await sql.query("SELECT 1 FROM conversations LIMIT 1");
    return true;
  } catch {
    return false;
  }
};

describe("schema provisioning", () => {
  it("auto provisions a fresh database", async () => {
    const sql = executor();
    const mgr = createSchemaManager(sql);
    expect(await mgr.currentVersion()).toBe(0);
    const res = await provisionSchema(sql, { mode: "auto" });
    expect(res.applied.length).toBeGreaterThan(0);
    expect(await mgr.currentVersion()).toBe(mgr.targetVersion());
    expect(await hasConversations(sql)).toBe(true);
  });

  it("plan mode logs the diff and applies nothing", async () => {
    const sql = executor();
    const log = vi.fn();
    const res = await provisionSchema(sql, { mode: "plan", log });
    expect(res.planned.length).toBeGreaterThan(0);
    expect(res.applied).toHaveLength(0);
    expect(log).toHaveBeenCalled();
    expect(await hasConversations(sql)).toBe(false); // DB untouched
    expect(await createSchemaManager(sql).currentVersion()).toBe(0);
  });

  it("apply run twice is a no-op — no double-provision", async () => {
    const sql = executor();
    await provisionSchema(sql, { mode: "auto" });
    const second = await provisionSchema(sql, { mode: "auto" });
    expect(second.applied).toHaveLength(0);
    const mgr = createSchemaManager(sql);
    expect(await mgr.currentVersion()).toBe(mgr.targetVersion());
  });

  it("off mode is a no-op (Postgres default)", async () => {
    const sql = executor();
    const res = await provisionSchema(sql);
    expect(res.mode).toBe("off");
    expect(await hasConversations(sql)).toBe(false);
  });
});
