#!/usr/bin/env node
/**
 * This deployment's tools, over MCP on stdio — task #250 AC-8.
 *
 *   npm run mcp        (from examples/)
 *
 * A runnable server rather than a snippet, so "verified against a real MCP client" is something anybody can
 * repeat. Add it to Claude Code with:
 *
 *   claude mcp add retinue -- node <abs path>/examples/scripts/mcp-server.mjs
 *
 * ## Identity comes from the environment, because stdio has nowhere else to put it
 *
 * A stdio server is launched *by* the client as a subprocess, so there is no request to authenticate — the
 * process boundary is the session. The host therefore builds the `ExecutionContext` once, from its own
 * configuration, and every call carries it. An HTTP mount authenticates per request instead; the package's
 * surface takes a resolved context either way, so a host that has not authenticated cannot construct a server.
 *
 * In-memory stores here, deliberately: this exists to demonstrate the protocol surface and the gating, and a
 * database would add a setup step to a script whose whole point is that it has none.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerRetinueTools } from "@retinue/agentkit/mcp-server";
import { asId } from "@retinue/agentkit";
import { createMemoryBackend } from "../dist/memory-app.js";
import { exampleRegistry } from "../dist/index.js";
import { asExampleBackend } from "../dist/memory-composition.js";

const tenantId = process.env.RETINUE_MCP_TENANT ?? "mcp-demo";
const principalId = process.env.RETINUE_MCP_PRINCIPAL ?? "mcp-user";

const context = {
  tenantId: asId(tenantId),
  principalId: asId(principalId),
  // The roles decide what `listAuthorized` returns, so this is the whole authorization story for this session.
  roleIds: (process.env.RETINUE_MCP_ROLES ?? "editor").split(",").map((r) => asId(r.trim())),
  locale: "en",
  timezone: "UTC",
  requestId: asId(`mcp-${process.pid}`),
};

const registry = exampleRegistry(asExampleBackend(createMemoryBackend()));

const server = new Server(
  { name: "retinue", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

registerRetinueTools(
  server,
  { listTools: ListToolsRequestSchema, callTool: CallToolRequestSchema },
  { registry, context },
);

await server.connect(new StdioServerTransport());
