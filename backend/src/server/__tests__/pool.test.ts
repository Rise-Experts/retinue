/**
 * The configured schema reaches every connection -- REQ-041 (#190).
 *
 * `RETINUE_DATABASE_SCHEMA` exists so a deployment can share a database with a product that owns
 * `public`. What makes it worth testing is the shape of the failure when it is wired to only *some* of
 * the paths: nothing errors. Migrations report success, the host answers, and the tables are simply in
 * the wrong schema -- or worse, half in each, since `createPgExecutor` runs every query through
 * `pool.query` and gets a different pooled connection each time.
 *
 * So these assert the two things that must both hold: every new connection is set, and the checked-out
 * connection the transaction scope uses is set too.
 */
import { describe, expect, it, vi } from "vitest";

import { searchPathFor } from "../pool.js";

describe("searchPathFor", () => {
  it("keeps public after the named schema", () => {
    /**
     * Not the schema alone. Two things resolve through `public`: the `vector` type is pinned there so it
     * is visible from any schema (see the note in `migrations.ts`), and ShareFlow's adapters qualify all
     * of their queries as `public.`. A bare `SET search_path TO retinue` makes the first fail with
     * `type "vector" does not exist` on a machine where the extension is installed and working.
     */
    expect(searchPathFor("retinue")).toBe("retinue,public");
  });

  it("puts no space after the comma, because libpq would read one as another option", () => {
    /**
     * The assertion a real database earned. This string becomes `-c search_path=…`, and in libpq's
     * option syntax a space separates options -- so `retinue, public` arrives as `search_path` =
     * `retinue,` plus a stray `public`, and Postgres refuses the connection outright:
     * `invalid value for parameter "search_path": "retinue,"`. Every test here passed with the spaced
     * version; `migrate` against a real server did not.
     */
    expect(searchPathFor("retinue")).not.toMatch(/,\s/);
  });

  it("is undefined when no schema is configured, rather than a guess", () => {
    // `undefined` means "leave the connection's own path alone". Defaulting to `public, public` or to a
    // named schema would change where an existing deployment's tables are, which is not a default's
    // decision to make.
    expect(searchPathFor(undefined)).toBeUndefined();
    expect(searchPathFor("")).toBeUndefined();
  });
});

