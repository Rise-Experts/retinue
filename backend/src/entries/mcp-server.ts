/**
 * `@retinue/agentkit/mcp-server` — expose this deployment's tools to MCP clients (#250).
 *
 * Its own subpath, and separate from `./mcp`, because the two are opposite directions: `./mcp` consumes a
 * tenant's MCP servers, and this **is** one. Sharing an entry would put the SDK's server half in the way of
 * every consumer who only wanted the client half.
 */
export * from "../mcp-server/index.js";
