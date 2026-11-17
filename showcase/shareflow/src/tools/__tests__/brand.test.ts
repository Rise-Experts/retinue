import { beforeEach, describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";

import type { BrandProfilePatch, ShareFlowServices } from "../../services/index.js";
import { normalizeHex, toBrandPatch, updateBrandProfileTool } from "../brand.js";
import { createPostgresBrandService } from "../../adapters/postgres/brand.js";

/** #641 — the workspace brand, changed by asking. */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CONTEXT = { tenantId: asId<TenantId>(WS), principalId: asId<PrincipalId>("p1"), roleIds: ["editor"] } as unknown as ExecutionContext;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

let patches: BrandProfilePatch[];
let idempotency: IdempotencyStore;
beforeEach(() => {
  patches = [];
  idempotency = createMemoryIdempotencyStore();
});

const tool = (writable = true): Tool =>
  updateBrandProfileTool.build({
    services: {
      brand: {
        async getBrandProfile() { return {}; },
        ...(writable
          ? {
              async updateBrandProfile(_c: ExecutionContext, patch: BrandProfilePatch) {
                patches.push(patch);
                return { profile: patch, changed: Object.keys(patch) };
              },
            }
          : {}),
      },
    } as unknown as Pick<ShareFlowServices, "brand">,
    deps: { authorization: allowAll, idempotency },
  });
const run = (t: Tool, input: unknown): Promise<ToolResult> => t.execute({ context: CONTEXT, input, idempotencyKey: `k${Math.random()}` });

describe("toBrandPatch", () => {
  it("keeps only what was sent, clears on null or blank, and normalises colours and tones", () => {
    expect(
      toBrandPatch({ tone: ["witty", "warm", "warm"], colors: [{ hex: "0E6C79", name: " Teal " }, { hex: "#fa3" }], voice: "", avoid: null } as never),
    ).toEqual({ tone: ["warm", "witty"], colors: [{ hex: "#0e6c79", name: "Teal" }, { hex: "#ffaa33", name: "" }], voice: null, avoid: null });
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });
});

describe("update_brand_profile", () => {
  it("saves just the fields asked for and says what changed", async () => {
    const result = await run(tool(), { tone: ["Warm", "Witty"], emojiUse: "light" });
    expect(patches).toEqual([{ tone: ["warm", "witty"], emojiUse: "light" }]);
    expect(result).toMatchObject({ ok: true, data: { changed: ["tone", "emoji use"] } });
  });

  it("refuses a tone the settings page does not offer", async () => {
    const result = await run(tool(), { tone: ["sarcastic"] });
    expect(result.ok).toBe(false);
    expect(patches).toEqual([]);
  });

  it("takes a logo only from this workspace's media, as an image", async () => {
    expect((await run(tool(), { logoPath: `${WS}/uploads/logo.png` })).ok).toBe(true);
    for (const bad of ["https://example.com/logo.png", "other-ws/uploads/logo.png", `${WS}/../x/logo.png`, `${WS}/uploads/brief.pdf`]) {
      const result = await run(tool(), { logoPath: bad });
      expect(result.ok, bad).toBe(false);
    }
    expect(patches).toHaveLength(1);
  });

  it("refuses an empty change, and a store that cannot write", async () => {
    expect((await run(tool(), {})).ok).toBe(false);
    expect((await run(tool(false), { tone: ["calm"] })).ok).toBe(false);
  });
});

describe("the Postgres write", () => {
  it("touches only the patched columns, with the right casts", async () => {
    const queries: { text: string; params: readonly unknown[] }[] = [];
    const sql = {
      async query(text: string, params: readonly unknown[] = []) {
        queries.push({ text, params });
        return text.includes("to_jsonb(p)") ? [{ profile: { tone: ["warm"], brand_colors: [{ hex: "#0e6c79", name: "Teal" }] } }] : [];
      },
    };
    const result = await createPostgresBrandService(sql as never).updateBrandProfile!(CONTEXT, { tone: ["warm"], colors: [{ hex: "#0e6c79", name: "Teal" }], avoid: null });
    const write = queries[0]!;
    expect(write.text).toContain("insert into public.workspace_ai_profile (workspace_id, brand_colors, tone, avoid, updated_at)");
    expect(write.text).toContain("$2::jsonb");
    expect(write.text).toContain("$3::text[]");
    expect(write.text).toContain("brand_colors = excluded.brand_colors, tone = excluded.tone, avoid = excluded.avoid");
    // Untouched columns are not in the statement at all, so they cannot be blanked.
    expect(write.text).not.toContain("brand_voice");
    expect(write.params).toEqual([WS, JSON.stringify([{ hex: "#0e6c79", name: "Teal" }]), ["warm"], null]);
    expect(result.changed).toEqual(["tone", "colors", "avoid"]);
    expect(result.profile.tone).toEqual(["warm"]);
  });
});
