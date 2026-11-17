import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asId, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";
import { createPostgresContentService, normalisePlatformCaptions } from "../content.js";

/**
 * Per-channel captions on a draft — #495. The rules for what is stored, and the seams that carry
 * them to publishing, checked without a database (the adapter's DB suite needs one).
 */
describe("what is stored", () => {
  const platforms = ["instagram", "linkedin", "x"];

  it("keeps only channels the post targets, trimmed, and not blank", () => {
    expect(normalisePlatformCaptions({ x: "  Short.  ", tiktok: "not a target", linkedin: "   " }, platforms, "Shared")).toEqual({ x: "Short." });
  });

  it("drops an entry identical to the shared caption: it says nothing", () => {
    expect(normalisePlatformCaptions({ x: "Shared", linkedin: "Different" }, platforms, "Shared")).toEqual({ linkedin: "Different" });
  });

  it("ignores anything that is not text", () => {
    expect(normalisePlatformCaptions({ x: 5, linkedin: null } as never, platforms, "Shared")).toEqual({});
  });

  it("reads a row written before the column existed as no overrides", () => {
    expect(normalisePlatformCaptions(undefined, platforms, "Shared")).toEqual({});
    expect(normalisePlatformCaptions(null, platforms, "Shared")).toEqual({});
  });

  it("drops an override when its channel leaves the post", () => {
    expect(normalisePlatformCaptions({ x: "Short." }, ["instagram"], "Shared")).toEqual({});
  });
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(SRC, "content.ts"), "utf8");
const publishing = readFileSync(resolve(SRC, "publishing.ts"), "utf8");

describe("the seams (source assertions)", () => {
  it("every post read selects the column", () => {
    const reads = content.match(/campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at(, platform_captions)?/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(9);
    expect(reads.every((r) => r.endsWith(", platform_captions"))).toBe(true);
  });

  it("create, update and duplicate write it", () => {
    expect(content).toMatch(/insert into public\.posts\s+\(workspace_id, author_id, title, raw_content, media_urls, status, target_platforms, campaign_id, platform_captions, conversation_id, project_id, text_format_preset_id\)\s+values/);
    expect(content).toContain("platform_captions = $6::jsonb");
    expect(content).toMatch(/select workspace_id, \$3::uuid, title, raw_content, media_urls, 'DRAFT', \$4::text\[\], campaign_id, platform_captions/);
  });

  it("tells the model to split the caption when one text fails several channels", () => {
    // Production: facebook ≤3 hashtags, instagram ≥5 — five refused calls before `platformCaptions` was found.
    const fn = content.slice(content.indexOf("const assertPostValid"), content.indexOf("const service: ContentService"));
    expect(fn).toContain("const sharedIssues = issues.length;");
    expect(fn).toMatch(/shared\.length > 1 && sharedIssues > 0[\s\S]*?platformCaptions/);
  });

  it("create and update both check every channel against the text it publishes", () => {
    expect(content).toMatch(/await assertPostValid\([\s\S]*?"That post cannot be saved"/);
    expect(content).toMatch(/await assertPostValid\(context, \{ caption, platforms: [^}]*platformCaptions \}, "That edit cannot be saved"\)/);
  });

  it("scheduling copies the channel's caption into the item the worker publishes", () => {
    expect(publishing).toContain("insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status, tailored_content)");
    expect(publishing).toContain("nullif(btrim(p.platform_captions ->> a.platform), '')");
  });
});

/**
 * Found by the post panel in production (#497): a two-channel draft refused with "7 hashtags; linkedin
 * allows at most 5" — Instagram's caption held to LinkedIn's rule, although LinkedIn had its own text.
 * Against a fake database answering only the two queries a save makes.
 */
describe("saving a post with a caption per channel", () => {
  const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const context = { tenantId: asId<TenantId>(WS), principalId: asId<PrincipalId>("9b2d1a4e-1111-4222-8333-944455556666") } as unknown as ExecutionContext;
  const RULES = [
    { platform: "instagram", char_limit: 2200, hashtag_min: 5, hashtag_max: 30 },
    { platform: "linkedin", char_limit: 3000, hashtag_min: null, hashtag_max: 5 },
  ];
  const fakeSql = (inserted: unknown[][]): SqlExecutor => ({
    async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
      if (text.includes("from public.platform_rules")) {
        const wanted = params[1] as string[];
        return RULES.filter((r) => wanted.includes(r.platform)) as Row[];
      }
      if (text.includes("insert into public.posts")) {
        inserted.push([...params]);
        return [{ id: "d1", campaign_id: null, status: "DRAFT", raw_content: params[3], title: params[2], target_platforms: params[5], media_urls: [], updated_at: new Date().toISOString(), platform_captions: JSON.parse(String(params[7])) }] as Row[];
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  });
  const instagram = "Autumn menu lands next week. #autumn #menu #food #cafe #seasonal #new #local";
  const linkedin = "Our autumn menu launches next week — here is what changed and why. #food #hospitality";

  it("checks each channel against its own caption, so a valid two-channel post saves", async () => {
    const inserted: unknown[][] = [];
    const service = createPostgresContentService(fakeSql(inserted));
    await service.createDraft(context, { caption: instagram, targetPlatforms: ["instagram", "linkedin"], platformCaptions: { linkedin } } as never);
    expect(inserted).toHaveLength(1);
  });

  it("still refuses a channel whose own caption breaks its rule, and saves nothing", async () => {
    const inserted: unknown[][] = [];
    const service = createPostgresContentService(fakeSql(inserted));
    const tooMany = `${linkedin} #a #b #c #d`;
    await expect(
      service.createDraft(context, { caption: instagram, targetPlatforms: ["instagram", "linkedin"], platformCaptions: { linkedin: tooMany } } as never),
    ).rejects.toThrow(/linkedin: 6 hashtags; linkedin allows at most 5/);
    expect(inserted).toEqual([]);
  });

  it("still holds the shared caption to every channel that publishes it", async () => {
    const inserted: unknown[][] = [];
    const service = createPostgresContentService(fakeSql(inserted));
    await expect(service.createDraft(context, { caption: instagram, targetPlatforms: ["instagram", "linkedin"] } as never)).rejects.toThrow(
      /7 hashtags; linkedin allows at most 5/,
    );
    expect(inserted).toEqual([]);
  });
});

/** #500: a post remembers the Assistant conversation that wrote it, so Edit can reopen that conversation. */
describe("the conversation a post came from", () => {
  const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const inserted: unknown[][] = [];
  const sql = {
    async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
      if (text.includes("from public.platform_rules")) return [{ platform: "linkedin", char_limit: 3000, hashtag_min: null, hashtag_max: 5 }] as Row[];
      if (text.includes("insert into public.posts")) {
        inserted.push([...params]);
        return [{ id: "d1", campaign_id: null, status: "DRAFT", raw_content: params[3], title: params[2], target_platforms: params[5], media_urls: [], updated_at: new Date().toISOString(), platform_captions: {} }] as Row[];
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  } as SqlExecutor;

  it("stores the conversation id when the draft is written in one, and null otherwise", async () => {
    const service = createPostgresContentService(sql);
    const base = { tenantId: asId<TenantId>(WS), principalId: asId<PrincipalId>("9b2d1a4e-1111-4222-8333-944455556666") };
    await service.createDraft({ ...base, conversationId: "conv-7" } as unknown as ExecutionContext, { caption: "Hello", targetPlatforms: ["linkedin"] } as never);
    await service.createDraft(base as unknown as ExecutionContext, { caption: "Hello", targetPlatforms: ["linkedin"] } as never);
    expect(inserted[0]![8]).toBe("conv-7");
    expect(inserted[1]![8]).toBeNull();
  });
});
