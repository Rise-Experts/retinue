/**
 * Citations and per-claim provenance (#137).
 *
 * Two tests carry the weight, and both are about *durability* and *permission* rather than about shape:
 *
 * - An answer must stay auditable after its source is gone. Tested by deleting the source and resolving the
 *   stored part, which is the only way to prove the part is a snapshot rather than a pointer.
 * - A permission revoked between retrieval and rendering must withhold the citation. Tested by doing exactly
 *   that, because a check at retrieval time passes this test's first half and fails its second.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { MessageId, MessagePartId, PrincipalId, RequestId, TenantId } from "../core/ids.js";
import type { ExecutionContext } from "../core/context.js";
import type { CitationPart, MessagePart } from "../core/content-parts.js";
import { MAX_CITATION_EXCERPT, parseMessagePart, serializeMessagePart } from "../core/validation.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { createMemoryKnowledgeBackend, createMemoryMessageStore } from "../adapters/memory/index.js";
import { EMBEDDING_DIMENSIONS, type EmbeddingModelRef } from "../persistence/index.js";
import {
  boundExcerpt,
  citationsFor,
  citationFromRetrieval,
  citationFromWeb,
  createCitationEmitter,
  danglingCitations,
  groundedPartIds,
  resolveCitation,
} from "../citations/index.js";
import type { RetrievalHit } from "../knowledge/retrieval.js";
import { createEmbeddingPipeline, createRetriever, type EmbeddingProvider } from "../knowledge/index.js";

const T1 = asId<TenantId>("tenant-1");
const MODEL: EmbeddingModelRef = { modelId: "e", version: "1", dimensions: EMBEDDING_DIMENSIONS };

const ctx = (): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("user-1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId<RequestId>("req-1"),
});

const policy = (deny: readonly string[] = []): AuthorizationPolicy => ({
  async can(_context, _action, resource) {
    return { allow: !(resource.id !== undefined && deny.includes(resource.id)) };
  },
  filterTools() {
    throw new Error("unused");
  },
  scope() {
    throw new Error("unused");
  },
});

/** A mutable policy, so a permission can be revoked *between* retrieval and emission. */
const revocablePolicy = () => {
  const denied = new Set<string>();
  return {
    revoke: (subject: string) => denied.add(subject),
    policy: {
      async can(_context: ExecutionContext, _action: string, resource: { id?: string }) {
        return { allow: !(resource.id !== undefined && denied.has(resource.id)) };
      },
      filterTools() {
        throw new Error("unused");
      },
      scope() {
        throw new Error("unused");
      },
    } as AuthorizationPolicy,
  };
};

const hit = (overrides: Partial<RetrievalHit["chunk"]> = {}): RetrievalHit => {
  const chunk = {
    id: "file:report:2",
    sourceType: "file" as const,
    sourceId: "report",
    chunkIndex: 2,
    content: "Revenue rose nine percent across EMEA in the third quarter.",
    tokenCount: 12,
    authSubject: "convo-1",
    embeddingModel: MODEL,
    locator: "Quarterly Review > By region",
    createdAt: "2026-08-23T09:00:00.000Z",
    ...overrides,
  };
  return {
    chunk,
    score: 0.9,
    signals: ["semantic"],
    reference: {
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.id,
      ...(chunk.locator === undefined ? {} : { locator: chunk.locator }),
    },
  };
};

const emitter = (authorization: AuthorizationPolicy = policy()) => {
  let n = 0;
  return createCitationEmitter({
    authorization,
    clock: () => "2026-08-23T10:00:00.000Z",
    partId: () => `cite-${++n}`,
  });
};

const CLAIM = asId<MessagePartId>("claim-1");

