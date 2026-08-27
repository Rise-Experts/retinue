/**
 * Only a schema this process can check is accepted for structured output — task #243 AC-2.
 *
 * The finding behind this file: the AI SDK's `jsonSchema()` wrapper returns `{ _type, jsonSchema, validate }`
 * with **`validate` undefined**. It constrains the provider's generation and validates nothing coming back. So
 * building structured output on a JSON schema would mean the platform promising a shape it never checks — a
 * softer version of the bug being fixed rather than a fix. Validating JSON schema properly needs `ajv`, a new
 * runtime dependency for every consumer of a package whose whole dependency list is `ai` and `zod`.
 *
 * Hence: fail closed, at wiring time, with a message naming the fix.
 */
import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { z } from "zod";
import { structuredValidator } from "../streaming.js";

describe("a Zod schema validates", () => {
  const validate = structuredValidator(z.object({ a: z.string(), n: z.number() }));

  it("accepts a conforming value", () => {
    expect(validate({ a: "x", n: 1 })).toEqual({ ok: true });
  });

  it("rejects a missing property, and says which", () => {
    const result = validate({ n: 1 });
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toMatch(/a/);
  });

  it("rejects a wrong type", () => {
    expect(validate({ a: "x", n: "not a number" }).ok).toBe(false);
  });

  it("rejects undefined — the shape a provider returns when it produced nothing", () => {
    expect(validate(undefined).ok).toBe(false);
  });

  it("rejects a string that merely looks like the JSON of a conforming value", () => {
    // The defect in miniature: text presented as a validated object. A caller reading `.value` would get a
    // string where it expected an object, and every consumer would have to re-parse and re-check.
    expect(validate('{"a":"x","n":1}').ok).toBe(false);
  });
});

describe("a bare JSON schema is refused, not silently unvalidated", () => {
  it("throws with a message naming the fix", () => {
    expect(() => structuredValidator({ type: "object", required: ["a"], properties: { a: { type: "string" } } })).toThrow(
      /needs a schema this process can validate/,
    );
  });

  it("throws for the SDK's own jsonSchema wrapper too", () => {
    // Which is the whole point: this is the object a caller would most plausibly reach for, and it is the one
    // that validates nothing.
    const wrapped = jsonSchema({ type: "object", properties: { a: { type: "string" } } }) as unknown;
    expect((wrapped as { validate?: unknown }).validate).toBeUndefined();
    expect(() => structuredValidator(wrapped)).toThrow(/needs a schema this process can validate/);
  });

  it("throws for absent, null and primitive schemas", () => {
    for (const bad of [undefined, null, "an object with a and n", 42, true]) {
      expect(() => structuredValidator(bad)).toThrow(/needs a schema this process can validate/);
    }
  });
});

describe("Standard Schema is accepted, so the seam is not Zod-only", () => {
  it("uses ~standard when present", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "object" && value !== null && "a" in value
            ? { value }
            : { issues: [{ message: "needs a", path: ["a"] }] },
      },
    };
    const validate = structuredValidator(schema);
    expect(validate({ a: 1 })).toEqual({ ok: true });
    const bad = validate({});
    expect(bad.ok).toBe(false);
    expect((bad as { detail: string }).detail).toBe("a: needs a");
  });

  it("refuses an asynchronous validator rather than treating a promise as success", () => {
    // A pending promise is truthy and has no `issues`, so the naive version of this check would report every
    // value valid — passing having checked nothing, which is worse than failing.
    const schema = {
      "~standard": { version: 1, vendor: "test", validate: async () => ({ value: {} }) },
    };
    const result = structuredValidator(schema)({ anything: true });
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toMatch(/asynchronously/);
  });
});
