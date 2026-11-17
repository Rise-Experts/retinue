import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";
import { createPostgresPublishingService } from "../publishing.js";

/**
 * `validate_publish` checks each platform against the caption it will publish — found on production
 * testing #499: Instagram's shared caption (5 hashtags) was held to Facebook's limit of 3 while
 * Facebook's own caption had 2, so a valid post was refused.
 */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const POST = "9b2d1a4e-1111-4222-8333-944455556666";
const IG = "11111111-1111-4111-8111-111111111111";
const FB = "22222222-2222-4222-8222-222222222222";
const context = { tenantId: WS, principalId: "33333333-3333-4333-8333-333333333333", roleIds: ["editor"] } as unknown as ExecutionContext;

const sqlWith = (post: { raw_content: string; platform_captions: Record<string, string> }): SqlExecutor => ({
  async query<Row>(text: string): Promise<Row[]> {
    if (text.includes("from public.posts where workspace_id = $1::uuid and id = $2::uuid")) {
      return [{ id: POST, ...post }] as Row[];
    }
    if (text.includes("from public.social_accounts")) {
      return [
        { id: IG, platform: "instagram", status: "ACTIVE", token_expires_at: null },
        { id: FB, platform: "facebook", status: "ACTIVE", token_expires_at: null },
      ] as Row[];
    }
    return [] as Row[];
  },
});

/** A validator that records what it was asked, and holds Facebook to 3 hashtags. */
const validatorInto = (calls: { caption: string; platformIds: readonly string[] }[]) =>
  (async (_c: ExecutionContext, input: { caption: string; platformIds: readonly string[] }) => {
    calls.push({ caption: input.caption, platformIds: [...input.platformIds] });
    const hashtags = (input.caption.match(/#\w+/g) ?? []).length;
    const issues = input.platformIds.includes("facebook") && hashtags > 3
      ? [{ code: "hashtags-too-many", platformId: "facebook", message: `${hashtags} hashtags; facebook allows at most 3.`, repairable: true }]
      : [];
    return { ok: issues.length === 0, issues };
  }) as never;

const INSTAGRAM = "Autumn is here. #autumn #menu #food #cafe #seasonal";
const FACEBOOK = "Our autumn menu arrives next week. #autumn #menu";

describe("PublishingService.validate", () => {
  it("checks each platform against its own caption, so a valid post passes", async () => {
    const calls: { caption: string; platformIds: readonly string[] }[] = [];
    const service = createPostgresPublishingService({
      sql: sqlWith({ raw_content: INSTAGRAM, platform_captions: { facebook: FACEBOOK } }),
      transaction: (async () => { throw new Error("no writes in validate"); }) as never,
      validateContent: validatorInto(calls),
    } as never);
    const report = await service.validate(context, { draftId: POST as never, accountIds: [IG, FB] as never });
    expect(report.issues.filter((i) => i.code === "hashtags-too-many")).toEqual([]);
    expect(calls).toEqual([
      { caption: INSTAGRAM, platformIds: ["instagram"] },
      { caption: FACEBOOK, platformIds: ["facebook"] },
    ]);
  });

  it("still refuses a platform whose own caption breaks its rule", async () => {
    const calls: { caption: string; platformIds: readonly string[] }[] = [];
    const service = createPostgresPublishingService({
      sql: sqlWith({ raw_content: INSTAGRAM, platform_captions: { facebook: `${FACEBOOK} #a #b` } }),
      transaction: (async () => { throw new Error("no writes in validate"); }) as never,
      validateContent: validatorInto(calls),
    } as never);
    const report = await service.validate(context, { draftId: POST as never, accountIds: [IG, FB] as never });
    expect(report.issues.map((i) => i.code)).toContain("hashtags-too-many");
  });

  it("holds the shared caption to every platform that publishes it", async () => {
    const calls: { caption: string; platformIds: readonly string[] }[] = [];
    const service = createPostgresPublishingService({
      sql: sqlWith({ raw_content: INSTAGRAM, platform_captions: {} }),
      transaction: (async () => { throw new Error("no writes in validate"); }) as never,
      validateContent: validatorInto(calls),
    } as never);
    const report = await service.validate(context, { draftId: POST as never, accountIds: [IG, FB] as never });
    expect(calls).toEqual([{ caption: INSTAGRAM, platformIds: ["instagram", "facebook"] }]);
    expect(report.issues.map((i) => i.code)).toContain("hashtags-too-many");
  });
});
