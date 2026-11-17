/**
 * Personal memory — #621. The service, the two tools, the "About you" provider and its declaration.
 *
 * Over agentkit's own in-memory `PrincipalMemoryStore`, which is partitioned by (tenant, principal) exactly as
 * the Postgres one is keyed; `personalMemory.pg.test.ts` runs the same service against the real table.
 */
import { describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { createMemoryIdempotencyStore, createMemoryPrincipalMemoryStore } from "@retinue/agentkit/persistence";
import { createToolRegistry, createToolSearch } from "@retinue/agentkit/tools";

import { createPersonalMemoryService, PERSONAL_MEMORY_PROMPT_ENTRIES, sensitiveReason } from "../../adapters/personal-memory.js";
import { ABOUT_YOU_TITLE, createPersonalMemoryContextProvider, PERSONAL_MEMORY_PROVIDER_ID } from "../../context/personal-memory.js";
import { selectDeclaredProviders } from "../../app/context-for-turn.js";
import { socialAssistantManifest, SOCIAL_ASSISTANT_PRELOADED_TOOLS } from "../../manifests/index.js";
import { forgetAboutMeTool, rememberAboutMeTool } from "../memory.js";
import { createShareFlowToolProvider, SHAREFLOW_TOOL_FACTORIES } from "../index.js";
import type { ShareFlowServices } from "../../services/index.js";
import { PLACEHOLDER_AUTHORIZATION } from "../../app/deployment.js";

const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_WS = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ME = "9b2d1a4e-1111-4222-8333-944455556666";
const COLLEAGUE = "1b2d1a4e-1111-4222-8333-944455556666";
const ctx = (tenant: string, principal: string) =>
  ({ tenantId: asId<TenantId>(tenant), principalId: asId<PrincipalId>(principal), roleIds: ["editor"], conversationId: "conv-1" }) as unknown as ExecutionContext;
const MINE = ctx(WS, ME);
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
const deps = () => ({ authorization: allowAll, idempotency: createMemoryIdempotencyStore() });

const setup = () => {
  const store = createMemoryPrincipalMemoryStore();
  const service = createPersonalMemoryService({ store });
  const services = { personalMemory: service } as unknown as ShareFlowServices;
  const remember = rememberAboutMeTool.build({ services, deps: deps() });
  const forget = forgetAboutMeTool.build({ services, deps: deps() });
  let n = 0;
  const call = (tool: typeof remember, context: ExecutionContext, input: unknown) =>
    tool.execute({ context, input, idempotencyKey: `k-${(n += 1)}` } as never) as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }>;
  return { store, service, remember, forget, call };
};

