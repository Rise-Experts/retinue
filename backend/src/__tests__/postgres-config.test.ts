/**
 * Postgres `SkillStore` / `McpConnectionStore` — adapter-specific cases (#101).
 *
 * Two of these exist because the SPEC asked for something I declined to build, and a decision like
 * that is worth pinning in a test rather than only in a commit message:
 *
 * - **AC-2** asked for a constraint rejecting "executable content" in a skill body. There is nothing
 *   to detect — `instructions` is a string nothing evaluates — so the rule is enforced structurally
 *   (the type has no executable field) plus the `SKILL_LIMITS` bounds, mirrored as CHECKs so a direct
 *   SQL insert cannot bypass them either.
 * - **AC-4** asked for a constraint rejecting "anything resembling an inline secret". A pattern
 *   cannot tell a reference from a secret, so the guarantee is that there is nowhere to put one.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { SkillId, TenantId } from "../core/ids.js";
import type { McpServerConnection } from "../mcp/index.js";
import type { SkillVersion } from "../skills/index.js";
import { SKILL_LIMITS } from "../skills/index.js";
import {
  createPostgresMcpConnectionStore,
  createPostgresSkillStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";

const T1 = asId<TenantId>("pg-cfg-t1");
const T2 = asId<TenantId>("pg-cfg-t2");
const NOW = "2020-01-01T00:00:00.000Z";
const EGRESS = { allowedSchemes: ["https"] } as const;

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const migrated = async (): Promise<SqlExecutor> => {
  const sql = pglite(new PGlite());
  await migrate(sql);
  return sql;
};

const skill = (name: string, version: number, over: Partial<SkillVersion> = {}): SkillVersion => ({
  id: asId<SkillId>(`${name}-${version}`),
  name,
  description: "A fixture skill with a description long enough to satisfy the limits.",
  source: "tenant",
  version,
  instructions: "Write posts in the brand voice. Keep them short.",
  status: "active",
  tenantId: T1,
  createdAt: NOW,
  ...over,
});

const connection = (id: string, over: Partial<McpServerConnection> = {}): McpServerConnection => ({
  id,
  tenantId: T1,
  label: `server ${id}`,
  transport: "streamable-http",
  endpoint: "https://mcp.example.com/rpc",
  auth: { kind: "bearer", credentialRef: "secret://tenant/mcp-token" },
  enabled: true,
  createdAt: NOW,
  ...over,
});

describe("migration 0010", () => {
  it("migrates up, rolls back, and re-migrates", async () => {
    const sql = await migrated();
    for (const t of ["skills", "mcp_connections"]) await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM skills LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM skills LIMIT 1");
  });

  it("names the body column instructions and keeps description and source", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'skills'`,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));

    // The SPEC said `content`; the field is `instructions`.
    expect(byName.has("content")).toBe(false);
    expect(byName.get("instructions")).toBe("text");
    // It omitted description — the field SkillCatalogEntry documents as what discovery puts in
    // context, so listCatalog could not return a usable entry without it — and source, which the
    // resolver layers tenant skills over built-ins by.
    expect(byName.get("description")).toBe("text");
    expect(byName.get("source")).toBe("text");
    // And it proposed `enabled boolean` for a three-state status. A boolean cannot tell a draft from
    // an archived skill, and listCatalog filters on active specifically.
    expect(byName.has("enabled")).toBe(false);
    expect(byName.get("status")).toBe("text");
  });

  it("keys skills by name and version, which is how findVersion looks them up", async () => {
    const sql = await migrated();
    const key = await sql.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'skills' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    // The SPEC's (tenant_id, id, version) would not serve findVersion(name, version) at all.
    expect(key.map((k) => k.column_name)).toEqual(["tenant_id", "name", "version"]);
  });

  it("carries no egress_policy or updated_at on mcp_connections", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_connections'`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    // The egress policy is a parameter of the store — a deployment-level rule, not per-row data — so
    // nothing could populate a per-connection column. `updated_at` has no field on the type.
    expect(names.has("egress_policy")).toBe(false);
    expect(names.has("updated_at")).toBe(false);
    // `name` -> `label`, and the auth union is split so its shape can be enforced.
    expect(names.has("name")).toBe(false);
    expect(names.has("label")).toBe(true);
    expect(names.has("auth_kind")).toBe(true);
    expect(names.has("last_handshake_at")).toBe(true);
    expect(names.has("last_error")).toBe(true);
  });
});

/**
 * AC-2, as it actually is. The store runs `validateSkillInput`, and these CHECKs cover the path that
 * does not: a migration, a data fix, anyone with psql. A limit enforced only in application code is a
 * limit that holds until someone writes SQL.
 */
