/**
 * Deployment configuration, provisioning and probes (#110).
 *
 * Two things get more care than the rest:
 *
 * - **`/healthz` must succeed while the database is down.** An orchestrator that restarts a process
 *   because a *dependency* is unavailable turns a brief blip into a restart storm, and the replacement
 *   process is no more able to reach the database than the one it killed.
 * - **The library must read `process.env` zero times.** That is what lets a host configure it from a
 *   file, a secret manager or a test fixture — and it erodes one convenient `process.env` at a time,
 *   so it is asserted rather than left as a convention.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createSchemaManager, MIGRATIONS, type SqlExecutor } from "@agentkit/backend/adapters/postgres";
import { ConfigurationError, DEFAULT_CONFIG, loadConfig, REQUIRED_VARIABLES } from "../config.js";
import { boot } from "../boot.js";
import { createHealthRoutes, postgresProbe, redisProbe, schemaProbe, type Probe } from "../health.js";

const validEnv = {
  AGENTKIT_DATABASE_URL: "postgres://user:pw@localhost:5432/agentkit",
  AGENTKIT_REDIS_URL: "redis://localhost:6379",
};

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/** AC-1. */
describe("configuration", () => {
  it("accepts a valid environment and applies documented defaults", () => {
    const config = loadConfig(validEnv);
    // `off` in production, so managed migrations stay in control. A default of `auto` would mean any
    // pod could migrate the database by starting.
    expect(config.schemaMode).toBe("off");
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.workerConcurrency).toBe(DEFAULT_CONFIG.workerConcurrency);
  });

  it("names every missing variable, not just the first", () => {
    const error = (() => {
      try {
        loadConfig({});
        return null;
      } catch (e) {
        return e as ConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    // Reporting all of them matters: a deployment with three missing variables should learn all three
    // from one boot rather than discovering them across three deploys.
    expect(error?.variables).toEqual([...REQUIRED_VARIABLES]);
    for (const variable of REQUIRED_VARIABLES) {
      expect(error?.message).toContain(variable);
    }
  });

  it("rejects a malformed URL by naming the variable and what was wrong", () => {
    for (const [variable, value] of [
      ["AGENTKIT_DATABASE_URL", "mysql://nope"],
      ["AGENTKIT_REDIS_URL", "http://nope"],
    ] as const) {
      const error = (() => {
        try {
          loadConfig({ ...validEnv, [variable]: value });
          return null;
        } catch (e) {
          return e as ConfigurationError;
        }
      })();
      expect(error?.variables).toContain(variable);
      // "Invalid configuration" without the name means reading the source in order to deploy.
      expect(error?.message).toMatch(new RegExp(`${variable}: must be a`));
    }
  });

  it("rejects a non-positive concurrency rather than booting a worker that consumes nothing", () => {
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(() => loadConfig({ ...validEnv, AGENTKIT_WORKER_CONCURRENCY: value })).toThrow(
        ConfigurationError,
      );
    }
    // A zero concurrency is the interesting case: the process boots, passes its own health check, and
    // consumes no work — which is worse than refusing to start.
    expect(() => loadConfig({ ...validEnv, AGENTKIT_WORKER_CONCURRENCY: "8" })).not.toThrow();
  });

  it("validates the schema mode against the library's union", () => {
    for (const mode of ["auto", "plan", "off"]) {
      expect(loadConfig({ ...validEnv, AGENTKIT_SCHEMA_MODE: mode }).schemaMode).toBe(mode);
    }
    expect(() => loadConfig({ ...validEnv, AGENTKIT_SCHEMA_MODE: "migrate" })).toThrow(/must be one of/);
  });

  it("takes the environment as an argument, so nothing global is read", () => {
    // The property that makes AC-1 testable at all — and that lets a host load configuration from
    // somewhere that is not `process.env`.
    const config = loadConfig({ ...validEnv, PORT: "9999" });
    expect(config.port).toBe(9999);
    expect(process.env["AGENTKIT_DATABASE_URL"]).toBeUndefined();
  });
});

/** AC-2. */
describe("startup provisioning", () => {
  const bootAgainst = async (sql: SqlExecutor, mode: string) => {
    const logs: Record<string, unknown>[] = [];
    const result = await boot({
      env: { ...validEnv, AGENTKIT_SCHEMA_MODE: mode },
      connect: async () => ({ sql }),
      log: (entry) => logs.push(entry),
      version: "test",
    });
    return { result, logs };
  };

  it("provisions an empty database in auto mode, and a second boot changes nothing", async () => {
    const sql = pglite(new PGlite());

    const first = await bootAgainst(sql, "auto");
    expect(first.result.schema.applied).toHaveLength(MIGRATIONS.length);

    // Idempotence is what makes `auto` survivable with more than one pod: `apply()` records what it
    // ran, so a second boot has nothing to do.
    const second = await bootAgainst(sql, "auto");
    expect(second.result.schema.applied).toEqual([]);

    const tables = await sql.query<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(Number(tables[0]?.count)).toBeGreaterThan(MIGRATIONS.length);
  }, 60_000);

  it("applies nothing in off mode, which is the production default", async () => {
    const sql = pglite(new PGlite());
    const { result } = await bootAgainst(sql, "off");
    expect(result.schema.applied).toEqual([]);
    // The schema is untouched, so a managed migration tool remains the only thing that changes it.
    await expect(sql.query("SELECT 1 FROM conversations LIMIT 1")).rejects.toThrow();
  }, 30_000);

  it("logs the plan without applying it in plan mode", async () => {
    const sql = pglite(new PGlite());
    const { result, logs } = await bootAgainst(sql, "plan");
    expect(result.schema.applied).toEqual([]);
    expect(logs.some((entry) => entry["event"] === "schema")).toBe(true);
    const startup = logs.find((entry) => entry["event"] === "startup");
    // The diff is machine-readable in the same stream as everything else, rather than printed.
    expect((startup?.["schemaPlanned"] as string[]).length).toBe(MIGRATIONS.length);
  }, 30_000);

  it("validates configuration before opening any connection", async () => {
    let connected = false;
    await expect(
      boot({
        env: {},
        connect: async () => {
          connected = true;
          return { sql: pglite(new PGlite()) };
        },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    // Otherwise a misconfigured deployment fails with a connection error that names nothing useful.
    expect(connected).toBe(false);
  });

  it("logs the adapters and concurrency actually selected", async () => {
    const sql = pglite(new PGlite());
    const { logs } = await bootAgainst(sql, "off");
    const startup = logs.find((entry) => entry["event"] === "startup");
    // So a support question does not begin with "which database are you using?".
    expect(startup?.["adapters"]).toEqual({ store: "postgres", queue: "bullmq", lock: "redis" });
    expect(startup?.["workerConcurrency"]).toBe(DEFAULT_CONFIG.workerConcurrency);
    expect(startup?.["version"]).toBe("test");
  }, 30_000);
});

/** AC-3 and AC-4 — the distinction, which is the whole point. */
describe("health and readiness", () => {
  const failing = (name: string, message = "down"): Probe => ({
    name,
    check: () => {
      throw new Error(message);
    },
  });
  const passing = (name: string): Probe => ({ name, check: () => undefined });

  const get = (routes: ReturnType<typeof createHealthRoutes>, path: string) =>
    routes.handle(new Request(`http://localhost${path}`));

  it("reports healthy while a dependency is down", async () => {
    const routes = createHealthRoutes({ probes: [failing("postgres")], version: "test" });
    const health = await get(routes, "/healthz");
    // The distinction that matters. Restarting a process because the database is unreachable turns a
    // blip into a restart storm, and the replacement is no better placed to reach it.
    expect(health?.status).toBe(200);
    expect(await health?.json()).toMatchObject({ status: "ok", version: "test" });

    const ready = await get(routes, "/readyz");
    expect(ready?.status).toBe(503);
  });

  it("returns 503 and names every failing probe", async () => {
    const routes = createHealthRoutes({
      probes: [failing("postgres", "connection refused"), failing("redis", "timeout"), passing("schema")],
    });
    const response = await get(routes, "/readyz");
    // 503, not a 200 carrying a flag: a load balancer keys off the status code.
    expect(response?.status).toBe(503);
    const body = (await response?.json()) as { status: string; probes: { name: string; ok: boolean; error?: string }[] };
    expect(body.status).toBe("not-ready");
    // All of them, so an operator is not sent round the loop once per broken dependency.
    expect(body.probes.filter((p) => !p.ok).map((p) => p.name)).toEqual(["postgres", "redis"]);
    expect(body.probes.find((p) => p.name === "postgres")?.error).toContain("connection refused");
  });

  it("returns 200 once every probe passes", async () => {
    const routes = createHealthRoutes({ probes: [passing("postgres"), passing("redis")] });
    const response = await get(routes, "/readyz");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "ready" });
  });

  it("returns null for a path it does not own, so a host can compose it", async () => {
    const routes = createHealthRoutes({ probes: [] });
    expect(await routes.handle(new Request("http://localhost/graphql"))).toBeNull();
  });

  it("distinguishes an unreachable database from a schema that is behind", async () => {
    const db = new PGlite();
    const sql = pglite(db);
    const manager = createSchemaManager(sql);

    // Reachable, but nothing applied: the Postgres probe passes and the schema probe fails. A single
    // combined probe would report this identically to a connection failure, and the operator response
    // is completely different.
    const routes = createHealthRoutes({ probes: [postgresProbe(sql), schemaProbe(manager)] });
    const notReady = (await (await get(routes, "/readyz"))?.json()) as {
      probes: { name: string; ok: boolean; error?: string }[];
    };
    expect(notReady.probes.find((p) => p.name === "postgres")?.ok).toBe(true);
    expect(notReady.probes.find((p) => p.name === "schema")?.ok).toBe(false);
    expect(notReady.probes.find((p) => p.name === "schema")?.error).toMatch(/schema at version 0, expected/);

    await manager.apply();
    const ready = await get(routes, "/readyz");
    expect(ready?.status).toBe(200);
  }, 60_000);

  it("treats a wrong PING reply as unhealthy, not merely a reachable Redis", async () => {
    const routes = createHealthRoutes({
      probes: [redisProbe({ ping: async () => "WAT" })],
    });
    expect((await get(routes, "/readyz"))?.status).toBe(503);
    const ok = createHealthRoutes({ probes: [redisProbe({ ping: async () => "PONG" })] });
    expect((await get(ok, "/readyz"))?.status).toBe(200);
  });
});

/** The invariant that makes all of the above possible. */
describe("the library reads no environment", () => {
  it("contains no process.env access outside its tests", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const root = new URL("../../../backend/src/", import.meta.url);

    const offenders: string[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "testing") continue;
          await walk(child);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const source = await readFile(child, "utf8");
          if (source.includes("process.env")) offenders.push(entry.name);
        }
      }
    };
    await walk(root);

    // A library that reads the environment cannot be configured by its host — from a file, a secret
    // manager, or a test fixture. The erosion is gradual and each step looks reasonable, which is why
    // this is a test rather than a convention.
    expect(offenders, `these read process.env: ${offenders.join(", ")}`).toEqual([]);
  });
});

