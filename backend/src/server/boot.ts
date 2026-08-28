/**
 * Boot sequence (#110): load configuration, provision the schema per mode, log what happened.
 *
 * Separate from `main.ts` so the ordering is testable without binding a port. The ordering is the
 * substance: configuration is validated *before* anything connects, so a misconfigured deployment
 * fails with a message about the variable rather than a connection error that names nothing useful.
 */
import {
  provisionSchema,
  type ConnectionOpener,
  type SchemaMode,
  type SqlExecutor,
} from "../entries/adapters-postgres.js";
import { createTransactionScope, type TransactionRunner } from "../adapters/postgres/transaction.js";
import { loadConfig, type RetinueConfig, type Env } from "./config.js";

export type StartupLog = {
  readonly event: string;
  readonly [key: string]: unknown;
};

export type BootOptions = {
  readonly env: Env;
  /**
   * Built after configuration validates, so a bad variable never opens a connection.
   *
   * `open` is optional and is what a `TransactionRunner` needs — the one primitive a pool-backed `SqlExecutor`
   * cannot express, because `pool.query` picks a different connection per call. A caller that supplies it gets a
   * runner in the result; one that does not gets `undefined`, and anything needing a transaction refuses by name.
   */
  readonly connect: (
    config: RetinueConfig,
  ) => Promise<{ readonly sql: SqlExecutor; readonly open?: ConnectionOpener }>;
  readonly log?: (entry: StartupLog) => void;
  readonly version?: string;
};

export type BootResult = {
  readonly config: RetinueConfig;
  /**
   * The executor an application should build its stores over.
   *
   * **Scoped when a runner exists**, so a store built on it joins the ambient transaction without knowing
   * transactions exist. Handing back the unscoped executor alongside a runner is the trap
   * `transaction.ts` warns about: "a store built over a *non*-scoped executor silently escapes the
   * transaction rather than failing".
   */
  readonly sql: SqlExecutor;
  /** Present when `connect` supplied an `open`. `undefined` for a process that needs no transactions. */
  readonly runner?: TransactionRunner;
  readonly schema: { readonly mode: SchemaMode; readonly applied: readonly string[] };
};

export const boot = async (options: BootOptions): Promise<BootResult> => {
  const log = options.log ?? ((entry: StartupLog) => console.log(JSON.stringify(entry)));

  // Configuration first, and it throws. A half-configured process that boots is worse than one that
  // refuses: it passes its own health check and fails on the first real request.
  const config = loadConfig(options.env);

  const { sql: base, open } = await options.connect(config);
  /**
   * The transaction scope, when the caller can open a connection — found by #254.
   *
   * `runApiHost` never built one, so `app.deps({ config, sql })` was called without a runner and the reference
   * app's coordinator refused: *"this process has no TransactionRunner, so the conversation run coordinator
   * cannot be used. The API host supplies one"*. It did not. `sendMessage` — the mutation that starts every run
   * — therefore failed with an internal error in the shipped API host and in `npm run api`, which is the
   * documented way to run the reference app.
   */
  const scope = open === undefined ? undefined : createTransactionScope(open);
  const sql = scope === undefined ? base : scope.scoped(base);

  const provisioned = await provisionSchema(sql, {
    mode: config.schemaMode,
    // Routed through the structured log rather than printed, so `plan` mode's diff is machine-readable
    // in the same stream as everything else.
    log: (message) => log({ event: "schema", mode: config.schemaMode, message }),
  });

  log({
    event: "startup",
    ...(options.version === undefined ? {} : { version: options.version }),
    schemaMode: config.schemaMode,
    schemaApplied: provisioned.applied,
    schemaPlanned: provisioned.planned.map((change) => change.id),
    port: config.port,
    workerConcurrency: config.workerConcurrency,
    logLevel: config.logLevel,
    // The adapters actually selected, so a support question does not start with "which database?".
    adapters: { store: "postgres", queue: "bullmq", lock: "redis" },
  });

  return {
    config,
    sql,
    ...(scope === undefined ? {} : { runner: scope.runner }),
    schema: { mode: config.schemaMode, applied: provisioned.applied },
  };
};
