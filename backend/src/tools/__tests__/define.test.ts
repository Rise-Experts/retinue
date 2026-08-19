import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import { defineTool, toolProvider } from "../index.js";

const ctx = {} as ExecutionContext;

describe("defineTool / toolProvider", () => {
  it("wraps a plain execute into the success envelope and fills descriptor defaults", async () => {
    const search = defineTool({
      name: "search",
      description: "search the web",
      inputSchema: z.object({ q: z.string() }),
      execute: (input: { q: string }) => ({ hits: [input.q] }),
    });
    expect(search.descriptor).toMatchObject({ name: "search", category: "general", effect: "read", approvalPolicy: "never", requiresIdempotencyKey: false });
    expect(await search.execute({ context: ctx, input: { q: "x" } })).toEqual({ ok: true, data: { hits: ["x"] } });
  });

  it("defaults external/destructive tools to approval + idempotency, and catches errors into the envelope", async () => {
    const publish = defineTool({
      name: "publish",
      description: "publish a post",
      effect: "external-write",
      execute: () => {
        throw new Error("boom");
      },
    });
    expect(publish.descriptor).toMatchObject({ approvalPolicy: "always", requiresIdempotencyKey: true });
    expect(await publish.execute({ context: ctx, input: {} })).toMatchObject({ ok: false, error: { code: "internal", message: "boom" } });
  });

  it("toolProvider serves a fixed set", async () => {
    const p = toolProvider("test", [defineTool({ name: "a", description: "a", execute: () => 1 })]);
    expect(p.id).toBe("test");
    expect((await p.listTools(ctx)).map((t) => t.descriptor.name)).toEqual(["a"]);
    void asId;
  });
});
