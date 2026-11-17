import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";

import { DOCUMENT_CHARS, FULL_DOCUMENTS, createDocumentsContextProvider, documentIdsOf, documentsText, slideOutline } from "../documents.js";

/** #644 — the current text of the chat's documents, every turn. */
const A = "a4e8619c-9077-4fc0-8dff-9d30b24b7a8b";
const B = "d2f1b1b2-8837-421e-9d84-98b1d1c7a8f4";
const C = "d200edef-0bb3-4454-8600-91cd1f2ed836";
const msg = (role: string, parts: unknown[]) => ({ id: Math.random().toString(), role, parts }) as never;

const DECK = "<!-- format: 16:9 -->\n---\n# Retinue Agent Kit\nBuild durable agents.\n---\n## Why Retinue?\n- Durable\n---\n## 1️⃣ Basic Agent Setup\n```ts\n---\nconst agent = createAgent({})\n```";

describe("documentIdsOf", () => {
  it("finds documents from tool results, tool calls and references, newest first, once each", () => {
    const newestFirst = [
      msg("assistant", [{ type: "tool-call", toolName: "update_artifact", input: { artifactId: A } }, { type: "text", text: `see chorus-artifact:${C}` }]),
      msg("user", [{ type: "text", text: `Attach the document (chorus-artifact:${B})` }]),
      msg("assistant", [{ type: "tool-result", toolName: "create_artifact", output: { artifactId: A, reference: `chorus-artifact:${A}` } }]),
    ];
    expect(documentIdsOf(newestFirst)).toEqual([C, A, B]);
  });

  it("finds the document an execute_tool call touched", () => {
    expect(documentIdsOf([msg("assistant", [{ type: "tool-call", toolName: "execute_tool", input: { name: "get_artifact", input: { artifactId: B } } }])])).toEqual([B]);
  });
});

describe("slideOutline", () => {
  it("numbers the slides the way slideEdits counts them, ignoring a --- inside code", () => {
    expect(slideOutline(DECK)).toBe("1. Retinue Agent Kit\n2. Why Retinue?\n3. 1️⃣ Basic Agent Setup");
  });
});

describe("documentsText", () => {
  const doc = (id: string, over: Partial<{ title: string; kind: string; content: string; version: number }> = {}) =>
    ({ id, title: over.title ?? `Doc ${id.slice(0, 4)}`, kind: over.kind ?? "markdown", content: over.content ?? "Hello", version: over.version ?? 1, createdAt: "", updatedAt: "" }) as never;

  it("gives the newest documents in full, with id, kind, version and a slide outline", () => {
    const text = documentsText([doc(A, { title: "Quick Intro", kind: "slides", content: DECK, version: 2 })]);
    expect(text).toContain(`### Quick Intro — artifactId ${A} · slides · version 2`);
    expect(text).toContain("Slides (3):\n1. Retinue Agent Kit");
    expect(text).toContain("const agent = createAgent({})");
  });

  it("lists older documents by title only, and caps a long one", () => {
    const docs = [doc(A, { content: "x".repeat(DOCUMENT_CHARS + 500) }), doc(B), doc(C), doc("e1e1e1e1-0000-0000-0000-000000000000", { content: "SECRET-OLD" })];
    const text = documentsText(docs);
    expect(FULL_DOCUMENTS).toBe(3);
    expect(text).toContain("more characters — read the rest with get_artifact");
    expect(text).not.toContain("SECRET-OLD");
    expect(text).toContain("(Text not shown here — read it with get_artifact.)");
  });
});

describe("the provider", () => {
  const context = { tenantId: "t", conversationId: "c" } as unknown as ExecutionContext;

  it("reads the latest version of each document, as data in the knowledge bucket", async () => {
    const provider = createDocumentsContextProvider({
      messages: { async listByConversation() { return { items: [msg("assistant", [{ type: "tool-result", toolName: "create_artifact", output: { artifactId: A } }])], nextCursor: null }; } } as never,
      artifacts: { async get() { return { id: A, title: "Deck", kind: "slides", content: DECK, version: 3, createdAt: "", updatedAt: "" }; } } as never,
    });
    const [section] = await provider.provide(context);
    expect(section).toMatchObject({ providerId: "shareflow.documents", kind: "knowledge", origin: "external" });
    expect(section!.body).toContain("version 3");
  });

  it("leaves out a document it cannot read, and says nothing when there are none", async () => {
    const provider = createDocumentsContextProvider({
      messages: { async listByConversation() { return { items: [msg("user", [{ type: "text", text: `chorus-artifact:${A}` }])], nextCursor: null }; } } as never,
      artifacts: { async get() { throw new Error("not found"); } } as never,
    });
    expect(await provider.provide(context)).toEqual([]);
  });
});
