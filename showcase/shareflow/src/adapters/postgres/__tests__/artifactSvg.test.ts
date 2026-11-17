/**
 * #607 part 3: an `svg` artifact is stored sanitized, on create and on revise — the adapter is the one write
 * path, so no tool can skip it. A fake executor records the statements; the real ordering guarantees are in
 * `services.test.ts` against a database.
 */
import { describe, expect, it } from "vitest";
import { asId, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createPostgresArtifactService } from "../artifacts.js";

const CONTEXT = { tenantId: asId<TenantId>("11111111-1111-4111-8111-111111111111"), principalId: asId<PrincipalId>("22222222-2222-4222-8222-222222222222") } as unknown as ExecutionContext;
const ID = "33333333-3333-4333-8333-333333333333";

const fake = (kind: string) => {
  const written: unknown[][] = [];
  const row = (content: string, version = 1) => ({ id: ID, title: "T", kind, content, version, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" });
  const query = async (text: string, params: unknown[] = []) => {
    if (/insert into public\.assistant_artifacts\b/.test(text)) {
      written.push(params);
      return [row(String(params[5]))];
    }
    if (/update public\.assistant_artifacts/.test(text)) {
      written.push(params);
      return [row(String(params[3]), 2)];
    }
    if (/select/.test(text)) return [row("<svg/>")];
    return [];
  };
  const sql = { query } as never;
  const service = createPostgresArtifactService({ sql, transaction: { transaction: async (fn: (tx: unknown) => unknown) => fn({ query }) } as never });
  return { service, written };
};

const DIRTY = '<svg onload="alert(1)"><script>alert(2)</script><circle r="2"/></svg>';

describe("svg artifacts are stored inert", () => {
  it("sanitizes on create", async () => {
    const { service, written } = fake("svg");
    const created = await service.create(CONTEXT, { idempotencyKey: "k" as never, title: "T", kind: "svg", content: DIRTY });
    expect(written[0]?.[5]).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>');
    expect(created.content).not.toMatch(/alert/);
  });

  it("sanitizes on revise, by the stored kind", async () => {
    const { service, written } = fake("svg");
    await service.revise(CONTEXT, { idempotencyKey: "k" as never, id: asId(ID), content: DIRTY });
    const update = written.find((p) => p.length === 6 && typeof p[4] === "number");
    expect(update?.[3]).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>');
  });

  it("refuses an svg that does not parse, saving nothing", async () => {
    const { service, written } = fake("svg");
    await expect(service.create(CONTEXT, { idempotencyKey: "k" as never, title: "T", kind: "svg", content: "<div>no</div>" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(written).toEqual([]);
  });

  it("leaves every other kind's content untouched", async () => {
    const { service, written } = fake("html");
    await service.create(CONTEXT, { idempotencyKey: "k" as never, title: "T", kind: "html", content: "<script>ok()</script>" });
    expect(written[0]?.[5]).toBe("<script>ok()</script>");
  });
});
