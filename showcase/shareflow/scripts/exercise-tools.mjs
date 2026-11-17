/**
 * Exercise **every** registered tool against a real database, through the real composition.
 *
 * Not a sample. The plan below is checked against the registry's own list and this script fails if a
 * single tool is missing from it, so a tool added without a line here cannot slip through untested.
 * That is the whole point: the defects found on 2026-09-09 were all "built, tested and unreachable",
 * and every one of them passed the unit suite. A unit test proves a tool works when called; this proves
 * the tool can be *reached* through the composed registry with the services a deployment actually wires.
 *
 * What it does NOT do: perform an external effect. The seven tools whose `approvalPolicy` is `always`
 * — publish, schedule, repost, retry, reply, delete, and the storage probe — are executed **without a
 * grant**, and the assertion is that each is refused with `approval_required`. That is the safety
 * property worth testing, and it is stronger than skipping them: a gate that stopped working would fail
 * this script rather than publish to a real account.
 *
 * Usage, against a local Postgres carrying the `retinue` schema and this app's tables (see
 * README → "Running the whole thing locally"):
 *
 *     RETINUE_DATABASE_URL=postgres://postgres:trace@127.0.0.1:55987/shareflow \
 *     RETINUE_DATABASE_SCHEMA=retinue \
 *     RETINUE_MODEL_API_KEY=… RETINUE_MODEL_PROVIDER=google \
 *     node scripts/exercise-tools.mjs
 *
 * Outcomes, and which of them are failures:
 *
 *     ok            ran and returned a result
 *     gated         a policy-gated tool refused for want of approval — expected, and asserted
 *     refused       returned a structured error: not_found, invalid_input, capability_unavailable…
 *                   Legitimate. A deployment without a media store or a search key refuses BY NAME,
 *                   and refusing is the documented behaviour rather than a fault.
 *     FAIL          unknown tool, an unexpected throw, or a gated tool that EXECUTED
 *
 * Exits non-zero on any FAIL or if the plan does not cover the registry.
 */

import { randomUUID } from "node:crypto";

const need = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} is required. See the header of this file.`);
    process.exit(2);
  }
  return value;
};

const databaseUrl = need("RETINUE_DATABASE_URL");
const schema = process.env["RETINUE_DATABASE_SCHEMA"] ?? "retinue";

const TENANT = process.env["EXERCISE_TENANT_ID"] ?? "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = process.env["EXERCISE_PRINCIPAL_ID"] ?? "22222222-2222-4222-8222-222222222222";

const { Pool } = await import("pg");
const { createPgExecutor, createPoolOpener, createTransactionScope } = await import(
  "@retinue/agentkit/adapters/postgres"
);
const { createApprovalGate } = await import("@retinue/agentkit/hitl");
const {
  createPostgresApprovalGrantStore,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
} = await import("@retinue/agentkit/adapters/postgres");

const { composeShareFlowApp } = await import("../dist/app/compose.js");
const { shareFlowServicesFrom } = await import("../dist/app/services.js");
const { PLACEHOLDER_AUTHORIZATION, structuredGenerateFrom, webToolkitFrom } = await import(
  "../dist/app/deployment.js"
);
const { SHAREFLOW_TOOL_FACTORIES } = await import("../dist/tools/index.js");

/**
 * The same wiring the worker builds, including the search path.
 *
 * `scope.scoped(...)` on the executor and `scope.runner` for transactions, which is the pairing
 * `main.ts` uses — a runner whose transactions no plain query joins is how `publish-once` silently
 * stops being once.
 */
const searchPath = `${schema},public`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${searchPath}` });
const scope = createTransactionScope(createPoolOpener(pool, searchPath));
const sql = scope.scoped(createPgExecutor(pool));

const web = await webToolkitFrom(process.env);
const generate = await structuredGenerateFrom(process.env);
const gate = createApprovalGate({
  grants: createPostgresApprovalGrantStore(sql),
  interactions: createPostgresInteractionStore(sql),
});

const { registry } = composeShareFlowApp({
  sql,
  runner: scope.runner,
  authorization: PLACEHOLDER_AUTHORIZATION,
  services: shareFlowServicesFrom({
    sql,
    transaction: scope.runner,
    search: web.search,
    fetchPage: web.fetchPage,
    generate,
    env: process.env,
  }),
  deps: {
    authorization: PLACEHOLDER_AUTHORIZATION,
    idempotency: createPostgresIdempotencyStore(sql),
    approvals: gate,
  },
  approval: gate,
  factories: SHAREFLOW_TOOL_FACTORIES,
});

