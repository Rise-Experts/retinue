/**
 * Deployment configuration (#110).
 *
 * Lives here rather than in `@agentkit/backend`, and that is deliberate: the library reads
 * `process.env` **zero times**, so a host can configure it however it likes — from a file, a secret
 * manager, a test fixture. A library that reads the environment cannot be configured by its host, and
 * that property erodes one convenient `process.env.DATABASE_URL` at a time, so there is a test for it.
 *
 * `loadConfig` takes the environment as an argument for the same reason. It makes "fails with a
 * message naming the problem" testable without mutating global state, and it means a caller can load
 * configuration from somewhere that is not `process.env` at all.
 */
import type { SchemaMode } from "@agentkit/backend/adapters/postgres";

export type AgentkitConfig = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** How the schema is provisioned at boot. `off` in production, so managed migrations stay in control. */
  readonly schemaMode: SchemaMode;
  readonly port: number;
  readonly workerConcurrency: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
};

/** Thrown when configuration is unusable. Carries the variable names so the message is actionable. */
export class ConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly string[], variables: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigurationError";
    this.variables = variables;
  }
}

const SCHEMA_MODES: readonly SchemaMode[] = ["auto", "plan", "off"];
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export const DEFAULT_CONFIG = {
  schemaMode: "off" as SchemaMode,
  port: 4000,
  workerConcurrency: 4,
  logLevel: "info" as const,
};

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Validate the whole environment and report **every** problem at once.
 *
 * Deliberately not fail-on-first: a deployment with three missing variables should learn all three
 * from one boot, not discover them across three deploys. That is what "fail fast with a precise
 * message" is actually worth.
 */
export const loadConfig = (env: Env): AgentkitConfig => {
  const problems: string[] = [];
  const variables: string[] = [];

  const fail = (variable: string, problem: string) => {
    problems.push(`${variable}: ${problem}`);
    variables.push(variable);
  };

  const required = (variable: string): string => {
    const value = env[variable];
    if (value === undefined || value.trim() === "") {
      // Named, because "invalid configuration" without the name means reading the source to deploy.
      fail(variable, "is required but was not set");
      return "";
    }
    return value;
  };

  const databaseUrl = required("AGENTKIT_DATABASE_URL");
  if (databaseUrl !== "" && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    fail("AGENTKIT_DATABASE_URL", `must be a postgres:// URL, got "${databaseUrl.slice(0, 12)}…"`);
  }

  const redisUrl = required("AGENTKIT_REDIS_URL");
  if (redisUrl !== "" && !/^rediss?:\/\//.test(redisUrl)) {
    fail("AGENTKIT_REDIS_URL", `must be a redis:// URL, got "${redisUrl.slice(0, 12)}…"`);
  }

  const rawSchemaMode = env["AGENTKIT_SCHEMA_MODE"] ?? DEFAULT_CONFIG.schemaMode;
  if (!SCHEMA_MODES.includes(rawSchemaMode as SchemaMode)) {
    fail("AGENTKIT_SCHEMA_MODE", `must be one of ${SCHEMA_MODES.join(", ")}, got "${rawSchemaMode}"`);
  }

  const positiveInt = (variable: string, fallback: number): number => {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      // A zero concurrency is the interesting case: it boots a worker that consumes nothing and looks
      // healthy, which is worse than refusing to start.
      fail(variable, `must be a positive integer, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const port = positiveInt("PORT", DEFAULT_CONFIG.port);
  const workerConcurrency = positiveInt("AGENTKIT_WORKER_CONCURRENCY", DEFAULT_CONFIG.workerConcurrency);

  const rawLogLevel = env["AGENTKIT_LOG_LEVEL"] ?? DEFAULT_CONFIG.logLevel;
  if (!LOG_LEVELS.includes(rawLogLevel as (typeof LOG_LEVELS)[number])) {
    fail("AGENTKIT_LOG_LEVEL", `must be one of ${LOG_LEVELS.join(", ")}, got "${rawLogLevel}"`);
  }

  if (problems.length > 0) throw new ConfigurationError(problems, variables);

  return {
    databaseUrl,
    redisUrl,
    schemaMode: rawSchemaMode as SchemaMode,
    port,
    workerConcurrency,
    logLevel: rawLogLevel as AgentkitConfig["logLevel"],
  };
};

/** The variables a deployment must set, for the README and for error messages to stay in step. */
export const REQUIRED_VARIABLES = ["AGENTKIT_DATABASE_URL", "AGENTKIT_REDIS_URL"] as const;
export const OPTIONAL_VARIABLES = [
  "AGENTKIT_SCHEMA_MODE",
  "AGENTKIT_WORKER_CONCURRENCY",
  "AGENTKIT_LOG_LEVEL",
  "PORT",
] as const;
