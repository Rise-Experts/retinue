/**
 * `BrandService` over ShareFlow's own tables — REQ-041 (#190), and what unblocks #128's shadow capture.
 *
 * The first of the three services `create-post` needs. It maps almost exactly, which is worth saying because
 * the other two do not: `workspace_ai_profile` was designed for the same job this port describes — per-workspace
 * brand, company and voice context injected into every generation — and every field lines up.
 *
 * ## Where the ports and the live schema disagree, and what I did about it
 *
 * The service ports were written from `docs/07`. ShareFlow's database was written by ShareFlow. Two of the four
 * methods here have no table behind them, and inventing one would have been the wrong answer:
 *
 * - **`getClaimPolicy` has no store.** Nothing in the schema holds approved or forbidden claims. It answers an
 *   *empty* policy — no approved claims, no forbidden ones — which is honest and, importantly, is not the same
 *   as permissive: `forbidden` being empty means nothing is refused *by this policy*, and the tool layer still
 *   enforces whatever it enforces. A fabricated table would have been a schema this deployment does not have.
 * - **`getPerformanceBrief` needs a metrics join** the port itself describes as expensive. It answers `null`,
 *   which the port defines as "nothing to say" and callers already handle.
 *
 * Both are marked in `SUPPORTED` so a caller can ask rather than discover. The alternative — throwing
 * `capability_unavailable` — would have been worse for the one thing this exists for: a shadow run must
 * complete, and a turn that dies on an optional brief produces no parity data at all.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import { brandKitFromRow } from "../../brand/kit.js";
import { selectByVoiceCoverage } from "../../brand/voice-coverage.js";
import type { BrandProfile, BrandService, ClaimPolicy, VoiceExample } from "../../services/index.js";

/**
 * What this adapter can actually answer, declared rather than discovered.
 *
 * A caller that needs a claim policy should be able to ask whether one exists, instead of receiving an empty
 * one and concluding the workspace has no forbidden claims — which is a different statement.
 */
export const BRAND_SUPPORTED = {
  getBrandProfile: true,
  /** No table holds claims. Empty is returned; see the header. */
  getClaimPolicy: false,
  getPerformanceBrief: false,
  listVoiceExamples: true,
} as const;

/** The voice examples ceiling. Beyond this the prompt cost outweighs the signal. */
export const MAX_VOICE_EXAMPLES = 20;

/**
 * How many flagged posts the selector chooses from — REQ-013 AC-3.
 *
 * Three times the example ceiling. Selection needs something to choose *between*: a pool equal to the
 * ask makes `selectByVoiceCoverage` return everything and the feature is inert. Three times leaves
 * real headroom at the maximum ask of 20 and is still one bounded, indexed read per assistant turn.
 *
 * Not unbounded. This runs on every turn through a context provider, and a workspace that has flagged
 * five hundred posts would otherwise pay for all of them each time — to pick four.
 */
export const VOICE_EXAMPLE_POOL = MAX_VOICE_EXAMPLES * 3;

/**
 * The whole row as jsonb — #634 §4.
 *
 * `to_jsonb(p)` rather than a column list, so a column that does not exist yet is a missing key rather than
 * `column "industry" does not exist` failing the turn. The brand-kit migration is applied by hand, after
 * deploy; until then this reads the six original columns exactly as before.
 */
type ProfileRow = { profile: Readonly<Record<string, unknown>> | string | null };

type ExemplarRow = { id: string; raw_content: string | null; title: string | null };

/**
 * Trimmed to something a prompt can carry several of. The whole body of twenty posts is not context,
 * it is the budget — and the trim happens **before** selection, so the voice profile is computed from
 * the text the model will actually be shown rather than from a body it never sees.
 */
const excerptOf = (row: ExemplarRow): string => (row.raw_content ?? row.title ?? "").slice(0, 500);

/** Absent columns become absent fields, not empty strings — "unset" and "set to nothing" are different. */
const present = <K extends string>(key: K, value: unknown): Record<K, string> | Record<string, never> =>
  typeof value !== "string" || value.trim() === "" ? {} : ({ [key]: value } as Record<K, string>);

/** A `workspace_ai_profile` row (as jsonb) → `BrandProfile`. Exported for the unit test of the mapping. */
export const brandProfileFromRow = (row: Readonly<Record<string, unknown>>): BrandProfile => ({
  ...present("brandName", row.brand_name),
  ...present("company", row.company),
  ...present("website", row.website),
  ...present("audience", row.audience),
  ...present("voice", row.brand_voice),
  ...present("customInstructions", row.custom_instructions),
  ...brandKitFromRow(row),
});

