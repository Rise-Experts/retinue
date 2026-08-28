---
title: MCP server
---

# Expose this deployment over MCP

`@retinue/agentkit/mcp-server` makes a deployment's tools available to any MCP client — Claude Code, Claude
Desktop, Cursor. It is the **inbound** direction; `@retinue/agentkit/mcp` is the outbound one, where a tenant
registers *their* MCP server and this platform consumes it.

Nothing here re-implements a capability. Every call goes through `registry.execute` exactly as an agent's would,
so authorization, the tenant's toolset, the approval gate, argument validation, idempotency and audit
attribution all apply unchanged.

## Tools

There are no tools of its own. What a client sees is **the authenticated caller's authorized tools**, with MCP
annotations derived from each tool's `ToolEffect` by one function, so the advertisement cannot drift from what is
enforced:

| `ToolEffect` | `readOnlyHint` | `destructiveHint` | `openWorldHint` | Meaning to a client |
|---|---|---|---|---|
| `read` | ✅ | — | — | Safe to call and to repeat |
| `internal-write` | — | — | — | Changes state inside this deployment |
| `external-write` | — | — | ✅ | Reaches something outside this deployment |
| `destructive` | — | ✅ | ✅ | Ask first |

`read` is the only effect that claims `readOnlyHint`, deliberately. Over-claiming read-only is the dangerous
direction, because a client may skip a confirmation on that basis.

## Wire it up

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerRetinueTools } from "@retinue/agentkit/mcp-server";

import type { ExecutionContext } from "@retinue/agentkit";
import type { ToolRegistry } from "@retinue/agentkit/tools";

export const mount = (registry: ToolRegistry, context: ExecutionContext) => {
  const server = new Server({ name: "retinue", version: "0.2.0" }, { capabilities: { tools: {} } });
  registerRetinueTools(
    server,
    { listTools: ListToolsRequestSchema, callTool: CallToolRequestSchema },
    { registry, context },
  );
  return server.connect(new StdioServerTransport());
};
```

A runnable one is in the repository: `examples/scripts/mcp-server.mjs`, plus `mcp-verify.mjs`, which drives it
with a real MCP client.

```bash
claude mcp add retinue -- node /abs/path/examples/scripts/mcp-server.mjs
```

## Credentials and scopes

`@modelcontextprotocol/sdk` is an **optional peer dependency**. Install it only if you mount a server.

There is no `authenticate` callback and no default. `registerRetinueTools` takes a **resolved
`ExecutionContext`**, so a host that has not authenticated has nothing to pass and cannot construct a server.
That is the same decision the API host makes — *"a permissive default would serve an open API to anyone who
forgot to set it"* — expressed in the type rather than in a runtime check, because this surface gets exposed to
the internet and a runtime check can be skipped.

One server per authenticated session:

- **stdio** — the client launches the server as a subprocess, so there is no request to authenticate: the
  process boundary *is* the session, and the host builds the context once from its own configuration.
- **HTTP** — authenticate per request and build a context per request, as the GraphQL host does.

What a client may reach is decided entirely by that context: its roles drive `listAuthorized`, and the tenant's
toolset and the agent's `toolPolicy.excluded` apply before authorization. A tool the caller may not use is
**absent**, not present-and-refused.

## Behaviour worth knowing

**The trust direction inverts.** Outbound, a remote server's hints are advisory and untrusted — "a remote server
cannot talk its way down to" a weaker effect. Inbound, this package *is* the remote server, so the mirror
obligations hold: advertise only what is enforced, and trust nothing the client sends. A client that includes
`annotations: { readOnlyHint: true }` or `approved: true` in its arguments gets exactly the same refusal.

**A refusal is `isError: true`, not a protocol error.** A protocol error tells the client the server is broken;
a tool refusal is a normal outcome a model should see and respond to. Both kinds of refusal are mapped —
including the ones the registry raises by throwing, which is what an unauthorized tool does.

**Schemas are converted where they must be.** MCP requires `inputSchema.type === "object"` and the SDK's client
*validates it*, so one tool carrying a Zod schema makes the entire listing fail — no tools at all, not one odd
entry. Zod schemas are converted; anything unconvertible is advertised as a permissive `{ "type": "object" }`
and still validated against the real schema on execution, so the failure direction is a rejected call rather
than an accepted bad one.

**Approval still stops the call.** A gated tool returns `approval_required` and does not run. Verified against a
real client, not only in a test.

## Limits

**No prompts, no resources.** Only `tools/list` and `tools/call`. Exposing agents as MCP prompts and knowledge as
MCP resources are natural follow-ups and are not built.

**No sampling** — a server asking the client's model to generate. That inverts the trust direction again and
needs its own thinking, not a flag.

**No transport is chosen for you.** The package registers handlers on a `Server` you construct, which leaves the
transport — and therefore the authentication story — with the host. A convenience wrapper would have to guess at
that, and guessing about authentication is how a surface ends up open.