describe("remember_about_me", () => {
  it("stores the memory for the turn's own principal and nobody else", async () => {
    const { store, remember, call } = setup();
    const result = await call(remember, MINE, { memory: "Writes in British English." });
    expect(result).toMatchObject({ ok: true, data: { duplicate: false, text: "Writes in British English." } });

    expect((await store.list({ tenantId: MINE.tenantId, principalId: MINE.principalId, limit: 10 })).items.map((e) => e.text)).toEqual(["Writes in British English."]);
    // A colleague in the same workspace, and the same person in another workspace, see nothing.
    expect((await store.list({ tenantId: MINE.tenantId, principalId: asId<PrincipalId>(COLLEAGUE), limit: 10 })).items).toEqual([]);
    expect((await store.list({ tenantId: asId<TenantId>(OTHER_WS), principalId: MINE.principalId, limit: 10 })).items).toEqual([]);
  });

  it("takes no principal or tenant from its input — the schema refuses one", async () => {
    const { remember, call } = setup();
    const result = await call(remember, MINE, { memory: "Is called Sam.", principalId: COLLEAGUE });
    expect(result.ok).toBe(false);
  });

  it("is ungated internal-write, like remember_project_rule, and preloaded because the prompt names it", () => {
    const { remember, forget } = setup();
    expect(remember.descriptor.effect).toBe("internal-write");
    expect(remember.descriptor.approvalPolicy).toBe("never");
    expect(forget.descriptor.approvalPolicy).toBe("never");
    expect(SOCIAL_ASSISTANT_PRELOADED_TOOLS).toContain("remember_about_me");
    // Not preloaded: the list must stay under half the catalogue; the prompt sends the model to find_tools.
    expect(SOCIAL_ASSISTANT_PRELOADED_TOOLS).not.toContain("forget_about_me");
  });

  it("stores the same memory once, however it is spaced or cased", async () => {
    const { store, remember, call } = setup();
    await call(remember, MINE, { memory: "Prefers captions without emoji." });
    const again = await call(remember, MINE, { memory: "  prefers   captions WITHOUT emoji. " });
    expect(again).toMatchObject({ ok: true, data: { duplicate: true } });
    expect((await store.list({ tenantId: MINE.tenantId, principalId: MINE.principalId, limit: 10 })).items).toHaveLength(1);
  });

  it.each([
    ["my password is hunter2", "password"],
    ["Mein Passwort: Sommer2024!", "password"],
    ["API key = sk-proj-abcdefghijklmnop1234", "key"],
    ["uses the token ghp_abcdefghijklmnopqrstuvwxyz0123", "token"],
    ["card 4242 4242 4242 4242 for the ads account", "card"],
    ["IBAN DE89 3704 0044 0532 0130 00", "bank"],
    ["AKIAIOSFODNN7EXAMPLE is the deploy key", "key"],
  ])("refuses text that looks like a secret: %s", async (text) => {
    const { store, remember, call } = setup();
    const result = await call(remember, MINE, { memory: text });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/never kept in memory/);
    expect((await store.list({ tenantId: MINE.tenantId, principalId: MINE.principalId, limit: 10 })).items).toEqual([]);
  });

  it.each([
    "Writes in British English.",
    "Is called Sam.",
    "Prefers to pin posts: only the launch ones.",
    "Posts at 9am on weekdays, order number 12345.",
    "Likes the password-manager brand 1Password in examples.",
  ])("keeps an ordinary preference: %s", (text) => {
    expect(sensitiveReason(text)).toBeNull();
  });

  it(`refuses past ${PERSONAL_MEMORY_PROMPT_ENTRIES} enabled memories — the number a prompt carries`, async () => {
    const { service, remember, call } = setup();
    for (let i = 0; i < PERSONAL_MEMORY_PROMPT_ENTRIES; i += 1) await service.remember(MINE, { text: `Preference number ${i}.` });
    const over = await call(remember, MINE, { memory: "One more preference." });
    expect(over).toMatchObject({ ok: false, error: { code: "conflict" } });
    // A disabled one frees a slot.
    const [first] = await service.list(MINE);
    await service.setEnabled(MINE, { id: first!.id, enabled: false });
    expect(await call(remember, MINE, { memory: "One more preference." })).toMatchObject({ ok: true });
    // And re-enabling past the cap is refused, rather than leaving one silently out of the prompt.
    await expect(service.setEnabled(MINE, { id: first!.id, enabled: true })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("forget_about_me", () => {
  it("forgets by id, only the caller's own", async () => {
    const { service, forget, call } = setup();
    const { memory } = await service.remember(MINE, { text: "Is called Sam." });
    const colleague = ctx(WS, COLLEAGUE);
    // The colleague cannot forget my memory by naming its id.
    expect(await call(forget, colleague, { memoryId: memory.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await service.list(MINE)).toHaveLength(1);
    expect(await call(forget, MINE, { memoryId: memory.id })).toMatchObject({ ok: true, data: { forgotten: [{ memoryId: memory.id }] } });
    expect(await service.list(MINE)).toEqual([]);
  });

  it("forgets by text, and asks when the text matches several", async () => {
    const { service, forget, call } = setup();
    await service.remember(MINE, { text: "Prefers captions without emoji." });
    await service.remember(MINE, { text: "Prefers short captions on LinkedIn." });
    const ambiguous = await call(forget, MINE, { text: "prefers" });
    expect(ambiguous).toMatchObject({ ok: true, data: { forgotten: [] } });
    expect((ambiguous.data?.["matches"] as unknown[]).length).toBe(2);
    expect(await service.list(MINE)).toHaveLength(2);

    expect(await call(forget, MINE, { text: "without emoji" })).toMatchObject({ ok: true, data: { forgotten: [{ text: "Prefers captions without emoji." }] } });
    expect((await service.list(MINE)).map((m) => m.text)).toEqual(["Prefers short captions on LinkedIn."]);
  });

  it("can be found through find_tools, which is how the prompt tells the model to reach it", async () => {
    const explode = new Proxy({}, { get: () => ({}) }) as ShareFlowServices;
    const registry = createToolRegistry({
      providers: [createShareFlowToolProvider({ services: explode, deps: deps(), factories: SHAREFLOW_TOOL_FACTORIES })],
      authorization: PLACEHOLDER_AUTHORIZATION,
      search: createToolSearch(),
    });
    const found = await registry.find(MINE, { query: "forget something about me", limit: 5 });
    expect(found.hits.map((hit) => hit.entry.name)).toContain("forget_about_me");
  });
});

describe("the About you provider", () => {
  it("is agentkit's principal-memory provider, declared by the manifest and so selected", () => {
    const provider = createPersonalMemoryContextProvider({ store: createMemoryPrincipalMemoryStore() });
    expect(provider.id).toBe(PERSONAL_MEMORY_PROVIDER_ID);
    const manifest = socialAssistantManifest({
      version: 1,
      instructions: "x",
      modelPolicy: { primary: { provider: "google", model: "m" } },
      authorizationPolicyId: "p",
      limits: { maxSteps: 8, maxDurationMs: 1_000, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    } as never);
    expect(manifest.contextProviderIds).toContain(PERSONAL_MEMORY_PROVIDER_ID);
    const other = { id: "shareflow.brand", async provide() { return []; } };
    const selected = selectDeclaredProviders([other, provider], { ...manifest, contextProviderIds: ["shareflow.brand", PERSONAL_MEMORY_PROVIDER_ID] });
    expect(selected.map((p) => p.id)).toEqual(["shareflow.brand", PERSONAL_MEMORY_PROVIDER_ID]);
  });

  it("carries the principal's enabled memories as one user-context section, with their ids", async () => {
    const store = createMemoryPrincipalMemoryStore();
    const service = createPersonalMemoryService({ store });
    const a = await service.remember(MINE, { text: "Writes in British English." });
    const b = await service.remember(MINE, { text: "Prefers captions without emoji." });
    await service.remember(ctx(WS, COLLEAGUE), { text: "Writes in German." });
    await service.setEnabled(MINE, { id: b.memory.id, enabled: false });

    const sections = await createPersonalMemoryContextProvider({ store }).provide(MINE);
    expect(sections).toHaveLength(1);
    const [section] = sections;
    expect(section).toMatchObject({ providerId: PERSONAL_MEMORY_PROVIDER_ID, title: ABOUT_YOU_TITLE, kind: "user-context", origin: "platform" });
    expect(section!.body).toContain(`- Writes in British English. (id ${a.memory.id})`);
    // Disabled, and another person's, never reach the prompt.
    expect(section!.body).not.toContain("without emoji");
    expect(section!.body).not.toContain("German");
    expect(section!.provenance).toBe(`principal-memory:${a.memory.id}`);
  });

  it("adds nothing for a person with no memories", async () => {
    expect(await createPersonalMemoryContextProvider({ store: createMemoryPrincipalMemoryStore() }).provide(MINE)).toEqual([]);
  });
});
