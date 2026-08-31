#!/usr/bin/env node
/**
 * `retinue` — the executable, task #252.
 *
 * `cli.ts` and `cli-worker.ts` have been here since #110 and the package had **no `bin`**, so a consumer had to
 * write an entrypoint before anything ran. Applying the schema was the sharpest case:
 * `adapters/postgres/migrations.ts` is a module, so provisioning a database meant writing a program first.
 *
 * ## What this does and does not invent
 *
 * It does not invent a deployment's wiring. `serve` and `worker` load `RETINUE_APP_MODULE` exactly as they did,
 * and refuse to start without it — a permissive default would serve an open API to anyone who forgot to set it,
 * which is the rule `cli.ts` established and this keeps.
 *
 * `migrate` and `doctor` deliberately need **no** app module: a database is provisioned before an application
 * exists, and a diagnostic that cannot run until everything else is configured is a diagnostic nobody can use.
 */

import { runApiHost } from "./cli.js";
import { runWorker } from "./cli-worker.js";
import { loadConfig } from "./config.js";
import { report, runChecks } from "./doctor.js";

const USAGE = `retinue <command>

  migrate            Apply pending migrations to RETINUE_DATABASE_URL.
    --status         Report applied and pending migrations; change nothing.
    --dry-run        Print the statements that would run; change nothing.
  serve              Start the API host. Needs RETINUE_APP_MODULE.
  worker             Start a run worker. Needs RETINUE_APP_MODULE.
  doctor             Check configuration, database, schema and Redis. Reports every failure.

Configuration comes from the environment; see .env.example.`;

/** Opened lazily and per command, so `doctor` and `migrate` never load a driver they do not use. */
const postgres = async (url: string) => {
  const { Pool } = await import("pg");
  const { createPgExecutor, createPoolOpener } = await import("../entries/adapters-postgres.js");
  // A connect timeout, because the default is *none*: `doctor` against a refused port sat silently instead of
  // reporting the failure it exists to report. Short, since every command here either connects immediately or
  // is misconfigured.
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
  return { sql: createPgExecutor(pool), open: createPoolOpener(pool), end: () => pool.end() };
};

/**
 * The advisory-lock key comes from `schema.ts` — #252's AC-2, and #266's AC-4.
 *
 * It used to be defined here. That made "the CLI and `auto` mode use the same key" a property of two constants
 * happening to be equal, and a copy that drifted would produce two locks, no serialisation, and the original
 * crash returning with the fix apparently in place. Two constants that must be equal are one constant.
 */

const migrate = async (flags: ReadonlySet<string>, env = process.env): Promise<number> => {
  const config = loadConfig(env);
  const { sql, open, end } = await postgres(config.databaseUrl);
  try {
    const { createSchemaManager, MIGRATION_LOCK } = await import("../entries/adapters-postgres.js");

    if (flags.has("--status") || flags.has("--dry-run")) {
      // Read-only paths take no lock. `plan()` and `currentVersion()` are documented as side-effect free — only
      // `apply()` creates the ledger table — which is what makes a dry run honest rather than a dry run that
      // provisions one table. Verified: after `--dry-run` against a fresh database, `public` has 0 tables.
      const manager = createSchemaManager(sql);
      const pending = await manager.plan();
      const current = await manager.currentVersion();
      const target = manager.targetVersion();
      if (flags.has("--status")) {
        console.log(`schema: ${current} of ${target} migrations applied`);
        for (const change of pending) console.log(`  pending ${change.id} (${change.statements.length} statement(s))`);
        if (pending.length === 0) console.log("  nothing pending");
        return 0;
      }
      console.log(`schema: ${current} of ${target} applied; ${pending.length} pending`);
      for (const change of pending) {
        console.log(`\n-- ${change.id}`);
        for (const statement of change.statements) console.log(`${statement};`);
      }
      return 0;
    }

    /**
     * Applied under a session advisory lock, on **one** connection — AC-2.
     *
     * Measured before this existed: two concurrent `retinue migrate` runs against one database left the ledger
     * correct (30 rows, 30 distinct) and **crashed one process** with
     * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` — Postgres's own type
     * catalogue, racing on DDL. The data was safe and the operator experience was not: running migrate from two
     * pods, which is the ordinary Kubernetes init-container pattern, gives one crash loop and an error that
     * names nothing an operator can act on.
     *
     * `createPoolOpener` rather than `createPgExecutor`, because `pool.query` picks a different connection per
     * call — so a `pg_advisory_lock` taken through it would be held by a connection we might never get back, and
     * the unlock would land elsewhere. One checked-out client makes the pair correct, and the lock is released
     * by the session ending if the process dies mid-migration.
     */
    return await open(async (locked) => {
      await locked.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      try {
        const manager = createSchemaManager(locked);
        const pending = await manager.plan();
        const target = manager.targetVersion();
        if (pending.length === 0) {
          console.log(`schema already at ${target}; nothing to apply`);
          return 0;
        }
        await manager.apply();
        console.log(`applied ${pending.length} migration(s); schema now at ${await manager.currentVersion()}`);
        return 0;
      } finally {
        await locked.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      }
    });
  } finally {
    await end();
  }
};

