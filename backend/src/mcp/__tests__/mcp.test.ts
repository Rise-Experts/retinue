import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import { createMemoryMcpConnectionStore } from "../../adapters/memory/index.js";
import {
  classifyMcpTool,
  createMcpToolProvider,
  detectCatalogDrift,
  hashToolList,
  isPrivateHost,
  mcpToolName,
  redactConnection,
  validateEndpoint,
  type McpClient,
  type McpServerConnection,
} from "../index.js";

const T = asId<TenantId>("t1");
const ctx = (tenant: TenantId = T): ExecutionContext => ({
  tenantId: tenant,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("r1"),
});

const connection = (over: Partial<McpServerConnection> = {}): McpServerConnection => ({
  id: "srv1",
  tenantId: T,
  label: "My server",
  transport: "streamable-http",
  endpoint: "https://mcp.example.com/rpc",
  auth: { kind: "bearer", credentialRef: "secret://tenant/mcp-token" },
  enabled: true,
  createdAt: "t",
  ...over,
});

describe("egress policy — SSRF & allow-lists", () => {
  const policy = { allowedSchemes: ["https"], allowedStdioCommands: ["mcp-server"] };

  it("blocks private/loopback/metadata hosts", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "localhost", "::1", "172.16.9.9"])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of ["mcp.example.com", "8.8.8.8", "203.0.113.5"]) expect(isPrivateHost(h)).toBe(false);
  });

  it("rejects a non-https scheme and a private host", () => {
    expect(() => validateEndpoint(policy, "streamable-http", "http://mcp.example.com")).toThrow(/scheme/);
    expect(() => validateEndpoint(policy, "streamable-http", "https://169.254.169.254/rpc")).toThrow(/private/);
    expect(() => validateEndpoint(policy, "streamable-http", "https://mcp.example.com/rpc")).not.toThrow();
  });

  it("denies stdio commands not on the allow-list", () => {
    expect(() => validateEndpoint(policy, "stdio", "rm -rf /")).toThrow(/allow-list/);
    expect(() => validateEndpoint(policy, "stdio", "mcp-server --port 3")).not.toThrow();
  });
});

describe("connection store — registration egress, tenant isolation, credential safety", () => {
  const store = () => createMemoryMcpConnectionStore({ allowedSchemes: ["https"] });

  it("rejects an endpoint failing egress at registration", async () => {
    await expect(
      store().register({ tenantId: T, connection: connection({ endpoint: "http://127.0.0.1/rpc" }) }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps one tenant from seeing another's connections", async () => {
    const s = store();
    await s.register({ tenantId: T, connection: connection() });
    const other = asId<TenantId>("t2");
    expect(await s.list({ tenantId: other })).toHaveLength(0);
    expect(await s.get({ tenantId: other, id: "srv1" })).toBeNull();
  });

  it("redacts credentials and endpoint from the model/log-safe view", () => {
    const redacted = redactConnection(connection());
    expect(redacted).not.toHaveProperty("auth");
    expect(redacted).not.toHaveProperty("endpoint");
    expect(JSON.stringify(redacted)).not.toContain("secret://");
  });
});

describe("tool classification — safe by default, hints untrusted", () => {
  it("classifies a hint-only tool as external-write requiring approval", () => {
    const c = classifyMcpTool({ readOnlyHint: true }); // attacker-controlled hint
    expect(c.effect).toBe("external-write"); // readOnlyHint alone cannot reach 'read'
    expect(c.source).toBe("default");
  });

  it("honors a destructive hint and an administrator override", () => {
    expect(classifyMcpTool({ destructiveHint: true }).effect).toBe("destructive");
    expect(classifyMcpTool({ readOnlyHint: true }, "read")).toMatchObject({ effect: "read", source: "administrator" });
  });
});

describe("MCP tool provider — namespacing, approval, catalog drift", () => {
  const remoteTools = [
    { name: "search", hints: { readOnlyHint: true } },
    { name: "delete_record", hints: { destructiveHint: true } },
  ];
  const client: McpClient = {
    async listTools() {
      return remoteTools;
    },
    async callTool(name) {
      return { called: name };
    },
  };

  it("namespaces imported tools and derives approval from the classified effect", async () => {
    const provider = createMcpToolProvider({ connection: connection(), client, adminEffects: { search: "read" } });
    const tools = await provider.listTools(ctx());
    const byName = Object.fromEntries(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(Object.keys(byName)).toEqual([mcpToolName("srv1", "search"), mcpToolName("srv1", "delete_record")]);
    // search: administrator-classified read → never needs approval.
    expect(byName[mcpToolName("srv1", "search")]!.approvalPolicy).toBe("never");
    // delete_record: destructive → always requires approval + idempotency.
    expect(byName[mcpToolName("srv1", "delete_record")]!.approvalPolicy).toBe("always");
    expect(byName[mcpToolName("srv1", "delete_record")]!.requiresIdempotencyKey).toBe(true);
  });

  it("detects a mid-run tool-list change via the snapshot hash", async () => {
    const provider = createMcpToolProvider({ connection: connection(), client, clock: () => "t" });
    const before = await provider.snapshot(ctx());
    let shifted = false;
    const driftingClient: McpClient = {
      async listTools() {
        return shifted ? [...remoteTools, { name: "new_tool" }] : remoteTools;
      },
      async callTool() {
        return null;
      },
    };
    const driftProvider = createMcpToolProvider({ connection: connection(), client: driftingClient, clock: () => "t" });
    const same = await driftProvider.snapshot(ctx());
    shifted = true;
    const after = await driftProvider.snapshot(ctx());
    expect(detectCatalogDrift(before, same)).toBe(false);
    expect(detectCatalogDrift(same, after)).toBe(true); // tool list changed → drift
  });

  it("hashToolList is order-independent", () => {
    expect(hashToolList([{ name: "a" }, { name: "b" }])).toBe(hashToolList([{ name: "b" }, { name: "a" }]));
  });
});