describe("AC-1: a grounded statement carries source, locator and excerpt", () => {
  it("builds a citation from a retrieval hit", async () => {
    const { parts, withheld } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "2026-08-23T09:30:00.000Z" }),
    ]);
    expect(withheld).toBe(0);
    expect(parts[0]).toMatchObject({
      type: "citation",
      origin: {
        kind: "retrieval",
        sourceType: "file",
        sourceId: "report",
        chunkId: "file:report:2",
        chunkIndex: 2,
        locator: "Quarterly Review > By region",
      },
      excerpt: "Revenue rose nine percent across EMEA in the third quarter.",
      retrievedAt: "2026-08-23T09:30:00.000Z",
      supports: [CLAIM],
    });
  });

  it("takes the excerpt from the chunk that was used, not from a re-read", async () => {
    // What was *used* is what must be cited. Re-reading the source would cite text the answer never saw.
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({
        hit: hit({ content: "The exact sentence the answer relied on." }),
        supports: [CLAIM],
        retrievedAt: "2026-08-23T09:30:00.000Z",
      }),
    ]);
    expect(parts[0]?.excerpt).toBe("The exact sentence the answer relied on.");
  });

  it("refuses a citation with no excerpt, since that is not evidence", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "2026-08-23T09:00:00.000Z", excerpt: "  " },
        supports: [CLAIM],
      }),
    ]);
    // The schema's `min(1)` is the backstop; the emitter produces the part and validation rejects it, which is
    // the loud failure rather than a citation nobody can read.
    expect(() => parseMessagePart(serializeMessagePart(parts[0] as MessagePart))).toThrow();
  });

  it("bounds an excerpt without cutting a word in half", () => {
    // A citation ending mid-word reads as corrupt, and a reader cannot tell whether the source said something
    // else. And unbounded, an excerpt is a way to store a document inside a message.
    const long = `${"word ".repeat(1000)}end`;
    const bounded = boundExcerpt(long);
    expect(bounded.length).toBeLessThanOrEqual(MAX_CITATION_EXCERPT);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toMatch(/wor…$/);
  });
});

describe("AC-2: a citation resolves to the passage, not the document", () => {
  it("resolves to the chunk and its heading path", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "2026-08-23T09:30:00.000Z" }),
    ]);
    expect(resolveCitation(parts[0] as CitationPart)).toMatchObject({
      label: "Quarterly Review > By region",
      target: "file:report:2",
      kind: "retrieval",
    });
  });

  it("still names the passage when the chunker found no heading", async () => {
    // A bare document name would be AC-2 unmet. The position is less useful than a heading and still more
    // specific than "somewhere in this file".
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({
        hit: hit({ locator: undefined }),
        supports: [CLAIM],
        retrievedAt: "2026-08-23T09:30:00.000Z",
      }),
    ]);
    expect(resolveCitation(parts[0] as CitationPart).label).toBe("report — passage 3");
  });

  it("carries a character range when the producer knows one", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({
        hit: hit(),
        supports: [CLAIM],
        retrievedAt: "2026-08-23T09:30:00.000Z",
        charRange: { start: 12, end: 44 },
      }),
    ]);
    expect(parts[0]?.charRange).toEqual({ start: 12, end: 44 });
  });

  it("rejects an inverted character range", () => {
    // An inverted range silently produces an empty highlight, which reads as "the passage is not in the source".
    expect(() =>
      parseMessagePart({
        id: "c", type: "citation", schemaVersion: 2, createdAt: "t",
        origin: { kind: "web", url: "https://example.test/a" },
        excerpt: "x", retrievedAt: "t", supports: [], charRange: { start: 40, end: 10 },
      }),
    ).toThrow(/charRange/);
  });

  it("resolves an end-to-end retrieval hit to the passage it came from", async () => {
    // Through the real retriever, so the reference the citation copies is the one retrieval produced rather
    // than a hand-built one that could disagree with it.
    const backend = createMemoryKnowledgeBackend();
    const embeddings: EmbeddingProvider = {
      model: MODEL,
      async embed(texts) {
        return texts.map((text) => {
          const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
          for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
            let h = 2166136261;
            for (const ch of word) {
              h ^= ch.charCodeAt(0);
              h = Math.imul(h, 16777619) >>> 0;
            }
            const axis = h % EMBEDDING_DIMENSIONS;
            v[axis] = (v[axis] ?? 0) + 1;
          }
          return v;
        });
      },
    };
    await createEmbeddingPipeline({ knowledge: backend.store, embeddings, clock: () => "2026-08-23T09:00:00.000Z" })
      .indexSource({ tenantId: T1 }, {
        sourceType: "file",
        sourceId: "report",
        blocks: [
          { kind: "heading", level: 1, text: "Quarterly Review" },
          { kind: "heading", level: 2, text: "By region" },
          { kind: "paragraph", text: "Revenue rose nine percent across EMEA." },
        ],
        authSubject: "convo-1",
      });
    const outcome = await createRetriever({
      vector: backend.index,
      keyword: backend.keyword,
      embeddings,
    }).retrieve({ tenantId: T1 }, { query: "revenue EMEA", authSubjects: ["convo-1"], limit: 1 });
    if (!outcome.found) throw new Error("expected a hit");

    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({
        hit: outcome.hits[0]!,
        supports: [CLAIM],
        retrievedAt: "2026-08-23T09:30:00.000Z",
      }),
    ]);
    const resolved = resolveCitation(parts[0] as CitationPart);
    expect(resolved.label).toBe("Quarterly Review > By region");
    expect(resolved.target).toBe(outcome.hits[0]?.reference.chunkId);
    expect(parts[0]?.excerpt).toContain("Revenue rose nine percent");
  });
});