/**
 * A fresh `runId` every run, and it is not cosmetic — without it this whole sweep was a replay.
 *
 * `deriveCallIdempotencyKey` builds its key from `{ tenantId, runId, toolName, args }`. This context
 * had no `runId`, so the key came out as `<tenant>:-:<tool>:<args>` — with an empty slot where the run
 * belongs — and since the fixtures below are constant, every key was **identical across runs**. The
 * idempotency store then did exactly its job and replayed the first run's recorded result.
 *
 * The effect was a sweep that looked better the less it did. Measured: `create_post_draft` and
 * `create_campaign` reported `ok` with ids `322349f6…` and `3f15d5c6…` on every run — the same ids
 * each time, which is the tell, since a fresh insert would get a fresh uuid — while
 * `select count(*) from public.posts where id = '322349f6…'` returned **0**. The rows had been created
 * once, cleaned up, and never created again. `get_campaign` was replayed too, so it cheerfully
 * returned a campaign that no longer existed, and only the tools whose keys happened to differ —
 * `attach_media_to_post`, `evaluate_campaign` — actually touched the database and correctly said
 * `not_found`. Those three "failures" were the only three tools telling the truth.
 *
 * A per-run id fixes it at the root and is also what production does: the engine sets `runId` on every
 * turn, so keys are per-run there and this was a gap in the harness rather than in the platform.
 */
const context = {
  tenantId: TENANT,
  principalId: PRINCIPAL,
  roleIds: ["editor"],
  locale: "en",
  timezone: "UTC",
  runId: `exercise-${randomUUID()}`,
  requestId: `exercise-${randomUUID()}`,
};

/** Ids discovered or created as the plan runs, so later tools get real ones. */
const found = {};

/**
 * Two media assets, seeded so the media tools have something real to work on.
 *
 * Without this, eight tools ran against `randomUUID()` and came back `not_found` — which proves the
 * lookup path and nothing else. `inspect_media`, `attach_media_to_post`, `detach_media_from_post`,
 * `replace_media_on_post` and `convert_media` all need an asset that exists, and `replace` needs
 * *two*, since swapping one id for the same id is not a swap.
 *
 * Rows rather than uploads: `generated_assets` is the table `MediaService` reads (`media.ts` queries
 * `public.generated_assets` directly), and its `job_id` and `workspace_id` are both foreign keys, so a
 * `generation_jobs` row comes first. Nothing is written to object storage — every tool here either
 * reads metadata or refuses for want of a media store, and the ones that would fetch bytes are
 * reported as such rather than pretended to work.
 *
 * Idempotent, and cleaned up at the end: this script is run by hand against a real database, and one
 * that accumulated fixtures on every run would slowly change the thing it is measuring.
 */
const seeded = {
  jobId: randomUUID(),
  assetIds: [randomUUID(), randomUUID()],
  objectIds: [randomUUID(), randomUUID()],
};

const seedMedia = async () => {
  const workspace = await sql.query("select id from public.workspaces where id = $1::uuid", [TENANT]);
  if (workspace.length === 0) {
    console.warn(
      `\nNo workspace ${TENANT}, so the media tools will run against ids that do not exist and report ` +
        `not_found. Set EXERCISE_TENANT_ID to a real workspace to exercise them properly.`,
    );
    return;
  }
  await sql.query(
    `insert into public.generation_jobs (id, workspace_id, kind, prompt, params, status, created_at, updated_at)
     values ($1::uuid, $2::uuid, 'image', 'exercise fixture', '{}'::jsonb, 'succeeded', now(), now())
     on conflict (id) do nothing`,
    [seeded.jobId, TENANT],
  );
  for (const [index, id] of seeded.assetIds.entries()) {
    /**
     * A path unique to this run, which the first version was not.
     *
     * It was `${TENANT}/exercise/fixture-1.png` with a fresh `storage.objects` uuid each run, so a run
     * whose cleanup did not complete left a second row with the *same name*. `attach_media_to_post`
     * joins assets to storage on `o.name = a.storage_path` and then compares `resolved.length` to the
     * number of ids asked for — with three same-named object rows, one asset resolved to three rows,
     * the counts disagreed, and the tool refused with "These assets are not attachable: ." naming
     * nothing at all. Two hours of that error pointing at the wrong thing is what unique paths cost.
     */
    const path = `${TENANT}/exercise/${seeded.jobId}/fixture-${index + 1}.png`;
    await sql.query(
      `insert into public.generated_assets (id, job_id, workspace_id, storage_path, mime, width, height, created_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, 'image/png', 1080, 1080, now())
       on conflict (id) do nothing`,
      [id, seeded.jobId, TENANT, path],
    );
    /**
     * And the storage row, because `listMedia` **inner** joins `storage.objects`.
     *
     * Deliberate on the adapter's part — "an asset whose object is gone cannot be published, so listing
     * it would offer a model something that cannot work" — and the first version of this seed inserted
     * only the `generated_assets` row, so every media tool still reported `not_found` and the seeding
     * looked like it had failed. The join is also where `bytes` comes from (`metadata->>'size'`), which
     * `check_media_for_platforms` needs in order to say anything true about a platform's limits.
     */
    await sql.query(
      `insert into storage.objects (id, bucket_id, name, metadata, created_at)
       values ($1::uuid, 'media', $2, $3::jsonb, now())
       on conflict (id) do nothing`,
      [seeded.objectIds[index], path, JSON.stringify({ size: 245_760, mimetype: "image/png" })],
    );
  }
  found.mediaAssetId = seeded.assetIds[0];
  found.secondMediaAssetId = seeded.assetIds[1];
};

