import { describe, expect, it } from "vitest";
import { formatByteSize, partKey, partSummary } from "../ui/part-summary.js";
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

describe("attachment references (#130)", () => {
  const file = (overrides: Record<string, unknown> = {}) =>
    p({
      id: "f-part",
      type: "file",
      schemaVersion: 1,
      createdAt: "t",
      fileId: "file-1",
      filename: "q3.csv",
      mediaType: "text/csv",
      byteSize: 4096,
      ...overrides,
    } as MessagePart);

  it("renders a file part with no reducer change", () => {
    // AC-5. `file` was already in the `KIND` table, so an attachment reference flows through the generic
    // typed-part path — this asserts that rather than assuming it, because "no change needed" is a claim.
    expect(partSummary(file())).toEqual({ kind: "attachment", preview: "q3.csv · 4.0 KB" });
  });

  it("shows the size a human expects at each scale", () => {
    // Pinned strings, because R2 makes this formatter a copy of the backend's: a divergence has to break a
    // test rather than turn up as "the UI says 104.9 MB and the assistant says 100 MB".
    expect(formatByteSize(0, "en")).toBe("0 B");
    expect(formatByteSize(999, "en")).toBe("999 B");
    expect(formatByteSize(1024, "en")).toBe("1.0 KB");
    expect(formatByteSize(100 * 1024 * 1024, "en")).toBe("100 MB");
    expect(formatByteSize(5 * 1024 ** 4, "en")).toBe("5.0 TB");
  });

  it("uses binary units, not the decimal ones Intl's compact notation would give", () => {
    // 100 MiB is "100 MB" here and "104.9MB" under `notation: "compact"`. The model is told the former, so
    // the UI must be too.
    expect(formatByteSize(104_857_600, "en")).toBe("100 MB");
  });

  it("previews an attachment without any of its content", () => {
    // The part carries no content field at all, so this is really an assertion about the type — kept because
    // it is the property the whole issue exists to hold, and a future field would break it here first.
    const summary = partSummary(file({ filename: "secrets.csv" }));
    expect(summary.preview).toBe("secrets.csv · 4.0 KB");
    expect(Object.keys(file())).not.toContain("content");
  });
});