/** AC-5. The documented commands have to actually start something, and fail usefully when they cannot. */
describe("runnable commands", () => {
  it("reports configuration problems before looking for the app module", async () => {
    const { runApiHost } = await import("../cli.js");
    const error = await runApiHost({}).then(
      () => null,
      (e: unknown) => e,
    );
    // Ordering matters: a deployment that removed AGENTKIT_DATABASE_URL must be told about *that*, not
    // about AGENTKIT_APP_MODULE. An earlier version loaded the app module first and reported the wrong
    // variable.
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain("AGENTKIT_DATABASE_URL");
  });

  it("refuses to start without an app module, and says why there is no default", async () => {
    const { runApiHost, APP_MODULE_VARIABLE } = await import("../cli.js");
    const error = await runApiHost(validEnv).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain(APP_MODULE_VARIABLE);
    // The reason is in the message on purpose: an authentication fallback would serve an open API to
    // anyone who forgot to set this, which is worse than refusing to boot.
    expect((error as Error).message).toMatch(/no default/i);
  });

  it("requires an engine for the worker command specifically", async () => {
    const { runWorker } = await import("../cli-worker.js");
    const error = await runWorker(validEnv).then(
      () => null,
      (e: unknown) => e,
    );
    // A worker without an engine would consume jobs it cannot execute — jobs that then look processed.
    expect((error as Error).message).toContain("engine");
  });

  it("has both documented entrypoints present in the build output", async () => {
    const { access } = await import("node:fs/promises");
    for (const file of ["../../dist/cli.js", "../../dist/cli-worker.js"]) {
      // The README names these commands; if the files are not built, the documentation is fiction.
      await expect(access(new URL(file, import.meta.url))).resolves.toBeUndefined();
    }
  });
});