/**
 * Everything this run put in the database, removed.
 *
 * Not only the seeded media. The sweep *writes*: `create_post_draft`, `duplicate_post_draft`,
 * `create_campaign`, `create_lead` and `create_artifact` all leave rows behind, and three runs took
 * this workspace from five post drafts to eight. That matters more than tidiness — the tools whose
 * fixtures read "the first row of the list" would start reading a previous run's leftovers, so the
 * sweep would be measuring itself, and the numbers would drift for reasons nobody would connect to
 * this script. A repeatable measurement has to leave the workspace as it found it.
 *
 * Deleted by the ids this run recorded, never by a `like 'Exercise%'` pattern: a pattern would reach
 * rows a person happened to name the same way, and this runs against real databases.
 *
 * Every statement is individually guarded. A cleanup that throws would replace the sweep's result
 * with its own stack trace, which is the one outcome worse than leaving a row behind.
 */
const cleanUp = async () => {
  const posts = [found.createdPostId, found.duplicatedPostId].filter((id) => typeof id === "string");
  const statements = [
    // By id *and* by name: an interrupted run leaves a row whose id this process never knew, and a
    // same-named leftover is what breaks the join above.
    ["delete from storage.objects where id = any($1::uuid[])", [seeded.objectIds]],
    ["delete from storage.objects where bucket_id = 'media' and name like $1", [`%/exercise/${seeded.jobId}/%`]],
    ["delete from public.generated_assets where id = any($1::uuid[])", [seeded.assetIds]],
    ["delete from public.generation_jobs where id = $1::uuid", [seeded.jobId]],
    ...(posts.length === 0 ? [] : [["delete from public.posts where id = any($1::uuid[])", [posts]]]),
    ...(typeof found.createdCampaignId === "string"
      ? [["delete from public.campaigns where id = $1::uuid", [found.createdCampaignId]]]
      : []),
    ...(typeof found.createdLeadId === "string"
      ? [["delete from public.leads where id = $1::uuid", [found.createdLeadId]]]
      : []),
    ...(typeof found.createdLinkId === "string"
      ? [["delete from public.short_links where id = $1::uuid", [found.createdLinkId]]]
      : []),
  ];
  for (const [statement, params] of statements) {
    try {
      await sql.query(statement, params);
    } catch (error) {
      console.warn(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

await seedMedia();

const FIRST = { kind: "first" };

/**
 * The plan: one entry per tool, in dependency order.
 *
 * `input` may be a function, called with the ids gathered so far — that is how `get_post_draft` reads
 * the draft `create_post_draft` just made instead of a fixture id that would only prove `not_found`
 * works.
 *
 * `keep` pulls an id out of a result for later entries.
 */
const PLAN = [
  // ---- accounts: no prerequisites, and they supply the account ids everything else needs.
  { name: "list_accounts", input: {}, keep: (data) => { found.accountIds = (data?.accounts ?? []).map((a) => a.accountId); } },
  { name: "get_connection_setup", input: {} },
  { name: "check_account_health", input: () => ({ accountIds: (found.accountIds ?? []).slice(0, 2) }) },

  // ---- posts
  { name: "list_post_drafts", input: { page: FIRST }, keep: (data) => { found.postDraftId = data?.posts?.[0]?.postDraftId; } },
  {
    name: "create_post_draft",
    input: {
      // Five hashtags, because instagram's rules require at least five and `validate_publish`
      // enforces them on save. Three was a fixture that only ever proved the validator works.
      caption:
        "Exercise draft — written by scripts/exercise-tools.mjs. " +
        "#coffee #roast #filter #singleorigin #specialtycoffee",
      targetPlatforms: ["instagram"],
      campaign: { kind: "none" },
    },
    keep: (data) => { found.createdPostId = data?.postDraftId ?? data?.id; },
  },
  { name: "get_post_draft", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },
  {
    name: "update_post_draft",
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      caption: "Exercise draft, updated. #coffee #roast #filter #singleorigin #specialtycoffee",
    }),
  },
  {
    name: "duplicate_post_draft",
    input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }),
    keep: (data) => { found.duplicatedPostId = data?.postDraftId ?? data?.id; },
  },
  // A thread — #456. Two parts, because one part is a post and the tool refuses it.
  {
    name: "create_thread_draft",
    input: {
      parts: [{ body: "We cupped eleven samples this week." }, { body: "Two made it. The rest were good, not right." }],
      targetPlatforms: ["x"],
      campaign: { kind: "none" },
    },
  },
  { name: "propose_post_angles", input: { brief: "a single-origin Ethiopian filter coffee", count: 2 } },
  { name: "generate_content", input: { brief: "the Guji lot has landed", platformIds: ["instagram"] } },
  // #496: one draft, a caption per channel — writes, so it is exercised against a scratch workspace like create_post_draft.
  { name: "draft_post_for_channels", input: { brief: "the Guji lot has landed", platformIds: ["instagram", "linkedin"] } },
  // #523: outside a project the list is empty and attaching refuses by name — both are answers.
  { name: "list_project_assets", input: {} },
  { name: "render_post_template", input: () => ({ template: "quote", text: "Exercise run: a quote card." }) },
  { name: "attach_uploaded_media", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId, paths: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301/exercise.png"] }) },
  { name: "update_project", input: () => ({ instructions: "Exercise run: never used." }) },
  { name: "propose_project_setup", input: () => ({ instructions: "Exercise run.", sources: ["https://example.com"] }) },
  { name: "extract_brand_kit", input: () => ({ url: "https://example.com" }) },
  { name: "remember_project_rule", input: () => ({ rule: "Exercise run: never used." }) },
  // #621: stored for the exercising principal only, then forgotten again so the run leaves nothing behind.
  { name: "remember_about_me", input: () => ({ memory: "Exercise run: never used." }) },
  { name: "forget_about_me", input: () => ({ text: "Exercise run: never used." }) },
  // #630: a ref that exists nowhere is refused as not found — the answer that proves the service is wired.
  { name: "recall_tool_result", input: { ref: "msg_exercise#call_exercise" } },
  // #641: an empty change is refused by name — the answer that proves the tool is wired, and writes nothing.
  { name: "update_brand_profile", input: {} },
  { name: "attach_project_asset", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId, projectAssetId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }) },
  {
    name: "revise_post_channels",
    input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId, instruction: "make it shorter", platformIds: ["linkedin"] }),
  },
  // One destination, several versions — the opposite of the line above, and the distinction REQ-014 turns on.
  { name: "generate_alternatives", input: { brief: "the Guji lot has landed", platformId: "instagram", count: 2 } },
  // `research: false` so the exercise does not depend on a live search provider being configured.
  { name: "research_hashtags", input: { topic: "single-origin filter coffee", platformId: "instagram", count: 3, research: false } },
  {
    name: "repurpose_source",
    input: { sourceText: "The Guji lot landed Tuesday and was roasted Thursday.", platformIds: ["linkedin"], count: 1 },
  },
  // One of each format — #458. The whole point is that the three arms come back in one call.
  {
    name: "repurpose_to_formats",
    input: {
      sourceText: "The Guji lot landed Tuesday and was roasted Thursday. We cupped it twice before saying yes.",
      platformIds: ["linkedin"],
      posts: 1,
      threads: 1,
      scripts: 1,
    },
  },

  // ---- campaigns
  { name: "list_campaigns", input: { page: FIRST }, keep: (data) => { found.campaignId = data?.campaigns?.[0]?.campaignId; } },
  {
    name: "create_campaign",
    input: {
      name: "Exercise campaign",
      theme: "single-origin filter coffee",
      startsOn: "2026-10-01",
      endsOn: "2026-10-14",
      cadence: "weekly", // an enum string — daily | 3x-week | weekly — not an object
      channels: ["instagram"],
    },
    keep: (data) => { found.createdCampaignId = data?.campaignId ?? data?.id; },
  },
  { name: "get_campaign", input: () => ({ campaignId: found.createdCampaignId ?? found.campaignId }) },
  {
    name: "update_campaign",
    input: () => ({ campaignId: found.createdCampaignId ?? found.campaignId, goal: "awareness" }),
  },
  {
    name: "get_campaign_calendar",
    input: () => ({ campaignId: found.createdCampaignId ?? found.campaignId, page: FIRST }),
  },
  { name: "suggest_campaign_ideas", input: { theme: "filter coffee", count: 2 } },
  { name: "generate_campaign", input: { theme: "filter coffee", postCount: 2, platformIds: ["instagram"] } },
  { name: "evaluate_campaign", input: () => ({ campaignId: found.createdCampaignId ?? found.campaignId }) },

  // ---- analytics
  { name: "get_post_metrics", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },
  { name: "get_campaign_metrics", input: () => ({ campaignId: found.createdCampaignId ?? found.campaignId }) },
  // Exactly one of postDraftId | campaignId, and `{}` is not "both unset" to this schema.
  { name: "get_attribution", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },

  // ---- engagement
  { name: "list_comments", input: { page: FIRST }, keep: (data) => { found.commentId = data?.comments?.[0]?.commentId; } },
  {
    name: "draft_comment_reply",
    input: () => ({ commentId: found.commentId, text: "Exercise draft reply — not sent." }),
  },
  {
    name: "draft_auto_reply",
    // `comment` is the comment's text, a string. The surrounding metadata goes in its own fields.
    input: {
      comment: "Do you ship to Austria?",
      rules: [{ title: "Shipping", description: "We ship across the EU; delivery is 2-4 working days." }],
      tone: "warm and brief",
      accountName: "Exercise Roastery",
    },
  },
  { name: "dismiss_comment", input: () => ({ commentId: found.commentId }) },

  // ---- leads
  { name: "list_leads", input: { page: FIRST }, keep: (data) => { found.leadId = data?.leads?.[0]?.leadId; } },
  {
    name: "create_lead",
    // `attribution` takes no `kind` and needs at least one of postDraftId|campaignId|commentId|platformId.
    input: () => ({
      name: "Exercise Lead",
      email: "exercise@example.com",
      attribution: { platformId: "instagram" },
    }),
    keep: (data) => { found.createdLeadId = data?.leadId ?? data?.id; },
  },
  { name: "update_lead", input: () => ({ leadId: found.createdLeadId ?? found.leadId, status: "contacted" }) },

  // ---- links (#424)
  //
  // Created first, then read: `get_link_performance` on a workspace with no tracked links is a
  // truthful empty answer and tells us nothing about whether the query works.
  {
    name: "create_tracked_link",
    input: () => ({
      destinationUrl: "northwind.studio/exercise",
      title: "Exercise link",
      ...(typeof found.postDraftId === "string" ? { postId: found.postDraftId } : {}),
    }),
    keep: (data) => { found.createdLinkId = data?.linkId; },
  },
  { name: "list_tracked_links", input: { limit: 5 } },
  {
    name: "get_link_performance",
    // A window wide enough to contain the link just minted, which has no clicks — the point is that
    // the query runs and reports zero, not that it finds traffic.
    input: () => ({ since: "2020-01-01", limit: 5, ...(found.createdLinkId ? { linkId: found.createdLinkId } : {}) }),
  },

  // ---- schedules (#425)
  //
  // Reads only. `create_recurring_schedule` publishes on every occurrence and `cancel_...` removes a
  // rule; exercising either against a real workspace would schedule real posts or delete someone's
  // schedule, which is not what a smoke run is for. Both are listed as skipped rather than omitted,
  // so the coverage check still sees them and nobody concludes they were forgotten.
  { name: "list_schedules", input: { limit: 5 }, keep: (data) => { found.scheduleId = data?.schedules?.[0]?.scheduleId; } },
  { name: "list_time_slots", input: {} },
  { name: "suggest_publish_time", input: { sinceDays: 90 } },
  { name: "create_recurring_schedule", skip: "creates real recurring posts" },
  // #496: skipped rather than run — it spends the person's Higgsfield credits or the workspace's Chorus
  // credits on every smoke run. Its contract is proven by the tool tests and a recorded live generation.
  { name: "generate_media", skip: "spends real generation credits" },
  { name: "check_media_job", skip: "needs a job generate_media started" },
  { name: "cancel_recurring_schedule", skip: "deletes a real schedule" },

  // ---- insights (#426)
  //
  // `start_campaign_from_template` is skipped: it creates a real campaign, and a smoke run that
  // leaves one behind every time is a smoke run people stop reading. The other three are reads.
  { name: "list_campaign_templates", input: {}, keep: (data) => { found.templateKey = data?.templates?.[0]?.key; } },
  /*
   * Not skipped, though it creates a campaign — #426's third acceptance is that this tool is
   * *exercised*, and `create_campaign` twenty lines up creates one too and has always run. Skipping
   * this one "because it creates a real campaign" drew a line the plan does not draw anywhere else,
   * and left the one tool whose whole job is the template path unexercised while an entry in the
   * plan made it look covered.
   *
   * It is also the entry that would have caught the cadence bug: the template's stored `3x_week`
   * went to `createCampaign`, which takes `3x-week`, and the insert failed the column's own CHECK.
   */
  {
    name: "start_campaign_from_template",
    input: () => ({
      templateKey: found.templateKey ?? "product_launch",
      name: "Exercise template campaign",
      theme: "the spring lot",
      startsOn: "2026-10-01",
      endsOn: "2026-10-14",
    }),
    keep: (data) => { found.templateCampaignId = data?.campaignId ?? data?.campaign?.id; },
  },
  { name: "get_daily_rollup", input: { since: "2020-01-01" } },
  // A window that certainly has no data before it, so the `noPriorWindowReason` branch is the one
  // exercised — which is the half of this tool that #426 cares about.
  { name: "compare_periods", input: { since: "2020-01-01", until: "2020-02-01" } },

  // ---- media
  { name: "list_media", input: { page: FIRST }, keep: (data) => {
      // Only if the workspace has one of its own: the seeded pair is the fallback, not the other way
      // round, so a real asset is preferred and an empty list does not undo the seed.
      const first = data?.media?.[0]?.mediaAssetId;
      if (first !== undefined) found.mediaAssetId = first;
      const second = data?.media?.[1]?.mediaAssetId;
      if (second !== undefined) found.secondMediaAssetId = second;
    } },
  { name: "inspect_media", input: () => ({ mediaAssetId: found.mediaAssetId ?? randomUUID() }) },
  {
    name: "check_media_for_platforms",
    input: () => ({ mediaAssetIds: [found.mediaAssetId ?? randomUUID()], platformIds: ["instagram"] }),
  },
  {
    name: "attach_media_to_post",
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      mediaAssetIds: [found.mediaAssetId ?? randomUUID()],
    }),
  },
  {
    name: "detach_media_from_post",
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      mediaAssetIds: [found.mediaAssetId ?? randomUUID()],
    }),
  },
  {
    name: "replace_media_on_post",
    // `remove` and `add` are single asset ids — one swap per call, not two lists.
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      remove: found.mediaAssetId ?? randomUUID(),
      add: found.secondMediaAssetId ?? found.mediaAssetId ?? randomUUID(),
    }),
  },
  { name: "convert_media", input: () => ({ mediaAssetId: found.mediaAssetId ?? randomUUID(), targetFormat: "mp4" }) },
  { name: "check_conversion", input: () => ({ jobId: found.conversionJobId ?? randomUUID() }) },
  { name: "enhance_media_prompt", input: { brief: "a coffee bag on a wooden table", kind: "image" } },
  { name: "plan_video_scenes", input: { concept: "a roastery tour", sceneCount: 2 } },
  /**
   * A URL that 404s, **on purpose** — this is the negative path and it is the one worth proving.
   *
   * `describe_image` and `read_pdf` both fetch remote bytes, and the failure that matters is a fetch
   * that does not return what was promised: a link the model read off a page, a file that moved. What
   * is asserted here is that such a call comes back as a typed `provider_error` saying "That URL
   * answered 404" rather than throwing and taking the turn down with it. Pointing these at live
   * third-party files would make the sweep depend on someone else's uptime and would exercise less.
   */
  { name: "describe_image", input: { source: { kind: "url", url: "https://example.com/nonexistent.png" } } },
  { name: "render_diagram", input: { diagram: "graph TD\n  A[Draft] --> B[Review]" } },
  { name: "render_code_snippet", input: { code: "const answer = 42;\nconsole.log(answer);", title: "answer.ts" } },
  { name: "plan_visuals", input: { brief: "autumn menu launch", images: 2, channel: "instagram", reelScenes: 3 } },
  { name: "attach_artifact_to_post", input: { artifactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", postDraftId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302" } },

  // ---- artifacts
  {
    name: "create_artifact",
    input: { title: "Exercise artifact", kind: "markdown", content: "# Exercise\n\nWritten by the tool sweep." },
    keep: (data) => { found.artifactId = data?.artifactId ?? data?.id; },
  },
  { name: "get_artifact", input: () => ({ artifactId: found.artifactId ?? randomUUID() }) },
  {
    name: "update_artifact",
    input: () => ({ artifactId: found.artifactId ?? randomUUID(), content: "# Exercise\n\nRevised." }),
  },
  // `kind` is text|markdown|html|media — there is no `artifact` kind, and `source` is required.
  {
    name: "generate_pdf",
    input: () => ({ kind: "markdown", source: "# Exercise\n\nA one-page document, rendered to check the pipeline." }),
  },

  // ---- research
  { name: "search_web", input: { query: "specialty coffee", maxResults: 3 } },
  { name: "read_source", input: { url: "https://example.com" } },
  { name: "read_pdf", input: { source: { kind: "url", url: "https://example.com/nonexistent.pdf" } } }, // see describe_image
  { name: "capture_website", input: { url: "https://example.com" } },
  /*
   * #615: without PEXELS_API_KEY both refuse by name ("set PEXELS_API_KEY"), which is the answer worth seeing
   * on a deployment that has not enabled stock media. With a key, one search (one request against the hourly
   * limit) and an import of an id that does not exist, so nothing is stored.
   */
  { name: "search_stock_media", input: { query: "coffee shop", kind: "photo", count: 3 } },
  { name: "import_stock_media", input: { pexelsId: "1", kind: "photo" } },

  // ---- publishing: the read-only half runs, the rest is gated below.
  {
    name: "validate_publish",
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      accountIds: (found.accountIds ?? []).slice(0, 1),
    }),
  },
  { name: "get_publish_status", input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },

  // ---- gated: executed WITHOUT a grant, and expected to refuse. Nothing here reaches a platform.
  {
    name: "publish_post_now",
    gated: true,
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      accountIds: (found.accountIds ?? []).slice(0, 1),
    }),
  },
  {
    name: "schedule_post",
    gated: true,
    input: () => ({
      postDraftId: found.createdPostId ?? found.postDraftId,
      accountIds: (found.accountIds ?? []).slice(0, 1),
      scheduledAt: "2027-01-01T09:00:00.000Z",
    }),
  },
  { name: "repost_post", gated: true, input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },
  { name: "retry_publish_target", gated: true, input: () => ({ publishTargetId: randomUUID() }) },
  {
    name: "reply_to_comment",
    gated: true,
    input: () => ({ commentId: found.commentId ?? randomUUID(), text: "Exercise reply — must not be sent." }),
  },
  { name: "check_media_storage", gated: true, input: {} },
  { name: "delete_post", gated: true, input: () => ({ postDraftId: found.createdPostId ?? found.postDraftId }) },
];