export const createPostgresBrandService = (sql: SqlExecutor): BrandService => ({
  async getBrandProfile(context: ExecutionContext): Promise<BrandProfile> {
    const rows = await sql.query<ProfileRow>(
      `select to_jsonb(p) as profile from public.workspace_ai_profile p where p.workspace_id = $1::uuid`,
      [String(context.tenantId)],
    );
    const row = rows[0];
    /**
     * No row is an **empty profile**, not an error.
     *
     * A workspace that has never opened the brand settings is the ordinary case, and refusing here would mean
     * the assistant could not answer at all until somebody filled a form. Every field is optional in the port
     * for the same reason.
     */
    if (row === undefined || row.profile === null) return {};
    // node-postgres parses jsonb; an executor that hands back text is parsed here rather than trusted to.
    const profile = typeof row.profile === "string" ? (JSON.parse(row.profile) as Record<string, unknown>) : row.profile;
    return brandProfileFromRow(profile);
  },

  /*
   * #641: the assistant's write to Settings → Brand. Only the fields in the patch are touched — an upsert whose
   * update names exactly those columns — so a change of tone can never blank the voice or the logo.
   */
  async updateBrandProfile(context, patch) {
    const columns: { readonly column: string; readonly cast: string; readonly value: unknown }[] = [];
    const add = (key: keyof BrandProfile, column: string, cast = "", encode: (v: unknown) => unknown = (v) => v) => {
      if (!(key in patch)) return;
      const value = patch[key];
      columns.push({ column, cast, value: value === null || value === undefined ? null : encode(value) });
    };
    add("brandName", "brand_name");
    add("company", "company");
    add("website", "website");
    add("audience", "audience");
    add("voice", "brand_voice");
    add("customInstructions", "custom_instructions");
    add("logoPath", "logo_path");
    add("colors", "brand_colors", "::jsonb", (v) => JSON.stringify(v));
    add("industry", "industry");
    add("tone", "tone", "::text[]");
    add("emojiUse", "emoji_use");
    add("hashtagStyle", "hashtag_style");
    add("language", "language");
    add("avoid", "avoid");
    if (columns.length === 0) return { profile: await createPostgresBrandService(sql).getBrandProfile(context), changed: [] };

    const params: unknown[] = [String(context.tenantId), ...columns.map((c) => c.value)];
    const names = columns.map((c) => c.column);
    const values = columns.map((c, i) => `$${i + 2}${c.cast}`);
    await sql.query(
      `insert into public.workspace_ai_profile (workspace_id, ${names.join(", ")}, updated_at)
       values ($1::uuid, ${values.join(", ")}, now())
       on conflict (workspace_id) do update set ${names.map((n) => `${n} = excluded.${n}`).join(", ")}, updated_at = now()`,
      params,
    );
    return { profile: await createPostgresBrandService(sql).getBrandProfile(context), changed: Object.keys(patch) as (keyof BrandProfile)[] };
  },

  async getClaimPolicy(_context: ExecutionContext): Promise<ClaimPolicy> {
    /**
     * Empty, because nothing stores claims — see the header.
     *
     * Deliberately not throwing: this is called on the generation path, and a shadow run that died here would
     * produce no parity data, which is the opposite of what it exists for. Deliberately not fabricated either:
     * a hard-coded forbidden list would be this package deciding what a customer may not say.
     */
    return { approved: [], forbidden: [] };
  },

  async listVoiceExamples(
    context: ExecutionContext,
    input: { readonly limit: number },
  ): Promise<readonly VoiceExample[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_VOICE_EXAMPLES);
    /**
     * `is_voice_exemplar`, which the schema already has.
     *
     * The port says "the workspace's own best and flagged posts. Heuristic selection is ShareFlow's, not
     * ours" — and ShareFlow's heuristic is that column. Reading it rather than inventing a ranking is the
     * whole point: a scoring rule here would be a second, divergent notion of what a good post is.
     */
    /*
     * A **pool**, larger than the ask, then chosen from — REQ-013 AC-3, #278.
     *
     * `order by updated_at desc limit $2` was the whole selection: the four most recent flagged posts,
     * whatever they were. AC-3 asks for examples chosen by relevance rather than recency, and spike
     * #279 measured what "relevance" should mean here — see `selectByVoiceCoverage`, which is where
     * the finding and its limits are written down. The short version: relevance-to-brief moved
     * nothing, and representativeness moved most of the achievable range.
     *
     * Recency still does two jobs. It bounds the pool — a workspace with five hundred flagged posts
     * should not read all of them on every assistant turn — and it is the tie-break inside the
     * selector, which prefers the earlier row when two candidates are equally representative.
     *
     * The pool is deliberately not the whole table. That makes the selection representative of *the
     * recent corpus* rather than of all history, which is the more useful claim anyway: a brand voice
     * that changed last year should not be averaged with the one in use now.
     */
    const flagged = await sql.query<ExemplarRow>(
      `select id, raw_content, title
         from public.posts
        where workspace_id = $1::uuid
          and is_voice_exemplar = true
          and raw_content is not null
        order by updated_at desc
        limit $2`,
      [String(context.tenantId), VOICE_EXAMPLE_POOL],
    );

    /**
     * The posts a person marked are **never** displaced — REQ-013 AC-1.
     *
     * When there are at least `limit` of them, they are the whole pool and the selector chooses the
     * most representative. When there are fewer, every one of them is kept and the best-performing
     * published posts fill the remainder. An explicit signal losing to a measured one would make the
     * toggle in the post detail page advisory, which is not what a checkbox means.
     *
     * The cost of that rule, stated: the top-performing half is chosen to represent *the top-performing
     * pool* rather than the union of both, because the union's representativeness is not something the
     * selector can optimise while part of its answer is fixed. With a handful of flagged posts the
     * difference is small, and the alternative — letting the selector drop a post somebody deliberately
     * marked — is not a trade worth making.
     */
    if (flagged.length >= limit) {
      const excerpts = flagged.map((row) => excerptOf(row));
      return selectByVoiceCoverage(excerpts, limit).map((index) => ({
        postDraftId: (flagged[index] as ExemplarRow).id as never,
        excerpt: excerpts[index] as string,
        source: "manual" as const,
      }));
    }

    const chosen: VoiceExample[] = flagged.map((row) => ({
      postDraftId: row.id as never,
      excerpt: excerptOf(row),
      source: "manual" as const,
    }));

    /**
     * The best-performing published posts, from the view that already ranks them — REQ-013 AC-1.
     *
     * *"Approved/top posts form a per-workspace voice corpus"*, and until now only the flagged ones
     * did. `workspace_top_posts` has existed since the growth-system migration and orders by
     * `engagement_rate desc` over published items; `web/src/lib/data/voiceCorpus.ts` implemented
     * exactly this fallback and **has no callers** — the live path is this method, and it read the
     * flagged posts alone. So a workspace that had never ticked the box got no examples at all while a
     * ranked list of its best posts sat one join away.
     *
     * Ranked by the view and *not* re-ranked here: a scoring rule in this adapter would be a second,
     * divergent notion of what a good post is, which is the same reason the flag is read rather than
     * invented.
     *
     * `auto_approved` — the third value `posts_voice_exemplar_source_check` admits — is deliberately
     * not implemented. "Approved" is a workflow state rather than a quality signal, and every approved
     * post joining the corpus would make it the set of everything the workspace ever wrote, which is
     * the opposite of a voice sample.
     */
    const wanted = limit - chosen.length;
    const taken = new Set(flagged.map((row) => row.id));
    const top = await sql.query<ExemplarRow>(
      `select post_id as id, raw_content, null::text as title
         from public.workspace_top_posts
        where workspace_id = $1::uuid
          and raw_content is not null
        order by engagement_rate desc nulls last
        limit $2`,
      [String(context.tenantId), VOICE_EXAMPLE_POOL],
    );
    /*
     * Deduplicated on the post id, not on the text.
     *
     * A flagged post that also performed well appears in both reads, and the view returns one row per
     * *published destination* — so a post published to three platforms is three rows of the same
     * caption. Without this the model is shown the same post three times and learns that whatever it
     * says is what this brand always says.
     */
    const candidates: ExemplarRow[] = [];
    for (const row of top) {
      if (taken.has(row.id)) continue;
      taken.add(row.id);
      candidates.push(row);
    }

    const excerpts = candidates.map((row) => excerptOf(row));
    for (const index of selectByVoiceCoverage(excerpts, wanted)) {
      chosen.push({
        postDraftId: (candidates[index] as ExemplarRow).id as never,
        excerpt: excerpts[index] as string,
        source: "auto_top" as const,
      });
    }
    return chosen;
  },

  async getPerformanceBrief(_context: ExecutionContext): Promise<string | null> {
    /**
     * `null`, which the port defines as "nothing to say".
     *
     * The real version joins metrics across sixty rows, and the port already warns it is expensive and must
     * not be called on a routine request. Returning null is the correct empty answer rather than a stub: every
     * caller already handles it, and a fabricated brief would put invented performance claims into a prompt.
     */
    return null;
  },
});

/** Thrown when a caller insists on a capability this adapter does not have. Exported so a host can offer it. */
export const brandCapabilityMissing = (method: keyof typeof BRAND_SUPPORTED): AgentPlatformError =>
  new AgentPlatformError({
    code: "capability_unavailable",
    message:
      `BrandService.${method} has no store behind it in this deployment. It answers empty rather than ` +
      "throwing, so a run completes — check `BRAND_SUPPORTED` before treating the answer as data.",
    retryable: false,
  });
