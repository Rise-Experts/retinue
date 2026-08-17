/**
 * MCP egress policy — `docs/10-mcp-integration.md` → Egress and trust.
 *
 * A tenant's MCP endpoint is validated *before any handshake*, at registration and again at connect.
 * HTTP endpoints are checked against scheme/host rules and blocked from reaching private/loopback
 * addresses (SSRF defense); stdio commands are checked against an explicit allow-list. Anything not
 * allowed is rejected — the safe default is deny.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { McpTransport } from "./index.js";

export type EgressPolicy = {
  /** If set, only these HTTP hosts are permitted (allow-list). */
  readonly allowedHttpHosts?: readonly string[];
  /** Permitted URL schemes for HTTP transports. Defaults to `["https"]`. */
  readonly allowedSchemes?: readonly string[];
  /** Explicit allow-list of stdio commands. Stdio is denied unless a command matches. */
  readonly allowedStdioCommands?: readonly string[];
  /** Allow private/loopback addresses (dev only). Defaults to false. */
  readonly allowPrivateNetworks?: boolean;
};

const forbidden = (message: string) =>
  new AgentPlatformError({ code: "forbidden", message, retryable: false });

const PRIVATE_HOSTNAMES = new Set(["localhost", "ip6-localhost", "metadata.google.internal"]);

/** Best-effort private/loopback/link-local detection for a host (name or IP literal). */
export const isPrivateHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.has(h) || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // IPv6 loopback/ULA/link-local
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
};

/**
 * Validate an endpoint against the policy. Throws `forbidden` when disallowed. For stdio the endpoint
 * is the command; for HTTP transports it is a URL.
 */
export const validateEndpoint = (policy: EgressPolicy, transport: McpTransport, endpoint: string): void => {
  if (transport === "stdio") {
    const allowed = policy.allowedStdioCommands ?? [];
    const command = endpoint.trim().split(/\s+/)[0] ?? "";
    if (!allowed.includes(command)) throw forbidden(`stdio command "${command}" is not on the egress allow-list`);
    return;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw forbidden(`Invalid MCP endpoint URL`);
  }
  const schemes = policy.allowedSchemes ?? ["https"];
  const scheme = url.protocol.replace(/:$/, "");
  if (!schemes.includes(scheme)) throw forbidden(`scheme "${scheme}" is not permitted for MCP egress`);
  if (!policy.allowPrivateNetworks && isPrivateHost(url.hostname))
    throw forbidden(`endpoint host "${url.hostname}" resolves to a private/loopback address`);
  if (policy.allowedHttpHosts && !policy.allowedHttpHosts.includes(url.hostname))
    throw forbidden(`host "${url.hostname}" is not on the egress allow-list`);
};