describe("SKILL_LIMITS enforced in the schema, not only in the store", () => {
  const insert = (sql: SqlExecutor, over: Record<string, string>) =>
    sql.query(
      `INSERT INTO skills
         (tenant_id, id, name, description, source, version, instructions, status, created_at)
       VALUES ($1, 'x', ${over["name"] ?? "'valid-name'"}, ${over["description"] ?? "repeat('d', 40)"},
               'tenant', 1, ${over["instructions"] ?? "'body'"}, 'active', now())`,
      [T1],
    );

  it("rejects a name that is not a slug", async () => {
    const sql = await migrated();
    await expect(insert(sql, { name: "'Not A Slug'" })).rejects.toThrow();
    await expect(insert(sql, { name: "'trailing-'" })).rejects.toThrow();
  });

  it("rejects a description below the minimum and above the maximum", async () => {
    const sql = await migrated();
    expect(SKILL_LIMITS.descriptionMinLength).toBe(20);
    await expect(insert(sql, { description: "'too short'" })).rejects.toThrow();
    await expect(
      insert(sql, { description: `repeat('d', ${SKILL_LIMITS.descriptionMaxLength + 1})` }),
    ).rejects.toThrow();
  });

  it("rejects instructions past the ceiling", async () => {
    const sql = await migrated();
    await expect(
      insert(sql, { instructions: `repeat('x', ${SKILL_LIMITS.instructionsMaxLength + 1})` }),
    ).rejects.toThrow();
  });

  it("rejects a status or source outside the declared sets", async () => {
    const sql = await migrated();
    for (const bad of [
      `'tenant', 1, 'body', 'published'`, // status not in SkillStatus
      `'vendor', 1, 'body', 'active'`, // source not in SKILL_SOURCES
    ]) {
      await expect(
        sql.query(
          `INSERT INTO skills (tenant_id, id, name, description, source, version, instructions, status, created_at)
           VALUES ($1, 'x', 'valid-name', repeat('d', 40), ${bad}, now())`,
          [T1],
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects a bad skill through the store as a platform error, not a driver error", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);

    // Asserting the *error type*, not the message. An earlier version of this test matched
    // /slug/ and /description/, and passed even with validateSkillInput removed from the store —
    // because the CHECK constraints reject the same rows and their constraint names happen to
    // contain those words. It verified "something refuses this", which the schema already covers.
    //
    // What actually requires the shared validator is the contract: a caller gets the platform's
    // invalid_input error, with the same message shape the reference adapter produces, rather than a
    // raw Postgres constraint violation it would have to parse.
    for (const bad of [skill("Not A Slug", 1), skill("ok-name", 1, { description: "short" })]) {
      const error = await store.add(T1, bad).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AgentPlatformError);
      expect((error as AgentPlatformError).code).toBe("invalid_input");
    }
  });

  it("accepts instructions that talk about code — there is no executable field to reject", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    // The point of declining AC-2's content filter. A skill about writing code legitimately contains
    // code, and nothing ever evaluates this string, so a pattern would block real skills while
    // preventing nothing.
    await store.add(
      T1,
      skill("code-review", 1, {
        instructions: "When reviewing, look for `eval(userInput)` and <script> tags. Run npm audit.",
      }),
    );
    expect(
      (await store.findVersion({ tenantId: T1, name: "code-review", version: 1 }))?.instructions,
    ).toContain("eval(userInput)");
  });
});

describe("catalog and version resolution", () => {
  it("lists the latest active version per name, once", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    await store.add(T1, skill("post-composition", 1));
    await store.add(T1, skill("post-composition", 2));
    await store.add(T1, skill("tone-check", 1));

    const catalog = await store.listCatalog({ tenantId: T1 });
    expect(catalog).toHaveLength(2);
    expect(catalog.find((e) => e.name === "post-composition")?.version).toBe(2);
  });

  it("hides drafts and archived versions from discovery but keeps them resolvable", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    await store.add(T1, skill("post-composition", 1, { status: "archived" }));
    await store.add(T1, skill("post-composition", 2, { status: "draft" }));

    // Deliberate, and the reason it is deliberate: a run pinned to an archived version keeps working
    // while no new run picks it up.
    expect(await store.listCatalog({ tenantId: T1 })).toHaveLength(0);
    expect(await store.findVersion({ tenantId: T1, name: "post-composition", version: 1 })).toMatchObject(
      { status: "archived" },
    );
  });

  it("keeps a pinned version stable after a newer one is added", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    await store.add(T1, skill("post-composition", 1, { instructions: "v1 body" }));
    await store.add(T1, skill("post-composition", 2, { instructions: "v2 body" }));
    // AC-1's real content: the version a run recorded still resolves to the body it used.
    expect(
      (await store.findVersion({ tenantId: T1, name: "post-composition", version: 1 }))?.instructions,
    ).toBe("v1 body");
  });

  it("omits bodies from the catalog, so discovery cannot pull 20k characters into context", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    await store.add(T1, skill("post-composition", 1, { instructions: "x".repeat(19_000) }));
    const entry = (await store.listCatalog({ tenantId: T1 }))[0];
    // AC-5. The catalog/body split is the whole reason SkillCatalogEntry exists separately.
    expect(entry).not.toHaveProperty("instructions");
    expect(Object.keys(entry ?? {}).sort()).toEqual(["description", "id", "name", "source", "version"]);
  });

  it("serves the catalog and the version lookup from indexes", async () => {
    const sql = await migrated();
    for (const q of [
      `EXPLAIN SELECT DISTINCT ON (name) name FROM skills WHERE tenant_id = $1 AND status = 'active' ORDER BY name, version DESC`,
      `EXPLAIN SELECT 1 FROM skills WHERE tenant_id = $1 AND name = 'post-composition' AND version = 1`,
    ]) {
      const plan = await sql.query<Record<string, string>>(q, [T1]);
      expect(plan.map((r) => Object.values(r)[0]).join("\n")).not.toContain("Seq Scan");
    }
  });

  it("enforces tenant isolation on both reads", async () => {
    const sql = await migrated();
    const store = createPostgresSkillStore(sql);
    await store.add(T1, skill("post-composition", 1));
    expect(await store.listCatalog({ tenantId: T2 })).toHaveLength(0);
    expect(await store.findVersion({ tenantId: T2, name: "post-composition", version: 1 })).toBeNull();
  });
});

