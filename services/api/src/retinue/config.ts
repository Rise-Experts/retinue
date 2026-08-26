/**
 * Configuration — REQ-044 (#201).
 *
 * Read through the platform's own `loadConfig`, not from `process.env` here. Two readers of the same variables
 * is two sets of defaults and two spellings, and the platform's already handles the `RETINUE_*` → `AGENTKIT_*`
 * deprecation path (#192) which this service would otherwise silently lack.
 */

import { loadConfig } from "@retinue/agentkit/server";
import type { RetinueConfig } from "@retinue/agentkit/server";

export type ServiceConfig = RetinueConfig & {
  /**
   * The Postgres schema, folded into the connection string.
   *
   * The platform builds its pool from `databaseUrl` alone and cannot be told about a schema separately, so a
   * deployment whose tables are not in the default schema has to carry it in the URL. Doing that here rather
   * than asking every operator to hand-write an `options=-c search_path=…` parameter.
   */
  readonly schema?: string;
};

export const loadServiceConfig = (env: Readonly<Record<string, string | undefined>> = process.env): ServiceConfig => {
  const base = loadConfig(env);
  const schema = env["RETINUE_SCHEMA"]?.trim();
  if (schema === undefined || schema === "") return base;

  const url = new URL(base.databaseUrl);
  // Only when the caller has not already said. An explicit `options` in the URL is the operator being specific,
  // and overwriting it would be this service quietly disagreeing with them.
  if (!url.searchParams.has("options")) url.searchParams.set("options", `-c search_path=${schema},public`);
  return { ...base, databaseUrl: url.toString(), schema };
};
