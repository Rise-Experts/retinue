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
    expect(searchPathFor("retinue")).toBe("retinue, public");
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
      query: vi.fn(() => Promise.resolve({ rows: [] })),
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

  it("sets the search path on every new connection, not once at startup", async () => {
    /**
     * The heart of it. `createPgExecutor` calls `pool.query`, which checks out whichever connection is
     * free and hands back one carrying whatever `search_path` its previous borrower left. A single `SET`
     * at startup therefore governs the first statements and nothing after them -- so migration 1 lands
     * in `retinue` and migration 20 lands in `public`, and both report success.
     */
    const { listeners, client, queries } = await load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" });
    expect(listeners["connect"]).toHaveLength(1);
    listeners["connect"]?.[0]?.(client);
    await Promise.resolve();
    expect(queries).toEqual(["SET search_path TO retinue, public"]);
  });

  it("destroys a connection whose search path could not be set", async () => {
    /**
     * The alternative is a connection silently reading the wrong schema for the rest of its life, which
     * is the outcome this whole file exists to prevent. A failure here means the schema is missing or
     * the role cannot use it -- both worth failing the borrower's query over.
     */
    const { listeners, client } = await load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" });
    client.query.mockReturnValueOnce(Promise.reject(new Error("permission denied for schema retinue")) as never);
    listeners["connect"]?.[0]?.(client);
    await new Promise((done) => setTimeout(done, 0));
    expect(client.end).toHaveBeenCalled();
  });

  it("also sets it on the checked-out connection the transaction scope uses", async () => {
    /**
     * The second of the two paths, and not redundant with the first. `createPoolOpener` is what holds a
     * single connection across `SELECT ... FOR UPDATE` and its follow-up statements -- the publish-once
     * path -- and it must not depend on an event listener having fired on that particular connection.
     * Dropping this argument changed nothing that any other assertion here could see.
     */
    const { openerSearchPath } = await load({ databaseUrl: "postgres://x/y", databaseSchema: "retinue" });
    expect(openerSearchPath()).toBe("retinue, public");
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
