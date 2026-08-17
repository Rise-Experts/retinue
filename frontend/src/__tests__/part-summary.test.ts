import { describe, expect, it } from "vitest";
import { partKey, partSummary } from "../ui/part-summary.js";
import type { MessagePart } from "../types/index.js";

const p = <T extends MessagePart>(x: T): T => x;

describe("partSummary", () => {
  it("classifies each part type into a stable render kind with a preview", () => {
    expect(partSummary(p({ id: "1", type: "text", schemaVersion: 1, createdAt: "t", text: "hello world" } as MessagePart))).toEqual({ kind: "text", preview: "hello world" });
    expect(partSummary(p({ id: "2", type: "tool-call", schemaVersion: 1, createdAt: "t", toolCallId: "tc", toolName: "search", input: {} } as MessagePart))).toMatchObject({ kind: "tool", preview: "search(…)" });
    expect(partSummary(p({ id: "3", type: "approval", schemaVersion: 1, createdAt: "t", interactionId: "i", toolName: "publish", summary: "post", riskCategory: "share" } as MessagePart))).toMatchObject({ kind: "interaction" });
    expect(partSummary(p({ id: "4", type: "error", schemaVersion: 1, createdAt: "t", error: { code: "internal", message: "boom", retryable: false } } as MessagePart))).toEqual({ kind: "error", preview: "boom" });
    expect(partSummary(p({ id: "5", type: "image", schemaVersion: 1, createdAt: "t", fileId: "f", mediaType: "image/png", altText: "chart" } as MessagePart))).toMatchObject({ kind: "attachment", preview: "chart" });
  });

  it("uses the part id as the stable key", () => {
    expect(partKey(p({ id: "abc", type: "text", schemaVersion: 1, createdAt: "t", text: "x" } as MessagePart))).toBe("abc");
  });
});