describe("AC-3: grounded and ungrounded statements are structurally distinguishable", () => {
  const text = (id: string): MessagePart =>
    ({ id: asId<MessagePartId>(id), type: "text", schemaVersion: 1, createdAt: "t", text: `claim ${id}` }) as MessagePart;

  it("derives groundedness from the citation graph", async () => {
    // Derived, not flagged. A boolean on the text part would be a second place for the same fact, and the two
    // would drift the first time a citation was withheld.
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [asId<MessagePartId>("a")], retrievedAt: "t" }),
    ]);
    const all = [text("a"), text("b"), ...parts];
    const grounded = groundedPartIds(all);
    expect(grounded.has("a")).toBe(true);
    expect(grounded.has("b")).toBe(false);
  });

  it("needs no inspection of the prose", () => {
    // The requirement is "without heuristics on the text". A claim that *mentions* a source is not grounded;
    // one a citation names is.
    const looksCited: MessagePart = {
      id: asId<MessagePartId>("c"),
      type: "text",
      schemaVersion: 1,
      createdAt: "t",
      text: "According to the Q3 report [1], revenue rose.",
    } as MessagePart;
    expect(groundedPartIds([looksCited]).has("c")).toBe(false);
  });

  it("lists the citations for a claim, in order", async () => {
    const e = emitter();
    const { parts } = await e.emit(ctx(), [
      citationFromRetrieval({ hit: hit({ id: "file:report:1", chunkIndex: 1 }), supports: [CLAIM], retrievedAt: "t" }),
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "Also true." },
        supports: [CLAIM],
      }),
      citationFromWeb({
        passage: { url: "https://example.test/b", retrievedAt: "t", excerpt: "Unrelated." },
        supports: [asId<MessagePartId>("other")],
      }),
    ]);
    expect(citationsFor(parts, CLAIM).map((c) => c.id)).toEqual(["cite-1", "cite-2"]);
  });

  it("finds a citation that grounds nothing", async () => {
    // The shape a bug takes: citations in a list at the bottom, no individual statement traceable. That is an
    // answer that *looks* cited, which is the failure REQ-030 exists to prevent.
    const { parts } = await emitter().emit(ctx(), [
      citationFromWeb({ passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "x" }, supports: [] }),
      citationFromWeb({
        passage: { url: "https://example.test/b", retrievedAt: "t", excerpt: "y" },
        // Names a part that does not exist in the message — equally dangling, and harder to spot.
        supports: [asId<MessagePartId>("ghost")],
      }),
    ]);
    expect(danglingCitations([text("a"), ...parts]).map((c) => c.id)).toEqual(["cite-1", "cite-2"]);
  });

  it("does not call a citation dangling when its claim is present", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "x" },
        supports: [asId<MessagePartId>("a")],
      }),
    ]);
    expect(danglingCitations([text("a"), ...parts])).toEqual([]);
  });
});

