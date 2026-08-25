/**
 * Boot sequence (#110): load configuration, provision the schema per mode, log what happened.
 *
 * Separate from `main.ts` so the ordering is testable without binding a port. The ordering is the
 * substance: configuration is validated *before* anything connects, so a misconfigured deployment
 * fails with a message about the variable rather than a connection error that names nothing useful.
 */
import { provisionSchema, type SchemaMode, type SqlExecutor } from "@agentkit/backend/adapters/postgres";
import { loadConfig, type AgentkitConfig, type Env } from "./config.js";

export type StartupLog = {
  readonly event: string;
  readonly [key: string]: unknown;
};

export type BootOptions = {
  readonly env: Env;
  /** Built after configuration validates, so a bad variable never opens a connection. */
  readonly connect: (config: AgentkitConfig) => Promise<{ readonly sql: SqlExecutor }>;
  readonly log?: (entry: StartupLog) => void;
  readonly version?: string;
};

export type BootResult = {
  readonly config: AgentkitConfig;
  readonly sql: SqlExecutor;
  readonly schema: { readonly mode: SchemaMode; readonly applied: readonly string[] };
};

export const boot = async (options: BootOptions): Promise<BootResult> => {
  const log = options.log ?? ((entry: StartupLog) => console.log(JSON.stringify(entry)));

  // Configuration first, and it throws. A half-configured process that boots is worse than one that
  // refuses: it passes its own health check and fails on the first real request.
  const config = loadConfig(options.env);

  const { sql } = await options.connect(config);

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

  return { config, sql, schema: { mode: config.schemaMode, applied: provisioned.applied } };
};
