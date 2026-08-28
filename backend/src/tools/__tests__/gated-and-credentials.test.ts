/**
 * The confirmation wrappers and the credential seam — REQ-047 (#206), task #214, AC-5/AC-9.
 *
 * Both exist because of what happens at scale rather than in one package: `docs/23-tool-catalogue.md` plans
 * twenty-one toolkit packages, and the two mistakes that survive code review are a mistyped `effect` and a token
 * read from the environment. Neither is visible in a diff that looks otherwise correct.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import { confirms, destroys, defineTool } from "../define.js";
import { createStaticCredentialResolver, credentialMissing } from "../credentials.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

describe("confirms / destroys — AC-9", () => {
  it("sets the three fields together, so two cannot be set without the third", () => {
    const tool = confirms({ name: "create_issue", description: "Open an issue.", execute: () => ({ id: 1 }) });
    expect(tool.descriptor).toMatchObject({
      effect: "external-write",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
    });
  });

  it("destroys classifies distinctly from confirms, because policy reads the difference", () => {
    // A shadow run suppresses both, but an operator asking "what can this agent irreversibly do" needs the
    // catalogue to answer it — collapsing the two would lose that.
    expect(destroys({ name: "delete_post", description: "x", execute: () => ({}) }).descriptor.effect).toBe("destructive");
    expect(confirms({ name: "post_message", description: "x", execute: () => ({}) }).descriptor.effect).toBe("external-write");
  });

  it("the safe form is shorter than the unsafe one", () => {
    // Stated as a test because it is the actual mechanism: `confirms({…})` versus `defineTool({…, effect,
    // approvalPolicy, requiresIdempotencyKey})`. Ergonomics are the control here; the check in
    // scripts/check-tool-effects.mjs is the backstop for whoever writes the long form anyway.
    const gated = confirms({ name: "send_email", description: "x", execute: () => ({}) });
    const byHand = defineTool({
      name: "send_email",
      description: "x",
      effect: "external-write",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
      execute: () => ({}),
    });
    expect(gated.descriptor).toMatchObject({
      effect: byHand.descriptor.effect,
      approvalPolicy: byHand.descriptor.approvalPolicy,
      requiresIdempotencyKey: byHand.descriptor.requiresIdempotencyKey,
    });
  });

  it("a read still defaults to no gate, so the wrappers are not the only way to define a tool", () => {
    const read = defineTool({ name: "get_issue", description: "x", execute: () => ({}) });
    expect(read.descriptor).toMatchObject({ effect: "read", approvalPolicy: "never", requiresIdempotencyKey: false });
  });
});

describe("credentials are referenced, not held — AC-5", () => {
  it("resolves a reference to a secret", async () => {
    // A bare string still means a bearer token — #260 widened the return type and deliberately did not make the
    // single-tenant path harder. The common case stays one line.
    const resolver = createStaticCredentialResolver({ github: "ghp_example" });
    const credential = await resolver.resolve({ ref: "github", context });
    expect(credential.scheme).toBe("bearer");
    expect(credential.scheme === "bearer" && credential.token).toBe("ghp_example");
  });

  it("throws on a missing reference rather than returning an empty string", async () => {
    // An empty token sends an unauthenticated request and surfaces as a vendor 401 several layers away, where
    // the real problem — nobody wired it — is invisible.
    const resolver = createStaticCredentialResolver({});
    await expect(resolver.resolve({ ref: "github", context })).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("treats an empty secret as missing, because a blank token is a misconfiguration", async () => {
    const resolver = createStaticCredentialResolver({ github: "" });
    await expect(resolver.resolve({ ref: "github", context })).rejects.toMatchObject({ retryable: false });
  });

  it("names the reference in the failure, and points at the fix", () => {
    const error = credentialMissing("slack");
    expect(error.message).toContain("slack");
    expect(error.message).toContain("CredentialResolver");
    // Retrying an unwired credential cannot help; something has to be configured.
    expect(error.retryable).toBe(false);
  });

  it("is not environment-backed, deliberately", () => {
    // A host that wants env vars passes them in and can be seen doing so. A resolver with a silent
    // `process.env` fallback is the thing this module exists to prevent, because it works for exactly one tenant.
    process.env.RETINUE_TEST_SECRET_XYZ = "leaked";
    const resolver = createStaticCredentialResolver({});
    return expect(resolver.resolve({ ref: "RETINUE_TEST_SECRET_XYZ", context })).rejects.toBeDefined();
  });
});
