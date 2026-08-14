/**
 * MCP — outbound server consumption. `@proposed`: no specification section covers this
 * yet, so these contracts are the open proposal, not settled design.
 *
 * Direction matters. The repository already ships an *inbound* MCP server
 * (`web/src/lib/mcp/server.ts`) that exposes Chorus tools to external clients. This
 * module is the other direction: a tenant registers their own MCP server and the
 * assistant gains its tools.
 *
 * An imported tool is a `ToolProvider` like any other, which means it inherits the
 * whole authorization and approval path rather than sitting beside it.
 */

import type { ExecutionContext } from "../core/context.js";
import type { TenantId } from "../core/ids.js";
import type { ToolDescriptor, ToolEffect, ToolProvider } from "../tools/index.js";

export const MCP_TRANSPORTS = ["stdio", "streamable-http", "sse"] as const;

export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type McpAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly credentialRef: string }
  | { readonly kind: "oauth"; readonly credentialRef: string };

/**
 * Credentials are referenced, never inlined — `credentialRef` points at secret storage.
 * Nothing in this record may reach model context.
 */
export type McpServerConnection = {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly label: string;
  readonly transport: McpTransport;
  /** URL for HTTP transports, command for stdio. Validated against the egress policy. */
  readonly endpoint: string;
  readonly auth: McpAuth;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastHandshakeAt?: string;
  readonly lastError?: string;
};

/**
 * MCP does not classify side effects the way the platform does. `readOnlyHint` and
 * `destructiveHint` are advisory and come from the remote server, which is untrusted.
 * So classification defaults to the safe end and only an administrator can relax it.
 */
export type McpToolHints = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
};

export type McpToolClassification = {
  readonly effect: ToolEffect;
  readonly source: "hint" | "administrator" | "default";
};

/**
 * Safe default: anything not explicitly classified by an administrator is treated as an
 * external write and requires approval. A remote server cannot talk its way down to
 * `read` — a `readOnlyHint` alone is not enough, because the hint is attacker-controlled
 * when the server is.
 */
export const classifyMcpTool = (
  hints: McpToolHints,
  administratorEffect?: ToolEffect,
): McpToolClassification => {
  if (administratorEffect !== undefined) {
    return { effect: administratorEffect, source: "administrator" };
  }
  if (hints.destructiveHint === true) {
    return { effect: "destructive", source: "hint" };
  }
  return { effect: "external-write", source: "default" };
};

/** Namespaced so two servers exposing `search` cannot collide. */
export const mcpToolName = (serverId: string, toolName: string): string =>
  `mcp__${serverId}__${toolName}`;

/**
 * MCP servers may change their tool list between calls. The run records a hash of what
 * it discovered, so a catalog that shifted mid-run is detectable after the fact.
 */
export type McpCatalogSnapshot = {
  readonly connectionId: string;
  readonly toolListHash: string;
  readonly discoveredAt: string;
  readonly tools: readonly ToolDescriptor[];
};

/** Bridges one connection into the ordinary tool pipeline. */
export interface McpToolProvider extends ToolProvider {
  readonly connectionId: string;
  snapshot(context: ExecutionContext): Promise<McpCatalogSnapshot>;
}

/**
 * MCP resources and prompts are context, not tools. They belong on the context-provider
 * path so they are budgeted and pruned like every other section.
 */
export type McpResourceRef = {
  readonly connectionId: string;
  readonly uri: string;
  readonly mimeType?: string;
};
