import { describe, expect, it } from "vitest";
import { AgentPlatformError, asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { readPdfTool } from "../research.js";

/**
 * Production, 2026-09-28: asked to rename a heading in a document it had made, the model passed the artifact's
 * id to read_pdf, got "No media asset", and asked the person to upload the file.
 */
const CONTEXT = { tenantId: asId<TenantId>("ws"), principalId: asId<PrincipalId>("u") } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
const ARTIFACT = "eab2df20-2686-4b71-b567-d03685b91733";

const build = (artifacts?: unknown) =>
  readPdfTool.build({
    services: {
      research: {
        async readPdf() {
          throw new AgentPlatformError({ code: "not_found", message: `No media asset ${ARTIFACT} in this workspace.`, retryable: false });
        },
      },
      ...(artifacts === undefined ? {} : { artifacts }),
    } as never,
    deps: { authorization: allowAll, idempotency: createMemoryIdempotencyStore() },
  });

describe("read_pdf given a document's id", () => {
  it("says it is a document the model made, and how to change it", async () => {
    const tool = build({ async get() { return { title: "Q4 Content Strategy Guide" }; } });
    const result = await tool.execute({ context: CONTEXT, input: { source: { kind: "asset", assetId: ARTIFACT } }, idempotencyKey: "k1" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const message = (result as { error: { message: string } }).error.message;
    expect(message).toContain("is a document you made");
    expect(message).toContain(`call update_artifact with artifactId ${ARTIFACT}`);
  });

  it("keeps the plain not-found for an id that is no artifact either", async () => {
    const tool = build({ async get() { throw new AgentPlatformError({ code: "not_found", message: "no", retryable: false }); } });
    const result = await tool.execute({ context: CONTEXT, input: { source: { kind: "asset", assetId: ARTIFACT } }, idempotencyKey: "k2" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
