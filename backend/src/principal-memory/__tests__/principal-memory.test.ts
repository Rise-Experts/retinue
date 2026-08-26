import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { PrincipalId, TenantId } from "../../core/ids.js";
import { createMemoryPrincipalMemoryStore } from "../../adapters/memory/index.js";
import { type PrincipalMemoryEntry } from "../index.js";
import { commitExtractedMemories, createPrincipalMemoryProvider, validateAndDedupe } from "../index.js";

const T = asId<TenantId>("t1");
const P = asId<PrincipalId>("p1");

const ctx = (tenantId: TenantId, principalId: PrincipalId): ExecutionContext => ({
  tenantId,
  principalId,
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("r1"),
});

describe("principal memory — isolation", () => {
  it("persists across conversations but is invisible to other principals and tenants", async () => {
    const store = createMemoryPrincipalMemoryStore(() => "t");
    await store.put({ tenantId: T, principalId: P, text: "prefers metric units" });
    // Same principal, later conversation — still there.
    expect((await store.retrieve({ tenantId: T, principalId: P, limit: 10 })).map((e) => e.text)).toEqual(["prefers metric units"]);
    // Another principal / tenant sees nothing.
    expect(await store.retrieve({ tenantId: T, principalId: asId<PrincipalId>("p2"), limit: 10 })).toHaveLength(0);
    expect(await store.retrieve({ tenantId: asId<TenantId>("t2"), principalId: P, limit: 10 })).toHaveLength(0);
  });
});

describe("principal memory — extraction validates and dedupes", () => {
  it("drops empties, over-long text, and duplicates of existing/each-other", async () => {
    const existing: PrincipalMemoryEntry[] = [
      { id: "m1", tenantId: T, principalId: P, text: "Likes dark mode", tags: [], salience: 1, version: 1, createdAt: "t", updatedAt: "t" },
    ];
    const accepted = validateAndDedupe(
      [
        { text: "  likes dark mode  " }, // dup of existing (normalized)
        { text: "" }, // empty
        { text: "x".repeat(2000) }, // too long
        { text: "Works in Berlin" },
        { text: "works in berlin" }, // dup of the previous candidate
      ],
      existing,
    );
    expect(accepted.map((c) => c.text)).toEqual(["Works in Berlin"]);
  });

  it("commits only validated, unique memories — raw duplicates are not stored", async () => {
    const store = createMemoryPrincipalMemoryStore(() => "t");
    await store.put({ tenantId: T, principalId: P, text: "Likes dark mode" });
    const stored = await commitExtractedMemories(store, {
      tenantId: T,
      principalId: P,
      candidates: [{ text: "Likes dark mode" }, { text: "Speaks German" }],
    });
    expect(stored.map((e) => e.text)).toEqual(["Speaks German"]);
  });
});

describe("principal memory — user control", () => {
  it("disabled and deleted memories never surface to the provider", async () => {
    const store = createMemoryPrincipalMemoryStore(() => "t");
    const a = await store.put({ tenantId: T, principalId: P, text: "keep me", salience: 5 });
    const b = await store.put({ tenantId: T, principalId: P, text: "disable me", salience: 5 });
    const c = await store.put({ tenantId: T, principalId: P, text: "delete me", salience: 5 });
    await store.update({ tenantId: T, principalId: P, id: b.id, expectedVersion: b.version, patch: { disabled: true } });
    await store.delete({ tenantId: T, principalId: P, id: c.id });

    const provider = createPrincipalMemoryProvider({ store });
    const sections = await provider.provide(ctx(T, P));
    const bodies = sections.map((s) => s.body);
    expect(bodies).toContain("keep me");
    expect(bodies).not.toContain("disable me");
    expect(bodies).not.toContain("delete me"); // deletion cannot resurface
    void a;
  });
});

describe("principal memory — budgeted provider with attribution", () => {
  it("retrieves under budget, tags provenance, and uses the user-context bucket", async () => {
    const store = createMemoryPrincipalMemoryStore(() => "t");
    for (let i = 0; i < 10; i += 1) await store.put({ tenantId: T, principalId: P, text: `fact ${i}`, salience: i });
    const provider = createPrincipalMemoryProvider({ store, maxEntries: 3 });
    const sections = await provider.provide(ctx(T, P));
    expect(sections).toHaveLength(3); // under budget
    expect(sections.every((s) => s.kind === "user-context")).toBe(true); // won't crowd out recent turns/history
    expect(sections[0]!.provenance).toMatch(/^principal-memory:/); // attributable in the inspector
    expect(sections[0]!.body).toBe("fact 9"); // most salient first
  });
});
