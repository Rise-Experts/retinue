import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { z } from "zod";
import type { Tool } from "@retinue/agentkit";
import { coerceJsonTextArguments, withJsonTextArguments } from "../factory.js";
import { SHAREFLOW_TOOL_FACTORIES } from "../index.js";

/**
 * Object arguments sent as JSON text — production, three times: `page` (#508) and then `campaign` on
 * `create_post_draft`, refused four times in a row before the tool ran (#500's test).
 */
const schema = z
  .object({
    caption: z.string(),
    campaign: z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("id"), id: z.string() }).strict()]),
    tags: z.array(z.string()).optional(),
  })
  .strict();

describe("coerceJsonTextArguments", () => {
  it("reads an object or array sent as JSON text as the value it is — the production failure", () => {
    expect(coerceJsonTextArguments({ caption: "hi", campaign: '{"kind": "none"}', tags: '["a","b"]' }, schema)).toEqual({
      caption: "hi",
      campaign: { kind: "none" },
      tags: ["a", "b"],
    });
  });

  it("never touches a valid call, even a string that looks like JSON", () => {
    const valid = { caption: '{"this": "is the caption"}', campaign: { kind: "none" } };
    expect(coerceJsonTextArguments(valid, schema)).toBe(valid);
  });

  it("returns the input as sent when coercion does not make it valid, so its own error is what is reported", () => {
    const hopeless = { caption: "hi", campaign: '{"kind": "later"}' };
    expect(coerceJsonTextArguments(hopeless, schema)).toBe(hopeless);
  });
});

describe("every ShareFlow tool gets it", () => {
  const createPostDraft = SHAREFLOW_TOOL_FACTORIES.map((factory) =>
    factory.build({ services: {} as never, deps: { authorization: { can: async () => ({ allow: true }) } } as never }),
  ).find((tool) => tool.descriptor.name === "create_post_draft")!;

  it("validates create_post_draft's production input, campaign as JSON text", () => {
    const input = { caption: "Autumn soups are back.", campaign: '{"kind": "none"}', targetPlatforms: ["linkedin"] };
    expect((createPostDraft.descriptor.inputSchema as z.ZodTypeAny).safeParse(input).success).toBe(true);
  });

  it("declares the same schema to the model: an object, not a string", () => {
    const declared = JSON.stringify(zodSchema(createPostDraft.descriptor.inputSchema as never).jsonSchema);
    expect(declared).toContain('"campaign"');
    expect(declared).toContain('"kind"');
  });

  it("hands execute the coerced input, since the tool re-validates it", async () => {
    let seen: unknown;
    const inner = { descriptor: { name: "t", inputSchema: schema }, execute: async (i: { input: unknown }) => { seen = i.input; return { ok: true }; } } as unknown as Tool;
    await withJsonTextArguments(inner).execute({ context: {} as never, input: { caption: "x", campaign: '{"kind":"none"}' } });
    expect(seen).toEqual({ caption: "x", campaign: { kind: "none" } });
  });
});