describe("MCP connections", () => {
  it("round-trips every auth kind, rebuilding the union from two columns", async () => {
    const sql = await migrated();
    const store = createPostgresMcpConnectionStore(sql, EGRESS);
    await store.register({ tenantId: T1, connection: connection("c-none", { auth: { kind: "none" } }) });
    await store.register({
      tenantId: T1,
      connection: connection("c-oauth", { auth: { kind: "oauth", credentialRef: "secret://t/oauth" } }),
    });
    expect((await store.get({ tenantId: T1, id: "c-none" }))?.auth).toEqual({ kind: "none" });
    expect((await store.get({ tenantId: T1, id: "c-oauth" }))?.auth).toEqual({
      kind: "oauth",
      credentialRef: "secret://t/oauth",
    });
  });

  it("refuses a half-written auth union at the schema level", async () => {
    const sql = await migrated();
    // A bearer connection with no reference would fail at handshake time, far from the write that
    // caused it; and a 'none' carrying a reference implies a credential nothing will use.
    for (const [kind, ref] of [
      ["bearer", "NULL"],
      ["none", "'secret://t/x'"],
    ] as const) {
      await expect(
        sql.query(
          `INSERT INTO mcp_connections
             (tenant_id, id, label, transport, endpoint, auth_kind, auth_credential_ref, enabled, created_at)
           VALUES ($1, 'bad-${kind}', 'l', 'streamable-http', 'https://x/y', '${kind}', ${ref}, true, now())`,
          [T1],
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects a transport outside MCP_TRANSPORTS", async () => {
    const sql = await migrated();
    await expect(
      sql.query(
        `INSERT INTO mcp_connections
           (tenant_id, id, label, transport, endpoint, auth_kind, enabled, created_at)
         VALUES ($1, 'bad-t', 'l', 'grpc', 'https://x/y', 'none', true, now())`,
        [T1],
      ),
    ).rejects.toThrow();
  });

  it("refuses to persist an endpoint the egress policy rejects", async () => {
    const sql = await migrated();
    const store = createPostgresMcpConnectionStore(sql, EGRESS);
    await expect(
      store.register({ tenantId: T1, connection: connection("c1", { endpoint: "http://mcp.example.com/rpc" }) }),
    ).rejects.toThrow();
    // Refused at registration means it never reaches storage, so a later boot cannot resurrect it.
    expect(await store.list({ tenantId: T1 })).toHaveLength(0);
  });

  it("refuses a connection whose tenant does not match the scope", async () => {
    const sql = await migrated();
    const store = createPostgresMcpConnectionStore(sql, EGRESS);
    await expect(
      store.register({ tenantId: T2, connection: connection("c1") }),
    ).rejects.toThrow(/tenant mismatch/i);
  });

  it("survives a new store instance with its optional fields intact", async () => {
    const sql = await migrated();
    await createPostgresMcpConnectionStore(sql, EGRESS).register({
      tenantId: T1,
      connection: connection("c1", {
        lastHandshakeAt: "2020-02-02T00:00:00.000Z",
        lastError: "handshake timed out",
      }),
    });
    // AC-3's achievable half: the connection survives. The egress policy is not per-connection state,
    // so what applies after a restart is whatever policy the store is constructed with.
    const reopened = createPostgresMcpConnectionStore(sql, EGRESS);
    expect(await reopened.get({ tenantId: T1, id: "c1" })).toMatchObject({
      label: "server c1",
      lastHandshakeAt: "2020-02-02T00:00:00.000Z",
      lastError: "handshake timed out",
    });
  });

  it("toggles enabled, and is silent about a connection that is not there", async () => {
    const sql = await migrated();
    const store = createPostgresMcpConnectionStore(sql, EGRESS);
    await store.register({ tenantId: T1, connection: connection("c1") });
    await store.setEnabled({ tenantId: T1, id: "c1", enabled: false });
    expect((await store.get({ tenantId: T1, id: "c1" }))?.enabled).toBe(false);
    await expect(
      store.setEnabled({ tenantId: T1, id: "ghost", enabled: false }),
    ).resolves.toBeUndefined();
  });
});

/** AC-4. The guarantee is that there is nowhere to put a secret — not that a pattern would spot one. */
describe("credentials are references, structurally", () => {
  it("has no column capable of holding a credential value", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_connections'`,
    );
    const names = cols.map((c) => c.column_name);
    // Exactly one auth-value column, and its name says reference. A pattern-matching constraint on
    // the *contents* was declined deliberately: it cannot tell a reference from a secret in general,
    // so it would miss secrets shaped like paths while blocking legitimate reference formats — and
    // its name would tell a reviewer the problem was handled.
    expect(names.filter((n) => n.startsWith("auth_")).sort()).toEqual([
      "auth_credential_ref",
      "auth_kind",
    ]);
    for (const forbidden of ["token", "secret", "password", "api_key", "credential"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("returns only the reference on every read path", async () => {
    const sql = await migrated();
    const store = createPostgresMcpConnectionStore(sql, EGRESS);
    await store.register({ tenantId: T1, connection: connection("c1") });
    for (const read of [
      await store.get({ tenantId: T1, id: "c1" }),
      (await store.list({ tenantId: T1 }))[0],
    ]) {
      expect(read?.auth).toEqual({ kind: "bearer", credentialRef: "secret://tenant/mcp-token" });
      // Nothing beyond the declared fields — a stray column leaking into the object is how a secret
      // would reach model context, since this record is documented as never being allowed there.
      expect(Object.keys(read ?? {}).sort()).toEqual(
        ["auth", "createdAt", "enabled", "endpoint", "id", "label", "tenantId", "transport"].sort(),
      );
    }
  });
});