describe("openPostgres", () => {
  /**
   * `pg` and the adapters entry are both dynamic imports inside `openPostgres`, so they are mocked by
   * specifier here. The `Pool` double records what the factory did to it, which is the only way to see
   * a `connect` listener that a real pool would only reveal under load.
   */
  const load = async (
    settings: { databaseUrl: string; databaseSchema?: string; connectionTimeoutMillis?: number },
    /**
     * What the database reports for `show search_path`.
     *
     * Defaults to what the settings ask for, so a test that is not about the assertion does not have
     * to restate it. A test that *is* about it passes something else.
     */
    reportedSearchPath?: string,
  ) => {
    const queries: string[] = [];
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const client = {
      query: vi.fn((text: string) => {
        queries.push(text);
        return Promise.resolve({ rows: [] });
      }),
      end: vi.fn(),
    };
    const pool = {
      options: settings,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(listener);
      },
      emit: vi.fn(),
      query: vi.fn((text: string) => {
        queries.push(text);
        if (/show search_path/i.test(text)) {
          const path =
            reportedSearchPath ??
            (settings.databaseSchema === undefined ? '"$user", public' : `${settings.databaseSchema}, public`);
          return Promise.resolve({ rows: [{ search_path: path }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      connect: vi.fn(() => Promise.resolve(client)),
      end: vi.fn(() => Promise.resolve()),
    };
    let constructedWith: Record<string, unknown> | undefined;
    let openerSearchPath: unknown = "never called";
    vi.doMock("../../entries/adapters-postgres.js", () => ({
      createPgExecutor: () => ({ query: pool.query }),
      createPoolOpener: (_pool: unknown, searchPath: unknown) => {
        openerSearchPath = searchPath;
        return async () => undefined;
      },
    }));
    vi.doMock("pg", () => ({
      Pool: class {
        constructor(config: Record<string, unknown>) {
          constructedWith = config;
          return pool as never;
        }
      },
    }));
    vi.resetModules();
    const { openPostgres } = await import("../pool.js");
    const connection = await openPostgres(settings);
    return {
      connection,
      pool,
      client,
      queries,
      listeners,
      constructedWith: () => constructedWith,
      openerSearchPath: () => openerSearchPath,
    };
  };

  it("sets the search path as a startup parameter, so it is applied before any statement", async () => {
    /**
     * The heart of it, and why it is a *startup parameter* rather than a `SET`.
     *
     * `createPgExecutor` calls `pool.query`, which checks out whichever connection is free and hands
     * back one carrying whatever `search_path` its previous borrower left. So setting it once at
     * startup governs the first statements and nothing after them -- migration 1 in `retinue`,
     * migration 20 in `public`, both reporting success.
     *
     * The first version did it per connection with `pool.on("connect", (c) => c.query("SET …"))`,
     * node-postgres's documented idiom. That works and pg deprecated it: *"Calling client.query() when
     * the client is already executing a query is deprecated and will be removed in pg@9.0"*, printed
     * on every boot. `options` needs no query, so the ordering question does not arise.
     */
    const { constructedWith, listeners } = await load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" });
    expect(constructedWith()?.["options"]).toBe("-c search_path=retinue,public");
    // And no `connect` listener: the deprecated mechanism is gone, not merely supplemented.
    expect(listeners["connect"]).toBeUndefined();
  });

  it("refuses to start when the reported search path is not the one asked for", async () => {
    /**
     * Because `options` is the kind of mechanism that fails silently. A pooler that dropped it --
     * PgBouncer rejects unknown startup parameters by default, and a managed pooler can change
     * behaviour under you -- would leave every connection on the default path and every table this
     * process creates in the wrong schema, with no error and no log line.
     *
     * One round-trip at startup turns that into a refusal.
     */
    const { load: loadWith } = { load };
    const rejected = loadWith({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" }, "public");
    await expect(rejected).rejects.toThrow(/were not applied/);
  });

  it("accepts a path that differs only in spacing, since Postgres echoes its own formatting", async () => {
    // `retinue, public` and `retinue,public` are the same path. Comparing strings would refuse a
    // correctly configured database, which is the false alarm that gets a check deleted.
    await expect(
      load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" }, "retinue,public"),
    ).resolves.toBeDefined();
    await expect(
      load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" }, '"retinue", public'),
    ).resolves.toBeDefined();
  });

  it("refuses a path with the right schemas in the wrong order", async () => {
    // Order is the whole meaning of a search path: `public, retinue` creates in `public`.
    await expect(
      load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" }, "public, retinue"),
    ).rejects.toThrow(/were not applied/);
  });

  it("also sets it on the checked-out connection the transaction scope uses", async () => {
    /**
     * The second of the two paths, and not redundant with the first. `createPoolOpener` is what holds a
     * single connection across `SELECT ... FOR UPDATE` and its follow-up statements -- the publish-once
     * path -- and it must not depend on an event listener having fired on that particular connection.
     * Dropping this argument changed nothing that any other assertion here could see.
     */
    const { openerSearchPath } = await load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" });
    expect(openerSearchPath()).toBe("retinue,public");
  });

  it("adds no listener and no search path when none is configured", async () => {
    const { listeners, openerSearchPath } = await load({ databaseUrl: "postgres://x/y" });
    expect(listeners["connect"]).toBeUndefined();
    expect(openerSearchPath()).toBeUndefined();
  });

  it("passes a connect timeout only when asked for one", async () => {
    // The default is *no* timeout, which is why `doctor` asks for one and the host does not: a short
    // timeout on the host would turn a slow failover into a boot failure.
    const withTimeout = await load({ databaseUrl: "postgres://x/y", connectionTimeoutMillis: 5_000 });
    expect(withTimeout.constructedWith()?.["connectionTimeoutMillis"]).toBe(5_000);
    const without = await load({ databaseUrl: "postgres://x/y" });
    expect(without.constructedWith()).not.toHaveProperty("connectionTimeoutMillis");
  });
});