describe("AC-4: provenance is durable and auditable months later", () => {
  it("resolves after the source is deleted", async () => {
    // The test step, and the reason the part is a snapshot rather than a pointer. Everything the audit needs is
    // on the part, so deleting the source cannot change the answer.
    const backend = createMemoryKnowledgeBackend();
    await backend.store.replaceSource({
      tenantId: T1,
      sourceType: "file",
      sourceId: "report",
      chunks: [
        {
          id: "file:report:2",
          sourceType: "file",
          sourceId: "report",
          chunkIndex: 2,
          content: "Revenue rose nine percent across EMEA in the third quarter.",
          tokenCount: 12,
          authSubject: "convo-1",
          embeddingModel: MODEL,
          locator: "Quarterly Review > By region",
          createdAt: "2026-08-23T09:00:00.000Z",
          embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01),
        },
      ],
    });
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "2026-08-23T09:30:00.000Z" }),
    ]);

    // The source goes.
    await backend.store.deleteSource({ tenantId: T1, sourceType: "file", sourceId: "report" });
    expect(await backend.store.get({ tenantId: T1, id: "file:report:2" })).toBeNull();

    // The provenance does not.
    const resolved = resolveCitation(parts[0] as CitationPart);
    expect(resolved.excerpt).toBe("Revenue rose nine percent across EMEA in the third quarter.");
    expect(resolved.retrievedAt).toBe("2026-08-23T09:30:00.000Z");
    expect(resolved.label).toBe("Quarterly Review > By region");
  });

  it("survives storage and re-parsing with every field intact", async () => {
    // An audit reads a stored message. A field lost through `jsonb` would make the citation unresolvable in
    // exactly the situation it exists for.
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({
        hit: hit(),
        supports: [CLAIM],
        retrievedAt: "2026-08-23T09:30:00.000Z",
        charRange: { start: 0, end: 20 },
      }),
    ]);
    const messages = createMemoryMessageStore();
    messages.append(T1, {
      id: asId<MessageId>("msg-1"),
      conversationId: asId("convo-1"),
      role: "assistant",
      parts: [
        { id: CLAIM, type: "text", schemaVersion: 1, createdAt: "t", text: "Revenue rose." } as MessagePart,
        ...parts,
      ],
      createdAt: "2026-08-23T10:00:00.000Z",
    });
    const stored = (await messages.listByConversation({ tenantId: T1, conversationId: asId("convo-1"), limit: 5 }))
      .items[0]?.parts;
    const reparsed = (stored ?? []).map((p) => parseMessagePart(serializeMessagePart(p)));
    expect(reparsed[1]).toEqual(parts[0]);
    // And the graph still says which claim it grounds.
    expect(groundedPartIds(reparsed).has(CLAIM)).toBe(true);
  });

  it("does not carry the auth subject into the stored part", async () => {
    // A durable part must not carry a permission claim nobody re-evaluates: months later the subject may mean
    // something different, and a reader trusting it would be trusting a stale check.
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
    ]);
    expect(Object.keys(parts[0] ?? {})).not.toContain("authSubject");
  });
});

