#!/usr/bin/env node
/**
 * The MCP server, driven by a **real MCP client** — task #250 AC-8.
 *
 *   npm run mcp:verify        (from examples/)
 *
 * The SDK's own `Client` over stdio, which is the same client implementation Claude Code and Cursor use. A
 * committed script rather than a one-off, because the acceptance criterion is "verified against a real MCP
 * client, not only a protocol test" and that is only true for as long as somebody can repeat it.
 *
 * It found two real bugs on its first run, neither of which a fake would have:
 *
 * 1. A refusal that **threw** (an unauthorized tool) became JSON-RPC `-32603`, so a client asking for a tool it
 *    may not have was told the server was broken rather than that it was refused.
 * 2. One tool whose descriptor held a Zod schema made `tools/list` fail validation *entirely* — the client
 *    rejects `inputSchema.type !== "object"`, so a single non-conforming entry meant **no tools at all**.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const withTimeout = (label, p, ms = 15000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref())]);

const script = resolve(import.meta.dirname, "mcp-server.mjs");
console.log("spawning", script);
const client = new Client({ name: "verification", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe" });
try {
  await withTimeout("connect", client.connect(transport));
  console.log("connected");
  const { tools } = await withTimeout("listTools", client.listTools());
  console.log(`tools/list → ${tools.length} tools`);
  for (const t of tools.slice(0, 8)) {
    const a = t.annotations ?? {};
    console.log(`  ${t.name.padEnd(22)} readOnly=${a.readOnlyHint} destructive=${a.destructiveHint} openWorld=${a.openWorldHint}`);
  }
  const readOnly = tools.find((t) => t.annotations?.readOnlyHint);
  const gated = tools.find((t) => t.annotations?.openWorldHint || t.annotations?.destructiveHint);
  if (readOnly) {
    const r = await withTimeout("call read", client.callTool({ name: readOnly.name, arguments: {} }));
    console.log(`\ncall ${readOnly.name} → isError=${r.isError ?? false}: ${String(r.content?.[0]?.text ?? "").slice(0,100)}`);
  }
  if (gated) {
    const r = await withTimeout("call gated", client.callTool({ name: gated.name, arguments: {} }));
    console.log(`call ${gated.name} (gated) → isError=${r.isError ?? false}: ${String(r.content?.[0]?.text ?? "").slice(0,120)}`);
  }
  const u = await withTimeout("call unknown", client.callTool({ name: "definitely_not_a_tool", arguments: {} }));
  console.log(`call unknown → isError=${u.isError ?? false}: ${String(u.content?.[0]?.text ?? "").slice(0,80)}`);
} catch (e) {
  console.error("FAILED:", e.message);
  const errStream = transport.stderr;
  if (errStream) { let s=""; errStream.on("data", d=>s+=d); await new Promise(r=>setTimeout(r,500)); console.error("server stderr:", s.slice(0,1200) || "(none)"); }
} finally {
  await client.close().catch(()=>{});
  process.exit(0);
}