const doctor = async (env = process.env): Promise<number> => {
  const results = await runChecks({
    env,
    connectPostgres: async (url) => {
      const { sql, end } = await postgres(url);
      return { query: (text, params) => sql.query(text, params as never), end };
    },
    connectRedis: async (url) => {
      const { Redis } = await import("ioredis");
      /**
       * Fail fast, on every axis ioredis has one.
       *
       * `maxRetriesPerRequest` alone was not enough: it bounds *command* retries, and a refused **connection**
       * is retried for ever by the default `retryStrategy`. So `doctor` against a closed port hung rather than
       * reporting it. `retryStrategy: () => null` stops reconnecting, `enableOfflineQueue: false` makes a
       * command fail immediately instead of queueing for a connection that will never come, and `connectTimeout`
       * bounds the first attempt.
       */
      const redis = new Redis(url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        // No reconnection: a refused connection must fail, not be retried behind a spinner.
        retryStrategy: () => null,
        /**
         * The offline queue stays **on**, and that is a correction.
         *
         * Turning it off made the check fail against a *working* Redis: `lazyConnect: false` starts connecting
         * but `ping()` is called before the socket is ready, and with no offline queue the command is rejected
         * immediately with "Stream isn't writeable". So the queue is what lets the first command wait for the
         * connection; `retryStrategy` and `connectTimeout` are what stop it waiting for ever, and `withTimeout`
         * is the backstop.
         */
        lazyConnect: false,
      });
      // Otherwise an unreachable Redis emits an unhandled 'error' and takes the process down before the report.
      redis.on("error", () => undefined);
      return {
        ping: () => redis.ping(),
        /**
         * `disconnect()`, not `quit()`, and wrapped so it is always a promise.
         *
         * `quit()` sends a QUIT command, which needs a working connection — so on the failure path it hangs or
         * rejects, which is the path where closing matters most. `disconnect()` drops the socket unilaterally.
         * It returns `void`, and returning that raw produced `Cannot read properties of undefined (reading
         * 'catch')` in the caller's cleanup.
         */
        quit: async () => {
          redis.disconnect();
        },
      };
    },
    schemaVersions: async (sql) => {
      const { createSchemaManager, MIGRATION_LOCK } = await import("../entries/adapters-postgres.js");
      const manager = createSchemaManager(sql as never);
      return { current: await manager.currentVersion(), target: manager.targetVersion() };
    },
  });
  return report(results);
};

export const main = async (argv: readonly string[], env = process.env): Promise<number> => {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  switch (command) {
    case "migrate":
      return migrate(flags, env);
    case "doctor":
      return doctor(env);
    case "serve":
      await runApiHost(env);
      // Resolves once listening; the process stays alive on the server's own handles.
      return 0;
    case "worker":
      await runWorker(env);
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
};

/** Commands that finish and must return the prompt. `serve` and `worker` deliberately do not. */
const ONE_SHOT = new Set(["migrate", "doctor", "help", "--help", "-h"]);

// Only when invoked as the binary, so importing this module for a test starts nothing.
if (process.argv[1] !== undefined && /(^|\/)(retinue|bin\.js)$/.test(process.argv[1])) {
  const command = process.argv[2];
  main(process.argv.slice(2))
    .then((code) => {
      /**
       * A one-shot command **exits**, rather than setting `exitCode` and hoping the loop drains.
       *
       * `doctor` reported correctly and then hung: a driver that has been asked to stop reconnecting can still
       * hold a socket handle, and one lingering handle keeps Node alive for ever. Closing every client is the
       * fix and this is the guarantee — a diagnostic that never returns the prompt is a diagnostic nobody runs
       * twice. `serve` and `worker` are excluded because their whole job is to stay up.
       */
      if (command === undefined || ONE_SHOT.has(command)) process.exit(code);
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
