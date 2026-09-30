# Outbound MCP Integration

The platform already exposes its own tools to external clients through an *inbound* MCP
server. This specification covers the other direction: a tenant registers their own MCP
server and the assistant gains its tools, resources and prompts.

An imported MCP tool is a `ToolProvider` like any other. It inherits the whole
authorization, classification and approval path rather than sitting beside it.

## Connection model

```ts
type McpTransport = "stdio" | "streamable-http" | "sse";

type McpAuth =
  | { kind: "none" }
  | { kind: "bearer"; credentialRef: string }
  | { kind: "oauth"; credentialRef: string };

type McpServerConnection = {
  id: string;
  tenantId: string;
  label: string;
  transport: McpTransport;
  endpoint: string;        // URL for HTTP transports, command for stdio
  auth: McpAuth;
  enabled: boolean;
  createdAt: string;
  lastHandshakeAt?: string;
  lastError?: string;
};
```

Credentials are referenced, never inlined. `credentialRef` points at secret storage, and
nothing in a connection record may reach model context.

## Egress and trust

- `endpoint` is validated against a configured egress policy before any handshake. Stdio
  commands are validated against an allow-list; HTTP endpoints against host/scheme rules.
- A remote MCP server is **untrusted**. Its tool descriptions, schemas, resources and
  prompt text are data, never instructions to the runtime.
- Connections are tenant-scoped. One tenant can never discover or invoke another tenant's
  MCP tools.

## Tool classification

MCP does not classify side effects the way the platform does. `readOnlyHint`,
`destructiveHint` and `openWorldHint` are advisory and originate from the remote server,
so they are attacker-controlled when the server is.

```mermaid
flowchart TB
  Hint["Remote tool hints"] --> Classify
  Admin["Administrator classification"] --> Classify
  Classify{"Classify effect"} -->|administrator set| Explicit["Use administrator effect"]
  Classify -->|destructiveHint only| Dest["destructive"]
  Classify -->|otherwise| Default["external-write (requires approval)"]
```

- Anything not explicitly classified by an administrator defaults to `external-write` and
  therefore requires approval.
- A `readOnlyHint` alone is **not** enough to reach `read`. Only an administrator can relax
  a tool to a lower effect for a given connection.

## Discovery and drift

- Imported tools are namespaced as `mcp__<serverId>__<toolName>` — the standard MCP-client
  scheme — so two servers exposing `search` cannot collide.
- MCP servers may change their tool list between calls. A run records a
  `McpCatalogSnapshot` — connection ID, discovered tools and a `toolListHash` with a
  timestamp — so a catalog that shifted mid-run is detectable after the fact.
- Imported tool schemas enter context lazily through the same compact-catalog and
  `learn_tools`/`execute_tool` path as native tools.

## Resources and prompts

MCP resources and prompts are context, not tools. They are surfaced through the
context-provider path so they are budgeted, cached and pruned like every other section,
and carry the same untrusted-data treatment.

## Interfaces

- `McpServerConnectionStore` — tenant-scoped connection persistence.
- `McpToolProvider` — bridges one connection into the ordinary tool pipeline.
- `McpTransportClient` — transport-specific handshake, list and call.
- `EgressPolicy` — validates endpoints and stdio commands.

## Acceptance criteria

- A tenant's MCP tools appear only in that tenant's discovery.
- An unclassified or hint-only MCP tool requires approval before executing.
- A remote `readOnlyHint` cannot downgrade an effect on its own.
- Credentials never appear in prompts, logs or tool results.
- Mid-run tool-list changes are detectable through the recorded catalog hash.
- Endpoints failing the egress policy are rejected at registration and at handshake.

## Both directions — added by #250

This document describes MCP **outbound**: a tenant registers their server and the platform consumes it. That was
the only direction the package had, and it is half the story — `backend/src/mcp/index.ts` even points at an
inbound server that lives in the *old Chorus repository*, not in this package. So a deployment could consume an
MCP server and could not be one, and its tools were unreachable from Claude Code, Claude Desktop and Cursor.

`@retinue/agentkit/mcp-server` is the other direction. It adds no capability: every call goes through
`registry.execute` exactly as an agent's would, so authorization, the tenant's toolset, the approval gate,
validation, idempotency and audit attribution all apply unchanged.

The rule this document sets for outbound is what governs inbound too, read in a mirror. Here:

> a remote server's `readOnlyHint`/`destructiveHint` are advisory and come from the remote server, which is
> untrusted. A remote server cannot talk its way down to a weaker effect.

