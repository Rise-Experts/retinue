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

/** Normalize a host for policy checks: lowercase, strip IPv6 brackets and a trailing dot (`a.` ≡ `a`). */
export const normalizeHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

const isPrivateV4 = (h: string): boolean => {
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

/**
 * Private/loopback/link-local detection for a host (name or IP literal). Blocks the obvious private
 * ranges, and — importantly — every IPv6 literal by default: an IPv4-mapped form like
 * `::ffff:169.254.169.254` otherwise slips a metadata address past a naive v4-only check. A specific
 * public IPv6 endpoint must instead be permitted explicitly via `allowedHttpHosts`.
 */
export const isPrivateHost = (host: string): boolean => {
  const h = normalizeHost(host);
  if (h.length === 0) return true;
  if (h === "localhost" || PRIVATE_HOSTNAMES.has(h) || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) return true; // any IPv6 literal (incl. ::, ::1, ::ffff:… mapped) — deny by default
  return isPrivateV4(h);
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
  validateHttpEgress(policy, endpoint);
};

/**
 * The HTTP half of the policy, on its own — #176.
 *
 * Extracted because the check is about **HTTP egress**, not about MCP: an agent tool that fetches a URL needs
 * exactly these rules, and the alternatives were both bad. Calling `validateEndpoint(policy, "streamable-http",
 * url)` would be passing a transport the caller does not have, and writing the checks again in the tool would be
 * a second SSRF defence that drifts from the first — and the one that drifts is the one nobody re-reads.
 *
 * Everything here was already load-bearing for MCP. Stated again because it is now reachable from a tool the
 * *model* chooses the argument for, which is a materially more hostile position than an operator-configured
 * endpoint:
 *
 * - Credentials in userinfo are **refused**, not stripped.
 * - Every IPv6 literal is denied by default, because `::ffff:169.254.169.254` slips a cloud metadata address
 *   past any v4-only check.
 * - An explicit host allow-list is authoritative, so an operator can permit something they trust.
 * - Absent an allow-list, private, loopback, link-local and `.internal`/`.local` targets are blocked.
 */
export const validateHttpEgress = (policy: EgressPolicy, endpoint: string): URL => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw forbidden(`Invalid URL`);
  }
  /**
   * A URL carrying userinfo is a **credential**, and it is refused (#145).
   *
   * `https://user:sk-live-abc@allowed.host` passed every check here: the scheme is permitted, the host is on the
   * allow-list, and the endpoint was then stored verbatim in `mcp_connections.endpoint`. A secret in a database
   * column — and in every log line, error message and support ticket that ever quotes the endpoint.
   *
   * The whole point of `McpAuth.credentialRef` is that a secret is *referenced*, never inlined. A URL is a second,
   * unguarded way to inline one, which is why this is a refusal and not a strip: silently removing the userinfo
   * would connect without the credential the operator believed they had configured, and the failure would look
   * like the remote server rejecting them.
   */
  if (url.username !== "" || url.password !== "")
    throw forbidden(
      "MCP endpoint URL must not contain credentials in its userinfo; use McpAuth.credentialRef instead",
    );

  const schemes = policy.allowedSchemes ?? ["https"];
  const scheme = url.protocol.replace(/:$/, "");
  if (!schemes.includes(scheme)) throw forbidden(`scheme "${scheme}" is not permitted for MCP egress`);
  const host = normalizeHost(url.hostname);
  // An explicit host allow-list is authoritative — it lets an operator permit a specific internal or
  // IPv6-literal host they trust. Without one, private/loopback/metadata targets are blocked.
  if (policy.allowedHttpHosts) {
    if (!policy.allowedHttpHosts.map(normalizeHost).includes(host))
      throw forbidden(`host "${url.hostname}" is not on the egress allow-list`);
    return url;
  }
  if (!policy.allowPrivateNetworks && isPrivateHost(url.hostname))
    throw forbidden(`endpoint host "${url.hostname}" resolves to a private/loopback address`);
  return url;
};