describe("AC-5: a citation the reader may not open is never emitted", () => {
  it("withholds a citation whose source the reader cannot read", async () => {
    const { parts, withheld } = await emitter(policy(["convo-1"])).emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
    ]);
    expect(parts).toEqual([]);
    expect(withheld).toBe(1);
  });

  it("checks at citation time, not at retrieval time", async () => {
    // The case the test steps name and the one a retrieval-time check fails: the permission is revoked *between*
    // the retrieval that produced the candidate and the emission that renders it.
    const { policy: mutable, revoke } = revocablePolicy();
    const e = emitter(mutable);
    const candidate = citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" });

    // Allowed at retrieval time.
    expect(await e.mayCite(ctx(), candidate)).toBe(true);
    revoke("convo-1");
    // Withheld at emission time, from the very same candidate.
    const { parts, withheld } = await e.emit(ctx(), [candidate]);
    expect(parts).toEqual([]);
    expect(withheld).toBe(1);
  });

  it("emits the permitted citations and withholds only the rest", async () => {
    const { parts, withheld } = await emitter(policy(["convo-secret"])).emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
      citationFromRetrieval({
        hit: hit({ id: "file:secret:0", sourceId: "secret", chunkIndex: 0, authSubject: "convo-secret" }),
        supports: [CLAIM],
        retrievedAt: "t",
      }),
    ]);
    expect(parts.map((p) => p.origin.kind === "retrieval" && p.origin.sourceId)).toEqual(["report"]);
    expect(withheld).toBe(1);
  });

  it("withholds a retrieval citation with no subject to check", async () => {
    // Failing closed is the only safe direction: the alternative emits an excerpt nobody authorised.
    const e = emitter();
    const unchecked = { ...citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }), authSubject: undefined };
    const { parts, withheld } = await e.emit(ctx(), [unchecked]);
    expect(parts).toEqual([]);
    expect(withheld).toBe(1);
  });

  it("does not ask the policy about a public web source", async () => {
    // Asking about a resource the policy has never heard of is asking a question most policies answer by
    // denying — which would silently suppress every web citation.
    let asked = 0;
    const counting: AuthorizationPolicy = {
      async can() {
        asked += 1;
        return { allow: false };
      },
      filterTools() {
        throw new Error("unused");
      },
      scope() {
        throw new Error("unused");
      },
    };
    const { parts, withheld } = await emitter(counting).emit(ctx(), [
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "Public text." },
        supports: [CLAIM],
      }),
    ]);
    expect(asked).toBe(0);
    expect(parts).toHaveLength(1);
    expect(withheld).toBe(0);
  });

  it("reports the withheld count so a caller can drop the claim instead", async () => {
    // A withheld citation leaves its claim looking ungrounded. A caller that cannot tell "nothing supported
    // this" from "you may not see what supported this" will present the two identically.
    const { parts, withheld } = await emitter(policy(["convo-1"])).emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
    ]);
    expect(groundedPartIds(parts).has(CLAIM)).toBe(false);
    expect(withheld).toBeGreaterThan(0);
  });
});

describe("AC-6: retrieval and web citations share one representation", () => {
  it("produces the same part type for both", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "From the web." },
        title: "A page",
        supports: [CLAIM],
      }),
    ]);
    expect(parts.map((p) => p.type)).toEqual(["citation", "citation"]);
    // Same fields, differing only in the origin arm — which is the difference that is real.
    for (const part of parts) {
      expect(part).toMatchObject({
        excerpt: expect.any(String),
        retrievedAt: expect.any(String),
        supports: [CLAIM],
      });
    }
    expect(parts.map((p) => p.origin.kind)).toEqual(["retrieval", "web"]);
  });

  it("resolves both to a label, a target and an excerpt", async () => {
    // One renderer. A frontend switching on `origin.kind` for a *link* is fine; one switching on it for the
    // whole shape would be two renderers wearing one name.
    const { parts } = await emitter().emit(ctx(), [
      citationFromRetrieval({ hit: hit(), supports: [CLAIM], retrievedAt: "t" }),
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "From the web." },
        title: "A page",
        supports: [CLAIM],
      }),
    ]);
    for (const part of parts) {
      const resolved = resolveCitation(part);
      expect(resolved.label).toBeTruthy();
      expect(resolved.target).toBeTruthy();
      expect(resolved.excerpt).toBeTruthy();
    }
    expect(resolveCitation(parts[1] as CitationPart)).toMatchObject({
      label: "A page",
      target: "https://example.test/a",
      kind: "web",
    });
  });

  it("falls back to the URL when a web source has no title", async () => {
    const { parts } = await emitter().emit(ctx(), [
      citationFromWeb({
        passage: { url: "https://example.test/a", retrievedAt: "t", excerpt: "x" },
        supports: [CLAIM],
      }),
    ]);
    expect(resolveCitation(parts[0] as CitationPart).label).toBe("https://example.test/a");
  });

  it("refuses a web citation that is not an openable http url", () => {
    // A `data:` or `file:` citation is not a source anyone can open, and a relative URL resolves against
    // whatever page happens to render it.
    for (const url of ["data:text/plain,hello", "file:///etc/passwd", "/relative/path", "javascript:alert(1)"]) {
      expect(() =>
        parseMessagePart({
          id: "c", type: "citation", schemaVersion: 2, createdAt: "t",
          origin: { kind: "web", url },
          excerpt: "x", retrievedAt: "t", supports: [],
        }),
      ).toThrow();
    }
  });
});