// ---------------------------------------------------------------- coverage

// `listAuthorized` is the registry's own name for "every tool this caller may use, with schemas".
const registered = (await registry.listAuthorized(context)).map((descriptor) => descriptor.name);
const planned = new Set(PLAN.map((entry) => entry.name));
const missing = registered.filter((name) => !planned.has(name));
const unknown = [...planned].filter((name) => !registered.includes(name));

if (missing.length > 0 || unknown.length > 0) {
  if (missing.length > 0) console.error(`\nNOT EXERCISED (${missing.length}): ${missing.join(", ")}`);
  if (unknown.length > 0) console.error(`\nPLANNED BUT NOT REGISTERED (${unknown.length}): ${unknown.join(", ")}`);
  console.error("\nEvery registered tool needs a line in PLAN — that is what makes this a sweep.");
  await pool.end();
  process.exit(1);
}

// ---------------------------------------------------------------- run

const resolve = (input) => {
  const value = typeof input === "function" ? input() : input;
  if (value === null || typeof value !== "object") return value;
  // A nested thunk, for `generate_pdf`'s `source`.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === "function" ? entry() : entry]),
  );
};

const rows = [];
let failures = 0;

for (const entry of PLAN) {
  const started = Date.now();
  let outcome;
  let detail = "";

  /*
   * Deliberately not called, with the reason printed.
   *
   * A smoke run must not schedule real recurring posts or delete someone's schedule. Listing them as
   * skipped rather than leaving them out keeps the coverage check honest — `exercise-coverage.test.ts`
   * requires an entry for every registered tool, and an omission would read as an oversight while a
   * skip reads as a decision.
   */
  if (typeof entry.skip === "string") {
    results.push({ name: entry.name, outcome: "skipped", detail: entry.skip, ms: 0 });
    console.log(`  ${entry.name.padEnd(28)} skipped — ${entry.skip}`);
    continue;
  }

  try {
    const resolved = resolve(entry.input);
    /**
     * A distinct `idempotencyKey` per call per run, and the sweep is dishonest without it.
     *
     * `createDelegatingTool` falls back to a key of its own when the caller supplies none, and the
     * platform's comment on that fallback says exactly what goes wrong: it is derived from "tenant,
     * conversation, tool and normalised arguments", so it "collides for *any* call with identical
     * arguments **across runs**" and the second call "would return the first result and never
     * publish". It calls this "suppression of an intended action rather than deduplication of a
     * retry".
     *
     * Which is precisely what happened here. The fixtures are constant by design, this context had no
     * conversation id — the `-` in the stored keys `<tenant>:-:create_post_draft:{…}` is that empty
     * slot — so every run produced the same key and the store replayed the first run's result.
     * Measured: `create_post_draft` and `create_campaign` returned `ok` with ids `322349f6…` and
     * `3f15d5c6…` on every run, always the same ids, while `select count(*)` for those ids returned
     * **0**. They had been created once, cleaned up, and never created again. `get_campaign` was
     * replayed too and happily returned a campaign that no longer existed. The only tools telling the
     * truth were the ones whose keys differed and therefore hit the database — which is why
     * `attach_media_to_post` and `evaluate_campaign` looked like the broken ones.
     *
     * So the summary line was inflated by every write tool in the plan. Production does not have this
     * problem: the engine passes the model's `toolCallId`, and the registry derives a run-scoped key
     * from it. The gap was the harness pretending to be a caller without doing what a caller does.
     */
    const result = await registry.execute(context, {
      name: entry.name,
      input: resolved,
      idempotencyKey: `exercise:${context.runId}:${entry.name}`,
    });
    const code = result?.error?.code;
    if (result?.ok === true) {
      outcome = entry.gated === true ? "FAIL" : "ok";
      if (entry.gated === true) detail = "a policy-gated tool EXECUTED without a grant";
      else entry.keep?.(result.data);
    } else if (entry.gated === true) {
      outcome = code === "approval_required" ? "gated" : "FAIL";
      detail = code === "approval_required" ? "refused: approval required" : `expected approval_required, got ${code}: ${result?.error?.message ?? ""}`;
    } else if (code === undefined) {
      outcome = "FAIL";
      detail = "no ok flag and no error code";
    } else if (code === "invalid_input") {
      /**
       * **A failure of this script, not a finding about the tool.**
       *
       * The first run of this sweep reported "20 ok, 7 correctly gated, 31 refused by name, 0 failed"
       * and the 31 read like a deployment with two thirds of its tools unwired. Most of them were
       * `invalid_input`: the fixtures here were written from memory rather than from the schemas, so
       * `keep` callbacks read `data.items[0].id` where the real shape is `data.posts[0].postDraftId`,
       * every downstream id was `undefined`, and the tools correctly rejected the calls. A sweep whose
       * own bad input is filed under "refused" proves nothing at all — it is the same shape as a test
       * that passes for the wrong reason, and it reads as coverage.
       *
       * So it is loud. An `invalid_input` here means: go and read that tool's schema.
       */
      outcome = "FAIL";
      detail = `BAD FIXTURE — ${String(result.error.message ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
    } else {
      outcome = "refused";
      detail = `${code}: ${String(result.error.message ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
    }
  } catch (error) {
    outcome = "FAIL";
    detail = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (outcome === "FAIL") failures += 1;
  rows.push({ name: entry.name, outcome, detail, ms: Date.now() - started });
}

// ---------------------------------------------------------------- report

const width = Math.max(...rows.map((row) => row.name.length));
console.log("");
for (const row of rows) {
  const mark = row.outcome === "FAIL" ? "FAIL " : row.outcome === "ok" ? "ok   " : row.outcome === "gated" ? "gated" : "  -  ";
  console.log(`${mark} ${row.name.padEnd(width)} ${String(row.ms).padStart(6)}ms  ${row.detail}`);
}

const tally = rows.reduce((counts, row) => ({ ...counts, [row.outcome]: (counts[row.outcome] ?? 0) + 1 }), {});
console.log(
  `\n${rows.length} tools exercised — ` +
    `${tally["ok"] ?? 0} ran, ${tally["gated"] ?? 0} correctly gated, ${tally["refused"] ?? 0} refused, ` +
    `${tally["FAIL"] ?? 0} failed.`,
);

/**
 * What is left is a **report about the deployment**, which is the point of the exercise.
 *
 * With bad fixtures counted as failures above, every remaining refusal is the tool's own answer.
 * `capability_unavailable` is the one that matters: it means the tool is registered, described to the
 * model, named by the prompt or a skill — and has nothing behind it. `tools/index.ts` validates
 * `factory.requires` at the *service* level rather than the dependency level, so a tool whose service
 * exists but whose specific function was never passed constructs happily and refuses at execute time,
 * which is exactly the outcome that check's error message promises to prevent.
 */
const byCode = rows
  .filter((row) => row.outcome === "refused")
  .reduce((groups, row) => {
    const code = row.detail.split(":")[0];
    return { ...groups, [code]: [...(groups[code] ?? []), row.name] };
  }, {});

for (const [code, names] of Object.entries(byCode).sort(([, a], [, b]) => b.length - a.length)) {
  console.log(`\n  ${code} (${names.length}): ${names.join(", ")}`);
}

const unwired = byCode["capability_unavailable"] ?? [];
if (unwired.length > 0) {
  console.log(
    `\n  ${unwired.length} tool(s) are registered and advertised with nothing behind them. Each one is a ` +
      `dead end the model can reach: it will call the tool, be refused, and have to tell the user the ` +
      `deployment cannot do a thing the assistant offered.`,
  );
}

/**
 * `EXERCISE_KEEP=1` leaves the rows in place.
 *
 * For the question this script cannot answer about itself: when a tool reports `not_found` for an id
 * another tool just returned, the only way to tell a stale id from an invisible write is to look in the
 * database afterwards. That is how the replayed-idempotency problem above was found.
 */
if (process.env["EXERCISE_KEEP"] === "1") {
  console.log(
    `\nEXERCISE_KEEP=1, so nothing was removed. post=${found.createdPostId ?? "-"} ` +
      `duplicate=${found.duplicatedPostId ?? "-"} campaign=${found.createdCampaignId ?? "-"} ` +
      `lead=${found.createdLeadId ?? "-"} assets=${seeded.assetIds.join(",")}`,
  );
} else {
  await cleanUp();
}
await pool.end();
process.exit(failures > 0 ? 1 : 0);
