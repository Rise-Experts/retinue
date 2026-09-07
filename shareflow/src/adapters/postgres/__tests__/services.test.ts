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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentPlatformError } from "@retinue/agentkit";
import { createPoolOpener, createTransactionScope, type TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { createPostgresBrandService, BRAND_SUPPORTED } from "../brand.js";
import { SWEEP_ALERT_MS, SWEEP_WORST_CASE_MS, UNCHECKED_CODES } from "../publishing.js";
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
import { createModelContentGenerator } from "../../model/generator.js";
import { BACKED_SERVICES, UNBACKED_SERVICES, backedContextProviders, createShareFlowServices } from "../../index.js";
import { createShareFlowApp } from "../../../app/index.js";
import {
  CAMPAIGN_TOOL_FACTORIES,
  GENERATE_TOOL_FACTORIES,
  MEDIA_TOOL_FACTORIES,
  POSTS_TOOL_FACTORIES,
} from "../../../tools/index.js";
import { POST_DRAFT_STATUSES, PUBLISH_TARGET_STATES } from "../../../services/index.js";
import type { ShareFlowServices } from "../../../services/index.js";

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


describe.skipIf(URL_ === undefined)("PublishingService — the first adapter that writes outside the tenant", () => {
  /**
   * The fourth adapter, and the first whose methods are `external-write`. Everything before it was `read` or
   * `internal-write`, so a shadow run's suppressed-write list was correctly empty and the parity diff had no
   * signal. This is where the signal comes from — and where a mistake reaches a customer's audience.
   */
  const publishing = () =>
    createShareFlowServices({ sql: sql as never, transaction, generate: (async () => ({})) as never }).publishing;
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
     * The row and not a queue job, deliberately. ShareFlow's route inserts *and* enqueues; reaching Redis
     * from this package would add a queue dependency the boundary rules forbid and make this a second
     * producer for a queue ShareFlow owns — where the sweep's whole safety argument rests on `jobId` being
     * the item id.
     *
     * The cost is real and quantified: `SWEEP_WORST_CASE_MS`, the grace period plus a cron tick.
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
    // No job id: this adapter does not enqueue, and a fabricated one would collide with the sweep's.
    expect(rows[0]!.job_id).toBeNull();
    expect(SWEEP_WORST_CASE_MS).toBe(6 * 60_000);
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

describe.skipIf(URL_ === undefined)("wiring the three, which is what makes them reachable", () => {
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
     * `shareFlowBaseContextProviders` includes `accounts`, which calls `services.connectors.listAccounts` on
     * every turn — and there is no connector adapter. `backend/src/context/assembler.ts:35` runs providers in
     * a bare `for` loop with no `try`, so one that throws aborts the assembly and with it the turn.
     *
     * This asserts the narrower list actually *runs* against the live database, which is the only way to know
     * none of the three reaches a service that is not there.
     */
    const services = createShareFlowServices({ sql: sql as never, transaction, generate: (async () => ({})) as never });
    const providers = backedContextProviders(services);
    expect(providers.map((provider) => provider.id)).toEqual([
      "shareflow.brand",
      "shareflow.claims",
      "shareflow.audience",
    ]);
    for (const provider of providers) {
      const sections = await provider.provide(context());
      expect(Array.isArray(sections)).toBe(true);
    }
  });

  it("builds a real ShareFlow app from three services and the factories that read them", async () => {
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
    const services = createShareFlowServices({ sql: sql as never, transaction, generate: (async () => ({})) as never });
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
    expect(tools).toHaveLength(12);
    expect(tools.map((registered) => registered.descriptor.name)).toContain("create_post_draft");
    expect(tools.map((registered) => registered.descriptor.name)).toContain("generate_content");
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

  it("refuses an app whose factory list needs a service it does not have", () => {
    /**
     * The other half, and the one that makes the first half safe: a factory whose service is absent fails
     * **here**, naming the tools, rather than at the moment a user asks for something.
     *
     * This test named the *publishing* factories until `PublishingService` was built, at which point the
     * configuration became legitimate and the test correctly stopped throwing. Media is the next one with no
     * adapter — and the fact this had to be updated is the mechanism working: a service becoming available
     * changes what a deployment may register.
     */
    const services = createShareFlowServices({ sql: sql as never, transaction, generate: (async () => ({})) as never });
    expect(() =>
      createShareFlowApp({
        services,
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
    expect(all).toHaveLength(10);
    // Each name is a real member — the length check alone would accept ten wrong names.
    const backed = createShareFlowServices({ sql: sql as never, transaction, generate: (async () => ({})) as never });
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

describe("ContentGenerator over a model", () => {
  const generator = (reply: unknown) =>
    createModelContentGenerator({
      generate: (async () => reply) as never,
      brand: async () => ({ brandName: "Acme", voice: "wry" }),
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
