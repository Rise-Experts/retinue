import { describe, expect, it } from "vitest";
import {
  MESSAGE_PART_TYPES,
  parseExecutionContext,
  parseMessagePart,
  parseRunEvent,
  serializeMessagePart,
  type MessagePart,
} from "../core/index.js";

import { asId } from "../core/ids.js";
import type { ArtifactId, ArtifactVersionId, FileId, InteractionId, MessagePartId } from "../core/ids.js";
// A valid sample for every part type, so the round-trip test covers all 13.
const samples: Record<string, MessagePart> = {
  text: { id: asId<MessagePartId>("p1"), type: "text", schemaVersion: 1, createdAt: "t", text: "hi" } as MessagePart,
  reasoning: { id: asId<MessagePartId>("p2"), type: "reasoning", schemaVersion: 1, createdAt: "t", text: "think", redacted: true } as MessagePart,
  "tool-call": { id: asId<MessagePartId>("p3"), type: "tool-call", schemaVersion: 1, createdAt: "t", toolCallId: "tc1", toolName: "create_post", input: { a: 1 } } as MessagePart,
  "tool-result": { id: asId<MessagePartId>("p4"), type: "tool-result", schemaVersion: 1, createdAt: "t", toolCallId: "tc1", toolName: "create_post", output: { ok: true }, truncated: false } as MessagePart,
  question: { id: asId<MessagePartId>("p5"), type: "question", schemaVersion: 1, createdAt: "t", interactionId: asId<InteractionId>("i1"), questions: [{ key: "q", prompt: "why?", options: ["a", "b"] }] } as MessagePart,
  approval: { id: asId<MessagePartId>("p6"), type: "approval", schemaVersion: 1, createdAt: "t", interactionId: asId<InteractionId>("i2"), toolName: "publish_post", summary: "publish", riskCategory: "external-write" } as MessagePart,
  file: { id: asId<MessagePartId>("p7"), type: "file", schemaVersion: 1, createdAt: "t", fileId: asId<FileId>("f1"), filename: "a.pdf", mediaType: "application/pdf", byteSize: 10 } as MessagePart,
  image: { id: asId<MessagePartId>("p8"), type: "image", schemaVersion: 1, createdAt: "t", fileId: asId<FileId>("f2"), mediaType: "image/png", width: 100, height: 50 } as MessagePart,
  // #137. Self-contained on purpose: the excerpt and the retrieval time live on the part so an audit months
  // later works after the source is gone.
  citation: {
    id: asId<MessagePartId>("p9"), type: "citation", schemaVersion: 2, createdAt: "t",
    origin: { kind: "retrieval", sourceType: "file", sourceId: "s1", chunkId: "file:s1:2", chunkIndex: 2, locator: "Report > Findings" },
    excerpt: "Revenue rose nine percent.", retrievedAt: "2026-08-23T10:00:00.000Z", supports: [asId<MessagePartId>("p1")],
  } as MessagePart,
  source: { id: asId<MessagePartId>("p10"), type: "source", schemaVersion: 1, createdAt: "t", sourceId: "s1", title: "Doc", url: "https://x" } as MessagePart,
  artifact: { id: asId<MessagePartId>("p11"), type: "artifact", schemaVersion: 1, createdAt: "t", artifactId: asId<ArtifactId>("a1"), versionId: asId<ArtifactVersionId>("v1"), title: "Report" } as MessagePart,
  status: { id: asId<MessagePartId>("p12"), type: "status", schemaVersion: 1, createdAt: "t", status: "running", detail: "step 1" } as MessagePart,
  error: { id: asId<MessagePartId>("p13"), type: "error", schemaVersion: 1, createdAt: "t", error: { code: "internal", message: "boom", retryable: false } } as MessagePart,
  // A structured agent's validated answer — #243. The value is arbitrary JSON by design: the schema that
  // constrains it belongs to the agent, not to the part.
  structured: { id: asId<MessagePartId>("p14"), type: "structured", schemaVersion: 1, createdAt: "t", value: { sentiment: "mixed", score: 0.5, tags: ["a", "b"] } } as MessagePart,
};

describe("message part validation", () => {
  it("covers all 14 declared part types", () => {
    expect(Object.keys(samples).sort()).toEqual([...MESSAGE_PART_TYPES].sort());
  });

  it("round-trips every part through serialize + parse", () => {
    for (const part of Object.values(samples)) {
      expect(parseMessagePart(serializeMessagePart(part))).toEqual(part);
    }
  });

  /**
   * Variants of a part type that `samples` cannot hold.
   *
   * `samples` is keyed by part type and a guard asserts the keys *are* the part types — which is what keeps a
   * new part type from going untested. A second shape of an existing type therefore lives here rather than
   * weakening that guard.
   */
  const variants: readonly MessagePart[] = [
    {
      id: asId<MessagePartId>("p9w"), type: "citation", schemaVersion: 2, createdAt: "t",
      origin: { kind: "web", url: "https://example.test/report", title: "Annual report" },
      excerpt: "Revenue rose nine percent.", retrievedAt: "2026-08-23T10:00:00.000Z", supports: [asId<MessagePartId>("p1")],
      charRange: { start: 10, end: 40 },
    } as MessagePart,
  ];

  it("round-trips a web citation, which is the other arm of the same part", () => {
    for (const part of variants) expect(parseMessagePart(serializeMessagePart(part))).toEqual(part);
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

describe("a structured part must carry a value — #243", () => {
  it("rejects a structured part with no value", () => {
    // `z.unknown()` accepts `undefined`, so without the refinement a part claiming to be a validated answer
    // could round-trip carrying nothing: the empty version of the defect #243 fixed.
    expect(() =>
      parseMessagePart({ id: asId<MessagePartId>("p14"), type: "structured", schemaVersion: 1, createdAt: "t" }),
    ).toThrow(/must carry a value/);
  });

  it("accepts null, which is a legal JSON value a schema may permit", () => {
    const part = parseMessagePart({ id: asId<MessagePartId>("p14"), type: "structured", schemaVersion: 1, createdAt: "t", value: null });
    expect((part as { value: unknown }).value).toBeNull();
  });

  it("preserves a nested value through serialize + parse without reshaping it", () => {
    // The value is the agent's, not this layer's. Anything that normalises it here would silently change what a
    // caller validated against their own schema.
    const value = { a: [1, { b: "two" }], c: { d: null }, e: false };
    const part = { id: asId<MessagePartId>("p14"), type: "structured" as const, schemaVersion: 1, createdAt: "t", value };
    expect(parseMessagePart(serializeMessagePart(part as never))).toEqual(part);
  });
});
