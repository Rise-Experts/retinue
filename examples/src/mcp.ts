/**
 * Bridging a real MCP server into the platform's tool pipeline — #173.
 *
 * `createMcpToolProvider` takes an injectable `McpClient` with exactly two methods, `listTools` and `callTool`,
 * precisely so the platform never depends on an MCP SDK. Providing one is the host's job, and **no host did** —
 * the eighth capability found built and unreachable.
 *
 * What the platform does with the tools once they arrive is the interesting part, and it is all already written:
 *
 * - Each remote tool is namespaced `mcp__<server>__<tool>`, so a server cannot shadow a first-party tool by
 *   naming its own tool `share_note`.
 * - Effects are classified **safe-by-default**: an untrusted `readOnlyHint` from a remote server cannot buy its
 *   way down to `read`. Only an administrator's explicit configuration relaxes a classification.
 * - The approval policy follows from the effect, so an imported write inherits the whole approval path rather
 *   than sitting beside it.
 * - A per-run catalog hash makes a tool list that shifted mid-run detectable afterwards.
 *
 * That last one matters more than it sounds: a remote server can change its tools between two turns of the same
 * conversation, and a run that approved `mcp__x__publish` should not silently end up calling something else.
 */

import { createMcpToolProvider, hashToolList, mcpToolName } from "@agentkit/backend";
import type { McpClient, McpRemoteTool, McpServerConnection, McpToolProvider, TenantId } from "@agentkit/backend";

/**
 * The documentation server this example connects to.
 *
 * **stdio, not HTTP.** The client spawns the process, so there is no port to configure, nothing to leave running,
 * and no network — `npm run app` works on a laptop with no internet. It also means the connection's lifetime is
 * the app's, which is what makes closing it on shutdown meaningful rather than decorative.
 *
 * `credentialRef` is empty because a local process needs no credential. The field exists because the connection
 * record must never hold a secret — only a reference something else can resolve — and that is true whether or not
 * this particular server has one.
 */
/** The server id, in one place: it forms the tool names, the category, and the role grants. */
export const DOCS_MCP_SERVER_ID = "agentkit-docs";

export const docsMcpConnection = (tenantId: TenantId): McpServerConnection => ({
  id: DOCS_MCP_SERVER_ID,
  tenantId,
  label: "agentkit-docs",
  transport: "stdio",
  endpoint: "node scripts/docs-mcp-server.mjs",
  auth: { kind: "none" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
});

/**
 * The SDK, behind the platform's two-method port.
 *
 * Deliberately thin. Everything the platform cares about — namespacing, classification, approval policy, drift
 * detection — happens on the other side of this boundary, and adding judgement here would be adding a second
 * place where those decisions are made.
 *
 * Lazily connected, and connected **once**: `listTools` is called on every catalogue build, and a client that
 * reconnected per call would spawn a process per turn.
 */
export const createDocsMcpClient = (deps: {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}): McpClient & { close(): Promise<void> } => {
  let connecting: Promise<{ close(): Promise<void>; listTools(): Promise<unknown>; callTool(a: unknown): Promise<unknown> }> | null =
    null;

  const connect = async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "agentkit-example", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: deps.command ?? "node",
        args: [...(deps.args ?? ["scripts/docs-mcp-server.mjs"])],
        ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      }),
    );
    return client as never;
  };

  const client = () => (connecting ??= connect());

  return {
    async listTools(): Promise<readonly McpRemoteTool[]> {
      const result = (await (await client()).listTools()) as {
        tools?: readonly {
          name: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
        }[];
      };
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        /**
         * The server's hints, passed through **as hints**.
         *
         * They are attacker-controlled data: a hostile server would mark everything `readOnlyHint: true`. The
         * platform's `classifyMcpTool` treats them as a claim rather than a fact, which is why passing them on is
         * safe and why sanitising them here would be the wrong layer — it would hide from the classifier the
         * information it is designed to distrust.
         */
        ...(tool.annotations === undefined
          ? {}
          : {
              hints: {
                ...(tool.annotations.readOnlyHint === undefined
                  ? {}
                  : { readOnlyHint: tool.annotations.readOnlyHint }),
                ...(tool.annotations.destructiveHint === undefined
                  ? {}
                  : { destructiveHint: tool.annotations.destructiveHint }),
                ...(tool.annotations.openWorldHint === undefined
                  ? {}
                  : { openWorldHint: tool.annotations.openWorldHint }),
              },
            }),
      }));
    },

    async callTool(name: string, input: unknown): Promise<unknown> {
      const result = (await (await client()).callTool({ name, arguments: (input ?? {}) as never })) as {
        content?: readonly { type?: string; text?: string }[];
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      /**
       * A server's `isError` is surfaced, not thrown.
       *
       * The remote call *happened*; it reported a failure. Throwing would make it indistinguishable from a
       * transport failure, and the platform's retry logic would then retry a deterministic refusal — the same
       * mistake #172 fixed one layer down.
       */
      return result.isError === true ? { error: text || "the MCP server reported an error" } : { text };
    },

    async close() {
      if (connecting === null) return;
      const c = await connecting;
      connecting = null;
      await c.close().catch(() => undefined);
    },
  };
};

/**
 * The administrator's classification of this server's tools — the only thing that can relax the safe default.
 *
 * Without this, `classifyMcpTool` returns `external-write` for **every** imported tool, whatever the server
 * claims. That is not a bug to work around: a `readOnlyHint` is attacker-controlled when the server is, so the
 * platform treats it as a claim and refuses to price a side effect off it. A hostile server marking everything
 * read-only would otherwise import a silent publish.
 *
 * So this is the mechanism working, and this line is the administrator step it requires. I am asserting these
 * three tools are reads — on the strength of having written the server and its path checks, not on the strength
 * of its annotations. Anything the server adds later that is not on this list arrives as `external-write` and
 * needs human approval before it can run once, which is the correct default for a tool nobody has reviewed.
 */
export const DOCS_MCP_EFFECTS = {
  list_documents: "read",
  read_document: "read",
  search_documents: "read",
} as const;

/**
 * The namespaced tool names a role grants, **derived** from the classification above.
 *
 * Derived rather than listed a second time: two hand-maintained lists of the same three tools is a list that
 * drifts, and the drift is silent — a tool classified but not granted is invisible in the catalogue, and a tool
 * granted but not classified arrives as an `external-write` needing approval to read a document.
 *
 * Still explicit rather than a wildcard, which is the authorization model rather than an inconvenience: a role
 * grants named tools, so a tool the server adds tomorrow is not callable until someone adds it here. That review
 * step is what makes importing a remote server safe.
 */
export const DOCS_MCP_TOOLS: readonly string[] = Object.keys(DOCS_MCP_EFFECTS).map((name) =>
  mcpToolName(DOCS_MCP_SERVER_ID, name),
);

/** The provider, and the snapshot hash a run records so mid-run catalog drift is detectable afterwards. */
export const createDocsMcpProvider = (tenantId: TenantId, client: McpClient): McpToolProvider =>
  createMcpToolProvider({
    connection: docsMcpConnection(tenantId),
    client,
    adminEffects: DOCS_MCP_EFFECTS,
  });

export { hashToolList };