Inbound, **this package is the remote server**, so it owes the other side the honesty this document demands of
them: the MCP annotations are derived from `ToolEffect` by a single function, so what is advertised cannot drift
from what is enforced — and nothing a client sends is trusted, including an effect, a hint, or a claim of prior
approval.

One consequence worth stating, because it changed a declaration in the reference host: **a mis-declared effect
stops being internal the moment tools are exposed over MCP.** `remember` was declared `read` while delegating to
`principalMemory.put`, which was survivable while the only reader was this platform's own policy; over MCP it
advertises `readOnlyHint: true` to an external client, which may skip a confirmation on that basis. `check:effects`
did not catch it because that check reads the tool's *name*.

See `website/content/integrations/mcp-server.md` for the operator-facing page.

## Serving the documentation, without an index — #291

The inbound server exposes a deployment's tools; `docs_list`, `docs_search` and `docs_read` make one of those
tools the documentation itself. A root is configured (`docs: { root }`) and the three appear; configure nothing
and they are absent, the same rule the filesystem tools follow.

**There are no vectors, and that is a measured position rather than a preference.**
`docs/26-retrieval-quality.md` scored five arms on this corpus. The one with no index — read a table of
contents, choose documents, look inside them — had the **best P@1 (44.4%) and the best MRR** of all five,
beating semantic, hybrid, and hybrid with a reranker. It recorded two costs: roughly 7× the latency and 4,000×
the marginal cost, and the worst-but-one recall "because it reads at most three documents".

Neither cost survives the move to MCP, which is the whole argument:

- the cost was **a model call inside the runtime** to choose documents. Over MCP the client's model chooses, as
  part of reasoning it is already doing. The expense leaves this side of the boundary entirely.
- the recall cap was **three documents**, a limit of that implementation. A client reads as many as it likes.

What remains is the property that was never a score: **no index**. Nothing to rebuild when a document changes,
no re-embedding, and no window in which the prose says one thing and the index still serves the previous
version. It also helps that this corpus's vocabulary is *enforced* — `check:terminology` against
`docs/22-glossary.md` — because controlled nouns are the condition under which literal search stops losing to
embeddings.

### Why not `fs_read`, `fs_list` and `fs_search`

Those exist and they are correct, and these three delegate to the same reader rather than reaching disk
themselves. Three differences, each of which otherwise costs a model a whole document:

| | the file tools | the documentation tools |
|---|---|---|
| listing | name, kind, bytes | **title**, summary and section headings |
| a match | the matching line | the line **plus the heading it sits under** |
| a read | the whole file | the whole file, **or one named section** |

A listing of `21-platform.md, 14KB` does not say what is in it, so choosing between thirty-two files means
opening thirty-two files; a line without its heading is hard to judge; and the largest document here is about
10k tokens to answer one question about one section. An unknown section is refused with the document's real
headings listed, so the next call can be right without another round trip.

The reader is built with **no writable root**, unlike `FileScope`. A corpus a model can edit is a corpus a model
can cite itself into, and documentation is the last place that should be possible.

### The documentation ships with the package

`docs/` is a **sibling** of `backend/`, and `files` cannot reach outside the package root — so the choice was to
copy the documentation in at pack time or to ship a documentation server with no documentation. A `prepack` step
(`scripts/copy-docs.mjs`) copies it, and `files` ships `dist/docs/**/*.md`. 32 documents, and the package grows
from 3.44 MB to 3.72 MB.

**Into `dist/`, and that detail is load-bearing.** The obvious destination is `backend/docs/`, which is wrong:
`check-terminology.mjs` and `check-doc-imports.mjs` both walk the tree for markdown and neither skips a
directory called `docs`, so every document would be scanned twice and a copy left behind by an interrupted pack
would keep doing it. `dist/` is already in those checks' `SKIP_DIRS`, already in `.gitignore`, and already
removed by `clean`. A copy is a build artifact; putting it where build artifacts live answers every question
about stale copies at once.

`agentkitDocsRoot()` returns the shipped copy when there is one and this repository's `docs/` otherwise, both
existence-tested — a path that is not there would turn "the tools found nothing" into the symptom, three layers
from the cause. It is **not** a default for `docs: { root }`: `wiring is the toggle` is the rule every tool in
the library follows, and a root that appeared on its own would make these the one exception. A host that wants
them writes `docs: { root: agentkitDocsRoot() }`, and a host serving its own documentation passes its own root.
