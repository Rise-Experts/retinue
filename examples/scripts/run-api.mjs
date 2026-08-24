#!/usr/bin/env node
/**
 * Start the API host against the example app module — #155, AC-1.
 *
 * A three-line wrapper. `runApiHost` does the work; this exists because `AGENTKIT_APP_MODULE` must be an absolute
 * specifier the server can `import()`, and asking a person to compute one by hand is how a documented command
 * becomes wrong. Also because the schema lives in a dedicated schema, which the connection string has to carry —
 * `boot` builds its pool from `databaseUrl` alone and cannot know about it.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SCHEMA = process.env.AGENTKIT_EXAMPLE_SCHEMA ?? "agentkit_example";

// The search_path, encoded in the URL, because that is the only channel `boot` gives us. Verified by the
// migrate script, which asserts the option actually took effect.
if (process.env.AGENTKIT_DATABASE_URL && !process.env.AGENTKIT_DATABASE_URL.includes("search_path")) {
  const url = new URL(process.env.AGENTKIT_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  process.env.AGENTKIT_DATABASE_URL = url.toString();
}
process.env.AGENTKIT_APP_MODULE = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href;

const { runApiHost } = await import("@agentkit/server");
const { port } = await runApiHost();

const endpoint = process.env.AGENTKIT_MODEL_BASE_URL ?? "https://api.openai.com/v1";
console.log(`
  agentkit example — API host
    graphql   http://localhost:${port}/graphql
    page      http://localhost:${port}/
    schema    ${SCHEMA}
    model     ${process.env.AGENTKIT_MODEL_ID ?? "gpt-4o-mini"} at ${endpoint}

  Send these headers (the dev authenticator reads them — this is not authentication):
    x-agentkit-tenant: demo
    x-agentkit-principal: you
    x-agentkit-roles: editor

  Start the worker in a second terminal, or nothing will execute:
    npm run worker -w @agentkit/example-app
`);
