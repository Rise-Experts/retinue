/**
 * `ContentService`, `BrandService` and `ContentGenerator` against **ShareFlow's real schema** — REQ-041 (#190).
 *
 * These are the three services `create-post` needs, which makes them the smallest set that lets #128's shadow
 * capture produce real parity data.
 *
 * ## Why this runs against a real database
 *
 * The whole difficulty here is that the ports were written from `docs/07` and the tables were written by
 * ShareFlow, and every gap between them is a mapping decision. A fake `SqlExecutor` would let me assert that
 * the adapter sends the SQL I think it sends, which is the one thing I already know. What it could not catch:
 * `posts` has no `post_drafts`, statuses are upper-case and a different vocabulary, `media_urls` holds URLs
 * rather than asset ids, and `platform_rules.workspace_id` is nullable so the default and the override live in
 * one table.
 *
 * Every one of those was found by querying, not by reading.
 *
 * Skips without `RETINUE_TEST_SHAREFLOW_URL`. It does not fall back to a fake, for the reason above.
 *
 * ## Isolation
 *
 * Its own workspace row per run, deleted afterwards. The database this points at is a developer's, with real
 * rows in it — a suite that wrote into an existing workspace would be editing somebody's drafts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { asId, type AgentPlatformError } from "@retinue/agentkit";
import { createPoolOpener, createTransactionScope, type TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createPostgresBrandService, BRAND_SUPPORTED } from "../brand.js";
import {
  SWEEP_ALERT_MS,
  SWEEP_WORST_CASE_MS,
  UNCHECKED_CODES,
  createPostgresPublishingService,
} from "../publishing.js";
import { ACCOUNT_STATUS_FROM_DB, accountHealthFrom } from "../connectors.js";
import { leadSuppressionFor, STORED_LEAD_STATUSES, encodeAttribution, normaliseEmail } from "../leads.js";
import { ANALYTICS_REFRESH_WINDOW_MS, createPostgresAnalyticsService } from "../analytics.js";
import { MAX_ALT_TEXT_CHARS, MAX_ALTERNATIVES, MAX_HASHTAGS, MAX_REPURPOSE_SOURCE_CHARS } from "../../model/generator.js";
import { MEDIA_UNCHECKED_CODE, createPostgresMediaService } from "../media.js";
import { createPostgresEngagementService } from "../engagement.js";
import { ARTIFACT_SCHEME, artifactReference, createPostgresArtifactService } from "../artifacts.js";
import {
  createPostgresContentService,
  cadenceFrom,
  plannedPostCount,
  statusFrom,
  CADENCE_TO_DB,
  CAMPAIGN_POST_CAP,
  DEFAULT_CAMPAIGN_MEDIA_TYPE,
  DEFAULT_CAMPAIGN_MODE,
  EXCERPT_CHARS,
  STATUS_FROM_DB,
  STATUS_TO_DB,
} from "../content.js";
import { readFile } from "node:fs/promises";
import { dayOf } from "../insights.js";
import { createModelContentGenerator } from "../../model/generator.js";
import { BACKED_SERVICES, UNBACKED_SERVICES, backedContextProviders, createShareFlowServices } from "../../index.js";
import { createShareFlowApp } from "../../../app/index.js";
import {
  CAMPAIGN_TOOL_FACTORIES,
  GENERATE_TOOL_FACTORIES,
  MEDIA_TOOL_FACTORIES,
  POSTS_TOOL_FACTORIES,
} from "../../../tools/index.js";
import {
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  POST_DRAFT_STATUSES,
  PUBLISH_TARGET_STATES,
} from "../../../services/index.js";
import type { PostDraftId, ShareFlowServices } from "../../../services/index.js";

/**
 * Unwraps a rejection, so a call that *resolved* fails loudly instead of vacuously.
 *
 * Same helper as `backend/src/__tests__/files.test.ts:35`, and the same reason: `.catch((e) => e)` gives a
 * union of the resolved value and the error, so `expect(error.code).toBe("invalid_input")` against a
 * successful call reads `undefined` and the assertion still says something. #276's test typechecking is what
 * refuses the union — a test that cannot fail is worse than no test.
 */
const thrown = (value: unknown): AgentPlatformError => {
  if (!(value instanceof Error)) {
    throw new Error(`expected the call to reject, and it returned ${JSON.stringify(value)}`);
  }
  return value as AgentPlatformError;
};

/**
 * `BACKED_SERVICES` and `UNBACKED_SERVICES` partition `ShareFlowServices` exactly — checked by the compiler.
 *
 * `Equal` is the standard two-thunk trick rather than `Extra extends never`, because a naked `never` in a
 * conditional distributes to `true` and the check would pass for every input. And it is an aliased constraint
 * rather than a variable declaration, because `const x: Extra[] = []` is satisfied by `[]` whatever `Extra` is
 * — which is how the first version of this passed while listing a service that does not exist.
 */
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Listed = (typeof BACKED_SERVICES)[number] | (typeof UNBACKED_SERVICES)[number];
export type ServicesArePartitioned = [
  Expect<Equal<Exclude<Listed, keyof ShareFlowServices>, never>>,
  Expect<Equal<Exclude<keyof ShareFlowServices, Listed>, never>>,
];

const URL_ = process.env["RETINUE_TEST_SHAREFLOW_URL"];

type Sql = { query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> };

let sql: Sql;
/**
 * A **real** transaction runner over the same pool, not a stub.
 *
 * `PublishingService` requires one, and stubbing it would defeat the point: publish-once rests on
 * `SELECT … FOR UPDATE` and a fresh snapshot on the next statement, which a fake that just calls the callback
 * on the pool cannot provide — `pool.query` takes a different connection per call, so `BEGIN` and the work
 * land on different connections and guarantee nothing. `transaction.ts` opens with exactly that warning.
 */
let transaction: TransactionRunner;
let end: (() => Promise<void>) | undefined;
let workspaceId = "";
let userId = "";

/**
 * A `ConnectionSetup` this suite supplies, because the adapter refuses to invent one.
 *
 * Deliberately not a plausible-looking Meta/LinkedIn table: the point of the dependency is that redirect
 * URLs, console field labels and environment variable *names* are a deployment's, and a default would be
 * this package asserting another deployment's configuration.
 */
const SETUP = {
  redirectUrl: "https://app.test/api/connect/callback",
  credentialsPageUrl: "https://app.test/settings/credentials",
  platforms: [
    {
      platformId: "linkedin",
      label: "LinkedIn",
      consoleUrl: "https://www.linkedin.com/developers/apps",
      credentialVariables: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      consoleFields: [{ label: "Authorized redirect URL", url: "https://app.test/api/connect/callback" }],
      scopes: ["w_member_social"],
    },
  ],
} as never;

/**
 * The research dependencies, as stubs.
 *
 * The real ones are the platform's `createWebSearch` and `createFetchPage` — where the egress policy, the
 * redirect refusal and the byte ceiling live. These are stubs because this suite is about the ShareFlow
 * adapters; the research adapter's own behaviour is tested against them directly in its own block.
 */
const RESEARCH = {
  search: (async (query: string) => ({ searched: true as const, query, hits: [] })) as never,
  fetchPage: (async (url: string) => ({ ok: true as const, url, status: 200, truncated: false, content: "" })) as never,
};

const context = () =>
  ({ tenantId: workspaceId, principalId: userId, roleIds: ["editor"], locale: "en", timezone: "UTC", requestId: "r" }) as never;

beforeAll(async () => {
  if (URL_ === undefined) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
  end = () => pool.end();
  transaction = createTransactionScope(createPoolOpener(pool)).runner;
  sql = {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return result.rows as Row[];
    },
  };

  // A workspace of this suite's own. `profiles` needs an auth user, so an existing one is borrowed as author.
  const owner = await sql.query<{ id: string }>("select id from public.profiles limit 1");
  userId = owner[0]?.id ?? "";
  const created = await sql.query<{ id: string }>(
    // `workspaces` has no owner column in this schema — membership lives in `workspace_members`.
    "insert into public.workspaces (name) values ($1) returning id",
    ["retinue-parity-test"],
  );
  workspaceId = created[0]?.id ?? "";
});

afterAll(async () => {
  if (URL_ !== undefined && workspaceId !== "") {
    // Cascades to posts, campaigns and the ai profile. Only this suite's workspace is touched.
    await sql.query("delete from public.workspaces where id = $1::uuid", [workspaceId]);
  }
  await end?.();
});

