import { describe, expect, it, vi } from "vitest";
import {
  assertToolAuthorized,
  createAuthorizationPolicy,
  tenantRlsFilter,
  type AuditEvent,
  type ExecutionContext,
  type ToolDescriptor,
} from "../index.js";

const ctx = (roleIds: string[], tenantId = "t1"): ExecutionContext =>
  ({ tenantId, principalId: "p1", roleIds, locale: "en", timezone: "UTC", requestId: "r1" }) as unknown as ExecutionContext;

const tool = (name: string, category: string): ToolDescriptor =>
  ({
    name, label: name, description: "", category,
    inputSchema: {}, outputSchema: {}, effect: "external-write",
    approvalPolicy: "required", requiresIdempotencyKey: true,
  }) as ToolDescriptor;

const audit = vi.fn<(e: AuditEvent) => void>();
const policy = createAuthorizationPolicy({
  audit,
  roles: [
    { roleId: "editor", permissions: [{ action: "read", resourceType: "conversation" }], tools: ["create_post", "publishing"] },
    { roleId: "viewer", permissions: [{ action: "read", resourceType: "conversation" }] },
  ],
});

const createPost = tool("create_post", "posts");
const publish = tool("publish_post", "publishing"); // allowed by category
const secret = tool("billing_export", "billing"); // not allowed

describe("authorization engine", () => {
  it("filters unauthorized tools from discovery", async () => {
    const forEditor = await policy.filterTools(ctx(["editor"]), [createPost, publish, secret]);
    expect(forEditor.map((t) => t.name)).toEqual(["create_post", "publish_post"]); // secret dropped
    const forViewer = await policy.filterTools(ctx(["viewer"]), [createPost, publish, secret]);
    expect(forViewer).toHaveLength(0);
  });

  it("rejects an unauthorized tool on direct execution", async () => {
    await expect(assertToolAuthorized(policy, ctx(["editor"]), createPost)).resolves.toBeUndefined();
    await expect(assertToolAuthorized(policy, ctx(["editor"]), secret)).rejects.toThrow(/not permitted|not authorized/);
    await expect(assertToolAuthorized(policy, ctx(["viewer"]), createPost)).rejects.toThrow();
  });

  it("scope() agrees with the RLS predicate", async () => {
    const s = await policy.scope(ctx(["editor"]), "conversation");
    expect(s.filter).toEqual(tenantRlsFilter("t1"));
    expect(s).toMatchObject({ tenantId: "t1", roleIds: ["editor"] });
  });

  it("denies a cross-tenant resource", async () => {
    const d = await policy.can(ctx(["editor"], "t1"), "read", { type: "conversation", attributes: { tenantId: "t2" } });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("cross-tenant");
  });

  it("audits denials", async () => {
    audit.mockClear();
    await policy.can(ctx(["viewer"]), "read", { type: "billing" }); // no permission
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "denied" }));
  });
});
