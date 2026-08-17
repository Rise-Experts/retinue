import { describe, expect, it } from "vitest";
import {
  MESSAGE_PART_TYPES,
  parseExecutionContext,
  parseMessagePart,
  parseRunEvent,
  serializeMessagePart,
  type MessagePart,
} from "../core/index.js";

// A valid sample for every part type, so the round-trip test covers all 13.
const samples: Record<string, MessagePart> = {
  text: { id: "p1", type: "text", schemaVersion: 1, createdAt: "t", text: "hi" } as MessagePart,
  reasoning: { id: "p2", type: "reasoning", schemaVersion: 1, createdAt: "t", text: "think", redacted: true } as MessagePart,
  "tool-call": { id: "p3", type: "tool-call", schemaVersion: 1, createdAt: "t", toolCallId: "tc1", toolName: "create_post", input: { a: 1 } } as MessagePart,
  "tool-result": { id: "p4", type: "tool-result", schemaVersion: 1, createdAt: "t", toolCallId: "tc1", toolName: "create_post", output: { ok: true }, truncated: false } as MessagePart,
  question: { id: "p5", type: "question", schemaVersion: 1, createdAt: "t", interactionId: "i1", questions: [{ key: "q", prompt: "why?", options: ["a", "b"] }] } as MessagePart,
  approval: { id: "p6", type: "approval", schemaVersion: 1, createdAt: "t", interactionId: "i2", toolName: "publish_post", summary: "publish", riskCategory: "external-write" } as MessagePart,
  file: { id: "p7", type: "file", schemaVersion: 1, createdAt: "t", fileId: "f1", filename: "a.pdf", mediaType: "application/pdf", byteSize: 10 } as MessagePart,
  image: { id: "p8", type: "image", schemaVersion: 1, createdAt: "t", fileId: "f2", mediaType: "image/png", width: 100, height: 50 } as MessagePart,
  citation: { id: "p9", type: "citation", schemaVersion: 1, createdAt: "t", sourceId: "s1", quote: "q", locator: "p.2" } as MessagePart,
  source: { id: "p10", type: "source", schemaVersion: 1, createdAt: "t", sourceId: "s1", title: "Doc", url: "https://x" } as MessagePart,
  artifact: { id: "p11", type: "artifact", schemaVersion: 1, createdAt: "t", artifactId: "a1", versionId: "v1", title: "Report" } as MessagePart,
  status: { id: "p12", type: "status", schemaVersion: 1, createdAt: "t", status: "running", detail: "step 1" } as MessagePart,
  error: { id: "p13", type: "error", schemaVersion: 1, createdAt: "t", error: { code: "internal", message: "boom", retryable: false } } as MessagePart,
};

describe("message part validation", () => {
  it("covers all 13 declared part types", () => {
    expect(Object.keys(samples).sort()).toEqual([...MESSAGE_PART_TYPES].sort());
  });

  it("round-trips every part through serialize + parse", () => {
    for (const part of Object.values(samples)) {
      expect(parseMessagePart(serializeMessagePart(part))).toEqual(part);
    }
  });

  it("rejects an unknown part type", () => {
    expect(() => parseMessagePart({ id: "x", type: "nope", schemaVersion: 1, createdAt: "t" })).toThrow(/invalid/i);
  });

  it("rejects a part missing a required field", () => {
    expect(() => parseMessagePart({ id: "x", type: "text", schemaVersion: 1, createdAt: "t" })).toThrow(/invalid/i);
  });

  it("requires a schemaVersion", () => {
    expect(() => parseMessagePart({ id: "x", type: "text", createdAt: "t", text: "hi" })).toThrow(/invalid/i);
  });

  it("providerMetadata is preserved but non-authoritative (cannot change the type)", () => {
    const part = parseMessagePart({
      id: "x", type: "text", schemaVersion: 1, createdAt: "t", text: "hi",
      providerMetadata: { type: "tool-call", effect: "destructive" },
    });
    expect(part.type).toBe("text"); // discriminated on the real field, not providerMetadata
    expect(part.providerMetadata).toEqual({ type: "tool-call", effect: "destructive" });
  });
});

describe("execution context validation", () => {
  it("accepts a valid context and rejects a missing tenantId", () => {
    const ctx = { tenantId: "t1", principalId: "u1", roleIds: ["admin"], locale: "en", timezone: "UTC", requestId: "r1" };
    expect(parseExecutionContext(ctx)).toMatchObject({ tenantId: "t1" });
    expect(() => parseExecutionContext({ ...ctx, tenantId: "" })).toThrow(/invalid/i);
  });
});

describe("run event validation", () => {
  it("accepts a known event and rejects an unknown type", () => {
    expect(parseRunEvent({ type: "run.started", runId: "r1", sequence: 1, occurredAt: "t" })).toMatchObject({ type: "run.started" });
    expect(() => parseRunEvent({ type: "run.exploded", runId: "r1", sequence: 1, occurredAt: "t" })).toThrow(/invalid/i);
  });
});