describe.skipIf(URL_ === undefined)("BrandService over workspace_ai_profile", () => {
  it("returns an empty profile for a workspace that has never set one", async () => {
    /**
     * The ordinary case, and the reason it is not an error: a workspace that has not opened the brand settings
     * would otherwise be unable to use the assistant at all until somebody filled a form.
     */
    expect(await createPostgresBrandService(sql as never).getBrandProfile(context())).toEqual({});
  });

  it("maps every field the port has onto the column that holds it", async () => {
    await sql.query(
      `insert into public.workspace_ai_profile
         (workspace_id, brand_name, company, website, audience, brand_voice, custom_instructions)
       values ($1::uuid, 'Acme', 'Acme Ltd', 'https://acme.test', 'founders', 'wry, concrete', 'never use exclamation marks')`,
      [workspaceId],
    );
    expect(await createPostgresBrandService(sql as never).getBrandProfile(context())).toEqual({
      brandName: "Acme",
      company: "Acme Ltd",
      website: "https://acme.test",
      audience: "founders",
      voice: "wry, concrete",
      customInstructions: "never use exclamation marks",
    });
  });

  it("omits an unset column rather than returning an empty string", async () => {
    /**
     * "Unset" and "set to nothing" are different, and the difference reaches a prompt: an empty `voice` would
     * render as `Voice: ` and a model told a field is blank sometimes writes about it being blank.
     */
    await sql.query("update public.workspace_ai_profile set company = null, brand_voice = '' where workspace_id = $1::uuid", [
      workspaceId,
    ]);
    const profile = await createPostgresBrandService(sql as never).getBrandProfile(context());
    expect(profile).not.toHaveProperty("company");
    expect(profile).not.toHaveProperty("voice");
  });

  it("reads voice examples from the column ShareFlow already flags them with", async () => {
    /**
     * `is_voice_exemplar`, not a ranking invented here. The port says heuristic selection is ShareFlow's, and a
     * scoring rule in this adapter would be a second, divergent notion of what a good post is.
     */
    await sql.query(
      `insert into public.posts (workspace_id, author_id, title, raw_content, status, is_voice_exemplar)
       values ($1::uuid, $2::uuid, 'good', 'This is how we sound.', 'PUBLISHED', true),
              ($1::uuid, $2::uuid, 'other', 'Not an exemplar.', 'PUBLISHED', false)`,
      [workspaceId, userId],
    );
    const examples = await createPostgresBrandService(sql as never).listVoiceExamples(context(), { limit: 10 });
    expect(examples.map((example) => example.excerpt)).toEqual(["This is how we sound."]);
  });

  it("chooses examples that represent the voice, not the four most recent — REQ-013 AC-3", async () => {
    /**
     * The query was `order by updated_at desc limit $2`, so the model was shown whatever happened to
     * be flagged most recently. This inserts a corpus where the newest three posts are the *least*
     * typical — a run of shouty sale posts in front of a steady house voice — which is exactly the
     * case that makes recency wrong: the assistant would learn to write the sale posts.
     *
     * The assertion is about the **set**, not about which particular posts: a test that pinned three
     * ids would have to be rewritten whenever the feature improved, and would pass for a selector
     * that simply preferred quiet posts.
     */
    /*
     * Every test in this describe shares one workspace, so each states its own precondition rather
     * than inheriting whichever posts the previous one flagged. Order-independent on purpose: the
     * alternative is a suite that passes and stops passing when someone reorders it.
     */
    await sql.query("update public.posts set is_voice_exemplar = false where workspace_id = $1::uuid", [workspaceId]);
    await sql.query(
      `insert into public.posts (workspace_id, author_id, title, raw_content, status, is_voice_exemplar, updated_at)
       values ($1::uuid, $2::uuid, 'loud1',  'HUGE news!!! 🎉🎉 The new roast is HERE and it is INSANE 🔥 #new #fire #musttry', 'PUBLISHED', true, now()),
              ($1::uuid, $2::uuid, 'loud2',  'Sale!! 20% off EVERYTHING this weekend!! 🛍️🛍️🛍️ #sale #deal #shopnow', 'PUBLISHED', true, now() - interval '1 hour'),
              ($1::uuid, $2::uuid, 'loud3',  'LAST CHANCE!!! 😱😱 Everything must go!! Tap the link NOW!! #urgent', 'PUBLISHED', true, now() - interval '2 hours'),
              ($1::uuid, $2::uuid, 'house1', 'We shipped the new roasting profile this week. Three months of tasting, and the difference is in the finish. #coffee', 'PUBLISHED', true, now() - interval '3 hours'),
              ($1::uuid, $2::uuid, 'house2', 'Our spring lot is landing Monday. We cupped every bag twice before saying yes to it. #coffee', 'PUBLISHED', true, now() - interval '4 hours'),
              ($1::uuid, $2::uuid, 'house3', 'We rebuilt the grinder burrs over the weekend. Small change, and the espresso is noticeably sweeter. #coffee', 'PUBLISHED', true, now() - interval '5 hours'),
              ($1::uuid, $2::uuid, 'house4', 'A short note on extraction yield: we now target 21% for the house espresso, up from 19.5%.', 'PUBLISHED', true, now() - interval '6 hours'),
              ($1::uuid, $2::uuid, 'house5', 'We have completed the migration of our roasting profile documentation to the new internal system.', 'PUBLISHED', true, now() - interval '7 hours')`,
      [workspaceId, userId],
    );
    const examples = await createPostgresBrandService(sql as never).listVoiceExamples(context(), { limit: 3 });
    expect(examples).toHaveLength(3);

    const shouty = examples.filter((example) => example.excerpt.includes("!!")).length;
    // Recency would return all three loud posts. Anything less is the selector doing its job.
    expect(shouty, "recency would have returned three").toBeLessThan(3);

    /*
     * And it reads more than `limit` rows to do it. A selector handed exactly what it returns has
     * nothing to choose between, which is the failure this feature could have shipped as — the port's
     * own doc now says `limit` caps what comes back, not what is read.
     */
    const ids = new Set(examples.map((example) => example.postDraftId));
    expect(ids.size, "three distinct posts").toBe(3);
    const older = await sql.query<{ id: string }>(
      `select id from public.posts where workspace_id = $1::uuid and title = 'house5'`,
      [workspaceId],
    );
    expect(older).toHaveLength(1);
  });

  it("falls back to the workspace's best-performing posts when nothing is flagged — REQ-013 AC-1", async () => {
    /**
     * *"Approved/top posts form a per-workspace voice corpus"*, and only the flagged ones did.
     *
     * `workspace_top_posts` has existed since the growth-system migration, ordering published posts by
     * `engagement_rate`, and `web/src/lib/data/voiceCorpus.ts` implemented exactly this fallback — with
     * **no callers**. The live path is this method, which read the flagged posts alone. So a workspace
     * that had never ticked the box got nothing while a ranked list of its best posts sat one join
     * away.
     */
    /*
     * The workspace is shared with the tests above, which flag posts of their own. Clearing the flag
     * — not the posts — is what makes this test's precondition ("nothing is flagged") true rather than
     * dependent on which order vitest happened to run them in.
     */
    await sql.query("update public.posts set is_voice_exemplar = false where workspace_id = $1::uuid", [workspaceId]);
    const account = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'ext-voice-1', 'Voice test', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    const accountId = (account[0] as { id: string }).id;

    const publish = async (content: string, rate: number) => {
      const post = await sql.query<{ id: string }>(
        `insert into public.posts (workspace_id, author_id, raw_content, status)
         values ($1::uuid, $2::uuid, $3, 'PUBLISHED') returning id`,
        [workspaceId, userId, content],
      );
      const item = await sql.query<{ id: string }>(
        `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status, published_at)
         values ($1::uuid, $2::uuid, now(), 'PUBLISHED', now()) returning id`,
        [(post[0] as { id: string }).id, accountId],
      );
      await sql.query(
        `insert into public.post_metrics (scheduled_item_id, likes, comments, shares, impressions, engagement_rate, updated_at)
         values ($1::uuid, 1, 1, 1, 100, $2, now())`,
        [(item[0] as { id: string }).id, rate],
      );
      return (post[0] as { id: string }).id;
    };

    await publish("Our best post. We cupped every bag twice before saying yes to it.", 0.2);
    await publish("Our second best. We rebuilt the grinder burrs over the weekend.", 0.1);
    await publish("Barely read. A short note on extraction yield: 21%, up from 19.5%.", 0.01);

    const examples = await createPostgresBrandService(sql as never).listVoiceExamples(context(), { limit: 2 });
    expect(examples).toHaveLength(2);
    // Every one of them came from the metrics, and says so — "we marked this" and "this worked" are
    // different claims to put in front of a model.
    expect(examples.every((example) => example.source === "auto_top")).toBe(true);
  });

  it("never displaces a post somebody marked, and does not show one twice", async () => {
    /**
     * Two guarantees that only fail together in production.
     *
     * An explicit signal losing to a measured one would make the toggle on the post detail page
     * advisory, which is not what a checkbox means. And `workspace_top_posts` returns one row per
     * published *destination*, so a post published to two platforms is two rows of the same caption —
     * shown twice, the model learns that whatever it says is what this brand always says.
     */
    /*
     * The workspace is shared with the tests above, which flag posts of their own. Clearing the flag
     * — not the posts — is what makes this test's precondition (one flagged post, the one it inserts) true rather than
     * dependent on which order vitest happened to run them in.
     */
    await sql.query("update public.posts set is_voice_exemplar = false where workspace_id = $1::uuid", [workspaceId]);
    const account = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'ext-voice-2', 'Voice test 2', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    const second = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'x', 'ext-voice-3', 'Voice test 3', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    const flaggedAndTop = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, is_voice_exemplar, voice_exemplar_source)
       values ($1::uuid, $2::uuid, 'The one we marked, which also did well.', 'PUBLISHED', true, 'manual') returning id`,
      [workspaceId, userId],
    );
    const postId = (flaggedAndTop[0] as { id: string }).id;

    // Published to two destinations: two rows in the view, one post.
    for (const acc of [account[0] as { id: string }, second[0] as { id: string }]) {
      const item = await sql.query<{ id: string }>(
        `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status, published_at)
         values ($1::uuid, $2::uuid, now(), 'PUBLISHED', now()) returning id`,
        [postId, acc.id],
      );
      await sql.query(
        `insert into public.post_metrics (scheduled_item_id, likes, comments, shares, impressions, engagement_rate, updated_at)
         values ($1::uuid, 9, 9, 9, 900, 0.9, now())`,
        [(item[0] as { id: string }).id],
      );
    }

    const examples = await createPostgresBrandService(sql as never).listVoiceExamples(context(), { limit: 3 });
    const ids = examples.map((example) => String(example.postDraftId));
    expect(new Set(ids).size, "the same post must not appear twice").toBe(ids.length);
    const mine = examples.filter((example) => String(example.postDraftId) === postId);
    expect(mine, "the flagged post is present exactly once").toHaveLength(1);
    expect(mine[0]?.source, "and it is reported as the person's choice, not as a metric").toBe("manual");
  });

  it("says which of its methods have no store, rather than letting empty read as data", async () => {
    /**
     * `getClaimPolicy` and `getPerformanceBrief` have no table. They answer empty so a run completes — a shadow
     * turn that died on an optional brief would produce no parity data at all — and `BRAND_SUPPORTED` is how a
     * caller tells that apart from "this workspace forbids nothing".
     */
    const brand = createPostgresBrandService(sql as never);
    expect(await brand.getClaimPolicy(context())).toEqual({ approved: [], forbidden: [] });
    expect(await brand.getPerformanceBrief(context())).toBeNull();
    expect(BRAND_SUPPORTED.getClaimPolicy).toBe(false);
    expect(BRAND_SUPPORTED.getPerformanceBrief).toBe(false);
    expect(BRAND_SUPPORTED.getBrandProfile).toBe(true);
  });
});

describe.skipIf(URL_ === undefined)("ContentService over posts", () => {
  const content = () => createPostgresContentService(sql as never);

  it("writes a thread and its parts in one statement — #456", async () => {
    /**
     * Post and parts commit together or not at all. A half-written thread would publish as a
     * truncated one: the publisher reads whatever rows exist and stops, and the reader gets an
     * argument that ends in the middle.
     *
     * One statement rather than a transaction — a data-modifying CTE runs exactly once and to
     * completion whether or not the outer query reads it, so this needs no transaction runner
     * threaded through the service.
     */
    const created = await content().createThreadDraft(context(), {
      idempotencyKey: "thread-1" as never,
      /*
       * One hashtag, on part one only — and that is the assertion, not the fixture's convenience.
       * ShareFlow's shipped `x` rule requires at least one. Per part, a five-part thread would need
       * five, and the instagram rule's five would need twenty-five; nobody writes that. Hashtags are
       * checked across the thread because a reader receives a thread as one thing.
       */
      parts: [
        { body: "We cupped eleven samples this week. #coffee" },
        { body: "Two made it. The rest were good, not right." },
      ],
      targetPlatforms: ["x"] as never,
    });

    const rows = await sql.query<{ ordinal: number; body: string }>(
      "select ordinal, body from public.post_parts where post_id = $1::uuid order by ordinal",
      [String(created.id)],
    );
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(rows[0]?.body).toBe("We cupped eleven samples this week. #coffee");

    const post = await sql.query<{ format: string; raw_content: string }>(
      "select format, raw_content from public.posts where id = $1::uuid",
      [String(created.id)],
    );
    expect(post[0]?.format).toBe("thread");
    /*
     * `raw_content` holds part one. Nothing publishes it for a thread, but list excerpts, duplicate
     * detection and the posts screen all read it — an empty one would make a thread look like a blank
     * post everywhere it is not being published.
     */
    expect(post[0]?.raw_content).toBe("We cupped eleven samples this week. #coffee");
  });

  it("counts hashtags across the thread, not per part", async () => {
    /**
     * The real `platform_rules` row is what made this necessary rather than theoretical: `x` requires
     * at least one hashtag. Checked per part, this thread fails on part two and a five-part thread
     * would need five hashtags — which nobody writes, and which would make threads unusable on the one
     * platform whose product they are.
     *
     * Length stays per part, because each part really is its own post. The two rules are about
     * different things and this is the case that separates them.
     */
    const created = await content().createThreadDraft(context(), {
      idempotencyKey: "thread-hashtags" as never,
      parts: [{ body: "The opener carries it. #coffee" }, { body: "No hashtag here." }, { body: "Nor here." }],
      targetPlatforms: ["x"] as never,
    });
    expect(String(created.id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a one-part thread, because that is a post", async () => {
    const error = thrown(
      await content()
        .createThreadDraft(context(), {
          idempotencyKey: "thread-2" as never,
          parts: [{ body: "Just the one." }],
          targetPlatforms: ["x"] as never,
        })
        .catch((e: unknown) => e),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(/create_post_draft/);
  });

  it("validates every part and saves nothing when one fails, naming which", async () => {
    /**
     * Each part becomes its own post, so each must fit the platform's limits alone. A thread whose
     * fourth part is 400 characters over is not a long thread — it is one that stops at three, half
     * of it already public.
     *
     * The ordinal is in the message because "part 2 is too long for x" is actionable and "the post is
     * too long" is not when there are three of them.
     */
    const before = await sql.query<{ n: string }>(
      "select count(*) as n from public.posts where workspace_id = $1::uuid and format = 'thread'",
      [workspaceId],
    );
    const error = thrown(
      await content()
        .createThreadDraft(context(), {
          idempotencyKey: "thread-3" as never,
          parts: [{ body: "fine #coffee" }, { body: "x".repeat(500) }, { body: "also fine" }],
          targetPlatforms: ["x"] as never,
        })
        .catch((e: unknown) => e),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(/Part 2:/);
    const after = await sql.query<{ n: string }>(
      "select count(*) as n from public.posts where workspace_id = $1::uuid and format = 'thread'",
      [workspaceId],
    );
    expect(after[0]?.n, "nothing may be saved when a part fails").toBe(before[0]?.n);
  });

  it("creates a draft and reads it back with the caption intact", async () => {
    const created = await content().createDraft(context(), {
      idempotencyKey: "k1" as never,
      /**
       * Five hashtags, because instagram's **shipped** rule requires them.
       *
       * The first version of this fixture had one and the adapter refused it — correctly. Worth leaving the
       * note: the refusal was the code reading a real `platform_rules` row rather than a constant, which is
       * the behaviour the port asks for and the thing a fake executor could never have shown.
       */
      caption: "Launch day. #ship #launch #product #team #news",
      targetPlatforms: ["instagram"] as never,
    });
    expect(created.caption).toBe("Launch day. #ship #launch #product #team #news");
    /**
     * The stored length, which is the field's whole purpose: a model asked to repeat a long caption into a
     * tool argument may abbreviate it, and the result publishes a fragment of what the user was shown.
     */
    expect(created.captionLength).toBe("Launch day. #ship #launch #product #team #news".length);

    const read = await content().getDraft(context(), { id: created.id });
    expect(read.caption).toBe(created.caption);
    expect(read.status).toBe("draft");
  });

  it("answers not_found — never forbidden — for another tenant's draft", async () => {
    /**
     * The two must be indistinguishable, or the endpoint confirms the existence of other tenants' ids. Every
     * query is scoped by `workspace_id`, so this holds by construction rather than by a check to forget.
     */
    const other = await sql.query<{ id: string }>(
      "insert into public.workspaces (name) values ('other') returning id",
      [],
    );
    const foreign = await sql.query<{ id: string }>(
      "insert into public.posts (workspace_id, author_id, raw_content, status) values ($1::uuid, $2::uuid, 'theirs', 'DRAFT') returning id",
      [other[0]!.id, userId],
    );
    await expect(content().getDraft(context(), { id: foreign[0]!.id as never })).rejects.toMatchObject({
      code: "not_found",
    });
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("refuses to save a draft that fails validation, and saves nothing", async () => {
    /**
     * #123's AC-3. The obvious order is the other one — insert, then validate — which leaves a bad draft
     * behind whenever a caller retries.
     */
    const before = await sql.query<{ n: string }>("select count(*) as n from public.posts where workspace_id = $1::uuid", [
      workspaceId,
    ]);
    await expect(
      content().createDraft(context(), { idempotencyKey: "k2" as never, caption: "  ", targetPlatforms: ["instagram"] as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const after = await sql.query<{ n: string }>("select count(*) as n from public.posts where workspace_id = $1::uuid", [
      workspaceId,
    ]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("enforces the workspace's own character limit, not a constant", async () => {
    /**
     * The reason the limits live in the service: `platform_rules` is workspace-overridable, so a limit known
     * to the caller is a limit that can be wrong for the workspace. This inserts an override and asserts it
     * wins over the shipped default.
     */
    await sql.query(
      `insert into public.platform_rules (workspace_id, platform, char_limit, hashtag_min, hashtag_max)
       values ($1::uuid, 'instagram', 20, 0, 30)`,
      [workspaceId],
    );
    const report = await content().validateContent(context(), {
      caption: "a".repeat(50),
      platformIds: ["instagram"] as never,
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("caption-too-long");
    // And the message names the workspace's number, not a default.
    expect(report.issues.find((issue) => issue.code === "caption-too-long")?.message).toContain("allows 20");
  });

  it("reports a platform with no rules rather than silently accepting it", async () => {
    // Silence would mean this deployment validated nothing for that destination, and the failure would surface
    // as a rejected publish long after the assistant said the post was fine.
    const report = await content().validateContent(context(), {
      caption: "hello",
      platformIds: ["fictional-network"] as never,
    });
    expect(report.issues.map((issue) => issue.code)).toContain("platform-unknown");
  });

  it("lists summaries with an excerpt, never the body", async () => {
    // linkedin wants three to five hashtags; the body is what this test is about.
    const long = `${"x".repeat(EXCERPT_CHARS + 200)} #a #b #c`;
    await content().createDraft(context(), {
      idempotencyKey: "k3" as never,
      caption: long,
      targetPlatforms: ["linkedin"] as never,
    });
    const page = await content().listDrafts(context(), { limit: 10 });
    const summary = page.items.find((item) => item.captionLength === long.length);
    expect(summary).toBeDefined();
    // A list of twenty captions is the context budget, so a summary carries the length and a recognisable head.
    expect(summary!.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(summary!.captionLength).toBe(long.length);
  });

  it("refuses to edit a published post and names duplicating as the remedy", async () => {
    const published = await sql.query<{ id: string }>(
      "insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms) values ($1::uuid, $2::uuid, 'live', 'PUBLISHED', '{instagram}') returning id",
      [workspaceId, userId],
    );
    await expect(
      content().updateDraft(context(), { idempotencyKey: "k4" as never, id: published[0]!.id as never, patch: { caption: "edited" } }),
    ).rejects.toMatchObject({ code: "conflict", details: { remedy: "duplicate" } });
  });

  it("returns `updatedAt` and the cursor as ISO strings, not Date objects", async () => {
    /**
     * Found by sabotage: reverting `iso()` on a draft's `updated_at` broke **nothing**, while the same revert
     * on a campaign's `created_at` was caught. The two are the same defect and only one was observable.
     *
     * It matters because node-postgres parses `timestamptz` into a `Date`, the port declares these `string`,
     * and a `Date` passes through `JSON.stringify` looking correct — so the failure surfaces in a caller doing
     * `updatedAt.slice(0, 10)`, far from here. `nextCursor` is the same value and is documented as an opaque
     * string a caller hands back.
     */
    await content().createDraft(context(), {
      idempotencyKey: "iso-1" as never,
      // linkedin, not instagram: an earlier test in this suite installs a 20-character override for
      // instagram, and a fixture that ignored it would fail for a reason this test is not about.
      caption: "first of two #a #b #c",
      targetPlatforms: ["linkedin"] as never,
    });
    await content().createDraft(context(), {
      idempotencyKey: "iso-2" as never,
      caption: "second of two #a #b #c",
      targetPlatforms: ["linkedin"] as never,
    });

    const draft = await content().listDrafts(context(), { limit: 1 });
    expect(typeof draft.items[0]!.updatedAt).toBe("string");
    expect(draft.items[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // A full page means a cursor, and it has to be the kind of value it is typed as.
    expect(typeof draft.nextCursor).toBe("string");
    expect(draft.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // And it round-trips: handing it back reads the next page rather than erroring on the cast.
    const next = await content().listDrafts(context(), { limit: 1, cursor: draft.nextCursor! });
    expect(next.items[0]!.id).not.toBe(draft.items[0]!.id);

    const one = await content().getDraft(context(), { id: draft.items[0]!.id });
    expect(typeof one.updatedAt).toBe("string");
  });

  it("duplicates without touching the original", async () => {
    // The port's whole point: "a duplicate is safe in a way that mutating a published post would not be."
    const original = await content().createDraft(context(), {
      idempotencyKey: "k5" as never,
      caption: "original text",
      targetPlatforms: ["instagram"] as never,
    });
    const copy = await content().duplicateDraft(context(), { idempotencyKey: "k6" as never, id: original.id });
    expect(copy.id).not.toBe(original.id);
    expect(copy.caption).toBe("original text");
    expect(copy.status).toBe("draft");
    expect((await content().getDraft(context(), { id: original.id })).caption).toBe("original text");
  });
});

describe.skipIf(URL_ === undefined)("what a real shadow turn found, which no test had", () => {
  /**
   * Four defects, all reached from a **model argument** in a live `create-post` turn against this database.
   * Every one of them was invisible to the compiler and to the 52 tests above.
   */
  const content = () => createPostgresContentService(sql as never);

  /**
   * **linkedin, not instagram, throughout this block.**
   *
   * The suite shares one workspace, and an earlier test installs a workspace override for instagram
   * (`char_limit: 20, hashtag_min: 0`) to prove that a workspace's own limits beat the shipped defaults. That
   * override then changes what *these* tests see — a 20-character ceiling refuses every fixture here, and a
   * zero minimum removes the very finding the first test is about. Three of these failed on it first time.
   *
   * linkedin's shipped rule (3-5 hashtags, 3000 characters) is untouched by the suite, so these assertions
   * are about the code rather than about test order.
   */

  it("marks every validation issue repairable or not — the field the repair loop reads", async () => {
    /**
     * **The defect that made the workflow impossible.** `ValidationIssue.repairable` is required in the port
     * and every issue here was built with `as unknown as ValidationIssue` and no such field.
     *
     * `generate_content`'s loop is `issues.some((i) => !i.repairable)` and stops on the first unrepairable
     * finding — and `!undefined` is `true`, so **every** finding read as unrepairable and generation never
     * made a second attempt. ShareFlow's shipped instagram rule wants five hashtags, gpt-4o writes two or
     * three, and the loop recovers on the very next attempt when told. It never got one: the tool refused
     * with "no version could be written that passes the brand's rules and the destinations' limits", which
     * reads as the model being incapable rather than as a dropped field.
     */
    const report = await content().validateContent(context(), {
      caption: "one hashtag #a",
      platformIds: ["linkedin"] as never,
    });
    expect(report.ok).toBe(false);
    for (const issue of report.issues) expect(typeof issue.repairable).toBe("boolean");
    // A hashtag count is exactly what regenerating fixes.
    expect(report.issues.find((issue) => issue.code === "hashtags-too-few")?.repairable).toBe(true);

    // And a missing destination is not: no amount of regenerating supplies one, so the assistant must ask.
    const noDestination = await content().validateContent(context(), { caption: "text", platformIds: [] as never });
    expect(noDestination.issues.find((issue) => issue.code === "no-destination")?.repairable).toBe(false);
  });

  it("answers invalid_input for a malformed id, not a Postgres cast error as `internal`", async () => {
    /**
     * A real turn passed `campaignId: "1"`. It reached `$7::uuid` and came back as
     * `invalid input syntax for type uuid: "1"` under code `internal` — a code that reads as a platform
     * fault and tells a model nothing it can act on.
     */
    const error = thrown(await content().getDraft(context(), { id: "1" as never }).catch((r: unknown) => r));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("must be a UUID");
    // The field, so the model knows which argument to change.
    expect(error.message).toContain("id");
  });

  it("answers invalid_input for a junk cursor, and does not let it reach a timestamptz cast", async () => {
    /**
     * Recorded verbatim because inventing this input would not have occurred to me. A live gpt-4o turn called
     * `list_campaigns` with
     *
     *     cursor: "}.kwargs_0_0} 0_SKIP_TO_PARAMS_MULTI_0_GP.next_0_multi_tool_use.parallel…"
     *
     * and in another run, four times with `cursor: "/"`. Untyped, each reached `$3::timestamptz` and returned
     * `date/time field value out of range: "0"` as `internal`. One malformed argument took out an otherwise
     * complete turn.
     */
    for (const cursor of ["/", "}.kwargs_0_0} 0_SKIP_TO_PARAMS_MULTI_0_GP.next_0_multi_tool_use.parallel"]) {
      const error = thrown(
        await content().listDrafts(context(), { limit: 5, cursor }).catch((rejection: unknown) => rejection),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("cursor");
    }
    // A real cursor still works, so the check did not close the door it guards.
    const page = await content().listDrafts(context(), { limit: 1 });
    if (page.nextCursor !== undefined) {
      await expect(content().listDrafts(context(), { limit: 1, cursor: page.nextCursor })).resolves.toBeDefined();
    }
  });

  it("refuses to attach a draft to another workspace's campaign", async () => {
    /**
     * **A cross-tenant hole the database does not close.** `posts_campaign_id_fkey` is
     * `FOREIGN KEY (campaign_id) REFERENCES campaigns(id)` and nothing more, so Postgres will happily attach
     * workspace B's draft to workspace A's campaign. Verified directly against this schema before the fix:
     *
     * ```
     *  post_in_b | points_at_a_campaign
     * -----------+----------------------
     *  t         | t
     * ```
     *
     * The id comes from a model argument, so it is reachable. Same lesson as the status-transition trigger,
     * which skips validation entirely when `auth.uid()` is null: the database does not guard this for a
     * service-role caller, so the service must.
     *
     * `not_found`, never `forbidden` — the two must be indistinguishable, or the endpoint confirms the
     * existence of other tenants' ids.
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-camp') returning id");
    const theirs = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, starts_on, ends_on, cadence, channels)
       values ($1::uuid, 'theirs', 't', '2026-10-01', '2026-10-02', 'weekly', '{instagram}') returning id`,
      [other[0]!.id],
    );

    const error = thrown(
      await content()
        .createDraft(context(), {
          idempotencyKey: "xt-1" as never,
          caption: "attaching to someone else's campaign #a #b #c #d #e",
          targetPlatforms: ["linkedin"] as never,
          campaignId: theirs[0]!.id as never,
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("not_found");

    // Nothing was written — the check runs before the insert, not as a cleanup after it.
    const written = await sql.query<{ n: string }>(
      "select count(*) as n from public.posts where workspace_id = $1::uuid and campaign_id = $2::uuid",
      [workspaceId, theirs[0]!.id],
    );
    expect(written[0]!.n).toBe("0");
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("answers not_found for a campaign that does not exist, not a foreign-key violation", async () => {
    // Same fix, kinder symptom: a well-formed id for no campaign used to surface as
    // `insert or update on table "posts" violates foreign key constraint` under code `internal`.
    const error = thrown(
      await content()
        .createDraft(context(), {
          idempotencyKey: "xt-2" as never,
          caption: "attaching to nothing #a #b #c #d #e",
          targetPlatforms: ["linkedin"] as never,
          campaignId: "00000000-0000-0000-0000-000000000000" as never,
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("list_campaigns");
  });

  it("attaches a draft to this workspace's own campaign", async () => {
    // The capability still works: the check refuses other tenants' ids, not every id.
    const mine = await content().createCampaign(context(), {
      idempotencyKey: "own-1" as never,
      name: "Own campaign",
      theme: "t",
      startsOn: "2026-11-01" as never,
      endsOn: "2026-11-30" as never,
      cadence: "weekly" as never,
      channels: ["linkedin"] as never,
    });
    const draft = await content().createDraft(context(), {
      idempotencyKey: "own-2" as never,
      caption: "in a campaign #a #b #c #d #e",
      targetPlatforms: ["linkedin"] as never,
      campaignId: mine.id,
    });
    expect(draft.campaignId).toBe(mine.id);
  });
});

describe.skipIf(URL_ === undefined)("ContentService over campaigns — the five methods nothing exercised", () => {
  /**
   * ## Why this block exists
   *
   * The five campaign methods were written, typechecked, exported and **completely unreachable**. Driving them
   * against the real schema for the first time, the very first call failed:
   *
   * ```
   * createCampaign: [23502] null value in column "mode" of relation "campaigns" violates not-null constraint
   * ```
   *
   * Behind it were three more, each of which would have failed the next call in turn: `status` was inserted as
   * `'DRAFT'` where `campaigns_status_check` admits only lower-case, `cadence` was passed straight through so
   * `3x-week` violated its own CHECK, and `starts_on` was read as a string when node-postgres hands over a
   * `Date`, so the mapper threw `value.slice is not a function`.
   *
   * Four independent failures in one code path, none of them visible to the compiler, all four found by the
   * first real call. That is the argument for this file being a live-database suite rather than a fake.
   */
  const content = () => createPostgresContentService(sql as never);

  const CAMPAIGN = {
    idempotencyKey: "camp-1" as never,
    name: "Launch week",
    theme: "the launch",
    goal: "signups",
    startsOn: "2026-10-01" as never,
    endsOn: "2026-10-21" as never,
    cadence: "weekly" as never,
    channels: ["instagram"] as never,
  };

  it("creates a campaign and reads it back — the call that used to fail every time", async () => {
    const created = await content().createCampaign(context(), CAMPAIGN);
    expect(created.name).toBe("Launch week");
    /**
     * The two columns that are `NOT NULL` **with a default**. An omitted optional became an explicit `null`
     * parameter, which does not fall back to the default — it violates the constraint.
     */
    expect(created.mode).toBe(DEFAULT_CAMPAIGN_MODE);
    expect(created.mediaType).toBe(DEFAULT_CAMPAIGN_MEDIA_TYPE);
    expect(created.status).toBe("draft");

    const read = await content().getCampaign(context(), { id: created.id });
    expect(read).toEqual(created);
  });

  it("stores the status the CHECK constraint admits, in the case it admits", async () => {
    /**
     * Posts are upper-case in this database and campaigns are not — the kind of inconsistency that survives a
     * reading and fails at runtime. Asserted against the stored value, not the mapped one, because the mapper
     * would happily lower-case a value the insert could never have written.
     */
    const created = await content().createCampaign(context(), { ...CAMPAIGN, idempotencyKey: "camp-2" as never });
    const stored = await sql.query<{ status: string }>("select status from public.campaigns where id = $1::uuid", [
      String(created.id),
    ]);
    expect(stored[0]!.status).toBe("draft");
  });

  it("round-trips a `3x-week` cadence through the column that spells it `3x_week`", async () => {
    const created = await content().createCampaign(context(), {
      ...CAMPAIGN,
      idempotencyKey: "camp-3" as never,
      cadence: "3x-week" as never,
    });
    expect(created.cadence).toBe("3x-week");
    // And the store really does hold the underscore, which is what the CHECK constraint requires.
    const stored = await sql.query<{ cadence: string }>("select cadence from public.campaigns where id = $1::uuid", [
      String(created.id),
    ]);
    expect(stored[0]!.cadence).toBe("3x_week");
    // Three weeks at three a week is nine posts, not the three a weekly fallthrough would have reported.
    expect(created.plannedPostCount).toBe(9);
  });

  it("returns dates as `YYYY-MM-DD` and instants as ISO strings, not Date objects", async () => {
    /**
     * The port declares every one of these a `string`, and node-postgres parses `date` and `timestamptz` into
     * `Date`. A `Date` here survives `JSON.stringify` looking correct and fails every `typeof`, `slice` and
     * `startsWith` — and `nextCursor` is one of these values, documented as an opaque string.
     *
     * The `date` columns are selected `::text` rather than converted in JavaScript, because node-postgres
     * builds a `Date` at **local** midnight: an ISO round-trip moves the day backwards for every negative UTC
     * offset, so a campaign starting on the 1st would report the 30th in Los Angeles.
     */
    const created = await content().createCampaign(context(), { ...CAMPAIGN, idempotencyKey: "camp-4" as never });
    expect(typeof created.startsOn).toBe("string");
    expect(created.startsOn).toBe("2026-10-01");
    expect(created.endsOn).toBe("2026-10-21");
    expect(typeof created.createdAt).toBe("string");
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("patches one field without disturbing the rest", async () => {
    const created = await content().createCampaign(context(), { ...CAMPAIGN, idempotencyKey: "camp-5" as never });
    const patched = await content().updateCampaign(context(), {
      idempotencyKey: "camp-5u" as never,
      id: created.id,
      patch: { name: "Launch week, revised" },
    });
    expect(patched.name).toBe("Launch week, revised");
    expect(patched.theme).toBe(created.theme);
    expect(patched.cadence).toBe(created.cadence);
    expect(patched.startsOn).toBe(created.startsOn);
  });

  it("refuses a one-sided date edit against the stored value, not with a constraint string", async () => {
    /**
     * The port's reason: the store has `CHECK (ends_on >= starts_on)` and a caller changing only one of the two
     * has no access to the other. Left to the constraint, a one-sided edit reaches the model as a raw violation
     * naming a constraint rather than the two dates that conflict.
     */
    const created = await content().createCampaign(context(), { ...CAMPAIGN, idempotencyKey: "camp-6" as never });
    const error = thrown(
      await content()
        .updateCampaign(context(), {
          idempotencyKey: "camp-6u" as never,
          id: created.id,
          patch: { endsOn: "2026-09-01" as never },
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("invalid_input");
    // Both dates, so the model can see which one to move.
    expect(error.message).toContain("2026-09-01");
    expect(error.message).toContain("2026-10-01");
  });

  it("refuses an off-union cadence by name, and writes nothing", async () => {
    /**
     * The types say `CampaignCadence`, so this can only happen one way — and it is the way that keeps
     * happening: a tool's Zod schema one shade looser than the union puts an arbitrary string here with
     * nothing complaining. `campaigns_cadence_check` would name a constraint; this names the three values.
     */
    const before = await sql.query<{ n: string }>(
      "select count(*) as n from public.campaigns where workspace_id = $1::uuid",
      [workspaceId],
    );
    const error = thrown(
      await content()
        .createCampaign(context(), { ...CAMPAIGN, idempotencyKey: "camp-7" as never, cadence: "fortnightly" as never })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("3x-week");
    const after = await sql.query<{ n: string }>(
      "select count(*) as n from public.campaigns where workspace_id = $1::uuid",
      [workspaceId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("keeps this adapter's defaults equal to the schema's own", async () => {
    /**
     * A tripwire, not a belief. `mode` and `media_type` are duplicated here because a single-statement insert
     * cannot ask a column for its default — so the duplication is checked against
     * `information_schema.column_default` and fails the moment a migration changes either.
     */
    const defaults = await sql.query<{ column_name: string; column_default: string }>(
      `select column_name, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'campaigns' and column_name in ('mode', 'media_type')`,
    );
    const of = (name: string) => defaults.find((row) => row.column_name === name)?.column_default ?? "";
    expect(of("mode")).toContain(DEFAULT_CAMPAIGN_MODE);
    expect(of("media_type")).toContain(DEFAULT_CAMPAIGN_MEDIA_TYPE);
  });

  it("answers not_found for another workspace's campaign", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-c') returning id");
    const foreign = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, starts_on, ends_on, cadence, channels)
       values ($1::uuid, 'theirs', 't', '2026-10-01', '2026-10-02', 'weekly', '{instagram}') returning id`,
      [other[0]!.id],
    );
    await expect(content().getCampaign(context(), { id: foreign[0]!.id as never })).rejects.toMatchObject({
      code: "not_found",
    });
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });
});

describe.skipIf(URL_ === undefined)("the campaign calendar, one row per destination", () => {
  /**
   * ## The worst bug in the adapter, and it was in four characters of a lookup table
   *
   * `scheduled_items.status` is `PENDING | QUEUED | SUCCESS | FAILED` — ShareFlow's own type, at
   * `web/src/lib/data/posts.ts:6`. The previous mapping had arms for `PUBLISHED` and `CANCELLED`, which the
   * column never holds, **no arm for `SUCCESS`**, and a default of `pending`, which is not a member of
   * `PUBLISH_TARGET_STATES` either.
   *
   * So every destination that had actually published read as waiting to publish. An assistant asked "did the
   * campaign go out?" would have said no, about a campaign that went out. It typechecked because the function
   * returned `as never`.
   */
  const content = () => createPostgresContentService(sql as never);

  let campaignId = "";
  let accountId = "";

  beforeAll(async () => {
    if (URL_ === undefined) return;
    const campaign = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, starts_on, ends_on, cadence, channels)
       values ($1::uuid, 'calendar', 't', '2026-10-01', '2026-10-31', 'weekly', '{instagram}') returning id`,
      [workspaceId],
    );
    campaignId = campaign[0]!.id;
    const account = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'instagram', 'ig-1', 'Acme IG', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    accountId = account[0]!.id;
  });

  /** One post plus one scheduled item in the given state, so a mapping can be read off a real row. */
  const itemWith = async (status: string, at: string): Promise<void> => {
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, campaign_id, target_platforms)
       values ($1::uuid, $2::uuid, $3, 'APPROVED', $4::uuid, '{instagram}') returning id`,
      [workspaceId, userId, `post for ${status}`, campaignId],
    );
    await sql.query(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, $3::timestamptz, $4)`,
      [post[0]!.id, accountId, at, status],
    );
  };

  it("reports a SUCCESS destination as published, which is the bug this replaced", async () => {
    await itemWith("SUCCESS", "2026-10-02T09:00:00Z");
    const page = await content().getCampaignCalendar(context(), { id: campaignId as never, limit: 10 });
    const item = page.items.find((candidate) => candidate.excerpt.includes("SUCCESS"));
    expect(item?.state).toBe("published");
  });

  it("maps every status the column actually holds onto a state the port declares", async () => {
    await itemWith("PENDING", "2026-10-03T09:00:00Z");
    await itemWith("QUEUED", "2026-10-04T09:00:00Z");
    await itemWith("FAILED", "2026-10-05T09:00:00Z");
    const page = await content().getCampaignCalendar(context(), { id: campaignId as never, limit: 20 });
    const stateOf = (marker: string) =>
      page.items.find((candidate) => candidate.excerpt.includes(marker))?.state;
    // `PENDING` is waiting for its time; `QUEUED` is an attempt handed over and not yet confirmed.
    expect(stateOf("PENDING")).toBe("scheduled");
    expect(stateOf("QUEUED")).toBe("publishing");
    expect(stateOf("FAILED")).toBe("failed");
    for (const item of page.items) expect(PUBLISH_TARGET_STATES).toContain(item.state);
  });

  it("reads an unrecognised status as publishing rather than claiming an outcome", async () => {
    /**
     * `publishing` is the port's unconfirmed state — *"an attempt in flight, or one whose process died
     * mid-attempt"*. The alternatives both assert something that may be false: `published` claims a result and
     * `failed` claims a failure. `AUTH_FAILED` is a real example — it appears in ShareFlow's publisher and not
     * in its declared union.
     */
    await itemWith("AUTH_FAILED", "2026-10-06T09:00:00Z");
    const page = await content().getCampaignCalendar(context(), { id: campaignId as never, limit: 20 });
    expect(page.items.find((candidate) => candidate.excerpt.includes("AUTH_FAILED"))?.state).toBe("publishing");
  });

  it("never returns another workspace's scheduled items", async () => {
    /**
     * Found by sabotage: removing `p.workspace_id = $1` from this query broke **nothing**. The calendar joins
     * three tables and its entire tenant scoping is that one predicate — the campaign id alone is not a scope,
     * because ids are guessable and a caller supplies this one.
     *
     * Empty rather than `not_found` is deliberate here, for the reason `getDraft` answers `not_found` rather
     * than `forbidden`: an empty calendar for a foreign id is indistinguishable from a real campaign with
     * nothing scheduled, so the answer confirms nothing about other tenants' data.
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-cal') returning id");
    const theirCampaign = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, starts_on, ends_on, cadence, channels)
       values ($1::uuid, 'theirs', 't', '2026-10-01', '2026-10-31', 'weekly', '{instagram}') returning id`,
      [other[0]!.id],
    );
    const theirAccount = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'instagram', 'ig-2', 'Their IG', '{}'::jsonb, 'ACTIVE') returning id`,
      [other[0]!.id],
    );
    const theirPost = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, campaign_id, target_platforms)
       values ($1::uuid, $2::uuid, 'THEIR SECRET POST', 'APPROVED', $3::uuid, '{instagram}') returning id`,
      [other[0]!.id, userId, theirCampaign[0]!.id],
    );
    await sql.query(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, '2026-10-09T09:00:00Z'::timestamptz, 'SUCCESS')`,
      [theirPost[0]!.id, theirAccount[0]!.id],
    );

    // Asking for *their* campaign id from *our* context returns nothing — not their row.
    const foreign = await content().getCampaignCalendar(context(), {
      id: theirCampaign[0]!.id as never,
      limit: 20,
    });
    expect(foreign.items).toEqual([]);

    // And our own calendar never picks their item up either.
    const ours = await content().getCampaignCalendar(context(), { id: campaignId as never, limit: 50 });
    expect(ours.items.some((item) => item.excerpt.includes("THEIR SECRET"))).toBe(false);

    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("names the destination's platform, one row per account", async () => {
    // The port's reason for joining `scheduled_items`: "a post to three channels is three rows with three states".
    const page = await content().getCampaignCalendar(context(), { id: campaignId as never, limit: 20 });
    expect(page.items.length).toBeGreaterThan(1);
    for (const item of page.items) {
      expect(item.platformId).toBe("instagram");
      expect(typeof item.scheduledAt).toBe("string");
    }
  });
});


describe.skipIf(URL_ === undefined)("ConnectorService — where the assistant learns it may publish", () => {
  /**
   * The fifth adapter, and it exists because of a gap the publishing work exposed: all five publishing
   * capabilities worked and nothing could tell the assistant *where* to publish. `list_accounts` is the only
   * capability that surfaces an account id, so a real turn could do nothing but guess — and it did, inventing
   * `accountIds: ["linkedin123"]`.
   */
  const connectors = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      ...over,
    }).connectors;

  let active = "";
  let expiredByStatus = "";
  let expiredByToken = "";
  let unknownStatus = "";

  beforeAll(async () => {
    if (URL_ === undefined) return;
    const rows = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status, token_expires_at)
       values
         ($1::uuid, 'linkedin', 'c-1', 'Acme Live',      '{"access_token":"SECRET-A"}'::jsonb, 'ACTIVE',  null),
         ($1::uuid, 'linkedin', 'c-2', 'Acme Lapsed',    '{"access_token":"SECRET-B"}'::jsonb, 'EXPIRED', null),
         -- ACTIVE with an expiry in the past: the disagreement healthOf exists to resolve.
         ($1::uuid, 'x',        'c-3', 'Acme Stale',     '{"access_token":"SECRET-C"}'::jsonb, 'ACTIVE',  now() - interval '1 day'),
         -- DISCONNECTED: permitted by the constraint and written by nothing in ShareFlow today.
         ($1::uuid, 'x',        'c-4', 'Acme Cut Off',   '{"access_token":"SECRET-D"}'::jsonb, 'DISCONNECTED', null)
       returning id`,
      [workspaceId],
    );
    // Non-null: the insert returns four rows or the suite has no fixtures at all.
    [active, expiredByStatus, expiredByToken, unknownStatus] = rows.map((row) => row.id) as [
      string,
      string,
      string,
      string,
    ];
  });

  const byName = async (name: string) =>
    (await connectors().listAccounts(context())).find((account) => account.displayName === name);

  it("lists this workspace's destinations with their stored health", async () => {
    const accounts = await connectors().listAccounts(context());
    expect(accounts.length).toBeGreaterThanOrEqual(4);
    expect((await byName("Acme Live"))?.health).toBe("active");
    expect((await byName("Acme Lapsed"))?.health).toBe("expired");
  });

  it("never returns a credential", async () => {
    const accounts = await connectors().listAccounts(context());
    const serialised = JSON.stringify(accounts);
    for (const secret of ["SECRET-A", "SECRET-B", "SECRET-C", "SECRET-D", "access_token", "auth_tokens"]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });

  it("never asks the database for the credential column either", () => {
    /**
     * **Scanned from the source, because the output cannot show it.** Sabotage added `auth_tokens` to the
     * `SELECT` and the assertion above still passed — the mapper does not copy it, so selecting it changes
     * nothing observable.
     *
     * That makes not selecting it a defence in depth rather than a testable behaviour, and for a column
     * holding access and refresh tokens the defence is worth pinning: the way a credential reaches a model
     * prompt is a `select *`, or one field added to a column list by someone who did not think about it. The
     * value never entering the process is stronger than a mapper remembering to drop it.
     */
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../connectors.ts"), "utf8");
    const selects = [...source.matchAll(/select\s[\s\S]*?from public\.social_accounts/g)].map((m) => m[0]);
    // Found the query rather than nothing: a regex that matched none would pass the loop below.
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) expect(select).not.toContain("auth_tokens");
  });

  it("reports an ACTIVE row with a lapsed token as expired, agreeing with the publish refusal", async () => {
    /**
     * **The consistency that matters most in this file.** An account sits at `ACTIVE` with
     * `token_expires_at` in the past whenever expiry has passed and ShareFlow's refresh route has not yet
     * run.
     *
     * Reading only `status` would make `list_accounts` say "active" while `PublishingService.validate`
     * refuses the same account with `credential-expired` — two answers to one question, and the assistant
     * would relay the reassuring one and then fail to publish.
     */
    expect((await byName("Acme Stale"))?.health).toBe("expired");

    const publishing = createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
    }).publishing;
    const rows = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'for a stale account #a #b #c', 'DRAFT', '{x}') returning id`,
      [workspaceId, userId],
    );
    const report = await publishing.validate(context(), {
      draftId: rows[0]!.id as never,
      accountIds: [expiredByToken] as never,
    });
    // The same conclusion from the other service, which is the point.
    expect(report.issues.map((issue) => issue.code)).toContain("credential-expired");
  });

  it("maps DISCONNECTED to revoked, which grepping the calling code missed", async () => {
    /**
     * **The finding this fixture caused.** I mapped this vocabulary from what ShareFlow *writes* — `ACTIVE`
     * from the connect callback, `EXPIRED` from the refresh route and the TikTok webhook — and concluded the
     * port's `revoked` was unreachable. `social_accounts_status_check` says
     * `ARRAY['ACTIVE', 'EXPIRED', 'DISCONNECTED']`, and the database refused this row until the map grew an
     * arm for it.
     *
     * The constraint is the authority on what a column can hold; the calling code shows only what one version
     * of it happens to write today. Same lesson as the post-status trigger.
     */
    expect((await byName("Acme Cut Off"))?.health).toBe("revoked");
  });

  it("reads an unrecognised status as expired, and cannot be reached through a row", () => {
    /**
     * Called directly, deliberately. The check constraint admits exactly the three mapped values, so a fourth
     * can only arrive from a future migration — there is no row that exercises this arm, and writing one
     * would mean dropping the constraint.
     *
     * The arm is not dead: that constraint has grown before, which is how `DISCONNECTED` came to be in it.
     */
    expect(accountHealthFrom("SOMETHING_NEW")).toBe("expired");
    expect(accountHealthFrom(null)).toBe("expired");
    // And the three real ones, so the map and the constraint are pinned together.
    expect(Object.keys(ACCOUNT_STATUS_FROM_DB).sort()).toEqual(["ACTIVE", "DISCONNECTED", "EXPIRED"]);
  });

  it("keeps `revoked` distinct from `expired` even when the token has also lapsed", async () => {
    /**
     * Ordering, and it changes what a user is told: `revoked` means reconnect, `expired` means re-authorise.
     * An expiry check that ran first would flatten the more specific answer away.
     */
    await sql.query(
      "update public.social_accounts set token_expires_at = now() - interval '1 day' where id = $1::uuid",
      [unknownStatus],
    );
    expect((await byName("Acme Cut Off"))?.health).toBe("revoked");
    await sql.query("update public.social_accounts set token_expires_at = null where id = $1::uuid", [unknownStatus]);
  });

  it("never reports `not-configured` unless the deployment can say", async () => {
    /**
     * ShareFlow decides this with `isPlatformConfigured`, which calls `connector.isConfigured()` — a runtime
     * read of environment variables **in ShareFlow's own process**. This package cannot see them, and
     * `process.env` here is forbidden by the boundary checks for exactly this reason.
     *
     * So absent the dependency, `not-configured` is never reported — which is not the same as claiming
     * everything is configured. Inventing the status from a row would be a guess presented as a fact.
     */
    const withoutIt = await connectors().listAccounts(context());
    expect(withoutIt.map((account) => account.health)).not.toContain("not-configured");

    // With it, a platform outside the list is reported — and it beats the stored status, because credentials
    // missing at the deployment level break every account on that platform at once.
    const withIt = await connectors({ configuredPlatforms: () => ["x"] }).listAccounts(context());
    const linkedin = withIt.filter((account) => account.platformId === "linkedin");
    expect(linkedin.length).toBeGreaterThan(0);
    for (const account of linkedin) expect(account.health).toBe("not-configured");
  });

  it("does not set `healthDetail`, which the port says carries a token", async () => {
    /**
     * The port: free prose an adapter fills, the obvious way to fill it is the provider's error message, and
     * that is where a token ends up. `tools/accounts.ts` does not propagate it either.
     */
    for (const account of await connectors().listAccounts(context())) {
      expect(account).not.toHaveProperty("healthDetail");
    }
  });

  it("refuses to re-check without a probe, rather than answering from the store", async () => {
    /**
     * **The one place in these adapters where refusing beats returning what is known.**
     *
     * `getClaimPolicy` and `getPerformanceBrief` answer empty because "nothing to say" truthfully answers
     * their question. This method's question is *"what does the platform say right now"* — the tool's own
     * description is "rather than reading the stored status" — and the model reaches for it precisely when
     * the stored status is what it has stopped trusting, after a publish failed. Answering `ACTIVE` from a
     * row would be a false claim relayed to a user as a live check.
     */
    const error = thrown(
      await connectors().checkHealth(context(), { accountIds: [active] as never }).catch((r: unknown) => r),
    );
    expect(error.code).toBe("capability_unavailable");
    // And it names the capability that does work, so the refusal is actionable.
    expect(error.message).toContain("list_accounts");
  });

  it("re-checks against the platform when a probe is wired", async () => {
    const asked: string[] = [];
    const service = connectors({
      probe: async ({ accountId }: { accountId: string }) => {
        asked.push(accountId);
        return "active";
      },
    });
    const checked = await service.checkHealth(context(), { accountIds: [expiredByStatus] as never });
    // The probe's answer wins over the stored `EXPIRED`, which is the whole purpose of a live re-check.
    expect(checked[0]?.health).toBe("active");
    expect(asked).toEqual([expiredByStatus]);
  });

  it("treats an unreachable platform as expired rather than losing the other answers", async () => {
    /**
     * One platform being down must not lose the answer for the others — and "we could not reach the
     * platform" is much closer to "this destination may not work" than to "this destination is fine".
     */
    const service = connectors({
      probe: async ({ accountId }: { accountId: string }) => {
        if (accountId === active) throw new Error("the platform did not answer");
        return "active";
      },
    });
    const checked = await service.checkHealth(context(), {
      accountIds: [active, expiredByStatus] as never,
    });
    expect(checked).toHaveLength(2);
    expect(checked.find((account) => account.id === (active as never))?.health).toBe("expired");
    expect(checked.find((account) => account.id === (expiredByStatus as never))?.health).toBe("active");
  });

  it("refuses the whole re-check when any id is unknown", async () => {
    /**
     * Returning the accounts that resolved and dropping the rest would have the assistant report on a subset
     * while believing it asked about all of them — and the dropped id is the one the user asked about,
     * because that is why it is being re-checked.
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-conn') returning id");
    const theirs = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'c-x', 'Theirs', '{}'::jsonb, 'ACTIVE') returning id`,
      [other[0]!.id],
    );
    const service = connectors({ probe: async () => "active" });
    const error = thrown(
      await service
        .checkHealth(context(), { accountIds: [active, theirs[0]!.id] as never })
        .catch((rejection: unknown) => rejection),
    );
    // `not_found` covers absent and another tenant's alike — indistinguishable on purpose.
    expect(error.code).toBe("not_found");
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("answers invalid_input for a malformed account id", async () => {
    const error = thrown(
      await connectors().checkHealth(context(), { accountIds: ["linkedin123"] as never }).catch((r: unknown) => r),
    );
    // The fabrication a real turn actually produced. `internal` with a Postgres cast error is not actionable.
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("must be a UUID");
  });

  it("never lists another workspace's destinations", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-l') returning id");
    await sql.query(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'c-z', 'THEIR SECRET ACCOUNT', '{}'::jsonb, 'ACTIVE')`,
      [other[0]!.id],
    );
    const accounts = await connectors().listAccounts(context());
    expect(accounts.some((account) => account.displayName.includes("THEIR SECRET"))).toBe(false);
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("hands back the deployment's setup rather than inventing one", async () => {
    /**
     * Redirect URLs, console field labels, scopes and environment variable *names* are deployment and
     * platform knowledge, not rows. A default here would be an assistant confidently telling a user to set a
     * variable that deployment does not use.
     */
    const setup = await connectors().getConnectionSetup(context());
    expect(setup.redirectUrl).toBe("https://app.test/api/connect/callback");
    expect(setup.platforms[0]?.credentialVariables).toContain("LINKEDIN_CLIENT_ID");
    // Names only, never values — the port is explicit about it.
    expect(JSON.stringify(setup)).not.toMatch(/CLIENT_SECRET"\s*:\s*"[^"]/);
  });
});

describe.skipIf(URL_ === undefined)("PublishingService — the first adapter that writes outside the tenant", () => {
  /**
   * The fourth adapter, and the first whose methods are `external-write`. Everything before it was `read` or
   * `internal-write`, so a shadow run's suppressed-write list was correctly empty and the parity diff had no
   * signal. This is where the signal comes from — and where a mistake reaches a customer's audience.
   */
  const publishing = () =>
    createShareFlowServices({ sql: sql as never, transaction, setup: () => SETUP,
      ...RESEARCH, generate: (async () => ({})) as never }).publishing;
  const content = () => createPostgresContentService(sql as never);

  let accountA = "";
  let accountB = "";

  beforeAll(async () => {
    if (URL_ === undefined) return;
    const created = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'li-1', 'Acme LinkedIn', '{}'::jsonb, 'ACTIVE'),
              ($1::uuid, 'linkedin', 'li-2', 'Acme Second',   '{}'::jsonb, 'ACTIVE')
       returning id`,
      [workspaceId],
    );
    accountA = created[0]!.id;
    accountB = created[1]!.id;
  });

  /** A draft this block owns. linkedin, for the override reason recorded above. */
  const draft = async (caption = "publishable text #a #b #c") =>
    (await content().createDraft(context(), {
      idempotencyKey: `pub-${caption.length}-${Math.trunc(Number(accountA.slice(0, 4).replace(/\D/g, "0")))}` as never,
      caption,
      targetPlatforms: ["linkedin"] as never,
    })).id;

  const target = (accountId: string, at?: string) =>
    ({ accountId, idempotencyKey: `${accountId}:key`, ...(at === undefined ? {} : { scheduledAt: at }) }) as never;

  it("schedules a destination and reads its state back", async () => {
    /**
     * Also the first execution of `ITEM_COLUMNS`, which is where a syntax error would surface — that query
     * carries a correlated subselect for the latest failure log and a three-table join, and none of it is
     * checked by the compiler.
     */
    const id = await draft("a first scheduled post #a #b #c");
    const statuses = await publishing().schedule(context(), {
      idempotencyKey: "call-1" as never,
      draftId: id,
      targets: [target(accountA, "2026-12-01T09:00:00Z")],
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ accountId: accountA, state: "scheduled" });
    expect(statuses[0]!.scheduledAt).toBe("2026-12-01T09:00:00.000Z");

    const read = await publishing().getStatus(context(), { draftId: id });
    expect(read.map((status) => status.accountId)).toEqual([accountA]);
  });

  it("writes PENDING, which is what ShareFlow's sweep collects", async () => {
    /**
     * The row first, always — and the queue only afterwards, when a deployment supplies one.
     *
     * This comment used to say "this adapter does not enqueue", which stopped being true when #403's
     * hop landed and the test kept passing because the fixture below supplies none. What it was
     * really asserting is the part that has not changed and must not: **the row is written whether
     * or not anything is enqueued**, because the sweep finds rows and reaching Redis from this
     * package would make it a second producer for a queue ShareFlow owns.
     *
     * A deployment with the hop gets the seconds back (measured at ~190ms round-trip on the live
     * container); one without waits `SWEEP_WORST_CASE_MS` — the grace period plus a cron tick. Both
     * publish.
     */
    const id = await draft("a pending post #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-2" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const rows = await sql.query<{ status: string; job_id: string | null }>(
      "select status, job_id from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    expect(rows[0]!.status).toBe("PENDING");
    // No job id: this fixture supplies no enqueue hop, and a fabricated one would collide with the sweep's.
    expect(rows[0]!.job_id).toBeNull();
    expect(SWEEP_WORST_CASE_MS).toBe(6 * 60_000);
  });

  it("writes the row even when the enqueue hop throws — #403's safety net", async () => {
    /*
     * The property a refactor could silently break: moving the enqueue *inside* the transaction, or
     * letting its failure propagate, would make Redis able to lose a scheduled post. The row comes
     * first and the queue is best effort after the commit, so a failed enqueue leaves the post late
     * rather than lost.
     */
    const id = await draft("a post whose enqueue fails #a #b #c");
    let asked = 0;
    const withBrokenQueue = createPostgresPublishingService({
      sql: sql as never,
      transaction,
      enqueue: async () => {
        asked += 1;
        throw new Error("redis is down");
      },
    } as never);

    await expect(
      withBrokenQueue.schedule(context(), {
        idempotencyKey: "call-enqueue-fails" as never,
        draftId: id,
        targets: [target(accountA)],
      }),
    ).resolves.toBeDefined();

    // It really did try, so this is not passing because the hop went unused.
    expect(asked).toBeGreaterThan(0);
    const rows = await sql.query<{ status: string }>(
      "select status from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    expect(rows[0]!.status).toBe("PENDING");
  });

  it("publishes a destination once, however many times it is asked", async () => {
    /**
     * **The guarantee this file exists for**, and the database does not provide it: `scheduled_items` has no
     * unique constraint on `(post_id, social_account_id)`. The only unique index is
     * `(posting_schedule_id, social_account_id, occurrence_at)` and it is partial on
     * `posting_schedule_id IS NOT NULL`, so it covers recurring rules and not one-off scheduling.
     *
     * The port asks for the harder half: a **second, distinct** call for the same draft and account must also
     * be deduplicated, not merely a retry of the same call.
     */
    const id = await draft("published exactly once #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-3a" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    // A different call key entirely — the case that would republish if the key came from the call.
    await publishing().schedule(context(), {
      idempotencyKey: "call-3b" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.scheduled_items where post_id = $1::uuid and social_account_id = $2::uuid",
      [String(id), accountA],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("publishes each destination once when two calls genuinely interleave", async () => {
    /**
     * **The hardest assertion here, and a plain `Promise.all` cannot make it.**
     *
     * Two concurrent `schedule` calls under `Promise.all` passed with the `FOR UPDATE` removed — sabotage
     * showed it. Node's event loop and pool acquisition happened to serialise them, so the dangerous window
     * never opened and the test proved nothing about the lock.
     *
     * So the interleaving is forced. The first caller's transaction is held **after** it takes the lock and
     * before it inserts, using a wrapped `TransactionRunner` — the runner being a dependency is what makes
     * this observable at all. Then:
     *
     * - **With `FOR UPDATE`:** the second caller blocks *inside Postgres* on the draft row for as long as the
     *   first is held. When the first commits, the second's next statement takes a fresh READ COMMITTED
     *   snapshot, sees the row, and inserts nothing. One row.
     * - **Without it:** the second caller sails past, its `WHERE NOT EXISTS` sees nothing because the first
     *   has not committed, and both insert. Two rows — a post published twice to a customer's audience.
     *
     * The hold is 500 ms, which is enormous next to a local insert; the assertion is about which side of the
     * lock the second caller waits on, not about timing precision.
     */
    /**
     * A **barrier**, not a delay, and the difference is why the first two attempts at this test were useless.
     *
     * Attempt one used a plain `Promise.all` and passed with `FOR UPDATE` removed: the calls happened to
     * serialise, so the window never opened. Attempt two held only the *first* transaction, which just
     * reordered them — the second inserted while the first was held, the first then saw the committed row and
     * skipped, and the count was 1 either way.
     *
     * What has to happen is both callers sitting **between their lock and their insert at the same time**:
     *
     * - **With `FOR UPDATE`,** the second never gets there. It blocks inside Postgres on the draft row, so
     *   only one caller ever arrives, the barrier times out, that caller inserts and commits, and the second
     *   then proceeds to find the row. One row.
     * - **Without it,** both arrive, the barrier releases them together, and both `WHERE NOT EXISTS` checks
     *   run against snapshots in which the other's uncommitted insert is invisible. Two rows — a post
     *   published twice to a customer's audience.
     *
     * The timeout is what keeps the locked case from deadlocking the test, and it is the arrival count rather
     * than any duration that the assertion turns on.
     */
    const BARRIER_TIMEOUT_MS = 1_500;
    let arrived = 0;
    let release: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async (): Promise<void> => {
      arrived += 1;
      if (arrived >= 2) {
        release?.();
        return;
      }
      await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, BARRIER_TIMEOUT_MS))]);
    };

    /** Holds **every** transaction between its lock and its insert. The runner being injected is what allows it. */
    const holding: TransactionRunner = {
      transaction: (fn) =>
        transaction.transaction(async (tx) =>
          fn({
            async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
              const rows = await tx.query<Row>(text, params);
              if (text.includes("for update") || text.includes("from public.posts where workspace_id")) {
                await barrier();
              }
              return rows;
            },
          }),
        ),
    };

    const withHold = createShareFlowServices({
      sql: sql as never,
      transaction: holding,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
    }).publishing;

    const id = await draft("racing two calls #a #b #c");
    await Promise.all([
      withHold.schedule(context(), { idempotencyKey: "race-1" as never, draftId: id, targets: [target(accountA)] }),
      new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        withHold.schedule(context(), { idempotencyKey: "race-2" as never, draftId: id, targets: [target(accountA)] }),
      ),
    ]);

    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.scheduled_items where post_id = $1::uuid and social_account_id = $2::uuid",
      [String(id), accountA],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("schedules the destinations that are outstanding and leaves the rest alone", async () => {
    // The port's reason for a per-destination key: a re-issued call must complete only what is not done.
    const id = await draft("two destinations #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-4a" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const both = await publishing().schedule(context(), {
      idempotencyKey: "call-4b" as never,
      draftId: id,
      targets: [target(accountA), target(accountB)],
    });
    expect(both.map((status) => status.accountId).sort()).toEqual([accountA, accountB].sort());
    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    expect(rows[0]!.n).toBe("2");
  });

  it("refuses another workspace's connected account", async () => {
    /**
     * `scheduled_items.social_account_id` has a foreign key to `social_accounts` and **not** to the
     * workspace — the same shape as the `posts.campaign_id` hole found earlier. `social_accounts` holds
     * credentials, so publishing to another tenant's account is the worst outcome in this adapter.
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-pub') returning id");
    const theirs = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'li-x', 'Theirs', '{}'::jsonb, 'ACTIVE') returning id`,
      [other[0]!.id],
    );
    const id = await draft("aimed at someone else #a #b #c");
    const error = thrown(
      await publishing()
        .schedule(context(), {
          idempotencyKey: "call-5" as never,
          draftId: id,
          targets: [target(theirs[0]!.id)],
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("not_found");
    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    expect(rows[0]!.n).toBe("0");
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("maps every status the column holds onto a state the port declares", async () => {
    const id = await draft("every state #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-6" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const [item] = await sql.query<{ id: string }>(
      "select id from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    for (const [stored, expected] of [
      ["PENDING", "scheduled"],
      ["QUEUED", "publishing"],
      ["SUCCESS", "published"],
      ["FAILED", "failed"],
      // Real, and not in ShareFlow's declared union: its publisher sets it. `publishing` is the honest
      // reading — the two alternatives each assert an outcome that may be false.
      ["AUTH_FAILED", "publishing"],
    ] as const) {
      await sql.query("update public.scheduled_items set status = $2 where id = $1::uuid", [item!.id, stored]);
      const [status] = await publishing().getStatus(context(), { draftId: id });
      expect(status!.state, stored).toBe(expected);
      expect(PUBLISH_TARGET_STATES).toContain(status!.state);
    }
  });

  it("reports the failure message and never the provider's raw body", async () => {
    /**
     * `post_logs.error_payload` holds the provider's response and is deliberately not selected — the port
     * says "never the provider's raw body", and a JSON blob in a tool result is both a context bomb and a
     * place credentials end up.
     */
    const id = await draft("a failed destination #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-7" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const [item] = await sql.query<{ id: string }>(
      "select id from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    await sql.query("update public.scheduled_items set status = 'FAILED' where id = $1::uuid", [item!.id]);
    await sql.query(
      `insert into public.post_logs (scheduled_item_id, status, message, error_payload)
       values ($1::uuid, 'ERROR', 'LinkedIn rejected the post: the API version is retired.',
               '{"secret":"do-not-surface"}'::jsonb)`,
      [item!.id],
    );
    const [status] = await publishing().getStatus(context(), { draftId: id });
    expect(status!.failure?.message).toContain("API version is retired");
    expect(JSON.stringify(status)).not.toContain("do-not-surface");
  });

  it("marks a long-overdue destination stuck, from this deployment's threshold", async () => {
    /**
     * The port says ShareFlow gives up after 24 hours because an Instagram container expires. **This
     * deployment has no such rule** — no 24-hour threshold, and no `finish-pending-targets` sweep. What it
     * has is the reconciliation sweep, which alerts at an hour late, so that is the number reported.
     * Asserting the port's would be claiming a rule that is not running.
     */
    const id = await draft("overdue by hours #a #b #c");
    const longAgo = new Date(Date.now() - SWEEP_ALERT_MS - 60_000).toISOString();
    await publishing().schedule(context(), {
      idempotencyKey: "call-8" as never,
      draftId: id,
      targets: [target(accountA, longAgo)],
    });
    const [status] = await publishing().getStatus(context(), { draftId: id });
    expect(status!.stuck).toBe(true);

    // And a destination that is merely due is not stuck: the flag means "late enough to be a problem".
    const fresh = await draft("due right now #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-9" as never,
      draftId: fresh,
      targets: [target(accountB)],
    });
    const [now] = await publishing().getStatus(context(), { draftId: fresh });
    expect(now!.stuck).toBeUndefined();
  });

  it("retries only a failed destination, and says why when it will not", async () => {
    /**
     * ShareFlow's own route refuses anything but `FAILED` with a 409, and the port's reason for per-target
     * retry is the same: a draft that published to three of four destinations must not be re-sent to the
     * three that succeeded.
     *
     * The refusal names the current state, because "not found" and "already published" lead to different next
     * steps and a caller told only "could not retry" will try again.
     */
    const id = await draft("retry me #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-10" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const [item] = await sql.query<{ id: string }>(
      "select id from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );

    // PENDING: nothing to retry, and the refusal says so rather than silently re-queuing.
    const early = thrown(
      await publishing().retry(context(), { idempotencyKey: "r-1" as never, targetId: item!.id as never }).catch((r: unknown) => r),
    );
    expect(early.code).toBe("conflict");
    expect(early.message).toContain("scheduled");

    // SUCCESS: the dangerous one. Retrying a published destination posts twice.
    await sql.query("update public.scheduled_items set status = 'SUCCESS' where id = $1::uuid", [item!.id]);
    const done = thrown(
      await publishing().retry(context(), { idempotencyKey: "r-2" as never, targetId: item!.id as never }).catch((r: unknown) => r),
    );
    expect(done.code).toBe("conflict");
    expect(done.message).toContain("post twice");

    // FAILED: back to PENDING, for the sweep to collect.
    await sql.query("update public.scheduled_items set status = 'FAILED' where id = $1::uuid", [item!.id]);
    const retried = await publishing().retry(context(), { idempotencyKey: "r-3" as never, targetId: item!.id as never });
    expect(retried.state).toBe("scheduled");
  });

  it("does not touch retry_count, which ShareFlow's worker owns", async () => {
    // A second writer would make the number mean nothing, and `attemptCount` is what distinguishes
    // "not tried" from "tried and failed twice" for an assistant offering a retry.
    const id = await draft("counting attempts #a #b #c");
    await publishing().schedule(context(), {
      idempotencyKey: "call-11" as never,
      draftId: id,
      targets: [target(accountA)],
    });
    const [item] = await sql.query<{ id: string }>(
      "select id from public.scheduled_items where post_id = $1::uuid",
      [String(id)],
    );
    await sql.query("update public.scheduled_items set status = 'FAILED', retry_count = 2 where id = $1::uuid", [item!.id]);
    const retried = await publishing().retry(context(), { idempotencyKey: "r-4" as never, targetId: item!.id as never });
    expect(retried.attemptCount).toBe(2);
  });

  it("refuses another workspace's publish target", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-t') returning id");
    const theirPost = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'theirs', 'APPROVED', '{linkedin}') returning id`,
      [other[0]!.id, userId],
    );
    const theirAccount = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'li-y', 'Theirs', '{}'::jsonb, 'ACTIVE') returning id`,
      [other[0]!.id],
    );
    const theirItem = await sql.query<{ id: string }>(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, now(), 'FAILED') returning id`,
      [theirPost[0]!.id, theirAccount[0]!.id],
    );
    const error = thrown(
      await publishing()
        .retry(context(), { idempotencyKey: "r-5" as never, targetId: theirItem[0]!.id as never })
        .catch((rejection: unknown) => rejection),
    );
    // `not_found`, never `forbidden` — the two must be indistinguishable.
    expect(error.code).toBe("not_found");
    const untouched = await sql.query<{ status: string }>(
      "select status from public.scheduled_items where id = $1::uuid",
      [theirItem[0]!.id],
    );
    expect(untouched[0]!.status).toBe("FAILED");
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("reports what it could not check rather than passing silently", async () => {
    /**
     * `validate` covers "claims, duplication, platform limits and media". Two of the four have nothing behind
     * them in this deployment: no table holds claims, and there is no media service. Silence would mean this
     * deployment validated nothing for those, and the failure would surface as a rejected publish long after
     * the assistant said the post was fine — which is exactly what running this before the approval gate is
     * meant to avoid.
     */
    const id = await draft("nothing wrong with this #a #b #c");
    const report = await publishing().validate(context(), { draftId: id, accountIds: [accountA] as never });
    const codes = report.issues.map((issue) => issue.code);
    for (const code of UNCHECKED_CODES) expect(codes).toContain(code);
    // And an absent check does not block: a missing claims table cannot mean nothing may be published.
    expect(report.ok).toBe(true);
  });

  it("refuses an expired credential before a human is asked to approve anything", async () => {
    const expired = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status, token_expires_at)
       values ($1::uuid, 'linkedin', 'li-exp', 'Expired', '{}'::jsonb, 'ACTIVE', now() - interval '1 day')
       returning id`,
      [workspaceId],
    );
    const id = await draft("aimed at an expired account #a #b #c");
    const report = await publishing().validate(context(), {
      draftId: id,
      accountIds: [expired[0]!.id] as never,
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("credential-expired");
  });

  it("carries the platform limits from ContentService rather than a second reading", async () => {
    /**
     * `platform_rules` is workspace-overridable, so two readings would be two answers to "is this caption
     * publishable" — and the one that mattered would be whichever ran last.
     */
    /**
     * Inserted directly, because `createDraft` refuses this caption itself — which is the point of a separate
     * assertion rather than a flaw in the fixture. A draft can also reach `validate` having been written by
     * ShareFlow's own UI, or before a rule changed, so `validate` must find the limit rather than assume
     * anything that exists was once acceptable.
     */
    const rows = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'one hashtag only #a', 'DRAFT', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const report = await publishing().validate(context(), {
      draftId: rows[0]!.id as never,
      accountIds: [accountA] as never,
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("hashtags-too-few");
  });

  it("flags a near-duplicate of an already published post", async () => {
    // ShareFlow's own heuristic, via `findDuplicateContent`. A second similarity rule here would be a second
    // notion of "this is the same post again", disagreeing on exactly the cases that matter.
    const caption = "Our workshop guide to torque settings is live today #a #b #c";
    await sql.query(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, $3, 'PUBLISHED', '{linkedin}')`,
      [workspaceId, userId, caption],
    );
    const id = await draft(caption);
    const report = await publishing().validate(context(), { draftId: id, accountIds: [accountA] as never });
    expect(report.issues.map((issue) => issue.code)).toContain("duplicate-content");
  });
});

describe.skipIf(URL_ === undefined)("EngagementService over inbox_comments", () => {
  /**
   * The cleanest of the six mappings: `inbox_comments_reply_status_check` is
   * `needs_review | auto_sent | sent | dismissed` and the port's union is the same four in kebab-case.
   * Underscore to hyphen, and the constraint says so rather than the calling code.
   */
  const engagement = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      ...over,
    }).engagement;

  const comment = async (status = "needs_review", content = "Is this in stock?") =>
    (
      await sql.query<{ id: string }>(
        `insert into public.inbox_comments
           (workspace_id, platform, author_name, author_handle, content, reply_status, post_ref)
         values ($1::uuid, 'linkedin', 'A Customer', '@cust', $2, $3, 'urn:li:share:1') returning id`,
        [workspaceId, content, status],
      )
    )[0]!.id;

  it("lists comments with their reply state and the drafted reply", async () => {
    const id = await comment("needs_review", "Do you ship to Ireland?");
    await sql.query("update public.inbox_comments set reply = 'We do.' where id = $1::uuid", [id]);
    const page = await engagement().listComments(context(), { limit: 20 });
    const found = page.items.find((item) => item.id === (id as never));
    expect(found?.replyState).toBe("needs-review");
    /**
     * The draft is surfaced read-only, and there is deliberately no capability to approve it: an assistant
     * that could send its own draft would route around the review step rather than pass through it. Knowing
     * one exists is what stops it writing a second.
     */
    expect(found?.draftedReply).toBe("We do.");
    expect(found?.authorHandle).toBe("@cust");
  });

  it("maps all four states the constraint admits", async () => {
    for (const [stored, expected] of [
      ["needs_review", "needs-review"],
      ["auto_sent", "auto-sent"],
      ["sent", "sent"],
      ["dismissed", "dismissed"],
    ] as const) {
      const id = await comment(stored, `state ${stored}`);
      const page = await engagement().listComments(context(), { limit: 50 });
      expect(page.items.find((item) => item.id === (id as never))?.replyState, stored).toBe(expected);
    }
  });

  it("refuses to reply when no connector is wired, which the port asks for by name", async () => {
    /**
     * *"Throws `capability_unavailable` when the platform's connector has no `sendReply`, because 'replying
     * is not supported on {platform} yet — reply in the {platform} app instead' is guidance, not an error."*
     *
     * The honest refusal for the same reason `checkHealth`'s is: this method's whole purpose is the external
     * effect, so there is no useful part of it to perform without a way to send.
     */
    const id = await comment();
    const error = thrown(
      await engagement()
        .reply(context(), { idempotencyKey: "r1" as never, commentId: id as never, text: "Yes." })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("capability_unavailable");
    expect(error.message).toContain("Reply in the platform");
  });

  it("claims the comment before sending, so a concurrent second reply cannot go out", async () => {
    /**
     * **The ordering that matters most here.** Read-then-send-then-write would send the second public reply
     * and only then discover the conflict — and a duplicate reply on a customer's post cannot be taken back.
     *
     * So the row is claimed as `sent` in one guarded `UPDATE` first, and the send happens after. The failure
     * that leaves is a row marked sent whose send failed, which a person reading the thread can recover; the
     * other order leaves two replies, which nobody can.
     */
    const sent: string[] = [];
    const service = engagement({
      sendReply: async ({ text }: { text: string }) => {
        sent.push(text);
      },
    });
    const id = await comment();
    const receipt = await service.reply(context(), {
      idempotencyKey: "r2" as never,
      commentId: id as never,
      text: "Yes, we ship to Ireland.",
    });
    expect(receipt.commentId).toBe(id as never);
    expect(sent).toEqual(["Yes, we ship to Ireland."]);

    const stored = await sql.query<{ reply_status: string; reply: string }>(
      "select reply_status, reply from public.inbox_comments where id = $1::uuid",
      [id],
    );
    expect(stored[0]!.reply_status).toBe("sent");
    expect(stored[0]!.reply).toBe("Yes, we ship to Ireland.");

    // A second reply is refused, and nothing more is sent.
    const again = thrown(
      await service
        .reply(context(), { idempotencyKey: "r3" as never, commentId: id as never, text: "Yes again." })
        .catch((rejection: unknown) => rejection),
    );
    expect(again.code).toBe("conflict");
    expect(again.message).toContain("publicly");
    expect(sent).toHaveLength(1);
  });

  it("reports a send that failed after the claim, rather than reverting it", async () => {
    /**
     * The row stays `sent`. Reverting would invite a retry that might duplicate a reply the platform did
     * accept before the error — "it may have gone out, check the thread" is the truthful report.
     */
    const service = engagement({
      sendReply: async () => {
        throw new Error("linkedin returned 502");
      },
    });
    const id = await comment();
    const error = thrown(
      await service
        .reply(context(), { idempotencyKey: "r4" as never, commentId: id as never, text: "Hello." })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("did not confirm");
    const stored = await sql.query<{ reply_status: string }>(
      "select reply_status from public.inbox_comments where id = $1::uuid",
      [id],
    );
    expect(stored[0]!.reply_status).toBe("sent");
  });

  it("dismisses a comment awaiting review, and refuses to hide an answered one", async () => {
    const open = await comment("needs_review", "no answer needed");
    expect(
      (await engagement().dismiss(context(), { idempotencyKey: "d1" as never, commentId: open as never })).replyState,
    ).toBe("dismissed");
    // Idempotent: dismissing an already dismissed comment satisfies the caller's intent.
    expect(
      (await engagement().dismiss(context(), { idempotencyKey: "d2" as never, commentId: open as never })).replyState,
    ).toBe("dismissed");

    // Answered is different: dismissing it would take a sent reply out of the queue and read as unanswered.
    const answered = await comment("sent", "already handled");
    const error = thrown(
      await engagement()
        .dismiss(context(), { idempotencyKey: "d3" as never, commentId: answered as never })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("hide a reply");
  });

  it("never returns another workspace's comments", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-e') returning id");
    await sql.query(
      `insert into public.inbox_comments (workspace_id, platform, author_name, content, reply_status)
       values ($1::uuid, 'linkedin', 'Them', 'THEIR SECRET COMMENT', 'needs_review')`,
      [other[0]!.id],
    );
    const page = await engagement().listComments(context(), { limit: 50 });
    expect(page.items.some((item) => item.content.includes("THEIR SECRET"))).toBe(false);
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });
});

describe.skipIf(URL_ === undefined)("InsightService over campaign_templates and analytics_daily", () => {
  const insights = () =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
    }).insights;

  it("lists the shared catalogue, which has no workspace of its own", async () => {
    const templates = await insights().listCampaignTemplates(context());
    expect(templates.length).toBeGreaterThan(0);
    // `plannedPosts` is the plan's length, not the plan: `/api/ai/campaign` reads the template's goal
    // and explicitly not its `post_plan`, so returning the plan would promise stages nothing produces.
    expect(templates[0]!.plannedPosts).toBeGreaterThan(0);
    expect(templates[0]).not.toHaveProperty("postPlan");
  });

  it("names the real keys when asked for one that does not exist", async () => {
    await expect(
      insights().startCampaignFromTemplate(context(), {
        idempotencyKey: "k1" as never,
        templateKey: "no_such_playbook",
        name: "X", theme: "Y", startsOn: "2026-09-01" as never, endsOn: "2026-09-30" as never,
      }),
    ).rejects.toThrow(/product_launch/);
  });

  it("seeds the campaign from the template and records which one", async () => {
    const templates = await insights().listCampaignTemplates(context());
    const chosen = templates.find((t) => t.key === "product_launch") ?? templates[0]!;

    const result = await insights().startCampaignFromTemplate(context(), {
      idempotencyKey: "k2" as never,
      templateKey: chosen.key,
      name: "#426 launch",
      theme: "The spring collection",
      startsOn: "2026-09-01" as never,
      endsOn: "2026-09-30" as never,
    });

    expect(result.template.key).toBe(chosen.key);
    // The template's cadence and channels applied, since the caller overrode neither.
    if (chosen.defaultCadence !== undefined) expect(result.campaign.cadence).toBe(chosen.defaultCadence);

    /*
     * `template_key` recorded on the row — what `/api/ai/campaign` does when a campaign is started
     * from a template. Without it the campaign is indistinguishable from a hand-made one and the
     * planner later has no idea which playbook it is filling.
     */
    const rows = await sql.query<{
      template_key: string | null;
      primary_goal: string | null;
      cadence: string;
    }>(
      `select template_key, primary_goal, cadence from public.campaigns where id = $1::uuid`,
      [String(result.campaign.id)],
    );
    expect(rows[0]!.template_key).toBe(chosen.key);

    /*
     * The **stored** cadence, which is what "matches one started in the UI" actually means — the UI
     * writes the store's vocabulary and the column's CHECK only accepts it. Asserting the returned
     * object alone passed while the insert was failing for `3x_week`, because the returned object
     * never went near the constraint.
     */
    expect(rows[0]!.cadence).toBe(CADENCE_TO_DB[result.campaign.cadence]);
    expect(["daily", "3x_week", "weekly"]).toContain(rows[0]!.cadence);
    if (chosen.defaultGoal !== undefined) expect(rows[0]!.primary_goal).toBe(chosen.defaultGoal);

    await sql.query("delete from public.campaigns where id = $1::uuid", [String(result.campaign.id)]);
  });

  /*
   * The day formatting, as a pure function — #426.
   *
   * `getDailyRollup` had the day wrong by one and the only thing that noticed was an unrelated
   * comparePeriods assertion, incidentally. A `date` column arrives as a Date at **local** midnight,
   * so `toISOString()` re-reads it in UTC and hands back the day before for anyone east of
   * Greenwich. A row stored 2026-09-10 was read back as 2026-09-09.
   *
   * Two cases, because one alone only catches half the world: an early-morning instant fails under
   * `toISOString` at positive offsets, a late-evening one at negative offsets. Together they fail
   * everywhere except exactly UTC — where `toISOString` is genuinely correct and there is no bug to
   * catch. That is the honest limit of this guard, not an oversight.
   */
  describe("the calendar day, which a timezone round-trip moves", () => {
    it("keeps the day of a local midnight, which UTC would read as the day before", () => {
      expect(dayOf(new Date(2026, 8, 10, 0, 0, 0))).toBe("2026-09-10");
    });

    it("keeps the day of a local late evening, which UTC would read as the day after", () => {
      expect(dayOf(new Date(2026, 8, 10, 23, 30, 0))).toBe("2026-09-10");
    });

    it("pads a single-digit month and day rather than emitting 2026-9-1", () => {
      expect(dayOf(new Date(2026, 0, 1, 12, 0, 0))).toBe("2026-01-01");
    });

    it("takes a string date as the day it already is", () => {
      expect(dayOf("2026-09-10")).toBe("2026-09-10");
    });

    /*
     * Scanned, because the two cases above cannot show this one.
     *
     * They fail under a `toISOString` round-trip at any non-zero offset — and pass in UTC, where the
     * round-trip is genuinely correct. CI runs in UTC. So the behavioural guard is asleep exactly
     * where this suite usually runs, and the only zone-independent statement left is about the code:
     * this function does not reach for UTC at all.
     */
    it("does not convert through UTC, which the behavioural cases cannot catch in CI's own zone", async () => {
      const source = await readFile(new URL("../insights.ts", import.meta.url), "utf8");
      const body = source.slice(source.indexOf("export const dayOf"));
      const fn = body.slice(0, body.indexOf("\n};"));

      expect(fn).not.toContain("toISOString");
      expect(fn).not.toContain("toUTCString");
      expect(fn).not.toContain("getUTC");
      // And it really is the function we think it is, not an empty slice that trivially contains nothing.
      expect(fn).toContain("getFullYear");
    });
  });

  /** #426's second acceptance, against the real query rather than a fixture. */
  it("says there is no prior window rather than comparing against zero", async () => {
    const result = await insights().comparePeriods(context(), { since: "2019-01-01", until: "2019-02-01" });
    expect(result.noPriorWindowReason).toBeDefined();
    expect(result.previous).toBeUndefined();
    // Not one comparison anywhere: a zero here would read as "measured, and unchanged".
    for (const metric of result.metrics) {
      expect(metric.change, metric.metric).toBeUndefined();
      expect(metric.previous, metric.metric).toBeUndefined();
    }
  });

  it("refuses a period that runs backwards", async () => {
    await expect(
      insights().comparePeriods(context(), { since: "2026-10-01", until: "2026-09-01" }),
    ).rejects.toThrow(/not a period/);
  });

  it("compares against the immediately preceding window of the same length", async () => {
    // Two months of one row each: September is the period, August is what it is compared against.
    await sql.query(
      `insert into public.analytics_daily (workspace_id, day, platform, impressions, engagements, link_clicks, watch_seconds, followers)
       values ($1::uuid, '2026-08-10', 'linkedin', 100, 10, 1, 0, 0),
              ($1::uuid, '2026-09-10', 'linkedin', 150, 20, 2, 0, 0)
       on conflict do nothing`,
      [workspaceId],
    );

    const result = await insights().comparePeriods(context(), { since: "2026-09-01", until: "2026-10-01" });
    expect(result.noPriorWindowReason).toBeUndefined();
    const impressions = result.metrics.find((m) => m.metric === "impressions")!;
    expect(impressions.current).toBe(150);
    expect(impressions.previous).toBe(100);
    expect(impressions.change).toEqual({ absolute: 50, percent: 50 });

    const rollup = await insights().getDailyRollup(context(), { since: "2026-09-01", until: "2026-10-01" });
    expect(rollup.map((d) => d.day)).toContain("2026-09-10");

    await sql.query(
      `delete from public.analytics_daily where workspace_id = $1::uuid and day in ('2026-08-10', '2026-09-10')`,
      [workspaceId],
    );
  });
});

describe.skipIf(URL_ === undefined)("ScheduleService over posting_schedules and time_slots", () => {
  /**
   * The read half, against a real database — #425.
   *
   * The writes go through the app (`/api/internal/schedules`), because #425's first acceptance is that
   * an assistant-made rule materialises *exactly* as a UI-made one and the materialiser needs BullMQ.
   * What is testable here is everything the runtime does itself, and the one with judgement in it.
   */
  const schedules = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      ...over,
    }).schedules;

  it("reports the next occurrence that is actually scheduled, not a predicted one", async () => {
    const posts = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, raw_content, status) values ($1::uuid, '#425', 'APPROVED') returning id`,
      [workspaceId],
    );
    const accounts = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'x', 'x-425', '#425', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    const rules = await sql.query<{ id: string }>(
      `insert into public.posting_schedules
              (workspace_id, post_id, name, frequency, time_of_day, timezone, anchor_date, social_account_ids)
       values ($1::uuid, $2::uuid, '#425 weekly', 'WEEKLY', '09:41', 'UTC', current_date, $3::uuid[])
       returning id`,
      [workspaceId, posts[0]!.id, [accounts[0]!.id]],
    );
    const ruleId = rules[0]!.id;

    // One past and one future, both PENDING. Only the future one is ahead of anything.
    await sql.query(
      `insert into public.scheduled_items (post_id, social_account_id, posting_schedule_id, status, scheduled_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'PENDING', now() - interval '2 days'),
              ($1::uuid, $2::uuid, $3::uuid, 'PENDING', now() + interval '3 days')`,
      [posts[0]!.id, accounts[0]!.id, ruleId],
    );

    const listed = await schedules().listSchedules(context(), { limit: 50 });
    const mine = listed.find((r) => r.id === ruleId);
    expect(mine).toBeDefined();
    expect(mine!.nextOccurrenceAt).toBeDefined();
    expect(new Date(mine!.nextOccurrenceAt!).getTime()).toBeGreaterThan(Date.now());
    // `time without time zone` comes back as 09:41:00; the seconds are noise to a reader.
    expect(mine!.timeOfDay).toBe("09:41");

    await sql.query("delete from public.posting_schedules where id = $1::uuid", [ruleId]);
    await sql.query("delete from public.posts where id = $1::uuid", [posts[0]!.id]);
    await sql.query("delete from public.social_accounts where id = $1::uuid", [accounts[0]!.id]);
  });

  it("never lists another workspace's rules", async () => {
    const other = await sql.query<{ id: string }>(
      `insert into public.workspaces (name) values ('#425 other') returning id`,
    );
    const otherId = other[0]!.id;
    const theirPost = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, raw_content, status) values ($1::uuid, 'theirs', 'APPROVED') returning id`,
      [otherId],
    );
    /*
     * A real account in that workspace, because the database will not accept anything else.
     *
     * `posting_schedules` has a trigger enforcing "social_account_ids must all belong to the row's
     * workspace" — a guarantee neither #425 nor this adapter mentions, and a stronger one than the
     * application check in `/api/internal/schedules`. Found by a fixture using `gen_random_uuid()`
     * and being refused.
     */
    const theirAccount = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'x', 'x-425-other', 'theirs', '{}'::jsonb, 'ACTIVE') returning id`,
      [otherId],
    );
    await sql.query(
      `insert into public.posting_schedules
              (workspace_id, post_id, name, frequency, time_of_day, timezone, anchor_date, social_account_ids)
       values ($1::uuid, $2::uuid, 'THEIR RULE', 'DAILY', '09:00', 'UTC', current_date, $3::uuid[])`,
      [otherId, theirPost[0]!.id, [theirAccount[0]!.id]],
    );

    const listed = await schedules().listSchedules(context(), { limit: 100 });
    expect(listed.some((r) => r.name === "THEIR RULE")).toBe(false);

    await sql.query("delete from public.workspaces where id = $1::uuid", [otherId]);
  });

  /**
   * #425's second acceptance, against the real query: no data and no slots must produce no time.
   *
   * The seeded workspace has neither, so this is the honest cold-start case rather than a contrived one.
   */
  it("says there is nothing to suggest rather than inventing a time", async () => {
    /*
     * Made deterministic rather than tolerant.
     *
     * The first version accepted any `basis` — "none if there is nothing, otherwise something" — and a
     * sabotage that returned a configured slot when there was no data passed it. An assertion that
     * accepts every outcome asserts nothing. The slots are cleared so the cold-start case is the case.
     */
    await sql.query("delete from public.time_slots where workspace_id = $1::uuid", [workspaceId]);

    const suggestion = await schedules().suggestPublishTime(context(), { sinceDays: 90 });
    expect(suggestion.basis).toBe("none");
    if (suggestion.basis === "none") expect(suggestion.reason.length).toBeGreaterThan(20);
    expect(suggestion).not.toHaveProperty("timeOfDay");
    expect(suggestion).not.toHaveProperty("weekday");
  });

  it("falls back to a configured slot when there is no engagement data", async () => {
    const slots = await sql.query<{ id: string }>(
      `insert into public.time_slots (workspace_id, label, weekday, time_of_day, timezone, sort_order)
       values ($1::uuid, '#425 Morning', 2, '09:41', 'Europe/Berlin', 0) returning id`,
      [workspaceId],
    );

    const suggestion = await schedules().suggestPublishTime(context(), { sinceDays: 1 });
    // A one-day window on a workspace with no rollups: whatever comes back cannot be `measured`.
    expect(suggestion.basis).not.toBe("none");
    if (suggestion.basis === "configured-slot") {
      expect(suggestion.timeOfDay).toBe("09:41");
      expect(suggestion.timezone).toBe("Europe/Berlin");
    }

    const listed = await schedules().listTimeSlots(context());
    expect(listed.some((s) => s.label === "#425 Morning")).toBe(true);

    await sql.query("delete from public.time_slots where id = $1::uuid", [slots[0]!.id]);
  });

  it("refuses to write when the deployment has no route to the app", async () => {
    await expect(
      schedules().createRecurringSchedule(context(), {
        idempotencyKey: "k1" as never,
        postId: "p1" as never,
        accountIds: ["a1"],
        frequency: "DAILY",
        timeOfDay: "09:41",
      }),
    ).rejects.toThrow(/no route to the app|expansion step/);
  });
});

describe.skipIf(URL_ === undefined)("LinkService over short_links and link_clicks", () => {
  /**
   * The SQL, against a real database — #424.
   *
   * Three things here can only be got wrong in Postgres, and each has a test:
   *
   *  - **`link_clicks` has no workspace column.** It reaches one only through `short_links`, so every
   *    query joins and the tenant check lives on that join. A click table scoped by a column that is
   *    not there reads another tenant's numbers.
   *  - **The dimension queries could fan out.** Totals, referrers and countries as three left joins in
   *    one statement would multiply the click rows by referrer *and* by country, and report every
   *    number several times over. They are separate queries for that reason, and this asserts the
   *    total is the total.
   *  - **The window is a half-open interval.** A click exactly at `until` belongs to the next period,
   *    or two adjacent reports double-count the same click.
   */
  const ORIGIN = "https://chorus.test";
  const links = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      publicAppUrl: ORIGIN,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      ...over,
    }).links;

  const clickOn = async (linkId: string, at: string, over: { referrer?: string | null; country?: string | null } = {}) => {
    await sql.query(
      `insert into public.link_clicks (short_link_id, clicked_at, referrer, country) values ($1::uuid, $2::timestamptz, $3, $4)`,
      [linkId, at, over.referrer ?? null, over.country ?? null],
    );
  };

  it("mints a link on this deployment's origin and starts it at zero clicks", async () => {
    const link = await links().createTrackedLink(context(), {
      idempotencyKey: "k1" as never,
      destinationUrl: "northwind.studio/spring",
      title: "Spring sale",
    });
    expect(link.url).toBe(`${ORIGIN}/l/${link.slug}`);
    expect(link.clicks).toBe(0);
    // A bare domain is accepted and normalised, because a model asked for a link writes the domain.
    expect(link.destinationUrl).toBe("https://northwind.studio/spring");
  });

  it("refuses a destination that is not a web address, before writing a row", async () => {
    const before = await sql.query<{ n: string }>("select count(*) as n from public.short_links where workspace_id = $1::uuid", [workspaceId]);
    await expect(
      links().createTrackedLink(context(), { idempotencyKey: "k2" as never, destinationUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/not a web address/);
    const after = await sql.query<{ n: string }>("select count(*) as n from public.short_links where workspace_id = $1::uuid", [workspaceId]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("counts clicks for the window, and the totals are not multiplied by their dimensions", async () => {
    const link = await links().createTrackedLink(context(), {
      idempotencyKey: "k3" as never,
      destinationUrl: "https://northwind.studio/a",
    });
    // Two referrers and two countries on four clicks: a fan-out would report 8 or 16.
    await clickOn(link.id, "2026-09-10T10:00:00Z", { referrer: "linkedin.com", country: "DE" });
    await clickOn(link.id, "2026-09-10T11:00:00Z", { referrer: "linkedin.com", country: "AT" });
    await clickOn(link.id, "2026-09-11T10:00:00Z", { referrer: "x.com", country: "DE" });
    await clickOn(link.id, "2026-09-11T11:00:00Z", { referrer: null, country: null });

    // By id, not the top of the list: this workspace accumulates links across runs, and `[0]` of a
    // ranking is whichever one happens to lead rather than the one under test.
    const [report] = await links().getLinkPerformance(context(), {
      since: "2026-09-01",
      linkId: link.id,
      limit: 10,
    });
    expect(report!.clicks).toBe(4);
    expect(report!.referrers.reduce((sum, r) => sum + r.clicks, 0)).toBe(4);
    expect(report!.countries.reduce((sum, c) => sum + c.clicks, 0)).toBe(4);
    // A click with no referrer is someone typing or tapping the link — a fact, not a gap.
    expect(report!.referrers.map((r) => r.referrer)).toContain("direct");
    expect(report!.countries.map((c) => c.country)).toContain("unknown");
  });

  it("excludes a click outside the window, at both ends", async () => {
    const link = await links().createTrackedLink(context(), {
      idempotencyKey: "k4" as never,
      destinationUrl: "https://northwind.studio/b",
    });
    await clickOn(link.id, "2026-08-31T23:59:59Z");
    await clickOn(link.id, "2026-09-05T12:00:00Z");
    await clickOn(link.id, "2026-09-30T00:00:00Z");

    const [report] = await links().getLinkPerformance(context(), {
      since: "2026-09-01",
      until: "2026-09-30T00:00:00Z",
      linkId: link.id,
      limit: 10,
    });
    // Half-open: the click exactly at `until` belongs to the next period, or adjacent reports double-count it.
    expect(report!.clicks).toBe(1);
  });

  it("answers what a post drove, which is the question this SPEC exists for", async () => {
    const posts = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, raw_content, status) values ($1::uuid, '#424', 'DRAFT') returning id`,
      [workspaceId],
    );
    const postId = posts[0]!.id;
    const attributed = await links().createTrackedLink(context(), {
      idempotencyKey: "k5" as never,
      destinationUrl: "https://northwind.studio/c",
      postId: postId as never,
    });
    const other = await links().createTrackedLink(context(), {
      idempotencyKey: "k6" as never,
      destinationUrl: "https://northwind.studio/d",
    });
    await clickOn(attributed.id, "2026-09-12T10:00:00Z");
    await clickOn(other.id, "2026-09-12T10:00:00Z");

    const byPost = await links().getLinkPerformance(context(), { since: "2026-09-01", postId: postId as never, limit: 10 });
    expect(byPost).toHaveLength(1);
    expect(byPost[0]!.linkId).toBe(attributed.id);
    expect(byPost[0]!.postId).toBe(postId);

    const listed = await links().listTrackedLinks(context(), { limit: 50, postId: postId as never });
    expect(listed.map((l) => l.id)).toEqual([attributed.id]);
  });

  /** The tenancy check that has to live on the join, because `link_clicks` has no workspace column. */
  it("never reports another workspace's links or their clicks", async () => {
    const other = await sql.query<{ id: string }>(
      `insert into public.workspaces (name) values ('#424 other') returning id`,
    );
    const otherId = other[0]!.id;
    // A generated slug, not a literal: `short_links_slug_key` is unique across every workspace, so a
    // hardcoded one collides with whatever a previous run of this suite left behind.
    const theirs = await sql.query<{ id: string }>(
      `insert into public.short_links (workspace_id, slug, destination_url, title)
       values ($1::uuid, substr(md5(random()::text), 1, 7), 'https://theirs.test', 'THEIR LINK') returning id`,
      [otherId],
    );
    await clickOn(theirs[0]!.id, "2026-09-12T10:00:00Z");

    const listed = await links().listTrackedLinks(context(), { limit: 100 });
    expect(listed.some((l) => l.title === "THEIR LINK")).toBe(false);

    const reported = await links().getLinkPerformance(context(), { since: "2026-09-01", limit: 100 });
    expect(reported.some((r) => r.linkId === theirs[0]!.id)).toBe(false);
    // Even asked for by id: the filter is applied inside the workspace scope, not instead of it.
    const direct = await links().getLinkPerformance(context(), { since: "2026-09-01", linkId: theirs[0]!.id as never, limit: 10 });
    expect(direct).toEqual([]);

    await sql.query("delete from public.workspaces where id = $1::uuid", [otherId]);
  });

  it("refuses by name when the deployment has no public origin", async () => {
    await expect(
      links({ publicAppUrl: "" }).createTrackedLink(context(), {
        idempotencyKey: "k7" as never,
        destinationUrl: "https://northwind.studio/e",
      }),
    ).rejects.toThrow(/PUBLIC_APP_URL/);
  });
});

describe.skipIf(URL_ === undefined)("LeadService over leads", () => {
  const leads = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      ...over,
    }).leads;

  it("refuses the status the port declares and the column cannot hold", async () => {
    /**
     * `LEAD_STATUSES` includes `rejected`; `leads_status_check` is `ARRAY['new', 'contacted', 'qualified']`.
     * Left to the constraint this would come back as a violation naming the constraint — which a model cannot
     * act on — and mapping it onto `contacted` would tell a salesperson to follow up on someone turned down.
     */
    const created = await leads().createLead(context(), {
      idempotencyKey: "l1" as never,
      name: "Rejected Person",
      email: "reject@acme.test",
      attribution: {},
    });
    expect(created.outcome).toBe("created");
    const id = created.outcome === "created" ? created.lead.id : undefined;
    const error = thrown(
      await leads()
        .updateLead(context(), { idempotencyKey: "l2" as never, id: id!, patch: { status: "rejected" } })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("new, contacted, qualified");
    expect(STORED_LEAD_STATUSES).not.toContain("rejected");
  });

  it("reports a duplicate as `existing`, never as `created`", async () => {
    /**
     * **The database provides this guarantee**, which is the opposite of `scheduled_items`: two partial
     * unique indexes hold the dedupe, so `ON CONFLICT DO NOTHING` is atomic in one statement with no lock.
     * The difference between the two adapters is the index, not the care taken.
     *
     * The port: *"a dedupe match reported as `created` is the same class of untruth"* as misreporting a
     * suppression.
     */
    const first = await leads().createLead(context(), {
      idempotencyKey: "l3" as never,
      name: "Dup Person",
      email: "Dup@Acme.test",
      valueMinorUnits: 5_000,
      attribution: { platformId: "linkedin" as never },
    });
    expect(first.outcome).toBe("created");

    // A different name and a different case in the email — the index is on `lower(email)`.
    const second = await leads().createLead(context(), {
      idempotencyKey: "l4" as never,
      name: "Duplicate Person",
      email: "dup@acme.TEST",
      attribution: {},
    });
    expect(second.outcome).toBe("existing");
    // And the stored row is returned unchanged: a second sighting must not overwrite a salesperson's edits.
    if (second.outcome === "existing") {
      expect(second.lead.name).toBe("Dup Person");
      expect(second.lead.valueMinorUnits).toBe(5_000);
    }
    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.leads where workspace_id = $1::uuid and lower(email) = 'dup@acme.test'",
      [workspaceId],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("round-trips a structured attribution through one text column", async () => {
    /**
     * The port says to serialise: *"The adapter serialises into `capturedFrom` until ShareFlow has columns
     * for it."* The encoding is sorted `key=value` pairs rather than JSON **because the column is part of a
     * unique index** — `(workspace_id, name, captured_from)` — so its text decides whether two leads are the
     * same lead, and JSON key order would make one attribution encode two ways.
     */
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'attributed post', 'PUBLISHED', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const created = await leads().createLead(context(), {
      idempotencyKey: "l5" as never,
      name: "Attributed Person",
      email: "attributed@acme.test",
      attribution: { postDraftId: post[0]!.id as never, platformId: "linkedin" as never },
    });
    expect(created.outcome).toBe("created");
    if (created.outcome === "created") {
      expect(created.lead.attribution.postDraftId).toBe(post[0]!.id as never);
      expect(created.lead.attribution.platformId).toBe("linkedin" as never);
    }
    /**
     * Deterministic, and pinned to the exact string.
     *
     * The first version of this compared two object literals with the keys in different orders — which could
     * not fail, because the encoder builds its parts in a fixed sequence regardless of how the object was
     * written. Sabotage removing the encoder's `.sort()` passed. Pinning the output is what actually holds
     * the dedupe: this text is part of `leads_dedupe_name_source_idx`.
     */
    expect(encodeAttribution({ platformId: "x" as never, campaignId: "c" as never })).toBe("campaign=c;platform=x");
    expect(encodeAttribution({})).toBeNull();
    // Not JSON: `JSON.stringify` does not guarantee key order across shapes, so one attribution could encode
    // two ways and two identical leads would both insert.
    expect(encodeAttribution({ campaignId: "c" as never })).not.toContain("{");
  });

  it("never reports a lead as suppressed unless the deployment can suppress", async () => {
    /**
     * There is **no suppression table and no suppression path** in this schema — the port describes it as
     * "enforced inside the insert path", and that path does not exist here.
     *
     * The arm is not dropped, because the risk the port names is real: *"the risk is not that a tool bypasses
     * it, but that a tool misreports it: telling the user a lead was captured for someone who opted out."*
     * `leadSuppressionFor(deps)` is how a caller checks instead of inferring from never seeing the outcome.
     *
     * Derived from the deps rather than written into the module (#451): it was a hardcoded `false`, which
     * stayed `false` on the day the app grew a `lead_suppressions` table and wired it. A constant answering
     * a question about the composition is a claim that cannot stay true.
     */
    expect(leadSuppressionFor({}).enforced).toBe(false);
    expect(leadSuppressionFor({ isSuppressed: async () => undefined }).enforced).toBe(true);

    const withList = leads({
      isSuppressed: async ({ email }: { email?: string }) =>
        email === "optout@acme.test" ? ("opt-out" as const) : undefined,
    });
    const refused = await withList.createLead(context(), {
      idempotencyKey: "l6" as never,
      name: "Opted Out",
      email: "optout@acme.test",
      attribution: {},
    });
    expect(refused).toEqual({ outcome: "suppressed", reason: "opt-out" });
    // And nothing was written, which is the point of checking before the insert.
    const rows = await sql.query<{ n: string }>(
      "select count(*) as n from public.leads where workspace_id = $1::uuid and email = 'optout@acme.test'",
      [workspaceId],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("suppresses in preference to reporting a duplicate", async () => {
    // An opt-out is a stronger answer than "already here": a lead that exists *and* opted out must be
    // reported as suppressed, or the caller is told to contact them.
    await leads().createLead(context(), {
      idempotencyKey: "l7" as never,
      name: "Both",
      email: "both@acme.test",
      attribution: {},
    });
    const service = leads({ isSuppressed: async () => "complaint" as const });
    const result = await service.createLead(context(), {
      idempotencyKey: "l8" as never,
      name: "Both",
      email: "both@acme.test",
      attribution: {},
    });
    expect(result.outcome).toBe("suppressed");
  });

  it("normalises the email exactly as the dedupe index does, and no further", () => {
    /**
     * `leads_dedupe_email_idx` is `lower((email)::text)`. Anything more aggressive here — stripping dots or
     * `+` tags — would make this adapter treat two addresses as the same lead when the index does not, so
     * both would insert and the "existing" answer would be wrong.
     */
    expect(normaliseEmail("  Mixed.Case+tag@Acme.TEST ")).toBe("mixed.case+tag@acme.test");
  });

  it("never returns another workspace's leads", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-lead') returning id");
    await sql.query(
      `insert into public.leads (workspace_id, name, email, platform, value_cents, status)
       values ($1::uuid, 'THEIR SECRET LEAD', 'secret@them.test', 'bio', 0, 'new')`,
      [other[0]!.id],
    );
    const page = await leads().listLeads(context(), { limit: 50 });
    expect(page.items.some((lead) => lead.name.includes("THEIR SECRET"))).toBe(false);
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });
});

describe.skipIf(URL_ === undefined)("AnalyticsService — facts, and explicit absences", () => {
  const analytics = () =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
    }).analytics;

  let account = "";
  beforeAll(async () => {
    if (URL_ === undefined) return;
    account = (
      await sql.query<{ id: string }>(
        `insert into public.social_accounts
           (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
         values ($1::uuid, 'linkedin', 'an-1', 'Analytics LI', '{}'::jsonb, 'ACTIVE') returning id`,
        [workspaceId],
      )
    )[0]!.id;
  });

  /** A published post with one destination and, optionally, a metrics row. */
  const measured = async (metrics?: { likes: number; comments: number; shares: number; impressions: number }) => {
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'measured post', 'PUBLISHED', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const item = await sql.query<{ id: string }>(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, now() - interval '1 day', 'SUCCESS') returning id`,
      [post[0]!.id, account],
    );
    if (metrics !== undefined) {
      await sql.query(
        `insert into public.post_metrics
           (scheduled_item_id, likes, comments, shares, impressions, engagement_rate, updated_at)
         values ($1::uuid, $2, $3, $4, $5, 0, now())`,
        [item[0]!.id, metrics.likes, metrics.comments, metrics.shares, metrics.impressions],
      );
    }
    return { postId: post[0]!.id, itemId: item[0]!.id };
  };

  const factOf = (report: { facts: readonly { metric: string }[] }, metric: string) =>
    report.facts.find((fact) => fact.metric === metric) as
      | { metric: string; value?: number; unavailable?: string; unit: string }
      | undefined;

  it("reports counts with their window and provenance", async () => {
    const { postId, itemId } = await measured({ likes: 10, comments: 4, shares: 1, impressions: 500 });
    const report = await analytics().postMetrics(context(), { draftId: postId as never });
    expect(factOf(report, "likes")?.value).toBe(10);
    expect(factOf(report, "impressions")?.value).toBe(500);
    // 15/500 — recomputed from the totals, not averaged from the stored per-row rate.
    expect(factOf(report, "engagement_rate")?.value).toBeCloseTo(0.03);
    expect(factOf(report, "engagement_rate")?.unit).toBe("fraction");

    const traced = report.facts.find((fact) => "derivedFrom" in fact) as
      | { derivedFrom: { recordType: string; recordCount: number; recordIds?: readonly string[] } }
      | undefined;
    expect(traced?.derivedFrom.recordType).toBe("post_metrics");
    expect(traced?.derivedFrom.recordCount).toBe(1);
    // A small set carries its ids; a large one carries only the type and count.
    expect(traced?.derivedFrom.recordIds).toEqual([itemId]);
  });

  it("reports engagement rate as unavailable when impressions are zero, not as 0%", async () => {
    /**
     * **The defect the port names, with the line it lives on.**
     * `web/src/lib/campaign-stats.ts:92` is `engagementRate: impressions === 0 ? 0 : engagements / impressions`
     * — correct for a dashboard tile and wrong as a fact. No impressions makes the rate *undefined*, and an
     * assistant handed `0` will report "engagement was 0%" when the truth is "nothing was measured".
     */
    const { postId } = await measured({ likes: 0, comments: 0, shares: 0, impressions: 0 });
    const report = await analytics().postMetrics(context(), { draftId: postId as never });
    expect(factOf(report, "engagement_rate")?.unavailable).toBe("no-data");
    expect(factOf(report, "engagement_rate")).not.toHaveProperty("value");
    // The counts are still measured zeroes: somebody looked and saw none.
    expect(factOf(report, "likes")?.value).toBe(0);
  });

  it("distinguishes 'not collected' from 'measured zero'", async () => {
    /**
     * The `analytics-reporting` skill already says it: *"if a platform is not covered, say we cannot see its
     * comments — not that the post has none."* A post with no metrics row at all is `not-collected`; a row of
     * zeroes is a measurement. Those are different sentences to a user.
     */
    const { postId } = await measured();
    const report = await analytics().postMetrics(context(), { draftId: postId as never });
    for (const metric of ["likes", "comments", "shares", "impressions", "engagement_rate"]) {
      expect(factOf(report, metric)?.unavailable, metric).toBe("not-collected");
    }
  });

  it("answers not_found for another workspace's post rather than a report full of absences", async () => {
    /**
     * Without the existence check, a foreign id would come back as `not-collected` everywhere — which reads
     * as "we have no numbers for your post" rather than "that is not your post".
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-a') returning id");
    const theirs = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'theirs', 'PUBLISHED', '{linkedin}') returning id`,
      [other[0]!.id, userId],
    );
    const error = thrown(
      await analytics().postMetrics(context(), { draftId: theirs[0]!.id as never }).catch((r: unknown) => r),
    );
    expect(error.code).toBe("not_found");
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("scopes every metrics read by workspace in the query text, not only by the id filter", () => {
    /**
     * **Scanned from the source, because behaviour cannot show it.** Sabotage replaced `p.workspace_id = $1`
     * with a tautology and every test still passed — the `post_id` / `campaign_id` filter already isolates
     * the rows, and the existence check rejects a foreign id before the aggregate runs.
     *
     * So the workspace predicate is a second layer behind those two, and for this table it is the layer that
     * matters most: `post_metrics` is keyed by `scheduled_item_id` and has **no workspace column at all**, so
     * its only tenant scope is this join. If the existence check were ever removed or an id filter widened,
     * this is what would still stand between one tenant's aggregate and another's numbers.
     */
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../analytics.ts"),
      "utf8",
    );
    const reads = [...source.matchAll(/from public\.(post_metrics|leads)[\s\S]*?(?=\n *\)|\n *`)/g)].map((m) => m[0]);
    // Found the queries rather than nothing: a regex matching none would pass the loop below.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) expect(read).toContain("workspace_id = $1::uuid");
  });

  it("never counts another workspace's metrics into an aggregate", async () => {
    /**
     * `post_metrics` is keyed by `scheduled_item_id` and has **no workspace column**, so its only tenant
     * scope is the join through `scheduled_items` to `posts`. A query that read it directly would sum every
     * tenant's numbers into one answer — the worst kind of wrong number, because it looks plausible.
     */
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-agg') returning id");
    const theirAccount = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'an-x', 'Theirs', '{}'::jsonb, 'ACTIVE') returning id`,
      [other[0]!.id],
    );
    const theirPost = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, campaign_id, target_platforms)
       values ($1::uuid, $2::uuid, 'theirs', 'PUBLISHED', null, '{linkedin}') returning id`,
      [other[0]!.id, userId],
    );
    const theirItem = await sql.query<{ id: string }>(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, now() - interval '1 day', 'SUCCESS') returning id`,
      [theirPost[0]!.id, theirAccount[0]!.id],
    );
    await sql.query(
      `insert into public.post_metrics (scheduled_item_id, likes, comments, shares, impressions, engagement_rate)
       values ($1::uuid, 999999, 0, 0, 999999, 0)`,
      [theirItem[0]!.id],
    );

    const { postId } = await measured({ likes: 3, comments: 0, shares: 0, impressions: 100 });
    const report = await analytics().postMetrics(context(), { draftId: postId as never });
    expect(factOf(report, "likes")?.value).toBe(3);
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
  });

  it("takes freshness from the oldest row, not the newest", async () => {
    /**
     * An aggregate is as fresh as its least fresh input. Reporting the newest would let one recently
     * refreshed destination present a month-old campaign total as current.
     */
    const campaign = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, starts_on, ends_on, cadence, channels)
       values ($1::uuid, 'fresh', 't', current_date - 3, current_date, 'daily', '{linkedin}') returning id`,
      [workspaceId],
    );
    for (const [ago, likes] of [[1, 5], [40, 7]] as const) {
      const post = await sql.query<{ id: string }>(
        `insert into public.posts (workspace_id, author_id, raw_content, status, campaign_id, target_platforms)
         values ($1::uuid, $2::uuid, 'campaign post', 'PUBLISHED', $3::uuid, '{linkedin}') returning id`,
        [workspaceId, userId, campaign[0]!.id],
      );
      const item = await sql.query<{ id: string }>(
        `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
         values ($1::uuid, $2::uuid, now() - interval '1 day', 'SUCCESS') returning id`,
        [post[0]!.id, account],
      );
      await sql.query(
        `insert into public.post_metrics
           (scheduled_item_id, likes, comments, shares, impressions, engagement_rate, updated_at)
         values ($1::uuid, $2, 0, 0, 100, 0, now() - ($3 || ' days')::interval)`,
        [item[0]!.id, likes, ago],
      );
    }
    const report = await analytics().campaignMetrics(context(), { campaignId: campaign[0]!.id as never });
    // Both posts counted, aggregated by the service and not by the caller.
    expect(factOf(report, "likes")?.value).toBe(12);
    // Forty days beats the seven-day refresh window, so the whole report is stale.
    expect(report.freshness.stale).toBe(true);
    expect(ANALYTICS_REFRESH_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("counts attributed leads as a measured zero, unlike missing metrics", async () => {
    /**
     * The difference is whether an absence of rows means "not measured" or "measured none". Every lead this
     * workspace captured is in `leads`, so no matching row genuinely means none were attributed — where a
     * missing `post_metrics` row means nobody collected the numbers.
     */
    const { postId } = await measured();
    const empty = await analytics().attribution(context(), { draftId: postId as never });
    expect(factOf(empty, "attributed_leads")?.value).toBe(0);
    expect(factOf(empty, "attributed_leads")).not.toHaveProperty("unavailable");

    // And a lead attributed to that post is found through the encoding `LeadService` writes.
    const service = createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
    }).leads;
    await service.createLead(context(), {
      idempotencyKey: "attr-1" as never,
      name: "From The Post",
      email: "fromthepost@acme.test",
      valueMinorUnits: 12_500,
      attribution: { postDraftId: postId as never },
    });
    const found = await analytics().attribution(context(), { draftId: postId as never });
    expect(factOf(found, "attributed_leads")?.value).toBe(1);
    expect(factOf(found, "attributed_pipeline_value")?.value).toBe(12_500);
  });

  it("refuses to be asked about a draft and a campaign at once", async () => {
    const error = thrown(
      await analytics()
        .attribution(context(), { draftId: "a" as never, campaignId: "b" as never })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("invalid_input");
  });
});

describe.skipIf(URL_ === undefined)("MediaService over generated_assets and storage", () => {
  /**
   * Compatibility problems the app would report, set per test — #320 AC-8.
   *
   * Empty by default, so every test written before the guard keeps testing what it was written for.
   * Note the key is the **config** name here (`checkMediaCompatibility`) and the **dep** name in the
   * suite that builds the adapter directly (`checkCompatibility`) — two spellings of one capability,
   * which is exactly the kind of seam this file has been bitten by before.
   */
  let compatProblems: { platform: string; reason: string }[] = [];
  beforeEach(() => {
    compatProblems = [];
  });

  const media = (over: Record<string, unknown> = {}) =>
    createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async () => ({})) as never,
      checkMediaCompatibility: async () => compatProblems,
      ...over,
    }).media;

  let job = "";
  let withObject = "";
  /** The same object's storage path, so a conversion job can name it as its result. */
  let withObjectPath = "";
  let orphan = "";

  beforeAll(async () => {
    if (URL_ === undefined) return;
    job = (
      await sql.query<{ id: string }>(
        `insert into public.generation_jobs (workspace_id, kind, prompt, status)
         values ($1::uuid, 'image', 'a hero image', 'succeeded') returning id`,
        [workspaceId],
      )
    )[0]!.id;

    const path = `${workspaceId}/media/hero.png`;
    /**
     * A real `storage.objects` row, because that is where the byte count lives.
     *
     * `generated_assets` has **no size column** and `MediaAsset.bytes` is not optional — so the alternatives
     * were `bytes: 0` (a lie an assistant repeats) or reading `metadata->>'size'`, which is what Supabase
     * records. This inserts the object the way an upload would.
     */
    await sql.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('media', $1, jsonb_build_object('size', 204800, 'mimetype', 'image/png'))`,
      [path],
    );
    withObjectPath = path;
    withObject = (
      await sql.query<{ id: string }>(
        `insert into public.generated_assets (job_id, workspace_id, storage_path, mime, width, height)
         values ($1::uuid, $2::uuid, $3, 'image/png', 1200, 630) returning id`,
        [job, workspaceId, path],
      )
    )[0]!.id;

    orphan = (
      await sql.query<{ id: string }>(
        `insert into public.generated_assets (job_id, workspace_id, storage_path, mime, duration_ms)
         values ($1::uuid, $2::uuid, $3, 'video/mp4', 15000) returning id`,
        [job, workspaceId, `${workspaceId}/media/gone.mp4`],
      )
    )[0]!.id;
  });

  it("reports the real byte size, from where Supabase records it", async () => {
    const asset = await media().inspect(context(), { id: withObject as never });
    expect(asset.bytes).toBe(204_800);
    expect(asset.kind).toBe("image");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBe(1200);
    // The label is the object key's last segment — the table has no filename column, and it is not a URL.
    expect(asset.label).toBe("hero.png");
  });

  it("never returns a URL of any kind", async () => {
    /**
     * The port's reason: ShareFlow signs media URLs with an expiry, and *"a signed URL in a tool result would
     * be persisted in the run event log and readable by anyone who can read that conversation, long
     * outliving the check that produced it."*
     */
    const serialised = JSON.stringify(await media().listAssets(context(), { limit: 10 }));
    for (const forbidden of ["http://", "https://", "signedUrl", "storagePath", "token="]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("excludes an asset whose file is gone, and says which absence it is", async () => {
    /**
     * Not tidiness: an asset with no object **cannot be published**, because the platforms fetch the file
     * themselves. Offering it to a model is offering something that cannot work.
     *
     * `inspect` tells the two absences apart — a wrong id and a broken upload need different actions, and one
     * `not_found` for both would send a user looking for a typo.
     */
    const page = await media().listAssets(context(), { limit: 50 });
    expect(page.items.map((asset) => asset.id)).toContain(withObject as never);
    expect(page.items.map((asset) => asset.id)).not.toContain(orphan as never);

    const error = thrown(await media().inspect(context(), { id: orphan as never }).catch((r: unknown) => r));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("missing from storage");

    const unknown = thrown(
      await media()
        .inspect(context(), { id: "00000000-0000-0000-0000-000000000000" as never })
        .catch((rejection: unknown) => rejection),
    );
    expect(unknown.message).not.toContain("missing from storage");
  });

  it("converts milliseconds to seconds", async () => {
    // A duration reported a thousand times too large would make every video look longer than every platform
    // allows — and the check would refuse a video that is fine.
    await sql.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('media', $1, jsonb_build_object('size', 5000000))`,
      [`${workspaceId}/media/clip.mp4`],
    );
    const asset = await sql.query<{ id: string }>(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime, duration_ms)
       values ($1::uuid, $2::uuid, $3, 'video/mp4', 15000) returning id`,
      [job, workspaceId, `${workspaceId}/media/clip.mp4`],
    );
    expect((await media().inspect(context(), { id: asset[0]!.id as never })).durationSeconds).toBe(15);
  });

  it("appends attachments rather than replacing them, and drops a duplicate", async () => {
    /**
     * The port is explicit that this is not `updateDraft({ mediaAssetIds })`: *"To append one file through a
     * replace the caller has to read the current list, append and write it back."* Attaching the same file
     * twice would publish it twice, so the union is taken.
     */
    const draft = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms, media_urls)
       values ($1::uuid, $2::uuid, 'with media', 'DRAFT', '{linkedin}', '{already-there}') returning id`,
      [workspaceId, userId],
    );
    const first = await media().attachToDraft(context(), {
      idempotencyKey: "m1" as never,
      draftId: draft[0]!.id as never,
      assetIds: [withObject as never],
    });
    expect(first.mediaAssetIds).toContain("already-there");
    expect(first.mediaAssetIds).toHaveLength(2);

    const again = await media().attachToDraft(context(), {
      idempotencyKey: "m2" as never,
      draftId: draft[0]!.id as never,
      assetIds: [withObject as never],
    });
    expect(again.mediaAssetIds).toHaveLength(2);
  });

  it("refuses to attach a file that is missing from storage", async () => {
    // A draft carrying a path the platforms cannot fetch fails at publish time — exactly the lateness this
    // check exists to avoid.
    const draft = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'no media', 'DRAFT', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const error = thrown(
      await media()
        .attachToDraft(context(), {
          idempotencyKey: "m3" as never,
          draftId: draft[0]!.id as never,
          assetIds: [orphan as never],
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("not_found");
    const stored = await sql.query<{ media_urls: string[] }>(
      "select media_urls from public.posts where id = $1::uuid",
      [draft[0]!.id],
    );
    expect(stored[0]!.media_urls).toEqual([]);
  });

  it("refuses to attach to a published post, and names duplicating as the remedy", async () => {
    const published = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'live', 'PUBLISHED', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const error = thrown(
      await media()
        .attachToDraft(context(), {
          idempotencyKey: "m4" as never,
          draftId: published[0]!.id as never,
          assetIds: [withObject as never],
        })
        .catch((rejection: unknown) => rejection),
    );
    expect(error.code).toBe("conflict");
    expect(error.details).toMatchObject({ remedy: "duplicate" });
  });

  /**
   * #320 AC-8 — the assistant may not do what the app refuses.
   *
   * `writeMedia` in the web app has run `checkMediaCompatibility` on add, remove and replace for as
   * long as it has existed. This package did not, and the assistant is the path that goes through this
   * package: a person could not attach a video to a platform that takes none, and the model could. The
   * failure then arrived as a rejected publish, long after the assistant reported the post fine.
   *
   * The rule itself is asked of the app rather than rebuilt here — `platform_rules` holds no media
   * rules at all, so the only real ones are the publish gate's.
   */
  describe("the platform rules on a draft media write — AC-8", () => {
    const onInstagram = async () => {
      const rows = await sql.query<{ id: string }>(
        `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
         values ($1::uuid, $2::uuid, 'draft', 'DRAFT', '{instagram}') returning id`,
        [workspaceId, userId],
      );
      return rows[0]!.id;
    };

    it("refuses a swap the platform will not accept, naming the platform", async () => {
      const draftId = await onInstagram();
      await media().attachToDraft(context(), {
        idempotencyKey: "ac8a" as never,
        draftId: draftId as never,
        assetIds: [withObject as never],
      });

      // A second asset to swap in, created here rather than borrowed from another suite's fixtures.
      const swapPath = `${workspaceId}/ac8-swap.mp4`;
      const swapIn = await sql.query<{ id: string }>(
        `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
         values ($1::uuid, $2::uuid, $3, 'video/mp4') returning id`,
        [job, workspaceId, swapPath],
      );
      await sql.query(
        `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 2048}'::jsonb)
         on conflict do nothing`,
        [swapPath],
      );

      compatProblems = [{ platform: "instagram", reason: "Instagram does not accept video" }];
      const error = thrown(
        await media()
          .replaceOnDraft(context(), {
            idempotencyKey: "ac8b" as never,
            draftId: draftId as never,
            remove: withObject as never,
            add: swapIn[0]!.id as never,
          })
          .catch((rejection: unknown) => rejection),
      );
      expect(error.code).toBe("conflict");
      // The platform by name, not a generic "incompatible media" — that is the acceptance.
      expect(error.message).toContain("Instagram");

      // And it did not write: the original file is still the one on the post.
      const after = await sql.query<{ media_urls: string[] | null }>(
        `select media_urls from public.posts where id = $1::uuid`,
        [draftId],
      );
      expect(after[0]!.media_urls ?? []).toHaveLength(1);
    });

    it("refuses an attach the platform will not accept, so the swap guard cannot be walked around", async () => {
      const draftId = await onInstagram();
      compatProblems = [{ platform: "instagram", reason: "Instagram does not accept video" }];
      const error = thrown(
        await media()
          .attachToDraft(context(), {
            idempotencyKey: "ac8c" as never,
            draftId: draftId as never,
            assetIds: [withObject as never],
          })
          .catch((rejection: unknown) => rejection),
      );
      expect(error.code).toBe("conflict");
      expect(error.message).toContain("Instagram");
    });

    it("refuses a removal that breaks the rule, because 'Instagram requires an image' is one a detach breaks", async () => {
      const draftId = await onInstagram();
      await media().attachToDraft(context(), {
        idempotencyKey: "ac8d" as never,
        draftId: draftId as never,
        assetIds: [withObject as never],
      });

      compatProblems = [{ platform: "instagram", reason: "Instagram requires an image or video" }];
      const error = thrown(
        await media()
          .detachFromDraft(context(), {
            idempotencyKey: "ac8e" as never,
            draftId: draftId as never,
            assetIds: [withObject as never],
          })
          .catch((rejection: unknown) => rejection),
      );
      expect(error.code).toBe("conflict");
      expect(error.message).toContain("Instagram");
    });

    it("refuses the write outright when the deployment cannot check, rather than allowing it unchecked", async () => {
      const draftId = await onInstagram();
      const error = thrown(
        await media({ checkMediaCompatibility: undefined })
          .attachToDraft(context(), {
            idempotencyKey: "ac8f" as never,
            draftId: draftId as never,
            assetIds: [withObject as never],
          })
          .catch((rejection: unknown) => rejection),
      );
      expect(error.code).toBe("provider_unavailable");
      expect(error.message).toContain("cannot check media");
    });

    it("does not ask about a draft that names no platform, since none can refuse it", async () => {
      const rows = await sql.query<{ id: string }>(
        `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
         values ($1::uuid, $2::uuid, 'draft', 'DRAFT', '{}') returning id`,
        [workspaceId, userId],
      );
      let asked = 0;
      await media({
        checkMediaCompatibility: async () => {
          asked += 1;
          return [{ platform: "instagram", reason: "Instagram does not accept video" }];
        },
      }).attachToDraft(context(), {
        idempotencyKey: "ac8g" as never,
        draftId: rows[0]!.id as never,
        assetIds: [withObject as never],
      });
      // Not "it allowed it" — it never asked, which is the difference between no rule and a passed one.
      expect(asked).toBe(0);
    });
  });

  it("reports that media rules could not be checked, rather than answering 'no issues'", async () => {
    /**
     * `platform_rules` holds `char_limit`, `hashtag_min` and `hashtag_max` and **nothing about media**. An
     * empty list would say the attachments are publishable everywhere, and the failure would arrive as a
     * rejected publish long after the assistant said the post was fine.
     */
    const issues = await media().checkPlatformCompatibility(context(), {
      assetIds: [withObject as never],
      platformIds: ["linkedin", "tiktok"] as never,
    });
    expect(issues.map((issue) => issue.code)).toEqual([MEDIA_UNCHECKED_CODE, MEDIA_UNCHECKED_CODE]);
    for (const issue of issues) expect(issue.repairable).toBe(false);
  });

  it("refuses to convert or to vouch for storage when neither is wired", async () => {
    /**
     * `convert` refuses because unlike a scheduled publish there is **no sweep** that would pick up an
     * unprocessed `media_conversion_jobs` row — writing one would queue a job nothing runs.
     *
     * `checkStorage` refuses because it is the check that catches a private bucket, which *"fails only at
     * publish time"*. A deployment with nothing to run it reporting `ok` would assert the very thing the
     * check exists to doubt.
     */
    const convert = thrown(
      await media()
        .convert(context(), { idempotencyKey: "c1" as never, id: withObject as never, targetFormat: "webp" })
        .catch((rejection: unknown) => rejection),
    );
    expect(convert.code).toBe("capability_unavailable");

    const storage = thrown(
      await media().checkStorage(context(), { idempotencyKey: "c2" as never }).catch((r: unknown) => r),
    );
    expect(storage.code).toBe("capability_unavailable");
    expect(storage.message).toContain("private bucket");
  });

  it("converts through the wired service and returns a finished conversion carrying a real object", async () => {
    /**
     * The seam returns a **job id** now, not an asset id — REQ-041 (#190). ShareFlow's converter is
     * asynchronous for video and records `media_conversion_jobs` rows, so a job id is what it actually
     * produces; a synchronous one returns a row that is already `succeeded`. This is that case.
     */
    const finished = await sql.query<{ id: string }>(
      `insert into public.media_conversion_jobs (workspace_id, source_path, target, status, result_path)
       values ($1::uuid, 'src.png', 'webp', 'succeeded', $2) returning id`,
      [workspaceId, withObjectPath],
    );
    const service = media({ convertMedia: async () => ({ jobId: finished[0]!.id }) });
    const converted = await service.convert(context(), {
      idempotencyKey: "c3" as never,
      id: withObject as never,
      targetFormat: "webp",
    });
    expect(converted.state).toBe("succeeded");
    // Read back rather than trusted: the asset carries a real size and a real object, the same guarantee
    // every other asset this service hands out has.
    expect(converted.asset?.bytes).toBe(204_800);
  });

  it("never returns another workspace's assets", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('other-m') returning id");
    const theirJob = await sql.query<{ id: string }>(
      "insert into public.generation_jobs (workspace_id, kind, prompt, status) values ($1::uuid, 'image', 'p', 'succeeded') returning id",
      [other[0]!.id],
    );
    /**
     * `on conflict do nothing`, because this object cannot be cleaned up.
     *
     * Supabase refuses a direct delete from `storage.objects`, and this path — unlike the others here — has
     * no workspace id in it, so a second run of the suite collided on `bucketid_objname`. The row's
     * existence is what the test needs; whether this run created it does not matter.
     */
    await sql.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('media', 'their-secret.png', jsonb_build_object('size', 1))
       on conflict do nothing`,
    );
    await sql.query(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, 'their-secret.png', 'image/png')`,
      [theirJob[0]!.id, other[0]!.id],
    );
    const page = await media().listAssets(context(), { limit: 50 });
    expect(page.items.some((asset) => asset.label.includes("their-secret"))).toBe(false);
    await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
    /**
     * The `storage.objects` row is deliberately left behind.
     *
     * Supabase refuses a direct delete — `Direct deletion from storage tables is not allowed. Use the
     * Storage API instead.` — so cleaning it up from SQL is not possible. It is a metadata row in a private
     * bucket with no file behind it, and the `generated_assets` row that referenced it went with the
     * workspace cascade.
     */
  });
});

describe.skipIf(URL_ === undefined)("wiring the services, which is what makes them reachable", () => {
  /**
   * Three adapters nobody can construct together are three adapters nobody uses. `createShareFlowServices` is
   * the composition, and the assertions here are about the two ways it could be dishonest.
   */
  it("builds all three from one executor, and the generator reads the brand through the brand service", async () => {
    /**
     * The generator's `brand` dependency is wired here rather than looked up inside it: a generator that
     * fetched the profile itself would read it once per variant, and five variants across three platforms
     * would be fifteen identical queries for text that cannot change during a turn.
     *
     * Asserted by observing the prompt: the profile written to `workspace_ai_profile` by an earlier test in
     * this file reaches the model's system text, which can only happen through the brand service.
     */
    const systems: string[] = [];
    const services = createShareFlowServices({
      sql: sql as never,
      transaction,
      setup: () => SETUP,
      ...RESEARCH,
      generate: (async (input: { system: string }) => {
        systems.push(input.system);
        return { variants: [{ platformId: "instagram", caption: "generated" }] };
      }) as never,
    });

    await sql.query(
      `insert into public.workspace_ai_profile (workspace_id, brand_name, audience)
       values ($1::uuid, 'Wired Co', 'operators')
       on conflict (workspace_id) do update set brand_name = 'Wired Co', audience = 'operators'`,
      [workspaceId],
    );

    const variants = await services.generator.generate(context(), {
      brief: "the launch",
      platformIds: ["instagram"] as never,
      avoid: [],
    });
    expect(variants[0]?.caption).toBe("generated");
    expect(systems[0]).toContain("Wired Co");
    expect(systems[0]).toContain("operators");

    // And the other two are the real adapters, not stubs: this reads the row the generator's brand just read.
    expect((await services.brand.getBrandProfile(context())).brandName).toBe("Wired Co");
    expect((await services.content.listDrafts(context(), { limit: 1 })).items.length).toBeGreaterThan(0);
  });

  it("offers only the context providers whose services exist", async () => {
    /**
     * `accounts` is in this list **now**, and its absence before was the whole argument for a narrower type.
     *
     * It calls `services.connectors.listAccounts` on every turn, and `backend/src/context/assembler.ts:35`
     * runs providers in a bare `for` loop with no `try` — so while `ConnectorService` had no adapter,
     * including it would have aborted the assembly and with it every turn, before the model was called. The
     * constraint is satisfied rather than worked around.
     *
     * The assertion runs each provider against the live database, which is the only way to know none of them
     * reaches a service that is not there.
     */
    const services = createShareFlowServices({ sql: sql as never, transaction, setup: () => SETUP,
      ...RESEARCH, generate: (async () => ({})) as never });
    const providers = backedContextProviders(services);
    expect(providers.map((provider) => provider.id)).toEqual([
      "shareflow.brand",
      "shareflow.claims",
      "shareflow.audience",
      "shareflow.accounts",
    ]);
    for (const provider of providers) {
      const sections = await provider.provide(context());
      expect(Array.isArray(sections)).toBe(true);
    }
  });

  it("builds a real ShareFlow app from a partial service set and the factories that read it", async () => {
    /**
     * **The payoff.** Before `ShareFlowToolFactory.requires`, `createShareFlowApp` demanded all ten
     * services, so these three adapters were constructible, tested and unreachable — the same defect
     * family as the campaign path that had never been called.
     *
     * Now `services` is a `Partial` and each factory declares what it reads, so a deployment with
     * three adapters and a matching factory list is a legitimate configuration, checked at
     * construction. This builds one and asserts the catalogue is exactly the twelve capabilities those
     * three services can serve.
     */
    const services = createShareFlowServices({ sql: sql as never, transaction, setup: () => SETUP,
      ...RESEARCH, generate: (async () => ({})) as never });
    const app = createShareFlowApp({
      services,
      factories: [...POSTS_TOOL_FACTORIES, ...CAMPAIGN_TOOL_FACTORIES, ...GENERATE_TOOL_FACTORIES],
      deps: { authorization: { async can() { return { allow: true }; } } } as never,
      authorization: {} as never,
      manifest: {
        instructions: "Draft and plan social content.",
        modelPolicy: {} as never,
        authorizationPolicyId: "shareflow-default",
        limits: {} as never,
        // Narrowed to what these services can serve. The manifest's own mechanism for a partial
        // rollout, and the reason `categories` exists.
        categories: ["posts", "campaigns"],
      },
    });

    const tools = await app.providers[0]!.listTools(context());
    // 12 -> 16 with the link and schedule categories (#424, #425); 17 with `generate_alternatives`
    // (#266). The narrowing above is by category, so this count moves whenever a category gains tools
    // — which is what it is for.
    expect(tools).toHaveLength(20);
    expect(tools.map((registered) => registered.descriptor.name)).toContain("create_post_draft");
    expect(tools.map((registered) => registered.descriptor.name)).toContain("generate_content");
    // Registered on a generator-only service set: the brand reaches its prompt through the adapter's
    // config, so declaring `brand` would have made this deployment refuse a tool it can serve.
    expect(tools.map((registered) => registered.descriptor.name)).toContain("generate_alternatives");
    /**
     * Two categories, and only two. No accounts, publishing, media, analytics, engagement, leads or
     * research — those services do not exist here, and a factory for one would have been refused at
     * construction rather than appearing in this catalogue.
     *
     * The generation tools sit under `posts` rather than a category of their own, which is why this
     * asserts the distinct set instead of a count per category.
     */
    expect([...new Set(tools.map((registered) => registered.descriptor.category))].sort()).toEqual([
      "campaigns",
      "posts",
    ]);
  });

  it("refuses an app whose factory list needs a service the deployment withheld", () => {
    /**
     * The other half, and the one that makes the first half safe: a factory whose service is absent fails
     * **here**, naming the tools, rather than when a user asks for something.
     *
     * **This test has been rewritten twice, and both rewrites were the mechanism working.** It named the
     * publishing factories until `PublishingService` was built, then the media factories until `MediaService`
     * was — each time the configuration became legitimate and the test correctly stopped throwing.
     *
     * Now that all ten services exist there is no unimplemented one to demonstrate with, so it withholds one
     * deliberately instead. That is the better test anyway: what is under test is the check, not which
     * services happen to be written this week.
     */
    const complete = createShareFlowServices({ sql: sql as never, transaction, setup: () => SETUP,
      ...RESEARCH, generate: (async () => ({})) as never });
    const { media: _withheld, ...withoutMedia } = complete;
    expect(() =>
      createShareFlowApp({
        services: withoutMedia,
        factories: [...POSTS_TOOL_FACTORIES, ...MEDIA_TOOL_FACTORIES],
        deps: { authorization: { async can() { return { allow: true }; } } } as never,
        authorization: {} as never,
        manifest: {
          instructions: "Draft and publish.",
          modelPolicy: {} as never,
          authorizationPolicyId: "shareflow-default",
          limits: {} as never,
        },
      }),
    ).toThrowError(/list_media \(media\)/);
  });

  it("keeps the backed and unbacked lists adding up to the whole interface", () => {
    /**
     * The tripwire that stops this file going stale, in two halves that catch different things.
     *
     * The runtime half here catches a duplicate and a wrong count. The **type** half is at the top of this
     * file (`ServicesArePartitioned`) and catches a name that is not a member, or a member nobody listed.
     *
     * The first version of the type half was written inside this test as `const noExtra: Extra[] = []`, and it
     * could not fail: an empty array literal is assignable to `never[]` *and* to `"media2"[]`, so a bogus
     * entry typechecked. Sabotage caught it — which is the only reason it is now written as a conditional the
     * compiler has to evaluate.
     */
    const all = [...BACKED_SERVICES, ...UNBACKED_SERVICES];
    expect(new Set(all).size).toBe(all.length);
    /*
     * Fifteen: twelve, plus `links` (#424), `schedules` (#425) and `insights` (#426).
     *
     * **This number was already wrong before either of those.** It read 11 against a list of 12, and
     * nothing caught it because this whole suite is `skipIf(URL_ === undefined)` and CI has no
     * database — so a count pinned here is only checked by whoever runs it locally with one. Worth
     * knowing before trusting any other assertion in this file: the compiler proves the two lists
     * partition `ShareFlowServices` exactly, which is the guarantee that actually held while this
     * number drifted.
     */
    // Eighteen since #621: the fifteen above, `credits` (#499), `projects` (#522) and `personalMemory` (#621) —
    // it read 15 against a list of 17 for the same reason given above.
    expect(all).toHaveLength(18);
    // Each name is a real member — the length check alone would accept ten wrong names.
    const backed = createShareFlowServices({ sql: sql as never, transaction, setup: () => SETUP,
      ...RESEARCH, generate: (async () => ({})) as never });
    for (const name of BACKED_SERVICES) expect(backed[name]).toBeDefined();
  });
});

describe("the status mapping, which is where the two vocabularies meet", () => {
  it("maps every status the port declares", () => {
    // A `toLowerCase()` would silently produce statuses the type does not have; the mapping is written out.
    for (const status of POST_DRAFT_STATUSES) expect(STATUS_TO_DB[status]).toBeTruthy();
  });

  it("knows exactly ShareFlow's five statuses and no invented ones", async () => {
    /**
     * The key set, asserted as a set. An earlier version also carried `REVIEW`, `REJECTED` and
     * `SCHEDULED → approved`; none is a value this column can hold, and the last would have reported a post as
     * approved on the strength of a status that does not exist.
     *
     * `web/src/lib/data/posts.ts:5` is the source, and the `enforce_post_status_transition` trigger is the
     * authority — it names every legal transition, so a status missing from it cannot be reached.
     */
    expect(Object.keys(STATUS_FROM_DB).sort()).toEqual(
      ["APPROVED", "CHANGES_REQUESTED", "DRAFT", "IN_REVIEW", "PUBLISHED"],
    );
    expect(Object.keys(STATUS_FROM_DB)).toHaveLength(POST_DRAFT_STATUSES.length);
  });

  it("reads the live values this deployment actually contains", () => {
    expect(statusFrom("PUBLISHED")).toBe("published");
    expect(statusFrom("APPROVED")).toBe("approved");
  });

  it("treats an unknown status as draft, the most cautious reading", () => {
    /**
     * Throwing would make one unrecognised row break a whole list; `published` would tell an assistant a post
     * is live when nobody knows. `draft` invites review rather than action.
     */
    expect(statusFrom("SOMETHING_NEW")).toBe("draft");
    expect(statusFrom(null)).toBe("draft");
  });
});

describe("the planned post count, which must be ShareFlow's number and not a plausible one", () => {
  /**
   * Pinned against `postCountFor` in `web/src/lib/campaigns.ts:34`, value for value.
   *
   * The first version of `plannedPostCount` computed `ceil(days / every)` from an interval table containing
   * `BIWEEKLY` and `MONTHLY` — cadences this schema's CHECK constraint does not permit — and had **no arm for
   * `3x-week`**, so three-a-week fell through to weekly and reported a third of the posts ShareFlow creates.
   * These are the numbers the other implementation produces; a formula that merely looks reasonable is what
   * this table exists to reject.
   */
  const CASES = [
    { startsOn: "2026-01-01", endsOn: "2026-12-31", cadence: "daily", expected: 31 },
    { startsOn: "2026-01-01", endsOn: "2026-01-07", cadence: "daily", expected: 7 },
    { startsOn: "2026-01-01", endsOn: "2026-01-28", cadence: "weekly", expected: 4 },
    { startsOn: "2026-01-01", endsOn: "2026-01-21", cadence: "3x-week", expected: 9 },
    { startsOn: "2026-01-01", endsOn: "2026-01-07", cadence: "3x-week", expected: 3 },
    { startsOn: "2026-01-01", endsOn: "2026-12-31", cadence: "3x-week", expected: 31 },
  ] as const;

  it.each(CASES)("$cadence over $startsOn..$endsOn is $expected posts", ({ startsOn, endsOn, cadence, expected }) => {
    expect(plannedPostCount(startsOn, endsOn, cadence)).toBe(expected);
  });

  it("would have reported a third of a three-a-week campaign under the old formula", () => {
    // The regression stated as a number: weekly over the same three weeks is 3, three-a-week is 9.
    expect(plannedPostCount("2026-01-01", "2026-01-21", "weekly")).toBe(3);
    expect(plannedPostCount("2026-01-01", "2026-01-21", "3x-week")).toBe(9);
  });

  it("caps a runaway range at 31 rather than reporting a year of posts", () => {
    /**
     * "Daily for the next year" is 31 posts, not 365. Without the cap the assistant reports a year of daily
     * posts and has planned a month — the same class of silent failure as a truncated caption.
     */
    expect(plannedPostCount("2026-01-01", "2026-12-31", "daily")).toBe(CAMPAIGN_POST_CAP);
  });

  it("returns zero for an inverted range rather than a negative count", () => {
    expect(plannedPostCount("2026-02-01", "2026-01-01", "daily")).toBe(0);
  });
});

describe("the cadence mapping the port asked for by name", () => {
  it("sends `3x_week` to the store and reads `3x-week` back", () => {
    /**
     * The port: *"the store's value is `3x_week`. **The adapter maps between them** — noted here because it is
     * exactly the kind of one-line translation that can go wrong silently, producing a campaign whose cadence
     * fails a CHECK constraint at insert time."* It did, and this is the assertion that would have caught it.
     */
    expect(CADENCE_TO_DB["3x-week"]).toBe("3x_week");
    expect(cadenceFrom("3x_week")).toBe("3x-week");
    expect(CADENCE_TO_DB.daily).toBe("daily");
    expect(CADENCE_TO_DB.weekly).toBe("weekly");
  });

  it("reads an unrecognised stored cadence as weekly, agreeing with ShareFlow's own fallthrough", () => {
    // `postCountFor`'s last line is an unguarded `// weekly`. Agreeing with it matters more than being clever.
    expect(cadenceFrom("fortnightly")).toBe("weekly");
    expect(cadenceFrom(null)).toBe("weekly");
  });
});

describe.skipIf(URL_ === undefined)("AnalyticsService.campaignBreakdown — the query, against a real database", () => {
  /**
   * The one part of `evaluate_campaign` that unit tests cannot reach.
   *
   * Sabotage proved it: keying `publishedDestinations` on the *metric* id instead of the item id compiles,
   * every unit test passes, and a campaign with three published-but-uncollected destinations reports **one**
   * — because `String(null)` is one key. Only rows can catch that, so this block exists.
   *
   * It was also verified against the live schema before being written, inside a transaction that was rolled
   * back: 31 real posts grouped, `scheduled_items.status` confirmed to be `'SUCCESS'` and not a guess, and
   * `campaignMetrics` agreeing with `totals` on the same window.
   */
  let campaignId = "";
  let accountId = "";
  let measuredPostId = "";
  const WINDOW = { fromDay: "2000-01-01", toDay: "2100-01-01" } as never;

  const analytics = () => createPostgresAnalyticsService({ sql });

  beforeAll(async () => {
    if (URL_ === undefined) return;
    const account = await sql.query<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', 'brk-1', 'Acme LI', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId],
    );
    accountId = account[0]!.id;
    const campaign = await sql.query<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, theme, cadence, starts_on, ends_on)
       values ($1::uuid, 'breakdown', 'packaging', '3x_week', '2026-08-01', '2026-08-31') returning id`,
      [workspaceId],
    );
    campaignId = campaign[0]!.id;

    const post = async (caption: string) =>
      (
        await sql.query<{ id: string }>(
          `insert into public.posts (workspace_id, author_id, raw_content, status, campaign_id, target_platforms)
           values ($1::uuid, $2::uuid, $3, 'PUBLISHED', $4::uuid, '{linkedin,x}') returning id`,
          [workspaceId, userId, caption, campaignId],
        )
      )[0]!.id;
    const item = async (postId: string) =>
      (
        await sql.query<{ id: string }>(
          `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
           values ($1::uuid, $2::uuid, '2026-08-10T09:00:00Z'::timestamptz, 'SUCCESS') returning id`,
          [postId, accountId],
        )
      )[0]!.id;

    // One post measured on two destinations…
    measuredPostId = await post("The measured post, first line\nsecond line never shown");
    const [a, b] = [await item(measuredPostId), await item(measuredPostId)];
    await sql.query(
      `insert into public.post_metrics (scheduled_item_id, likes, comments, shares, impressions, updated_at)
       values ($1::uuid, 10, 2, 1, 1000, now()), ($2::uuid, 5, 0, 0, 500, now())`,
      [a, b],
    );
    // …one published to three destinations that nobody has collected…
    const silent = await post("Published but nobody collected it");
    await Promise.all([item(silent), item(silent), item(silent)]);
    // …and one that never went out at all.
    await post("Never sent");
  });

  it("groups per post and sums each post's destinations", async () => {
    const out = await analytics().campaignBreakdown(context(), { campaignId: campaignId as never, window: WINDOW });
    expect(out.posts).toHaveLength(3);
    const measured = out.posts.find((post) => post.excerpt.startsWith("The measured"));
    expect(measured?.publishedDestinations).toBe(2);
    expect(measured?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "likes", value: 15 }),
        expect.objectContaining({ metric: "impressions", value: 1_500 }),
        // 18 engagements over 1500 impressions, recomputed from the totals rather than averaging rates.
        expect.objectContaining({ metric: "engagement_rate", value: 18 / 1_500 }),
      ]),
    );
  });

  it("counts every published destination, including ones with no metrics row", async () => {
    /**
     * The sabotage this block exists for. Keyed on the metric id, these three collapse to one — and the
     * number is wrong in exactly the case the field exists to describe.
     */
    const out = await analytics().campaignBreakdown(context(), { campaignId: campaignId as never, window: WINDOW });
    const silent = out.posts.find((post) => post.excerpt.startsWith("Published but nobody"));
    expect(silent?.publishedDestinations).toBe(3);
    // And its numbers are absences, not zeroes — three destinations nobody measured.
    expect(silent?.facts.every((fact) => !("value" in fact))).toBe(true);
  });

  it("includes a post that never went out, so an evaluation can say so", async () => {
    // `campaignMetrics` reads inwards from `post_metrics`, so this post is invisible to it. That is the
    // reason this method reads outwards from `posts`.
    const out = await analytics().campaignBreakdown(context(), { campaignId: campaignId as never, window: WINDOW });
    const unsent = out.posts.find((post) => post.excerpt === "Never sent");
    expect(unsent?.publishedDestinations).toBe(0);
  });

  it("clips the excerpt to the first line, the same as a draft list", async () => {
    const out = await analytics().campaignBreakdown(context(), { campaignId: campaignId as never, window: WINDOW });
    expect(out.posts.map((post) => post.excerpt)).toContain("The measured post, first line");
  });

  it("agrees with campaignMetrics on the same window", async () => {
    /**
     * The port claims `totals` is the same aggregate. Two ways of counting the same rows is exactly the
     * kind of claim that drifts, so it is measured rather than asserted in a comment.
     */
    const service = analytics();
    const [breakdown, report] = await Promise.all([
      service.campaignBreakdown(context(), { campaignId: campaignId as never, window: WINDOW }),
      service.campaignMetrics(context(), { campaignId: campaignId as never, window: WINDOW }),
    ]);
    const shape = (facts: readonly unknown[]) =>
      facts.map((fact) => {
        const f = fact as { metric: string; value?: number; unavailable?: string };
        return `${f.metric}=${f.value ?? f.unavailable}`;
      });
    expect(shape(breakdown.totals)).toEqual(shape(report.facts));
  });

  it("refuses another workspace's campaign rather than reporting zeroes for it", async () => {
    const other = await sql.query<{ id: string }>("insert into public.workspaces (name) values ('brk-other') returning id");
    try {
      const alien = {
        ...(context() as unknown as Record<string, unknown>),
        tenantId: other[0]!.id,
      } as never;
      await expect(
        analytics().campaignBreakdown(alien, { campaignId: campaignId as never, window: WINDOW }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await sql.query("delete from public.workspaces where id = $1::uuid", [other[0]!.id]);
    }
  });
});

describe("ContentGenerator over a model", () => {
  const generator = (reply: unknown) =>
    createModelContentGenerator({
      generate: (async () => reply) as never,
      brand: async () => ({ brandName: "Acme", voice: "wry" }),
    });

  /**
   * The same generator, keeping the prompt it built.
   *
   * The harness above throws the request away, which left the prompt as untested prose — deleting the
   * sibling-hook block from it broke nothing. What a model is *told* is the whole behaviour of this
   * adapter, so at least the clauses whose wording carries a claim are checked.
   */
  const capturing = (
    reply: unknown,
    /** The rules this deployment can read, when it can — #287. */
    rules?: readonly { platformId: string; charLimit: number | null; hashtagMin: number | null; hashtagMax: number | null }[],
  ) => {
    const sent: { system?: string; prompt?: string }[] = [];
    const instance = createModelContentGenerator({
      generate: (async (input: { system: string; prompt: string }) => {
        sent.push({ system: input.system, prompt: input.prompt });
        return reply;
      }) as never,
      brand: async () => ({ brandName: "Acme", voice: "wry" }),
      ...(rules === undefined ? {} : { platformRules: async () => rules }),
    });
    return { instance, sent };
  };

  describe("a set of different formats — REQ-015 AC-2, #458", () => {
    /**
     * `repurpose` returns N captions. That is "several posts", not a multi-format set — every piece it
     * could produce was a post body, so the acceptance's *"carousel + reel script + thread"* had no way
     * to be expressed.
     *
     * What is asserted here is the **narrowing**, because that is where the judgement is: the model
     * answers one loose array with a `format` tag and optional fields, and an item that does not carry
     * what its own format needs has to be dropped rather than passed on half-built.
     */
    const set = (...items: readonly Record<string, unknown>[]) => ({ items });

    const run = async (
      reply: unknown,
      input: { posts?: number; threads?: number; scripts?: number } = {},
    ) => {
      const sent: { system?: string; prompt?: string }[] = [];
      const instance = createModelContentGenerator({
        generate: (async (call: { system: string; prompt: string }) => {
          sent.push({ system: call.system, prompt: call.prompt });
          return reply;
        }) as never,
        brand: async () => ({}),
      });
      const items = await instance.repurposeToFormats({} as never, {
        source: "A long article about coffee roasting.",
        platformIds: ["linkedin", "x"] as never,
        posts: input.posts ?? 1,
        threads: input.threads ?? 1,
        scripts: input.scripts ?? 1,
      });
      return { items, sent };
    };

    const POST = { format: "post", angle: "the cost of doing nothing", platform: "linkedin", caption: "A post." };
    const THREAD = { format: "thread", angle: "how it works", platform: "x", parts: ["One.", "Two.", "Three."] };
    const SCRIPT = {
      format: "script",
      angle: "the taste test",
      kind: "reel",
      title: "Two of eleven",
      hook: "We rejected nine of these.",
      cta: "Follow for the next lot",
      beats: [
        { onScreen: "Eleven cups", voiceover: "We cupped eleven samples.", visual: "Overhead on the cupping table", seconds: 3 },
        { onScreen: "Two made it", voiceover: "Two made it.", visual: "Close on two cups", seconds: 4 },
      ],
    };

    it("returns all three kinds from one call", async () => {
      /*
       * One call, for a sharper version of `repurpose`'s own reason: a per-format call could not tell
       * that the thread and the reel script are the same argument twice.
       */
      const { items, sent } = await run(set(POST, THREAD, SCRIPT));
      expect(sent).toHaveLength(1);
      expect(items.map((item) => item.format)).toEqual(["post", "thread", "script"]);
    });

    it("asks for the counts as an explicit manifest", async () => {
      // A model told to write "a few of each" writes posts, because posts are what it has seen most of.
      const { sent } = await run(set(POST, POST, THREAD), { posts: 2, threads: 1, scripts: 0 });
      expect(sent[0]!.prompt).toContain("Produce exactly: 2 single post(s), 1 thread(s)");
      expect(sent[0]!.prompt).not.toContain("script(s)");
    });

    it("drops a thread with fewer than two parts, rather than passing on a post", async () => {
      /**
       * `createThreadDraft` refuses one part — a thread of one is a post. Dropping it here means the
       * caller never hands something to `create_thread_draft` that it is about to reject, one step
       * later and less clearly.
       */
      const { items } = await run(set({ ...THREAD, parts: ["Only one."] }), { posts: 0, scripts: 0, threads: 1 });
      expect(items).toEqual([]);
    });

    it("drops a script with no beats, because that is a title", async () => {
      const { items } = await run(set({ ...SCRIPT, beats: [] }), { posts: 0, threads: 0, scripts: 1 });
      expect(items).toEqual([]);
    });

    it("drops a post with no caption, because that is not a short post", async () => {
      const { items } = await run(set({ ...POST, caption: "   " }), { posts: 1, threads: 0, scripts: 0 });
      expect(items).toEqual([]);
    });

    it("gives a carousel no voiceover and no seconds, whatever the model answered", async () => {
      /**
       * A carousel has no audio and no time axis. Passing those through would put a voiceover on a
       * slide — which reads as a thing to record, for a format nobody records.
       */
      const { items } = await run(
        set({ ...SCRIPT, kind: "carousel" }),
        { posts: 0, threads: 0, scripts: 1 },
      );
      const script = items[0] as { beats: readonly Record<string, unknown>[]; markdown: string };
      for (const beat of script.beats) {
        expect(beat).not.toHaveProperty("voiceover");
        expect(beat).not.toHaveProperty("seconds");
      }
      // And the rendered table drops the columns rather than leaving them empty for somebody to fill.
      expect(script.markdown).not.toContain("Voiceover");
      expect(script.markdown).toContain("| Slide |");
    });

    it("keeps voiceover and seconds on a reel", async () => {
      const { items } = await run(set(SCRIPT), { posts: 0, threads: 0, scripts: 1 });
      const script = items[0] as { beats: readonly Record<string, unknown>[]; markdown: string };
      expect(script.beats[0]).toMatchObject({ voiceover: "We cupped eleven samples.", seconds: 3 });
      expect(script.markdown).toContain("| Shot | On screen | Voiceover | Visual | Seconds |");
    });

    it("renders the markdown itself rather than asking the model for it", async () => {
      /**
       * A model asked for a document *and* a structure will eventually return a document that does not
       * match its own structure, and the document is the half a person reads. So the artifact body is
       * built from the fields, and every one of them appears in it.
       */
      const { items } = await run(set(SCRIPT), { posts: 0, threads: 0, scripts: 1 });
      const markdown = (items[0] as { markdown: string }).markdown;
      expect(markdown).toContain("# Two of eleven");
      expect(markdown).toContain("**Hook:** We rejected nine of these.");
      expect(markdown).toContain("**Call to action:** Follow for the next lot");
      expect(markdown).toContain("Overhead on the cupping table");
      // Seven seconds across two beats.
      expect(markdown).toContain("**Runtime:** about 7s");
    });

    it("omits a runtime nobody gave, rather than reporting zero", async () => {
      // "about 0s" is a measurement, and nobody took it.
      const { items } = await run(
        set({ ...SCRIPT, beats: [{ onScreen: "One beat" }] }),
        { posts: 0, threads: 0, scripts: 1 },
      );
      expect((items[0] as { markdown: string }).markdown).not.toContain("Runtime");
    });

    it("escapes a pipe so one beat cannot break the table", async () => {
      const { items } = await run(
        set({ ...SCRIPT, beats: [{ onScreen: "before | after" }] }),
        { posts: 0, threads: 0, scripts: 1 },
      );
      expect((items[0] as { markdown: string }).markdown).toContain("before \\| after");
    });

    it("clamps a platform the caller never named", async () => {
      /*
       * The same clamp `repurpose` records: a model answering "instagram" for a piece assigned to
       * LinkedIn would otherwise retarget it at a destination the workspace never chose.
       */
      const { items } = await run(set({ ...POST, platform: "instagram" }), { posts: 1, threads: 0, scripts: 0 });
      expect((items[0] as { platformId: string }).platformId).toBe("linkedin");
    });

    it("stops at the count asked for per format", async () => {
      const { items } = await run(set(POST, POST, POST), { posts: 1, threads: 0, scripts: 0 });
      expect(items).toHaveLength(1);
    });

    it("refuses a request for nothing, and an empty source", async () => {
      const instance = createModelContentGenerator({
        generate: (async () => {
          throw new Error("the model should not have been called");
        }) as never,
        brand: async () => ({}),
      });
      const none = thrown(
        await instance
          .repurposeToFormats({} as never, { source: "x", platformIds: ["x"] as never, posts: 0, threads: 0, scripts: 0 })
          .catch((e: unknown) => e),
      );
      expect(none.code).toBe("invalid_input");
      const empty = thrown(
        await instance
          .repurposeToFormats({} as never, { source: "  ", platformIds: ["x"] as never, posts: 1, threads: 0, scripts: 0 })
          .catch((e: unknown) => e),
      );
      expect(empty.code).toBe("invalid_input");
    });

    it("tells the model what makes a set a set", async () => {
      // Two items making the same point is the failure this exists to avoid, and nothing else in the
      // prompt says so.
      const { sent } = await run(set(POST));
      expect(sent[0]!.system).toContain("two items making the same point is the failure");
      expect(sent[0]!.system).toContain("never one post split at the character limit");
      expect(sent[0]!.system).toContain("autoplay silently");
    });
  });

  describe("researched hashtags — REQ-016 AC-2", () => {
    /**
     * *"Hashtags researched (search-backed), relevance-ranked, not invented."*
     *
     * The hard part is that "not invented" is invisible in the output: `#coffee` looks identical
     * whether it came from a live search or from the model's idea of what coffee people write. So the
     * assertions here are about the **prompt** — what the model is told when there are findings and
     * what it is told when there are none — and about the rationale, which is the only thing a person
     * can check the claim against.
     */
    const reply = {
      hashtags: [
        { tag: "#SpringLot", rationale: "the finding names the spring lot release" },
        { tag: "coffee", rationale: "the category" },
      ],
    };

    const FINDINGS = [{ title: "Spring lots arriving", snippet: "Roasters are announcing spring lots." }];

    it("tells a grounded run that every tag must trace to a finding", async () => {
      const { instance, sent } = capturing(reply);
      await instance.deriveHashtags({} as never, { topic: "spring coffee", count: 5, findings: FINDINGS });
      expect(sent[0]!.system).toContain("Every tag must be traceable to the findings");
      expect(sent[0]!.system).toContain("Do not add tags the findings do not support");
      expect(sent[0]!.prompt).toContain("Spring lots arriving");
    });

    it("tells an ungrounded run to stop claiming anything is trending", async () => {
      /**
       * The failure this prevents. A model handed no findings and told to "stay grounded in them"
       * produces a confident list with a rationale that invents a source — so the *instruction*
       * changes, not just the findings block. An ungrounded list that reads as researched is worse
       * than either a researched one or an honest guess.
       */
      const { instance, sent } = capturing(reply);
      await instance.deriveHashtags({} as never, { topic: "spring coffee", count: 5, findings: [] });
      expect(sent[0]!.system).toContain("You have NO live search results");
      expect(sent[0]!.system).toContain("do not claim any tag is trending");
      expect(sent[0]!.system).not.toContain("traceable to the findings");
    });

    it("ranks for reach rather than volume, which is the judgement REQ-016 leaves open", async () => {
      // A tag with ten million posts buries a small brand. That is a choice, and it is in the prompt
      // where it can be argued with rather than implied by a score nobody can see.
      const { instance, sent } = capturing(reply);
      await instance.deriveHashtags({} as never, { topic: "coffee", count: 3, findings: [] });
      expect(sent[0]!.system).toContain("not by how many posts already use it");
      expect(sent[0]!.system).toContain("Prefer specific over generic");
    });

    it("normalises what the model wrote rather than refusing it", async () => {
      /*
       * A model writing `spring lot` has done the useful part and failed the punctuation. Failing the
       * whole batch over a missing `#` loses the research; normalising costs a regex.
       */
      const { instance } = capturing({
        hashtags: [
          { tag: "spring lot", rationale: "a" },
          { tag: "# coffee ", rationale: "b" },
          { tag: "#Roast-Profile", rationale: "c" },
        ],
      });
      const tags = await instance.deriveHashtags({} as never, { topic: "coffee", count: 5, findings: [] });
      expect(tags.map((t) => t.tag)).toEqual(["#springlot", "#coffee", "#RoastProfile"]);
    });

    it("drops a tag that normalises to nothing rather than returning a bare hash", async () => {
      const { instance } = capturing({ hashtags: [{ tag: "!!!", rationale: "a" }, { tag: "coffee", rationale: "b" }] });
      const tags = await instance.deriveHashtags({} as never, { topic: "coffee", count: 5, findings: [] });
      expect(tags.map((t) => t.tag)).toEqual(["#coffee"]);
    });

    it("deduplicates case-insensitively, because platforms do", async () => {
      // `#Coffee` and `#coffee` are one hashtag everywhere, and two of them in a list of eight is a
      // wasted slot.
      const { instance } = capturing({
        hashtags: [
          { tag: "#Coffee", rationale: "a" },
          { tag: "coffee", rationale: "b" },
          { tag: "#espresso", rationale: "c" },
        ],
      });
      const tags = await instance.deriveHashtags({} as never, { topic: "coffee", count: 5, findings: [] });
      expect(tags.map((t) => t.tag)).toEqual(["#Coffee", "#espresso"]);
    });

    it("keeps the order the model returned, because the order is the ranking", async () => {
      const { instance } = capturing({
        hashtags: [
          { tag: "first", rationale: "a" },
          { tag: "second", rationale: "b" },
          { tag: "third", rationale: "c" },
        ],
      });
      const tags = await instance.deriveHashtags({} as never, { topic: "coffee", count: 3, findings: [] });
      expect(tags.map((t) => t.tag)).toEqual(["#first", "#second", "#third"]);
    });

    it("stops at the count asked for, and at the ceiling", async () => {
      const many = { hashtags: Array.from({ length: 40 }, (_unused, i) => ({ tag: `tag${i}`, rationale: "r" })) };
      const { instance } = capturing(many);
      expect(await instance.deriveHashtags({} as never, { topic: "c", count: 3, findings: [] })).toHaveLength(3);
      const { instance: second } = capturing(many);
      expect(await second.deriveHashtags({} as never, { topic: "c", count: 99, findings: [] })).toHaveLength(MAX_HASHTAGS);
    });

    it("states the platform's own hashtag bounds when one was named", async () => {
      // ShareFlow's instagram rule requires five. A list of two is not a shorter answer, it is one
      // that fails validation for a reason nobody was given.
      const { instance, sent } = capturing(reply, [
        { platformId: "instagram", charLimit: 2200, hashtagMin: 5, hashtagMax: 12 },
      ]);
      await instance.deriveHashtags({} as never, {
        topic: "coffee",
        count: 8,
        platformId: "instagram" as never,
        findings: [],
      });
      expect(sent[0]!.prompt).toContain("Platform: instagram");
      expect(sent[0]!.prompt).toContain("5-12 hashtags");
    });

    it("refuses an empty topic before calling the model", async () => {
      const instance = createModelContentGenerator({
        generate: (async () => {
          throw new Error("the model should not have been called");
        }) as never,
        brand: async () => ({}),
      });
      const error = thrown(
        await instance.deriveHashtags({} as never, { topic: "  ", count: 3, findings: [] }).catch((e: unknown) => e),
      );
      expect(error.code).toBe("invalid_input");
    });
  });

  describe("alternatives, scored and refined — REQ-014", () => {
    /**
     * The quality loop. `/api/ai/generate` has accepted `variants: 1..5` since REQ-014 was specced and
     * the adapter **refused** anything above 1 — an honest refusal, and a shipped option in the
     * composer that failed every time somebody ticked it.
     *
     * These tests drive the model through a scripted sequence of replies, so each call's *purpose* is
     * assertable: write, score, refine, re-score. A stub returning one canned answer would make the
     * whole loop look like it ran.
     */
    const run = async (
      replies: readonly unknown[],
      input: { count?: number } = {},
    ) => {
      const sent: { system?: string; prompt?: string }[] = [];
      let index = 0;
      const instance = createModelContentGenerator({
        generate: (async (call: { system: string; prompt: string }) => {
          sent.push({ system: call.system, prompt: call.prompt });
          const reply = replies[Math.min(index, replies.length - 1)];
          index += 1;
          return reply;
        }) as never,
        brand: async () => ({ brandName: "Acme" }),
      });
      const drafts = await instance.draftAlternatives({} as never, {
        brief: "the new opening hours",
        platformId: "linkedin" as never,
        count: input.count ?? 3,
      });
      return { drafts, sent, calls: index };
    };

    const drafts = (...captions: readonly string[]) => ({ drafts: captions.map((caption) => ({ caption })) });
    const scores = (...rows: readonly [number, number, number, number][]) => ({
      scores: rows.map(([hook, onBrand, cta, platformFit], index) => ({
        index,
        hook,
        onBrand,
        cta,
        platformFit,
        critique: `critique ${index}`,
      })),
    });

    it("writes, scores, refines and re-scores — four calls for a good first round", async () => {
      const { drafts: out, calls } = await run([
        drafts("A.", "B.", "C."),
        scores([9, 9, 9, 9], [7, 7, 7, 7], [5, 5, 5, 5]),
        { caption: "A, sharpened." },
        scores([10, 10, 10, 10]),
      ]);
      expect(calls, "write + score + refine + re-score").toBe(4);
      expect(out).toHaveLength(3);
      expect(out[0]?.caption).toBe("A, sharpened.");
      expect(out[0]?.refined).toBe(true);
    });

    it("ranks by the mean of the four rubric dimensions", async () => {
      const { drafts: out } = await run([
        drafts("low.", "high."),
        // 2/10 mean against 8/10 — the second must come first.
        scores([2, 2, 2, 2], [8, 8, 8, 8]),
        { caption: "high, sharpened." },
        scores([1, 1, 1, 1]),
      ]);
      expect(out.map((draft) => draft.overall)).toEqual([8, 2]);
      expect(out[0]?.scores).toEqual({ hook: 8, onBrand: 8, cta: 8, platformFit: 8 });
    });

    it("discards a refinement that scored worse, rather than reporting it as an improvement", async () => {
      /**
       * A model asked to improve something always returns something different. Returning that as "the
       * refined one" without re-scoring is how a quality loop makes captions worse while reporting
       * that it improved them — and nothing downstream could tell.
       */
      const { drafts: out } = await run([
        drafts("good.", "bad."),
        scores([8, 8, 8, 8], [4, 4, 4, 4]),
        { caption: "worse." },
        scores([3, 3, 3, 3]),
      ]);
      expect(out.map((draft) => draft.caption)).toEqual(["good.", "bad."]);
      expect(out.every((draft) => !draft.refined)).toBe(true);
    });

    it("tells the refinement pass which dimension was weakest, not just to try harder", async () => {
      /*
       * A refinement given "make this better" rewrites; given "the ask is vague" it fixes the ask.
       * The weakest dimension is the one the critique is about.
       */
      const { sent } = await run([
        drafts("A."),
        scores([9, 9, 2, 9]),
        { caption: "A, with an ask." },
        scores([10, 10, 10, 10]),
      ]);
      expect(sent[2]!.prompt).toContain("weakest on cta (2/10)");
      expect(sent[2]!.prompt).toContain("critique 0");
      expect(sent[2]!.system).toContain("a rewrite is not a refinement");
    });

    it("re-drafts once when the best is below the floor, and never twice", async () => {
      /**
       * AC-4's quality floor. Exactly one extra round: a loop that retried until it cleared the floor
       * would spend a workspace's credits on a brief the model cannot do well.
       */
      const { sent, calls, drafts: out } = await run([
        drafts("weak."),
        scores([3, 3, 3, 3]),
        drafts("second try."),
        scores([4, 4, 4, 4]),
        { caption: "refined." },
        scores([5, 5, 5, 5]),
      ]);
      expect(calls, "write, score, re-write, re-score, refine, re-score").toBe(6);
      // The second round is told what the first one's critiques were — a re-draft, not a re-roll.
      expect(sent[2]!.prompt).toContain("A first attempt scored below the bar");
      expect(sent[2]!.prompt).toContain("critique 0");
      // Both rounds survive into the ranking: the user gets a better choice, not a different one.
      expect(out.map((draft) => draft.caption)).toContain("weak.");
      expect(out.map((draft) => draft.caption)).toContain("refined.");
    });

    it("does not re-draft when the first round clears the floor", async () => {
      const { calls } = await run([
        drafts("fine."),
        scores([7, 7, 7, 7]),
        { caption: "better." },
        scores([8, 8, 8, 8]),
      ]);
      expect(calls).toBe(4);
    });

    it("drops a candidate the rubric skipped rather than inventing a score for it", async () => {
      /*
       * A zero ranks an unjudged caption last and a five ranks it in the middle; both are inventions
       * the picker would present as the rubric's opinion. Losing a candidate is the honest outcome.
       */
      const { drafts: out } = await run([
        drafts("judged.", "skipped."),
        { scores: [{ index: 0, hook: 8, onBrand: 8, cta: 8, platformFit: 8, critique: "fine" }] },
        { caption: "judged, sharpened." },
        { scores: [{ index: 0, hook: 9, onBrand: 9, cta: 9, platformFit: 9, critique: "better" }] },
      ]);
      expect(out.map((draft) => draft.caption)).toEqual(["judged, sharpened."]);
    });

    it("keeps the first opinion when the rubric scores one caption twice", async () => {
      /*
       * A model that scores the same caption twice has two opinions about it and no way to say which
       * it meant. Taking the later one would make the ranking depend on the order it happened to emit.
       */
      const { drafts: out } = await run([
        drafts("A.", "B."),
        {
          scores: [
            { index: 0, hook: 9, onBrand: 9, cta: 9, platformFit: 9, critique: "first" },
            { index: 0, hook: 1, onBrand: 1, cta: 1, platformFit: 1, critique: "second" },
            { index: 1, hook: 5, onBrand: 5, cta: 5, platformFit: 5, critique: "b" },
          ],
        },
        { caption: "A+." },
        scores([2, 2, 2, 2]),
      ]);
      expect(out.map((draft) => draft.overall)).toEqual([9, 5]);
      expect(out[0]?.critique).toBe("first");
    });

    it("caps what it asks for, however many the caller wanted", async () => {
      // `/api/ai/generate` already clamped `variants` to five; a picker with more is a worse choice.
      const { sent } = await run([drafts("A."), scores([8, 8, 8, 8]), { caption: "A+." }, scores([9, 9, 9, 9])], {
        count: 99,
      });
      expect(sent[0]!.prompt).toContain(`Write ${MAX_ALTERNATIVES} alternative captions.`);
    });

    it("asks for different approaches, not different wordings", async () => {
      const { sent } = await run([drafts("A."), scores([8, 8, 8, 8]), { caption: "A+." }, scores([9, 9, 9, 9])]);
      expect(sent[0]!.system).toContain("a different argument, a different opening, a different ask");
      expect(sent[0]!.system).toContain("not one caption reworded");
    });

    it("scores every candidate in one call, so the ranking is a comparison", async () => {
      /*
       * A rubric applied one caption at a time has nothing to compare against, and the scores drift
       * between calls in a way that makes the ranking meaningless.
       */
      const { sent } = await run([
        drafts("A.", "B.", "C."),
        scores([8, 8, 8, 8], [7, 7, 7, 7], [6, 6, 6, 6]),
        { caption: "A+." },
        scores([9, 9, 9, 9]),
      ]);
      expect(sent[1]!.prompt).toContain("[0] A.");
      expect(sent[1]!.prompt).toContain("[1] B.");
      expect(sent[1]!.prompt).toContain("[2] C.");
    });

    it("refuses an empty brief before calling the model", async () => {
      const instance = createModelContentGenerator({
        generate: (async () => {
          throw new Error("the model should not have been called");
        }) as never,
        brand: async () => ({}),
      });
      const error = thrown(
        await instance
          .draftAlternatives({} as never, { brief: "   ", platformId: "linkedin" as never, count: 3 })
          .catch((e: unknown) => e),
      );
      expect(error.code).toBe("invalid_input");
    });

    it("fails rather than returning nothing when the rubric judged none of them", async () => {
      const instance = createModelContentGenerator({
        generate: (async (call: { prompt: string }) =>
          call.prompt.includes("Score each") ? { scores: [{ index: 9, hook: 1, onBrand: 1, cta: 1, platformFit: 1, critique: "x" }] } : drafts("A.")) as never,
        brand: async () => ({}),
      });
      const error = thrown(
        await instance
          .draftAlternatives({} as never, { brief: "a brief", platformId: "linkedin" as never, count: 2 })
          .catch((e: unknown) => e),
      );
      expect(error.code).toBe("provider_error");
    });
  });

  describe("the voice corpus in the prompt — REQ-013 AC-2", () => {
    /**
     * The half of REQ-013 that never reached generation.
     *
     * `listVoiceExamples`, the corpus, the exemplar toggle and the coverage selector all existed, and
     * `shareflow.examples` put the examples in front of the **conversational assistant** on every
     * turn. `generate_content` and `generate_campaign` are tools: invoked directly by the compose
     * screen and the campaign route, with no prompt assembly and so no context providers. The
     * captions the product actually writes were the ones that never saw the corpus.
     */
    const reply = { variants: [{ platformId: "x", caption: "short" }] };

    const withExamples = (examples: readonly { excerpt: string; source?: "manual" | "auto_top" }[]) => {
      const sent: { system?: string; prompt?: string }[] = [];
      const instance = createModelContentGenerator({
        generate: (async (input: { system: string; prompt: string }) => {
          sent.push({ system: input.system, prompt: input.prompt });
          return reply;
        }) as never,
        brand: async () => ({ brandName: "Acme", voice: "wry" }),
        voiceExamples: async () => examples as never,
      });
      return { instance, sent };
    };

    it("shows the workspace's own posts to the caption writer", async () => {
      const { instance, sent } = withExamples([{ excerpt: "We shipped the new roasting profile.", source: "manual" }]);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).toContain("We shipped the new roasting profile.");
    });

    it("says to match the voice and not the subject", async () => {
      /*
       * Without this the strongest signal in the prompt is three posts about coffee, and the model
       * writes a fourth post about coffee whatever the brief said. Nothing else tells it what the
       * examples are for.
       */
      const { instance, sent } = withExamples([{ excerpt: "A post.", source: "manual" }]);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).toMatch(/Match their VOICE/);
      expect(sent[0]!.prompt).toMatch(/not their subject matter/);
    });

    it("labels a chosen post differently from a well-performing one", async () => {
      /*
       * "This is how we want to sound" and "this is what worked" are different claims. Presented
       * identically, the model imitates a viral post as though the workspace had endorsed its voice.
       */
      const { instance, sent } = withExamples([
        { excerpt: "The one we picked.", source: "manual" },
        { excerpt: "The one that did well.", source: "auto_top" },
      ]);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).toContain("The one we picked. (chosen as an example of this brand's voice)");
      expect(sent[0]!.prompt).toContain("The one that did well. (one of this workspace's best-performing posts)");
    });

    it("puts each example on one line, however the post was written", async () => {
      // A multi-line excerpt inside a bulleted list reads as several examples.
      const { instance, sent } = withExamples([{ excerpt: "First line.\n\nSecond line.", source: "manual" }]);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).toContain("- First line. Second line.");
    });

    it("says nothing at all when the corpus is empty", async () => {
      /*
       * REQ-013 AC-5's cold start, arriving by another route. A model told a section is empty
       * sometimes writes about the emptiness; the brand profile above is the answer for a workspace
       * with no corpus.
       */
      const { instance, sent } = withExamples([]);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).not.toContain("Posts this workspace has written");
    });

    it("works without a corpus reader at all, rather than failing", async () => {
      // A deployment with no reader degrades to the brand profile — it does not crash generation.
      const { instance, sent } = capturing(reply);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).not.toContain("Posts this workspace has written");
    });

    it("asks the corpus per call, so ticking the box changes the next caption", async () => {
      let asked = 0;
      const instance = createModelContentGenerator({
        generate: (async () => reply) as never,
        brand: async () => ({}),
        voiceExamples: async () => {
          asked += 1;
          return [];
        },
      });
      await instance.generate({} as never, { brief: "a", platformIds: ["x"] as never, avoid: [] });
      await instance.generate({} as never, { brief: "b", platformIds: ["x"] as never, avoid: [] });
      expect(asked).toBe(2);
    });
  });

  describe("the funnel stage in the prompt — REQ-018", () => {
    const reply = { variants: [{ platformId: "x", caption: "short" }] };

    it("tells the caption what its stage is *for*, not just its name", async () => {
      /*
       * "Conversion" is a word a model nods at and then writes the same mid-funnel explainer it was
       * going to write anyway. The instruction has to be the behaviour — *ask for the decision now* —
       * or the stage is a label that changes nothing about the output.
       */
      const { instance, sent } = capturing(reply);
      await instance.generate({} as never, {
        brief: "launch",
        platformIds: ["x"] as never,
        avoid: [],
        step: { stage: "conversion" },
      });
      expect(sent[0]!.prompt).toContain("Funnel stage: conversion");
      expect(sent[0]!.prompt).toContain("ask for the decision now");
    });

    it("passes the playbook's wording as a suggestion, not as the sentence to write", async () => {
      // A model handed "Tease the problem you solve" as a command writes that line rather than a post
      // about the campaign's actual subject.
      const { instance, sent } = capturing(reply);
      await instance.generate({} as never, {
        brief: "launch",
        platformIds: ["x"] as never,
        avoid: [],
        step: { stage: "awareness", angle: "Tease the problem you solve", cta: "Follow for the reveal" },
      });
      expect(sent[0]!.prompt).toMatch(/adapt it to the subject, do not quote it\): Tease the problem you solve/);
      expect(sent[0]!.prompt).toContain("Suggested call to action: Follow for the reveal");
    });

    it("names an unrecognised stage rather than dropping it", async () => {
      /*
       * `posts.funnel_stage` takes four values today and could take a fifth before the intent map
       * does. The stage name alone is weaker guidance than a sentence and far better than silently
       * discarding the only strategy the caller supplied.
       */
      const { instance, sent } = capturing(reply);
      await instance.generate({} as never, {
        brief: "launch",
        platformIds: ["x"] as never,
        avoid: [],
        step: { stage: "advocacy" as never },
      });
      expect(sent[0]!.prompt).toContain("Funnel stage: advocacy");
    });

    it("says nothing about a funnel when the post has no stage", async () => {
      // A one-off post has no funnel position, and a campaign with no plan does not invent one.
      const { instance, sent } = capturing(reply);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).not.toContain("Funnel stage");
    });

    it("shows the planner the whole sequence in order, numbered from one", async () => {
      /**
       * AC-3 is about the sequence, and the sequence is decided where the angles are proposed. The
       * planner needs all N slots together: an angle for position 3 should not repeat the argument
       * position 2 is making, which is only visible when it can see both.
       */
      const { instance, sent } = capturing({ angles: [{ label: "a", rationale: "b" }] });
      await instance.proposeAngles({} as never, {
        brief: "launch",
        count: 3,
        steps: [{ stage: "awareness" }, { stage: "consideration" }, { stage: "conversion", cta: "Claim it now" }],
      });
      const prompt = sent[0]!.prompt!;
      expect(prompt).toContain("1. awareness");
      expect(prompt).toContain("2. consideration");
      expect(prompt).toContain("3. conversion");
      expect(prompt).toContain("Call to action: Claim it now.");
      // In order in the prompt, not merely all present.
      expect(prompt.indexOf("1. awareness")).toBeLessThan(prompt.indexOf("3. conversion"));
    });

    it("leaves the planner's prompt alone when there is no plan", async () => {
      const { instance, sent } = capturing({ angles: [{ label: "a", rationale: "b" }] });
      await instance.proposeAngles({} as never, { brief: "launch", count: 3 });
      expect(sent[0]!.prompt).not.toContain("This campaign is a sequence");
    });
  });

  describe("the limits the caption will be judged by — #287", () => {
    const RULES = [
      { platformId: "x", charLimit: 280, hashtagMin: 1, hashtagMax: 3 },
      { platformId: "instagram", charLimit: 2200, hashtagMin: 5, hashtagMax: 12 },
    ];
    const reply = { variants: [{ platformId: "x", caption: "short" }] };

    it("tells the model each platform's own bounds", async () => {
      /*
       * The generator was told `Platforms: x` and nothing else, so it wrote blind and discovered 280
       * characters by failing validation — two model calls for every X caption, and a first draft the
       * product already knew was wrong.
       */
      const { instance, sent } = capturing(reply, RULES);
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(sent[0]!.prompt).toContain("at most 280 characters");
    });

    it("states the hashtag minimum, not only the maximum", async () => {
      /*
       * ShareFlow's shipped instagram rule requires **five**. A model told nothing writes two and
       * fails for a reason it was never given, which is the case the repair loop burns attempts on.
       */
      const { instance, sent } = capturing(
        { variants: [{ platformId: "instagram", caption: "hi" }] },
        RULES,
      );
      await instance.generate({} as never, { brief: "launch", platformIds: ["instagram"] as never, avoid: [] });
      expect(sent[0]!.prompt).toContain("5-12 hashtags");
    });

    it("says nothing about a platform with no rule, rather than inviting an invented one", async () => {
      // `threads` is unseeded. Naming it with no bound is how a model decides on one itself.
      const { instance, sent } = capturing({ variants: [{ platformId: "threads", caption: "hi" }] }, RULES);
      await instance.generate({} as never, { brief: "launch", platformIds: ["threads"] as never, avoid: [] });
      expect(sent[0]!.prompt).not.toContain("Write each caption within");
    });

    it("asks for the rules of the platforms in this call, and no others", async () => {
      let asked: readonly string[] = [];
      const instance = createModelContentGenerator({
        generate: (async () => reply) as never,
        brand: async () => ({ brandName: "Acme", voice: "wry" }),
        platformRules: async (_ctx, platformIds) => {
          asked = platformIds;
          return RULES;
        },
      });
      await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(asked).toEqual(["x"]);
    });

    it("still generates for a deployment that cannot read rules at all", async () => {
      /*
       * Optional on purpose: a deployment without the reader degrades to the old behaviour — written
       * blind, corrected by the repair loop — rather than failing to generate.
       */
      const { instance, sent } = capturing(reply);
      const out = await instance.generate({} as never, { brief: "launch", platformIds: ["x"] as never, avoid: [] });
      expect(out).toHaveLength(1);
      expect(sent[0]!.prompt).not.toContain("Write each caption within");
    });
  });

  describe("a repurposed piece is bounded too — #283", () => {
    const RULES = [{ platformId: "x", charLimit: 280, hashtagMin: 1, hashtagMax: 3 }];

    it("tells the model the limits of the platforms it is spreading across", async () => {
      /*
       * `generate` writes blind and the repair loop corrects it. A repurposed piece has **no such
       * loop** — `repurpose_source` returns the pieces and saves nothing — so an X piece written at
       * 2,000 characters reaches the user looking finished and fails only at publish, after they
       * have chosen it.
       */
      const { instance, sent } = capturing(
        { pieces: [{ angle: "a", platform: "x", caption: "short" }] },
        RULES,
      );
      await instance.repurpose({} as never, {
        source: "a long article about coffee",
        count: 1,
        platformIds: ["x"] as never,
      });
      expect(sent[0]!.prompt).toContain("at most 280 characters");
    });

    it("keeps the source in the prompt after the bounds, not instead of it", async () => {
      // A truncation bug here would silently drop the thing being repurposed.
      const { instance, sent } = capturing(
        { pieces: [{ angle: "a", platform: "x", caption: "short" }] },
        RULES,
      );
      await instance.repurpose({} as never, {
        source: "a long article about coffee",
        count: 1,
        platformIds: ["x"] as never,
      });
      expect(sent[0]!.prompt).toContain("a long article about coffee");
      const prompt = sent[0]!.prompt!;
      expect(prompt.indexOf("at most 280")).toBeLessThan(prompt.indexOf("SOURCE:"));
    });

    it("still repurposes for a deployment that cannot read rules", async () => {
      const { instance } = capturing({ pieces: [{ angle: "a", platform: "x", caption: "short" }] });
      const out = await instance.repurpose({} as never, {
        source: "a long article",
        count: 1,
        platformIds: ["x"] as never,
      });
      expect(out).toHaveLength(1);
    });
  });

  it("returns only the platforms that were asked for", async () => {
    /**
     * A model that invents a platform would otherwise reach the caller. The duplicate case is the dangerous
     * one: a workflow taking "the caption for instagram" would silently get whichever came first.
     */
    const variants = await generator({
      variants: [
        { platformId: "instagram", caption: "first" },
        { platformId: "instagram", caption: "second" },
        { platformId: "tiktok", caption: "not asked for" },
      ],
    }).generate({} as never, { brief: "launch", platformIds: ["instagram"] as never, avoid: [] });
    expect(variants).toEqual([{ platformId: "instagram", caption: "first" }]);
  });

  it("fails rather than returning an empty caption for a skipped platform", async () => {
    // An empty string would flow into a draft and publish as a blank post.
    await expect(
      generator({ variants: [{ platformId: "tiktok", caption: "x" }] }).generate({} as never, {
        brief: "launch",
        platformIds: ["instagram"] as never,
        avoid: [],
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("names sibling hooks as a constraint, not as a rejection", async () => {
    /**
     * `avoidHooks` and `avoid` render differently, and they must. `avoid` says *"The previous attempt
     * was rejected. Do not repeat these"*, which is true of a repair and **false of a sibling** —
     * nothing of this post's has been written yet. Telling a model its work was rejected when it was
     * not is a misleading prompt, and the old runtime kept the two apart for the same reason: its
     * block reads "Do NOT reuse these hooks from sibling posts".
     */
    const { instance, sent } = capturing({ variants: [{ platformId: "instagram", caption: "c" }] });
    await instance.generate({} as never, {
      brief: "launch",
      platformIds: ["instagram"] as never,
      avoid: [],
      avoidHooks: ["the price is the story", "nobody reads pricing pages"],
    });
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt).toContain("Do NOT reuse these hooks from sibling posts");
    expect(prompt).toContain("the price is the story");
    expect(prompt).toContain("nobody reads pricing pages");
    // And emphatically not the repair wording.
    expect(prompt).not.toContain("was rejected");
  });

  it("says nothing about siblings when there are none", async () => {
    // A single post has no siblings, and an empty "do not reuse:" line invites a model to wonder what
    // it is being warned about.
    const { instance, sent } = capturing({ variants: [{ platformId: "instagram", caption: "c" }] });
    await instance.generate({} as never, { brief: "launch", platformIds: ["instagram"] as never, avoid: [], avoidHooks: [] });
    expect(sent[0]?.prompt).not.toContain("sibling");

    const blank = capturing({ variants: [{ platformId: "instagram", caption: "c" }] });
    await blank.instance.generate({} as never, {
      brief: "launch",
      platformIds: ["instagram"] as never,
      avoid: [],
      avoidHooks: ["", "   "],
    });
    expect(blank.sent[0]?.prompt, "blank hooks are not hooks").not.toContain("sibling");
  });

  it("keeps the repair wording for a real rejection", async () => {
    // The other half: `avoid` must still read as a rejection, because that is what it is.
    const { instance, sent } = capturing({ variants: [{ platformId: "instagram", caption: "c" }] });
    await instance.generate({} as never, {
      brief: "launch",
      platformIds: ["instagram"] as never,
      avoid: [{ code: "forbidden_claim", message: 'the claim "cures" is not allowed' }] as never,
    });
    expect(sent[0]?.prompt).toContain("The previous attempt was rejected");
    expect(sent[0]?.prompt).toContain('the claim "cures" is not allowed');
  });

  it("clamps a format it cannot render rather than losing the idea", async () => {
    /**
     * The old runtime's rule, transcribed: *"`format` is clamped to text/image/video … so a drifting
     * model can't suggest platforms the workspace doesn't have."* A model answering "reel" or "carousel"
     * is answering sensibly in the vernacular and the product has three formats; clamping keeps the
     * idea and loses only the label, which is the right trade for advisory output.
     */
    const ideas = await generator({
      ideas: [
        { angle: "a", hook: "h", cta: "c", format: "reel", channels: ["instagram"] },
        { angle: "b", hook: "h", cta: "c", format: "video", channels: ["instagram"] },
      ],
    }).suggestIdeas({} as never, { theme: "packaging", count: 2, channels: ["instagram"], trends: [] });
    expect(ideas.map((idea) => idea.format)).toEqual(["text", "video"]);
  });

  it("drops channels the workspace does not have, and keeps the ones it does", async () => {
    /**
     * The safety-relevant half. An idea recommending Threads to a workspace with no Threads account
     * sends a person off to connect one on the strength of a model's guess.
     */
    const ideas = await generator({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: ["linkedin", "threads"] }],
    }).suggestIdeas({} as never, { theme: "packaging", count: 1, channels: ["linkedin"], trends: [] });
    expect(ideas[0]?.channels).toEqual(["linkedin"]);
  });

  it("matches a channel the model capitalised, rather than filtering a right answer away", async () => {
    /**
     * The ids arrive lower-cased from `platformList` and a model handed "linkedin" may answer
     * "LinkedIn". An exact-match filter fails closed on a *correct* channel, which looks to the reader
     * exactly like the workspace not having it — worse than the drift the filter exists to catch.
     */
    const ideas = await generator({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: ["LinkedIn"] }],
    }).suggestIdeas({} as never, { theme: "packaging", count: 1, channels: ["linkedin"], trends: [] });
    // Returned under the caller's own id, so it can be used as a key.
    expect(ideas[0]?.channels).toEqual(["linkedin"]);
  });

  it("leaves channels alone when the caller named none", async () => {
    // An unresolved account list is not "no channels" — see the tool's schema.
    const ideas = await generator({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: ["threads"] }],
    }).suggestIdeas({} as never, { theme: "packaging", count: 1, channels: [], trends: [] });
    expect(ideas[0]?.channels).toEqual(["threads"]);
  });

  it("tells the model not to invent specifics beyond the findings it was given", async () => {
    /**
     * The instruction the old runtime attached to its trends block, and the clause that matters: a model
     * handed three real findings will otherwise produce a fourth statistic in the same register.
     */
    const { instance, sent } = capturing({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: [] }],
    });
    await instance.suggestIdeas({} as never, {
      theme: "packaging",
      count: 1,
      channels: [],
      trends: [{ title: "Refill schemes grow", snippet: "Refill pilots doubled in 2026." }],
    });
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt).toContain("do not fabricate specifics beyond these");
    expect(prompt).toContain("Refill pilots doubled in 2026.");
  });

  it("says nothing about a search when there were no findings", async () => {
    // An empty "current findings:" heading is an invitation to fill it in.
    const { instance, sent } = capturing({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: [] }],
    });
    await instance.suggestIdeas({} as never, { theme: "packaging", count: 1, channels: [], trends: [] });
    expect(sent[0]?.prompt).not.toContain("web search");
  });

  it("does not write the posts, and says so", async () => {
    /**
     * The distinction between this and `generate_campaign`: ideas are for a person to write. A system
     * prompt that did not say so produces captions, and the caller has no field to put them in.
     */
    const { instance, sent } = capturing({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: [] }],
    });
    await instance.suggestIdeas({} as never, { theme: "packaging", count: 1, channels: [], trends: [] });
    expect(sent[0]?.system).toContain("The HUMAN will write every post themselves");
    expect(sent[0]?.system).toContain("do not write the posts");
    // And the brand still reaches it — ideas off-voice are ideas nobody will use.
    expect(sent[0]?.system).toContain("Acme");
  });

  it("asks for channels from the allowed list as well as enforcing it", async () => {
    /**
     * The clamp is the guarantee; this is what stops it having to fire. A model that was never told to
     * pick from the workspace's ids produces channels that are all filtered away, and an idea with an
     * empty channel list is a worse answer than a wrong one.
     */
    const { instance, sent } = capturing({
      ideas: [{ angle: "a", hook: "h", cta: "c", format: "text", channels: ["linkedin"] }],
    });
    await instance.suggestIdeas({} as never, { theme: "packaging", count: 1, channels: ["linkedin"], trends: [] });
    expect(sent[0]?.system).toContain("Pick `channels` ONLY from the allowed platform ids");
    // And the list itself reaches the prompt, or the instruction refers to nothing.
    expect(sent[0]?.prompt).toContain("Allowed platform ids: linkedin");
  });

  it("trims ideas to the count asked for and refuses an empty theme", async () => {
    const ideas = await generator({
      ideas: [
        { angle: "a", hook: "h", cta: "c", format: "text", channels: [] },
        { angle: "b", hook: "h", cta: "c", format: "text", channels: [] },
        { angle: "c", hook: "h", cta: "c", format: "text", channels: [] },
      ],
    }).suggestIdeas({} as never, { theme: "packaging", count: 2, channels: [], trends: [] });
    expect(ideas).toHaveLength(2);

    await expect(
      generator({}).suggestIdeas({} as never, { theme: "   ", count: 2, channels: [], trends: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("omits an empty tip rather than carrying a blank field", async () => {
    // A UI rendering "Tip:" with nothing after it reads as a truncated answer.
    const ideas = await generator({
      ideas: [
        { angle: "a", hook: "h", cta: "c", format: "text", channels: [], tip: "   " },
        { angle: "b", hook: "h", cta: "c", format: "text", channels: [], tip: "Post it on a Tuesday." },
      ],
    }).suggestIdeas({} as never, { theme: "packaging", count: 2, channels: [], trends: [] });
    expect(ideas[0]?.tip).toBeUndefined();
    expect(ideas[1]?.tip).toBe("Post it on a Tuesday.");
  });

  /** A measured fact and an unmeasured one, in the port's shape. */
  const fact = (metric: string, v: number, unit: "count" | "fraction" = "count") => ({
    metric,
    unit,
    window: { fromDay: "2026-08-01", toDay: "2026-08-31" },
    value: v,
    derivedFrom: { recordType: "post_metrics" as const, recordCount: 1 },
  });
  const noFact = (metric: string, unit: "count" | "fraction" = "count") => ({
    metric,
    unit,
    window: { fromDay: "2026-08-01", toDay: "2026-08-31" },
    unavailable: "not-collected" as const,
  });

  const post = (over: Record<string, unknown> = {}) => ({
    draftId: asId<PostDraftId>("d1"),
    excerpt: "a post",
    platforms: ["linkedin"],
    publishedDestinations: 1,
    facts: [fact("impressions", 1_000), fact("engagement_rate", 0.0123, "fraction")],
    ...over,
  });

  it("writes an unmeasured metric as not measured, never as zero", async () => {
    /**
     * The defect this whole union exists to prevent, now on the prompt side: *"an assistant handed `0`
     * will report 'engagement was 0%' when the truth is 'nothing was measured'"*. The old block could
     * only print numbers, so it had no way to say this.
     */
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, {
      theme: "packaging",
      totals: [noFact("impressions"), noFact("engagement_rate", "fraction")],
      posts: [post({ facts: [noFact("impressions")] })],
    });
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt).toContain("impressions not measured");
    expect(prompt).not.toMatch(/impressions 0\b/);
    // And the system prompt says what to do with it, or the model averages it in as a zero anyway.
    expect(sent[0]?.system).toContain("say that it was not measured rather than treating it as zero");
  });

  it("counts the posts that never went out instead of dropping them silently", async () => {
    /**
     * The old block filtered them away, and that is the one place this departs from it on purpose.
     * Dropped, the totals read as the whole campaign: an evaluation of one published post out of three
     * looks like an evaluation of three, and *"what to change next time"* misses the largest thing that
     * went wrong.
     *
     * Counted, not listed. There is nothing to say about each unsent post, and a per-post line of
     * absences invites "this one underperformed" about a post nobody ever saw.
     */
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, {
      theme: "packaging",
      totals: [fact("impressions", 10)],
      posts: [
        post(),
        post({ publishedDestinations: 0, facts: [noFact("impressions")] }),
        post({ publishedDestinations: 0, facts: [noFact("impressions")] }),
      ],
    });
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt).toContain("NOT PUBLISHED — 2 of 3 posts in this campaign never went out.");
    // One results line, for the one post that has results.
    expect(prompt.match(/^Post \d+ \[/gm)).toHaveLength(1);
  });

  it("says nothing about unpublished posts when every post went out", async () => {
    // A "0 of 3 never went out" line is noise, and a model told about a zero will mention it.
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, {
      theme: "packaging",
      totals: [fact("impressions", 10)],
      posts: [post(), post()],
    });
    expect(sent[0]?.prompt).not.toContain("NOT PUBLISHED");
  });

  it("renders a rate as a percentage and counts as counts", async () => {
    // Transcribed from `formatStatsForEvaluation`: one decimal place, and the `%` sign.
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, {
      theme: "packaging",
      totals: [fact("impressions", 1_500), fact("engagement_rate", 0.012, "fraction")],
      posts: [post()],
    });
    expect(sent[0]?.prompt).toContain("impressions 1500");
    expect(sent[0]?.prompt).toContain("engagement rate 1.2%");
  });

  it("forbids inventing metrics, and labels a cause it cannot see as a hypothesis", async () => {
    /**
     * *"Use only the numbers provided — never invent metrics"* is transcribed verbatim; it is enforceable
     * here only because the numbers were read from the store rather than supplied by the model.
     *
     * The hypothesis clause is #125's AC-1 — *"it may not invent causal explanations"* — which applies to
     * this prose exactly as it applies to the assistant's own.
     */
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, { theme: "packaging", totals: [fact("impressions", 1)], posts: [post()] });
    expect(sent[0]?.system).toContain("never invent metrics");
    expect(sent[0]?.system).toContain("hypothesis");
    // The campaign's own subject reaches the prompt, or the evaluation is about nothing in particular.
    expect(sent[0]?.prompt).toContain("Campaign theme: packaging");
  });

  it("supplies a goal when the campaign has none, rather than the word undefined", async () => {
    // The old route's fallback, kept: `goal or 'grow awareness and engagement'`.
    const { instance, sent } = capturing({ evaluation: "fine" });
    await instance.evaluateCampaign({} as never, { theme: "packaging", totals: [fact("impressions", 1)], posts: [post()] });
    expect(sent[0]?.prompt).toContain("Campaign goal: grow awareness and engagement");
    expect(sent[0]?.prompt).not.toContain("undefined");
  });

  it("trims the evaluation, so a leading blank line is not the first thing a reader sees", async () => {
    const evaluation = await generator({ evaluation: "  Post 1 did best.\n\n" }).evaluateCampaign({} as never, {
      theme: "packaging",
      totals: [fact("impressions", 1)],
      posts: [post()],
    });
    expect(evaluation).toBe("Post 1 did best.");
  });

  it("grounds the angles in the findings it was given, with the same anti-fabrication clause", async () => {
    /**
     * Sabotage found this one: deleting the trends block from *this* prompt broke nothing, while
     * `generate_campaign` went on reporting `trendGrounded: true`. A claim of grounding with no grounding
     * behind it is worse than no claim, so the clause is pinned here as well as in `suggestIdeas`.
     */
    const { instance, sent } = capturing({ angles: [{ label: "a", rationale: "r" }] });
    await instance.proposeAngles({} as never, {
      brief: "launch the refill scheme",
      count: 1,
      trends: [{ title: "Refill schemes grow", snippet: "Refill pilots doubled in 2026." }],
    });
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt).toContain("do not fabricate specifics beyond these");
    expect(prompt).toContain("Refill pilots doubled in 2026.");
    // The brief is still the spine of it.
    expect(prompt).toContain("launch the refill scheme");
  });

  it("says nothing about a search when the planner was given no findings", async () => {
    // An empty findings heading invites a model to fill it in — and most campaigns are planned
    // without a search at all, so this is the common path.
    const { instance, sent } = capturing({ angles: [{ label: "a", rationale: "r" }] });
    await instance.proposeAngles({} as never, { brief: "launch", count: 1 });
    expect(sent[0]?.prompt).not.toContain("web search");
  });

  it("cycles the destinations across the pieces, rather than one piece per destination", async () => {
    /**
     * Transcribed: `assigned = [targets[i % len(targets)] for i in range(count)]`. Three pieces across
     * two platforms is LinkedIn, X, LinkedIn — the count is what the caller asked for and the platforms
     * are what it is spread across. A tool that returned two pieces instead would quietly answer a
     * different question.
     */
    const { instance, sent } = capturing({
      pieces: [
        { angle: "a", platform: "linkedin", caption: "one" },
        { angle: "b", platform: "x", caption: "two" },
        { angle: "c", platform: "linkedin", caption: "three" },
      ],
    });
    const pieces = await instance.repurpose({} as never, {
      source: "A long article.",
      count: 3,
      platformIds: ["linkedin", "x"] as never,
    });
    expect(pieces).toHaveLength(3);
    expect(sent[0]?.prompt).toContain("Platform assignment per piece, in order: linkedin, x, linkedin");
  });

  it("keeps a piece on its assigned destination when the model retargets it", async () => {
    /**
     * The old engine took the model's own platform whenever it sent one — `str(item.get("platform") or
     * assigned[i])` — so a piece assigned to LinkedIn came back for Instagram and the caller got a post
     * for a destination it never named. Which for a publishing tool is a post that cannot be published.
     */
    const pieces = await generator({
      pieces: [{ angle: "a", platform: "instagram", caption: "one" }],
    }).repurpose({} as never, { source: "A long article.", count: 1, platformIds: ["linkedin"] as never });
    expect(pieces[0]?.platformId).toBe("linkedin");
  });

  it("accepts a destination the model spelled with different case", async () => {
    // The ids arrive lower-cased; a model handed "linkedin" may answer "LinkedIn". Returned under the
    // caller's own id so it can be used as a key — the same rule as `suggestIdeas`' channels.
    const pieces = await generator({
      pieces: [{ angle: "a", platform: "LinkedIn", caption: "one" }],
    }).repurpose({} as never, { source: "A long article.", count: 1, platformIds: ["linkedin"] as never });
    expect(pieces[0]?.platformId).toBe("linkedin");
  });

  it("shows the model only the bounded source, and says nothing about hashtags", async () => {
    /**
     * `source_text.strip()[:6000]` — *"keep the prompt bounded"*. The prompt must also not ask for
     * hashtags: the old engine's system prompt said *"No hashtags"* and split them out afterwards, and
     * this generator writes them into the caption instead.
     */
    const { instance, sent } = capturing({ pieces: [{ angle: "a", platform: "linkedin", caption: "one" }] });
    await instance.repurpose({} as never, {
      source: `${"x".repeat(MAX_REPURPOSE_SOURCE_CHARS)}THIS-MUST-NOT-APPEAR`,
      count: 1,
      platformIds: ["linkedin"] as never,
    });
    expect(sent[0]?.prompt).not.toContain("THIS-MUST-NOT-APPEAR");
    expect(sent[0]?.system).toContain("never a reword of another");
    // Drawn from the source only — a repurposed post inventing a statistic is the worst version of this.
    expect(sent[0]?.system).toContain("do not add facts it does not contain");
  });

  it("refuses an empty source and a piece with no destination", async () => {
    await expect(
      generator({}).repurpose({} as never, { source: "  ", count: 2, platformIds: ["linkedin"] as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      generator({}).repurpose({} as never, { source: "An article.", count: 2, platformIds: [] as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("trims to the count asked for", async () => {
    const pieces = await generator({
      pieces: [
        { angle: "a", platform: "linkedin", caption: "one" },
        { angle: "b", platform: "linkedin", caption: "two" },
        { angle: "c", platform: "linkedin", caption: "three" },
      ],
    }).repurpose({} as never, { source: "An article.", count: 2, platformIds: ["linkedin"] as never });
    expect(pieces).toHaveLength(2);
  });

  it("gives a video motion and audio, and a still composition and mood", async () => {
    /**
     * The per-kind branch, transcribed. One instruction for both produces still-image language for a
     * clip — no motion over time, no audio cues — and the video model then renders a photograph.
     */
    const video = capturing({ prompt: "p" });
    await video.instance.enhanceMediaPrompt({} as never, { brief: "a barista", kind: "video" });
    expect(video.sent[0]?.system).toContain("Because this is VIDEO");
    expect(video.sent[0]?.system).toContain("audio cues");

    const still = capturing({ prompt: "p" });
    await still.instance.enhanceMediaPrompt({} as never, { brief: "a barista", kind: "image" });
    expect(still.sent[0]?.system).toContain("Because this is a STILL IMAGE");
    expect(still.sent[0]?.system).not.toContain("audio cues");
  });

  it("asks for one prompt and nothing around it", async () => {
    // *"Output ONLY the rewritten prompt — no preamble, no quotes, no options."* The caller stores this
    // string as the generation prompt, so "Here are three options:" becomes part of the image brief.
    const { instance, sent } = capturing({ prompt: "p" });
    await instance.enhanceMediaPrompt({} as never, { brief: "a barista", kind: "image" });
    expect(sent[0]?.system).toContain("Output ONLY the rewritten prompt");
    expect(sent[0]?.system).toContain("80-140 words");
  });

  it("refuses an empty brief rather than expanding nothing", async () => {
    await expect(
      generator({}).enhanceMediaPrompt({} as never, { brief: "   ", kind: "image" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("tells the scene planner that the video model has no memory between scenes", async () => {
    /**
     * The clause the whole planner rests on: *"restate them explicitly in every scene prompt — the
     * video model has no memory between scenes"*. Without it the scenes describe one world and the
     * model renders three unrelated clips, which is the failure this exists to prevent.
     */
    const { instance, sent } = capturing({ scenes: ["one", "two"] });
    await instance.planVideoScenes({} as never, { concept: "a barista's morning", sceneCount: 2 });
    expect(sent[0]?.system).toContain("no memory between scenes");
    expect(sent[0]?.system).toContain("scene 1 establishes, the last scene resolves");
    expect(sent[0]?.prompt).toContain("N = 2");
  });

  it("refuses a short plan rather than returning a film with a hole in it", async () => {
    /**
     * The old planner's own refusal — *"planner produced N scenes, expected M"*. The caller queues one
     * generation job per scene, so two scenes for a three-scene film is a video that does not make
     * sense, not a shorter one.
     */
    await expect(
      generator({ scenes: ["only one"] }).planVideoScenes({} as never, { concept: "a morning", sceneCount: 3 }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("does not count a blank scene towards the plan", async () => {
    // A blank string is not a scene. Counting it would satisfy the check above and queue a job with an
    // empty prompt.
    await expect(
      generator({ scenes: ["a real scene", "   "] }).planVideoScenes({} as never, {
        concept: "a morning",
        sceneCount: 2,
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("refuses a scene count the planner does not plan", async () => {
    for (const sceneCount of [1, 5]) {
      await expect(
        generator({ scenes: [] }).planVideoScenes({} as never, { concept: "a morning", sceneCount }),
        String(sceneCount),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("sends the image to the model, with the mode's own instruction", async () => {
    /**
     * The three prompts are transcribed and the mode chooses one whole instruction — they are not three
     * tones of the same answer. Asserted through `capturing`, because what a model is *told* is the whole
     * behaviour of this adapter.
     */
    const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" };
    const alt = capturing({ text: "A tabby cat on a windowsill." });
    await alt.instance.describeImage({} as never, { image: png, mode: "alt_text" });
    expect(alt.sent[0]?.system).toContain("no interpretation, no marketing language");

    const caption = capturing({ text: "Something worth a second look." });
    await caption.instance.describeImage({} as never, { image: png, mode: "caption" });
    expect(caption.sent[0]?.system).toContain("scroll-stopping caption");

    const competitor = capturing({ text: "They lead with social proof." });
    await competitor.instance.describeImage({} as never, { image: png, mode: "competitor" });
    expect(competitor.sent[0]?.system).toContain("competitive social-media analyst");
  });

  it("keeps the brand out of alt text, and in the other two", async () => {
    /**
     * A deliberate departure: the old runtime passed brand context to all three modes. Alt text is an
     * accessibility description, not copy — handing it a brand voice is how "a tabby cat on a windowsill"
     * becomes "the cosy moment your morning deserves", which its own instruction forbids.
     */
    const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" };
    const alt = capturing({ text: "A cat." });
    await alt.instance.describeImage({} as never, { image: png, mode: "alt_text" });
    expect(alt.sent[0]?.system).not.toContain("Acme");

    const caption = capturing({ text: "A cat." });
    await caption.instance.describeImage({} as never, { image: png, mode: "caption" });
    expect(caption.sent[0]?.system).toContain("Acme");
  });

  it("enforces the alt-text ceiling instead of only asking for it", async () => {
    /**
     * *"Max 125 characters"* is asked for in the prompt and enforced here, because an `<img alt>` that
     * runs to a paragraph is read out in full by a screen reader before the page can continue. Cut on a
     * word boundary, so the result is a fragment of a sentence rather than a word sliced in half.
     */
    const long = `A ${"very ".repeat(40)}long description of a cat.`;
    const text = await generator({ text: long }).describeImage({} as never, {
      image: { bytes: new Uint8Array([0x89]), mime: "image/png" },
      mode: "alt_text",
    });
    expect(text.length).toBeLessThanOrEqual(MAX_ALT_TEXT_CHARS);
    expect(text.endsWith("very") || text.endsWith("very ".trim())).toBe(true);
    expect(text).not.toContain("  ");
  });

  it("does not truncate a caption or an analysis", async () => {
    // The ceiling belongs to alt text. A caption cut at 125 characters would be a caption with its point
    // removed.
    const long = `A ${"very ".repeat(40)}long caption.`;
    const text = await generator({ text: long }).describeImage({} as never, {
      image: { bytes: new Uint8Array([0x89]), mime: "image/png" },
      mode: "caption",
    });
    expect(text.length).toBeGreaterThan(MAX_ALT_TEXT_CHARS);
  });

  it("trims angles to the count asked for", async () => {
    const angles = await generator({
      angles: [
        { label: "a", rationale: "r" },
        { label: "b", rationale: "r" },
        { label: "c", rationale: "r" },
      ],
    }).proposeAngles({} as never, { brief: "launch", count: 2 });
    expect(angles).toHaveLength(2);
  });

  it("refuses an empty brief and a post with no destination", async () => {
    await expect(generator({}).proposeAngles({} as never, { brief: "  ", count: 2 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      generator({}).generate({} as never, { brief: "x", platformIds: [] as never, avoid: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("passes the previous attempt's findings in as things not to repeat", async () => {
    /**
     * What makes the repair loop work. Rendered as instructions rather than raw validation output, because a
     * model handed `{"code":"caption-too-long"}` has to guess what to change.
     */
    const prompts: string[] = [];
    const withCapture = createModelContentGenerator({
      generate: (async (input: { prompt: string }) => {
        prompts.push(input.prompt);
        return { variants: [{ platformId: "instagram", caption: "shorter" }] };
      }) as never,
      brand: async () => ({}),
    });
    await withCapture.generate({} as never, {
      brief: "launch",
      platformIds: ["instagram"] as never,
      avoid: [{ code: "caption-too-long", message: "280 characters; instagram allows 200." }] as never,
    });
    expect(prompts[0]).toContain("Do not repeat these");
    expect(prompts[0]).toContain("instagram allows 200");
  });

  it("renders no brand lines for an empty profile", async () => {
    // "Brand: unknown" is worse than silence: a model told a field is unknown sometimes writes about not
    // knowing it.
    const systems: string[] = [];
    const withCapture = createModelContentGenerator({
      generate: (async (input: { system: string }) => {
        systems.push(input.system);
        return { variants: [{ platformId: "x", caption: "c" }] };
      }) as never,
      brand: async () => ({}),
    });
    await withCapture.generate({} as never, { brief: "b", platformIds: ["x"] as never, avoid: [] });
    expect(systems[0]).not.toContain("Brand:");
    expect(systems[0]).not.toContain("unknown");
  });
});

describe.skipIf(URL_ === undefined)("ArtifactService over assistant_artifacts — REQ-041 (#190)", () => {
  /**
   * The first of the three capabilities the inventory called "a tool away".
   *
   * Everything this needs was already in ShareFlow: `assistant_artifacts`, `assistant_artifact_versions` and
   * the `chorus-artifact:` scheme. So the interesting assertions are not "does it insert" — they are the two
   * places a plausible implementation would be wrong about something:
   *
   * - **the table.** `@retinue/agentkit` ships its own `createArtifactService`, and using it would have been
   *   less code and the wrong rows: every `chorus-artifact:` link in a customer's chat history resolves
   *   against an `assistant_artifacts` id.
   * - **the ordering.** The old lib archives the OLD content *before* the update, so a failed archive refuses
   *   the revision and leaves the previous version intact. Reversed, a partial failure loses a version.
   */
  const artifacts = () => createPostgresArtifactService({ sql, transaction });

  const create = async (over: Partial<{ title: string; kind: string; content: string }> = {}) =>
    artifacts().create(context(), {
      idempotencyKey: `k-${Math.random()}` as never,
      title: over.title ?? "Q3 content plan",
      kind: (over.kind ?? "markdown") as never,
      content: over.content ?? "# Plan\n\nFirst paragraph.",
    });

  it("writes to ShareFlow's own table, with the app's provenance columns", async () => {
    const artifact = await create();
    expect(artifact.version).toBe(1);
    expect(artifact.kind).toBe("markdown");
    // The reference the assistant is told to put in its reply, in the app's scheme so it opens the app's panel.
    expect(artifact.reference).toBe(`${ARTIFACT_SCHEME}${String(artifact.id).toLowerCase()}`);

    const rows = await sql.query<{ workspace_id: string; created_by: string | null; session_id: string | null }>(
      "select workspace_id, created_by, session_id from public.assistant_artifacts where id = $1::uuid",
      [String(artifact.id)],
    );
    expect(rows[0]?.workspace_id).toBe(workspaceId);
    expect(rows[0]?.created_by).toBe(userId);
    /**
     * `session_id` is null here, and that is the honest value rather than a gap.
     *
     * It is `text` with no foreign key — the app's comment says the artifact outlives the session and it is
     * *"never used for access control"* — so the adapter fills it from `context.conversationId`, which this
     * suite's context does not carry. A placeholder would be provenance nobody can trace.
     */
    expect(rows[0]?.session_id).toBeNull();
  });

  it("records an audit_log row, because the customer's own audit screen reads it", async () => {
    /**
     * The side effect no port mentions and every old internal write performs. `/audit` in the app reads this
     * table, and the old runtime writes to it from artifacts, drafts, schedules, reposts, branding and media —
     * so an adapter that skipped it would make the trail go quiet for exactly the actions an assistant took on
     * a customer's behalf.
     */
    const artifact = await create({ title: "Audited plan" });
    const rows = await sql.query<{ action: string; target_id: string; detail: Record<string, unknown> }>(
      `select action, target_id, detail from public.audit_log
        where workspace_id = $1::uuid and target_id = $2 order by created_at desc`,
      [workspaceId, String(artifact.id)],
    );
    expect(rows[0]?.action).toBe("artifact.created");
    expect(rows[0]?.detail).toMatchObject({ source: "assistant", title: "Audited plan" });
  });

  it("archives the previous version before writing the new one, and keeps the old text", async () => {
    const artifact = await create({ title: "First title", content: "Original body." });
    const revised = await artifacts().revise(context(), {
      idempotencyKey: "k2" as never,
      id: artifact.id,
      content: "Replacement body.",
      title: "Second title",
    });

    expect(revised.version).toBe(2);
    expect(revised.content).toBe("Replacement body.");

    // The archive holds what was there *before* — not a copy of the new content, which is the mistake an
    // "archive after update" ordering makes and which no assertion on the artifact row would catch.
    const versions = await sql.query<{ version: number; title: string; content: string }>(
      "select version, title, content from public.assistant_artifact_versions where artifact_id = $1::uuid order by version",
      [String(artifact.id)],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, title: "First title", content: "Original body." });
  });

  it("never writes the kind on a revision — scanned, because no result can show it", async () => {
    /**
     * A source scan, and the reason is a sabotage that got through.
     *
     * The first version of this test asserted the *outcome*: revise an html artifact, expect it still html.
     * That passes whatever the adapter does, because the `UPDATE` does not touch the column — so replacing
     * `validate(title, current.kind, …)` with a literal `"markdown"` broke nothing, and the comment claiming
     * the stored kind was load-bearing was wrong. `validate` only asks whether a kind is one of the three.
     *
     * What actually keeps a kind fixed is that the statement does not set it. That is an absence, and an
     * absence cannot be demonstrated by a fixture — same class as the `auth_tokens` column list and the
     * analytics workspace predicate, and pinned the same way. The other two halves of the rule (no `kind` on
     * the port, a `.strict()` tool schema) are behavioural and tested in `tools/__tests__/artifacts.test.ts`.
     */
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts.ts"), "utf8");
    const update = source.slice(source.indexOf("update public.assistant_artifacts"));
    const statement = update.slice(0, update.indexOf("returning"));
    expect(statement).toContain("set title =");
    expect(statement).not.toMatch(/\bkind\s*=/);

    const artifact = await create({ kind: "html", content: "<p>One</p>" });
    const revised = await artifacts().revise(context(), {
      idempotencyKey: "k3" as never,
      id: artifact.id,
      content: "<p>Two</p>",
    });
    expect(revised.kind).toBe("html");
    // Title omitted keeps the current one, rather than clearing it.
    expect(revised.title).toBe("Q3 content plan");
  });

  it("serialises concurrent revisions instead of refusing one, and loses no version", async () => {
    /**
     * The behaviour that differs from the old runtime, deliberately, and the reason the adapter takes
     * `select … for update`.
     *
     * The old path reads, archives and updates on separate connections, so two concurrent revisions both read
     * version 1 and both try to insert version 1 into `assistant_artifact_versions`.
     * `assistant_artifact_versions_artifact_id_version_key` refuses the second — which is why the old code
     * cannot lose a version, and it means the safety was the index rather than the sequencing — and that caller
     * gets "Could not archive the current version" for what is a queueing problem.
     *
     * Under the lock the second writer waits, sees version 2 and produces version 3. Both revisions land, both
     * prior versions are archived, and the guarantee the old code actually made is preserved.
     *
     * Sabotage check: removing `for update` from the adapter makes this fail with a unique-violation from the
     * archive insert, which is what confirms the lock is what produces the result rather than luck in the
     * scheduler.
     */
    const artifact = await create({ title: "Contended", content: "v1 body" });
    const service = artifacts();
    const results = await Promise.all([
      service.revise(context(), { idempotencyKey: "c1" as never, id: artifact.id, content: "from A" }),
      service.revise(context(), { idempotencyKey: "c2" as never, id: artifact.id, content: "from B" }),
    ]);

    expect([...results.map((r) => r.version)].sort()).toEqual([2, 3]);
    const versions = await sql.query<{ version: number; content: string }>(
      "select version, content from public.assistant_artifact_versions where artifact_id = $1::uuid order by version",
      [String(artifact.id)],
    );
    // v1 and v2 both archived: no revision overwrote another's text without keeping it.
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]?.content).toBe("v1 body");
  });

  it("reads another workspace's artifact as not-found, never as forbidden", async () => {
    // The app's own rule, and the reason for it: `forbidden` confirms the id exists, which is a fact about
    // another tenant's data.
    const artifact = await create();
    const other = { ...(context() as object), tenantId: workspaceId } as never;
    const foreign = await sql.query<{ id: string }>(
      "insert into public.workspaces (name) values ($1) returning id",
      ["retinue-artifact-foreign"],
    );
    const foreignId = foreign[0]?.id ?? "";
    try {
      const asForeign = { ...(other as object), tenantId: foreignId } as never;
      const error = thrown(await artifacts().get(asForeign, { id: artifact.id }).catch((r: unknown) => r));
      expect(error.code).toBe("not_found");
      // And a revision from the wrong workspace does not reach the lock either.
      const failed = thrown(
        await artifacts()
          .revise(asForeign, { idempotencyKey: "x" as never, id: artifact.id, content: "hijack" })
          .catch((r: unknown) => r),
      );
      expect(failed.code).toBe("not_found");
    } finally {
      await sql.query("delete from public.workspaces where id = $1::uuid", [foreignId]);
    }
  });

  it("refuses what the app refuses, in the app's own order", async () => {
    /**
     * Clause for clause from `web/src/lib/internal/artifacts.ts`, and the *order* is part of it: a model told
     * "an artifact needs a title" adds one, where a length complaint first would have it truncate content it
     * did not need to.
     */
    const cases: [string, Partial<{ title: string; kind: string; content: string }>][] = [
      ["An artifact needs a title", { title: "   " }],
      [`A title can be at most ${ARTIFACT_MAX_TITLE}`, { title: "t".repeat(ARTIFACT_MAX_TITLE + 1) }],
      ["kind must be one of", { kind: "md" }],
      ["An artifact needs content", { content: "  \n  " }],
      [`Content can be at most ${ARTIFACT_MAX_CHARS}`, { content: "c".repeat(ARTIFACT_MAX_CHARS + 1) }],
    ];
    for (const [message, over] of cases) {
      const error = thrown(await create(over).catch((r: unknown) => r));
      expect(error.code, message).toBe("invalid_input");
      expect(error.message, message).toContain(message);
    }
  });

  it("refuses an id that is not a uuid rather than asking the database", async () => {
    const error = thrown(await artifacts().get(context(), { id: "not-a-uuid" as never }).catch((r: unknown) => r));
    expect(error.code).toBe("invalid_input");
  });

  it("issues no reference for an id that is not a uuid, rather than a broken link", async () => {
    /**
     * The app's formatter returns null there and the reason is worth keeping: a reply streams token by token,
     * so a half-written `chorus-artifact:8f14e45` exists for a frame, and a client rendering a card for it
     * fetches an artifact that cannot be found. Absent means "do not link to this".
     */
    expect(artifactReference("8f14e45")).toBeUndefined();
    expect(artifactReference("  550E8400-E29B-41D4-A716-446655440000  ")).toBe(
      `${ARTIFACT_SCHEME}550e8400-e29b-41d4-a716-446655440000`,
    );
  });
});

describe.skipIf(URL_ === undefined)("repost and delete — the two publish capabilities REQ-041 added (#190)", () => {
  /**
   * Both were `requires_confirmation=True` in the old runtime and both are unreplaced-no-longer. The
   * assertions worth having are the two places a plausible implementation is wrong about something the old
   * tool's docstring is explicit on:
   *
   * - **a repost duplicates**, because the platforms cannot re-publish a live post, and the original keeps
   *   its own history and metrics;
   * - **a delete asks the platforms first**, and keeps the record whenever any of them still has a copy.
   */
  const deletions: { platformId: string; externalPostId: string }[] = [];

  const publishing = (over: Partial<Parameters<typeof createPostgresPublishingService>[0]> = {}) =>
    createPostgresPublishingService({
      sql,
      transaction,
      validateContent: createPostgresContentService(sql).validateContent,
      duplicate: (context, input) => createPostgresContentService(sql).duplicateDraft(context, input),
      ...over,
    });

  /** A post with one successful target, which is what both capabilities need to exist at all. */
  const published = async (over: { external?: string | null } = {}) => {
    const account = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', $2, 'Repost target', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId, `li-${Math.random().toString(36).slice(2)}`],
    );
    const accountId = account[0]!.id;
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'Original caption', 'PUBLISHED', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const postId = post[0]!.id;
    await sql.query(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status, external_post_id, published_at)
       values ($1::uuid, $2::uuid, now(), 'SUCCESS', $3, now())`,
      [postId, accountId, over.external === undefined ? "urn:li:share:1" : over.external],
    );
    return { postId, accountId };
  };

  it("duplicates rather than republishing, and leaves the original intact", async () => {
    /**
     * The old docstring: *"The platform APIs cannot edit or re-publish a live post, so this DUPLICATES the
     * content into a new post and publishes that — the original stays intact with its own history and
     * metrics."* Keeping the original is the assertion: its engagement numbers belong to it.
     */
    const { postId } = await published();
    const receipt = await publishing().repost(context(), {
      idempotencyKey: `r-${Math.random()}` as never,
      draftId: postId as never,
    });

    expect(String(receipt.draftId)).not.toBe(postId);
    expect(receipt.targets.length).toBe(1);

    // The original still exists, still published, still with its own successful item.
    const original = await sql.query<{ status: string }>(
      `select status from public.posts where id = $1::uuid`,
      [postId],
    );
    expect(original[0]?.status).toBe("PUBLISHED");
    const originalItems = await sql.query<{ n: string }>(
      `select count(*) as n from public.scheduled_items where post_id = $1::uuid and status = 'SUCCESS'`,
      [postId],
    );
    expect(Number(originalItems[0]?.n)).toBe(1);

    // And the copy carries the content, so a repost is the same post rather than an empty one.
    const copy = await sql.query<{ raw_content: string }>(
      `select raw_content from public.posts where id = $1::uuid`,
      [String(receipt.draftId)],
    );
    expect(copy[0]?.raw_content).toContain("Original caption");
  });

  it("defaults to the destinations that succeeded, not the ones that were attempted", async () => {
    /**
     * The narrower default, and the reason for it: a target that failed the first time is not silently
     * retried under cover of a repost. `retry_publish_target` exists for that, per target — so a draft that
     * reached three of four destinations is never re-sent to the three that worked.
     */
    const { postId } = await published();
    const failed = await sql.query<{ id: string }>(
      `insert into public.social_accounts
         (workspace_id, platform, platform_user_id, account_name, auth_tokens, status)
       values ($1::uuid, 'linkedin', $2, 'Failed target', '{}'::jsonb, 'ACTIVE') returning id`,
      [workspaceId, `li-${Math.random().toString(36).slice(2)}`],
    );
    await sql.query(
      `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
       values ($1::uuid, $2::uuid, now(), 'FAILED')`,
      [postId, failed[0]!.id],
    );

    const receipt = await publishing().repost(context(), {
      idempotencyKey: `r2-${Math.random()}` as never,
      draftId: postId as never,
    });
    // One, not two: the failed destination is not in the repost.
    expect(receipt.targets).toHaveLength(1);
  });

  it("refuses a post that never published, instead of treating a repost as a first publish", async () => {
    /**
     * A post with no successful target never published, so there is nothing to publish *again*. Refused
     * rather than defaulted to its intended destinations — otherwise a model reaches for `repost_post` when
     * the honest tool is `publish_post_now`, whose validation it would then have skipped.
     */
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'Never sent', 'DRAFT', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    const error = thrown(
      await publishing()
        .repost(context(), { idempotencyKey: "r3" as never, draftId: post[0]!.id as never })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("publish_post_now");
  });

  it("refuses to repost without duplication wired, rather than publishing the original again", async () => {
    const { postId } = await published();
    const error = thrown(
      await createPostgresPublishingService({
        sql,
        transaction,
        validateContent: createPostgresContentService(sql).validateContent,
      })
        .repost(context(), { idempotencyKey: "r4" as never, draftId: postId as never })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("capability_unavailable");
  });

  it("asks the platforms first and removes the record only when all confirmed", async () => {
    deletions.length = 0;
    const { postId } = await published();
    const result = await publishing({
      deleteFrom: async (input) => {
        deletions.push({ platformId: input.platformId, externalPostId: input.externalPostId });
        return { deleted: true };
      },
    }).deletePublished(context(), { idempotencyKey: "d1" as never, draftId: postId as never });

    // The platform was asked, with the id this database holds — not a guess.
    expect(deletions).toEqual([{ platformId: "linkedin", externalPostId: "urn:li:share:1" }]);
    expect(result.removedFromDatabase).toBe(true);
    expect(result.stillLive).toEqual([]);

    // And the row is gone, with its scheduled items cascaded.
    const rows = await sql.query<{ n: string }>(`select count(*) as n from public.posts where id = $1::uuid`, [postId]);
    expect(Number(rows[0]?.n)).toBe(0);
    const items = await sql.query<{ n: string }>(
      `select count(*) as n from public.scheduled_items where post_id = $1::uuid`,
      [postId],
    );
    expect(Number(items[0]?.n)).toBe(0);
  });

  it("keeps the record when a platform refuses, because a live post with no row cannot be found again", async () => {
    /**
     * The case the old docstring spends a paragraph on: *"TikTok has no delete API, and Instagram refuses ads
     * and single items inside a carousel. Those copies stay live."* A refusal is a normal answer, not a
     * failed call — and the record is kept **on purpose** so the leftover is still findable.
     */
    const { postId } = await published();
    const result = await publishing({
      deleteFrom: async () => ({ deleted: false, reason: "TikTok has no delete API" }),
    }).deletePublished(context(), { idempotencyKey: "d2" as never, draftId: postId as never });

    expect(result.removedFromDatabase).toBe(false);
    expect(result.stillLive).toEqual(["linkedin"]);
    expect(result.platforms[0]?.reason).toContain("no delete API");

    const rows = await sql.query<{ n: string }>(`select count(*) as n from public.posts where id = $1::uuid`, [postId]);
    // Still there, which is what makes the leftover findable.
    expect(Number(rows[0]?.n)).toBe(1);
    await sql.query(`delete from public.posts where id = $1::uuid`, [postId]);
  });

  it("treats a connector that threw exactly like one that refused", async () => {
    // Both mean the platform still has a copy, so `stillLive` must not be able to miss one of them.
    const { postId } = await published();
    const result = await publishing({
      deleteFrom: async () => {
        throw new Error("connection reset");
      },
    }).deletePublished(context(), { idempotencyKey: "d3" as never, draftId: postId as never });
    expect(result.stillLive).toEqual(["linkedin"]);
    expect(result.removedFromDatabase).toBe(false);
    expect(result.platforms[0]?.reason).toContain("connection reset");
    await sql.query(`delete from public.posts where id = $1::uuid`, [postId]);
  });

  it("reports a published target with no external id rather than skipping it", async () => {
    /**
     * A `SUCCESS` row without `external_post_id` is a post the platform accepted and this database cannot
     * name. There is nothing to ask the platform to delete, and a skipped row is a live post nobody was told
     * about — so it is reported as un-deleted with a reason.
     */
    const { postId } = await published({ external: null });
    const result = await publishing({
      deleteFrom: async () => ({ deleted: true }),
    }).deletePublished(context(), { idempotencyKey: "d4" as never, draftId: postId as never });
    expect(result.stillLive).toEqual(["linkedin"]);
    expect(result.platforms[0]?.reason).toContain("no id for the published post");
    await sql.query(`delete from public.posts where id = $1::uuid`, [postId]);
  });

  it("refuses to delete without a connector, rather than removing the record alone", async () => {
    /**
     * The most consequential refusal in the pair. Removing the row without asking the platforms would leave
     * live posts nobody can find, and report the post as deleted.
     */
    const { postId } = await published();
    const error = thrown(
      await publishing()
        .deletePublished(context(), { idempotencyKey: "d5" as never, draftId: postId as never })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("capability_unavailable");
    const rows = await sql.query<{ n: string }>(`select count(*) as n from public.posts where id = $1::uuid`, [postId]);
    expect(Number(rows[0]?.n)).toBe(1);
    await sql.query(`delete from public.posts where id = $1::uuid`, [postId]);
  });

  it("deletes a never-published post without asking any platform", async () => {
    // Nothing is live, so nothing needs the platforms' permission — and requiring a connector here would
    // make an ordinary draft undeletable in a deployment that has none.
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms)
       values ($1::uuid, $2::uuid, 'Draft only', 'DRAFT', '{linkedin}') returning id`,
      [workspaceId, userId],
    );
    let asked = 0;
    const result = await publishing({
      deleteFrom: async () => {
        asked += 1;
        return { deleted: true };
      },
    }).deletePublished(context(), { idempotencyKey: "d6" as never, draftId: post[0]!.id as never });
    expect(asked).toBe(0);
    expect(result.removedFromDatabase).toBe(true);
    expect(result.platforms).toEqual([]);
  });
});

describe.skipIf(URL_ === undefined)("MediaService — detach, replace and the queued conversion (#190)", () => {
  /**
   * Three capabilities the old runtime had and this package did not. The assertions that matter are the two
   * the old tools' docstrings are explicit about:
   *
   * - **a replacement keeps its position**, because media order is the order a platform shows a carousel in;
   * - **only `succeeded` means the file exists**, so an unfinished conversion carries no path to attach.
   */
  /** Permissive: this suite is about conversions, not platform rules. See AC-8's own block above. */
  const media = () =>
    createPostgresMediaService({
      sql,
      transaction,
      convert: async () => ({ jobId: queuedJob }),
      checkCompatibility: async () => [],
    });

  let queuedJob = "";
  /** `generated_assets.job_id` is NOT NULL, so every asset needs a generation job to hang off. */
  let mediaJob = "";

  beforeAll(async () => {
    if (URL_ === undefined) return;
    mediaJob = (
      await sql.query<{ id: string }>(
        `insert into public.generation_jobs (workspace_id, kind, prompt, status)
         values ($1::uuid, 'image', 'media capability fixtures', 'succeeded') returning id`,
        [workspaceId],
      )
    )[0]!.id;
  });

  /** A draft with three attachments, so "in place" is distinguishable from "appended". */
  const draftWithThree = async () => {
    const paths = ["a.jpg", "b.jpg", "c.jpg"].map((n) => `${workspaceId}/${n}`);
    const ids: string[] = [];
    for (const path of paths) {
      const row = await sql.query<{ id: string }>(
        `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
         values ($1::uuid, $2::uuid, $3, 'image/jpeg') returning id`,
        [mediaJob, workspaceId, path],
      );
      ids.push(row[0]!.id);
      await sql.query(
        `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 1024}'::jsonb)
         on conflict do nothing`,
        [path],
      );
    }
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms, media_urls)
       values ($1::uuid, $2::uuid, 'three files', 'DRAFT', '{linkedin}', $3::text[]) returning id`,
      [workspaceId, userId, paths],
    );
    return { postId: post[0]!.id, ids, paths };
  };

  it("keeps the replacement in the position the original held", async () => {
    /**
     * **The assertion this capability exists for.** ShareFlow: *"It replaces IN PLACE, so the file keeps its
     * position — which matters because media order is the order a platform shows a carousel in."* Detach then
     * attach would put the new file last, which reorders the user's carousel without telling them.
     */
    const { postId, ids, paths } = await draftWithThree();
    const replacement = `${workspaceId}/b-converted.mp4`;
    const newAsset = await sql.query<{ id: string }>(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, $3, 'video/mp4') returning id`,
      [mediaJob, workspaceId, replacement],
    );
    await sql.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 2048}'::jsonb)
       on conflict do nothing`,
      [replacement],
    );

    const result = await media().replaceOnDraft(context(), {
      idempotencyKey: "r1" as never,
      draftId: postId as never,
      remove: ids[1]! as never,
      add: newAsset[0]!.id as never,
    });

    // Index 1, not index 2: the middle slide is still the middle slide.
    expect(result.mediaAssetIds).toEqual([paths[0], replacement, paths[2]]);
  });

  it("refuses a replacement that is already attached, rather than shortening the post", async () => {
    // Writing it over the outgoing slot would leave the same file twice and dedupe to one — a carousel one
    // slide shorter than the user built, with nothing saying so.
    const { postId, ids } = await draftWithThree();
    const error = thrown(
      await media()
        .replaceOnDraft(context(), {
          idempotencyKey: "r2" as never,
          draftId: postId as never,
          remove: ids[0]! as never,
          add: ids[2]! as never,
        })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("already attached");
  });

  it("removes an attachment and leaves the file in storage", async () => {
    // The old tool calls itself reversible in its first line: *"The file is NOT deleted from storage — only
    // its attachment to this post — so it can be re-attached or used elsewhere."*
    const { postId, ids, paths } = await draftWithThree();
    const result = await media().detachFromDraft(context(), {
      idempotencyKey: "d1" as never,
      draftId: postId as never,
      assetIds: [ids[1]! as never],
    });
    expect(result.mediaAssetIds).toEqual([paths[0], paths[2]]);

    const stillThere = await sql.query<{ n: string }>(
      `select count(*) as n from storage.objects where bucket_id = 'media' and name = $1`,
      [paths[1]],
    );
    expect(Number(stillThere[0]?.n)).toBe(1);
  });

  it("refuses a removal that would change nothing", async () => {
    // A silent no-op lets an assistant report a file removed that was never there, while the one it meant to
    // remove is still on the post.
    const { postId } = await draftWithThree();
    const other = await sql.query<{ id: string }>(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, $3, 'image/jpeg') returning id`,
      [mediaJob, workspaceId, `${workspaceId}/unattached.jpg`],
    );
    const error = thrown(
      await media()
        .detachFromDraft(context(), {
          idempotencyKey: "d2" as never,
          draftId: postId as never,
          assetIds: [other[0]!.id as never],
        })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("None of those files are attached");
  });

  it("removes an orphan whose file has gone missing", async () => {
    /**
     * `attachToDraft` requires the storage object to exist, because attaching a path the platforms cannot
     * fetch fails at publish time. Detaching is the opposite case: an asset whose file has vanished is
     * exactly the one a caller most needs to take off a draft, and requiring the object would make it
     * unremovable.
     */
    const orphanPath = `${workspaceId}/orphan.jpg`;
    const orphan = await sql.query<{ id: string }>(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, $3, 'image/jpeg') returning id`,
      [mediaJob, workspaceId, orphanPath],
    );
    const post = await sql.query<{ id: string }>(
      `insert into public.posts (workspace_id, author_id, raw_content, status, target_platforms, media_urls)
       values ($1::uuid, $2::uuid, 'orphan', 'DRAFT', '{linkedin}', $3::text[]) returning id`,
      [workspaceId, userId, [orphanPath]],
    );
    const result = await media().detachFromDraft(context(), {
      idempotencyKey: "d3" as never,
      draftId: post[0]!.id as never,
      assetIds: [orphan[0]!.id as never],
    });
    expect(result.mediaAssetIds).toEqual([]);
  });

  it("reports a queued conversion with no file, and the finished one with it", async () => {
    /**
     * **The rule the old docstring states and this makes structural:** *"Only 'succeeded' means the file
     * exists — until then there is no path to use or show."* A shape carrying a path on every state invites a
     * model to read one off a `running` job, attach it, and have the post fail at publish with a file that
     * was never written.
     */
    const source = await sql.query<{ id: string }>(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, $3, 'video/quicktime') returning id`,
      [mediaJob, workspaceId, `${workspaceId}/clip.mov`],
    );
    const job = await sql.query<{ id: string }>(
      `insert into public.media_conversion_jobs (workspace_id, source_path, target, status)
       values ($1::uuid, $2, 'mp4', 'running') returning id`,
      [workspaceId, `${workspaceId}/clip.mov`],
    );
    queuedJob = job[0]!.id;

    const queued = await media().convert(context(), {
      idempotencyKey: "c1" as never,
      id: source[0]!.id as never,
      targetFormat: "mp4",
    });
    expect(queued.state).toBe("running");
    // There is nothing to attach, and the shape says so by omission rather than with an empty string.
    expect(queued.asset).toBeUndefined();

    // Finish it, and the asset appears.
    const outPath = `${workspaceId}/clip.mp4`;
    await sql.query(
      `insert into public.generated_assets (job_id, workspace_id, storage_path, mime)
       values ($1::uuid, $2::uuid, $3, 'video/mp4')`,
      [mediaJob, workspaceId, outPath],
    );
    await sql.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 4096}'::jsonb)
       on conflict do nothing`,
      [outPath],
    );
    await sql.query(
      `update public.media_conversion_jobs set status = 'succeeded', result_path = $2 where id = $1::uuid`,
      [queuedJob, outPath],
    );

    const done = await media().getConversion(context(), { jobId: queuedJob as never });
    expect(done.state).toBe("succeeded");
    expect(done.asset?.mimeType).toBe("video/mp4");
  });

  it("reports a succeeded job with no output as failed, not as finished", async () => {
    /**
     * The combination that is indistinguishable from success to any caller reading `state` alone: the
     * converter recorded success and wrote nothing. Reported as `failed` with a sentence, because the
     * alternative is an assistant telling a user the file is ready and attaching nothing.
     */
    const job = await sql.query<{ id: string }>(
      `insert into public.media_conversion_jobs (workspace_id, source_path, target, status, result_path)
       values ($1::uuid, $2, 'mp4', 'succeeded', null) returning id`,
      [workspaceId, `${workspaceId}/nowhere.mov`],
    );
    const outcome = await media().getConversion(context(), { jobId: job[0]!.id as never });
    expect(outcome.state).toBe("failed");
    expect(outcome.failure).toContain("recorded no output file");
  });

  it("reads another workspace's conversion as not-found", async () => {
    const foreign = await sql.query<{ id: string }>(
      "insert into public.workspaces (name) values ($1) returning id",
      ["media-conversion-foreign"],
    );
    const job = await sql.query<{ id: string }>(
      `insert into public.media_conversion_jobs (workspace_id, source_path, target, status)
       values ($1::uuid, 'x.mov', 'mp4', 'queued') returning id`,
      [foreign[0]!.id],
    );
    try {
      const error = thrown(
        await media().getConversion(context(), { jobId: job[0]!.id as never }).catch((r: unknown) => r),
      );
      expect(error.code).toBe("not_found");
    } finally {
      await sql.query("delete from public.workspaces where id = $1::uuid", [foreign[0]!.id]);
    }
  });
});

describe.skipIf(URL_ === undefined)("EngagementService.draftReply — the review step (#190)", () => {
  /**
   * `POST /reply` and `reply_to_comment` are two capabilities. This is the first: it drafts and sends
   * nothing, leaving the comment in `needs_review` — the state that exists so a person looks before anything
   * reaches a customer's audience. Mapping the two together would have claimed that step survived the
   * migration.
   */
  const engagement = () => createPostgresEngagementService({ sql, transaction });

  const comment = async (status: string) => {
    const row = await sql.query<{ id: string }>(
      `insert into public.inbox_comments
         (workspace_id, platform, author_name, content, reply_status)
       values ($1::uuid, 'linkedin', 'A reader', 'Is this available in the EU?', $2) returning id`,
      [workspaceId, status],
    );
    return row[0]!.id;
  };

  it("writes the draft and leaves it for a person", async () => {
    const id = await comment("needs_review");
    const drafted = await engagement().draftReply(context(), {
      idempotencyKey: "dr1" as never,
      commentId: id as never,
      text: "Yes — we ship to the EU, and duties are included.",
    });
    expect(drafted.replyState).toBe("needs-review");
    expect(drafted.draftedReply).toContain("we ship to the EU");

    // Nothing was sent: the row is still awaiting review, with no replied_at.
    const row = await sql.query<{ reply_status: string; replied_at: string | null }>(
      "select reply_status, replied_at from public.inbox_comments where id = $1::uuid",
      [id],
    );
    expect(row[0]?.reply_status).toBe("needs_review");
    expect(row[0]?.replied_at).toBeNull();
  });

  it("puts a dismissed comment back in the queue", async () => {
    /**
     * Drafting a reply to something previously set aside is a decision to look at it again. Leaving it
     * `dismissed` would hide the draft from the only screen that shows drafts — the assistant would report
     * writing one and nobody would ever see it.
     */
    const id = await comment("dismissed");
    const drafted = await engagement().draftReply(context(), {
      idempotencyKey: "dr2" as never,
      commentId: id as never,
      text: "Sorry for the delay — here is the answer.",
    });
    expect(drafted.replyState).toBe("needs-review");
  });

  it("refuses to draft over a reply that was already sent", async () => {
    // A draft written over sent text would overwrite what actually went out and make the record read as
    // though nobody had answered.
    for (const sent of ["sent", "auto_sent"]) {
      const id = await comment(sent);
      const error = thrown(
        await engagement()
          .draftReply(context(), { idempotencyKey: `dr-${sent}` as never, commentId: id as never, text: "hello" })
          .catch((r: unknown) => r),
      );
      expect(error.code, sent).toBe("conflict");
      expect(error.message, sent).toContain("hide the reply that was sent");
    }
  });

  it("refuses an empty draft", async () => {
    const id = await comment("needs_review");
    const error = thrown(
      await engagement()
        .draftReply(context(), { idempotencyKey: "dr4" as never, commentId: id as never, text: "   " })
        .catch((r: unknown) => r),
    );
    expect(error.code).toBe("invalid_input");
  });
});
