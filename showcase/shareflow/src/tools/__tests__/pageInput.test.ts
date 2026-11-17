import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { z } from "zod";
import { pageInput } from "../factory.js";

/**
 * Found on production (#498's /drafts): Gemini sent `page` as the object serialised into a string, four
 * times, and every call was refused before the tool ran.
 */
describe("pageInput", () => {
  const listInput = z.object({ page: pageInput, limit: z.number().optional() }).strict();

  it("takes the choice as an object, as declared", () => {
    expect(listInput.parse({ page: { kind: "first" } })).toEqual({ page: { kind: "first" } });
    expect(listInput.parse({ page: { kind: "after", cursor: "c1" } }).page).toEqual({ kind: "after", cursor: "c1" });
  });

  it("takes the same choice sent as JSON text — the production failure", () => {
    expect(listInput.parse({ page: '{"kind": "first"}', limit: 25 })).toEqual({ page: { kind: "first" }, limit: 25 });
    expect(listInput.parse({ page: '{"kind":"after","cursor":"c1"}' }).page).toEqual({ kind: "after", cursor: "c1" });
  });

  it("still refuses text that is not a valid choice", () => {
    expect(listInput.safeParse({ page: "first" }).success).toBe(false);
    expect(listInput.safeParse({ page: '{"kind":"after"}' }).success).toBe(false);
    expect(listInput.safeParse({ page: '{"kind":"last"}' }).success).toBe(false);
  });

  it("declares an object to the model, not a string or an empty schema", () => {
    const declared = JSON.stringify(zodSchema(listInput as never).jsonSchema);
    expect(declared).toContain('"kind"');
    expect(declared).toContain('"first"');
    expect(declared).toContain('"cursor"');
  });
});
