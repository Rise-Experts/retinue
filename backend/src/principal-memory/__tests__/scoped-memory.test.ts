/**
 * Scoped memory — #285. What a project's chats have taught, known to every chat in the project.
 *
 * Against the reference adapter here; `src/__tests__/postgres-scoped-memory.test.ts` runs AC-1 and AC-2 against
 * Postgres (PGlite by default, a real server with `RETINUE_TEST_PG_URL`), and the conformance harness holds every
 * adapter to the same isolation and confirmation rules.
 *
 * - **AC-1** a memory written in one conversation of a scope appears in the next conversation of the same scope,
 *   and never in another scope or tenant.
 * - **AC-2** forget removes it from the next turn's context.
 * - **AC-3** the section respects a byte budget and reports its size to the context-budget accounting.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import { createMemoryScopedMemoryStore } from "../../adapters/memory/index.js";
import { assemblePrompt, type ContextBudget } from "../../context/index.js";
import { estimateTokens } from "../../core/tokens.js";
import {
  commitExtractedScopedMemories,
  createScopedMemoryProvider,
  MEMORY_LIMITS,
  parseMemoryScope,
} from "../index.js";

const T1 = asId<TenantId>("t1");
const T2 = asId<TenantId>("t2");
const PROJECT = "project:p-1";
const OTHER = "project:p-2";

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("alice"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req"),
  conversationId: asId<ConversationId>("chat-1"),
  runId: asId<RunId>("run-1"),
  memoryScopes: [PROJECT],
  ...over,
});

const bodies = async (provider: ReturnType<typeof createScopedMemoryProvider>, context: ExecutionContext) =>
  (await provider.provide(context)).map((s) => s.body).join("\n");

describe("scope names", () => {
  it("parses kind:id", () => {
    expect(parseMemoryScope("project:7f3c-aa")).toEqual({ kind: "project", id: "7f3c-aa" });
    // Only the first colon splits: an id may itself contain one (a URN, a composite key).
    expect(parseMemoryScope("team:org:42")).toEqual({ kind: "team", id: "org:42" });
  });

  it.each([
    ["no id", "project"],
    ["empty id", "project:"],
    ["uppercase kind", "Project:1"],
    ["whitespace in the id", "project:a b"],
    ["the reserved kind", "principal:alice"],
  ])("refuses %s", (_why, scope) => {
    expect(() => parseMemoryScope(scope)).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});

describe("AC-1 — one conversation teaches, the next one knows; no other scope or tenant does", () => {
  it("flows from chat 1 to chat 2 of the same project", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "Never say revolutionary" }],
    });

    const provider = createScopedMemoryProvider({ store });
    // Bob, a different person, in a different chat of the same project.
    const next = ctx({ principalId: asId<PrincipalId>("bob"), conversationId: asId<ConversationId>("chat-2"), runId: asId<RunId>("run-2") });
    expect(await bodies(provider, next)).toContain("Never say revolutionary");

    // Another project in the same tenant, and the same project name in another tenant: nothing.
    expect(await provider.provide(ctx({ memoryScopes: [OTHER] }))).toEqual([]);
    expect(await provider.provide(ctx({ tenantId: T2 }))).toEqual([]);
    // A run that names no scope gets no group memory at all.
    expect(await provider.provide(ctx({ memoryScopes: undefined }))).toEqual([]);
  });

  it("records where each memory came from, from the trusted context", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const [entry] = await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "Slide 1 names the dish" }],
    });
    expect(entry).toMatchObject({ sourceConversationId: "chat-1", sourceRunId: "run-1", createdBy: "alice" });
  });

  it("uses the same gate as personal memory: bounds and dedupe", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await commitExtractedScopedMemories(store, { context: ctx(), candidates: [{ text: "Use metric units" }] });
    const stored = await commitExtractedScopedMemories(store, {
      context: ctx({ conversationId: asId<ConversationId>("chat-2") }),
      candidates: [
        { text: "  use METRIC units " }, // a duplicate, from another chat
        { text: "" },
        { text: "x".repeat(MEMORY_LIMITS.textMaxLength + 1) },
        { text: "Sign off as the team" },
      ],
    });
    expect(stored.map((e) => e.text)).toEqual(["Sign off as the team"]);
  });

  it("refuses a scope the run does not belong to — a turn cannot teach a project it is not in", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await expect(
      commitExtractedScopedMemories(store, { context: ctx(), scope: OTHER, candidates: [{ text: "leak" }] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await store.list({ tenantId: T1, scope: OTHER, limit: 10 })).items).toHaveLength(0);
  });

  it("asks which scope when the run belongs to several, and refuses when it belongs to none", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await expect(
      commitExtractedScopedMemories(store, { context: ctx({ memoryScopes: [PROJECT, OTHER] }), candidates: [{ text: "a" }] }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/several/) });
    await expect(
      commitExtractedScopedMemories(store, { context: ctx({ memoryScopes: [] }), candidates: [{ text: "a" }] }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/no memory scope/) });
  });

  it("with confirmation required, proposes — and a proposal reaches no prompt until a person confirms it", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const [proposed] = await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "Always credit the photographer" }],
      requireConfirmation: true,
    });
    const provider = createScopedMemoryProvider({ store });
    expect(proposed?.status).toBe("proposed");
    expect(await provider.provide(ctx())).toEqual([]);

    // Not proposed a second time while it waits for review.
    const again = await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "always credit the photographer" }],
      requireConfirmation: true,
    });
    expect(again).toHaveLength(0);

    await store.update({ tenantId: T1, scope: PROJECT, id: proposed!.id, expectedVersion: 1, patch: { status: "active" } });
    expect(await bodies(provider, ctx())).toContain("Always credit the photographer");
  });
});

describe("AC-2 — forget removes it from the next turn", () => {
  it("is gone from the provider after a delete, and after a disable", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const [a, b] = await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "Forget this one" }, { text: "Switch this one off" }],
    });
    const provider = createScopedMemoryProvider({ store });
    expect(await bodies(provider, ctx())).toContain("Forget this one");

    await store.delete({ tenantId: T1, scope: PROJECT, id: a!.id });
    await store.update({ tenantId: T1, scope: PROJECT, id: b!.id, expectedVersion: 1, patch: { disabled: true } });

    const after = await bodies(provider, ctx());
    expect(after).not.toContain("Forget this one");
    expect(after).not.toContain("Switch this one off");
  });
});

describe("AC-3 — a byte budget, and a size the budget accounting can see", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s).length;

  it("never emits more than maxBytes, and keeps whole entries in salience order", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const source = { conversationId: asId<ConversationId>("chat-1") };
    await store.put({ tenantId: T1, scope: PROJECT, text: "A".repeat(60), salience: 9, source });
    await store.put({ tenantId: T1, scope: PROJECT, text: "B".repeat(60), salience: 8, source });
    await store.put({ tenantId: T1, scope: PROJECT, text: "C".repeat(10), salience: 1, source });

    // Room for the first 62-byte line and the short one, not for the second long one.
    const [section] = await createScopedMemoryProvider({ store, maxBytes: 100 }).provide(ctx());
    expect(utf8(section!.body)).toBeLessThanOrEqual(100);
    expect(section!.body).toBe(`- ${"A".repeat(60)}\n- ${"C".repeat(10)}`);
    // Skipped whole rather than cut: half a rule reads as a different rule.
    expect(section!.body).not.toContain("B");
    // The inspector can attribute exactly what was included.
    expect(section!.provenance).toMatch(/^scoped-memory:project:p-1#/);
    expect(section!.provenance.split("#")[1]!.split(",")).toHaveLength(2);
  });

  it("counts bytes, not characters — the unit a prompt is sent in", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const source = { conversationId: null };
    // 20 characters, 60 bytes.
    await store.put({ tenantId: T1, scope: PROJECT, text: "€".repeat(20), source });
    expect(await createScopedMemoryProvider({ store, maxBytes: 40 }).provide(ctx())).toEqual([]);
    expect(await createScopedMemoryProvider({ store, maxBytes: 62 }).provide(ctx())).toHaveLength(1);
  });

  it("reports its size, and the assembler charges it to the user-context bucket", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await commitExtractedScopedMemories(store, {
      context: ctx(),
      candidates: [{ text: "Never say revolutionary" }, { text: "Slide 1 names the dish" }],
    });
    const sections = await createScopedMemoryProvider({ store }).provide(ctx());
    const [section] = sections;
    expect(section!.estimatedTokens).toBe(estimateTokens(section!.body));
    expect(section!.kind).toBe("user-context");

    const budget: ContextBudget = {
      basePolicyTokens: 1_000,
      userContextTokens: 1_000,
      toolTokens: 1_000,
      skillTokens: 1_000,
      knowledgeTokens: 1_000,
      historyTokens: 1_000,
    };
    const assembled = assemblePrompt({ sections, budget, modelContextTokens: 10_000 });
    expect(assembled.totalTokens).toBe(section!.estimatedTokens);
    // And a user-context budget smaller than the section excludes it rather than overrunning.
    const tight = assemblePrompt({
      sections,
      budget: { ...budget, userContextTokens: section!.estimatedTokens - 1 },
      modelContextTokens: 10_000,
    });
    expect(tight.sections).toHaveLength(0);
    expect(tight.pruned.map((p) => p.reason)).toEqual(["bucket-overflow"]);
  });

  it("gives each scope its own section and its own budget", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    const source = { conversationId: null };
    await store.put({ tenantId: T1, scope: PROJECT, text: "project rule", source });
    await store.put({ tenantId: T1, scope: "team:t-1", text: "team rule", source });
    const sections = await createScopedMemoryProvider({ store }).provide(ctx({ memoryScopes: [PROJECT, "team:t-1"] }));
    expect(sections.map((s) => [s.title, s.body])).toEqual([
      ["What this project has learned (project:p-1)", "- project rule"],
      ["What this team has learned (team:t-1)", "- team rule"],
    ]);
  });

  it("fails the turn on a malformed scope rather than rendering an empty project", async () => {
    const store = createMemoryScopedMemoryStore(() => "t");
    await expect(createScopedMemoryProvider({ store }).provide(ctx({ memoryScopes: ["bad scope"] }))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
