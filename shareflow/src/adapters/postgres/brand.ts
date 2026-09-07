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

type ProfileRow = {
  brand_name: string | null;
  company: string | null;
  website: string | null;
  audience: string | null;
  brand_voice: string | null;
  custom_instructions: string | null;
};

type ExemplarRow = { id: string; raw_content: string | null; title: string | null };

/** Absent columns become absent fields, not empty strings — "unset" and "set to nothing" are different. */
const present = <K extends string>(key: K, value: string | null): Record<K, string> | Record<string, never> =>
  value === null || value.trim() === "" ? {} : ({ [key]: value } as Record<K, string>);

export const createPostgresBrandService = (sql: SqlExecutor): BrandService => ({
  async getBrandProfile(context: ExecutionContext): Promise<BrandProfile> {
    const rows = await sql.query<ProfileRow>(
      `select brand_name, company, website, audience, brand_voice, custom_instructions
         from public.workspace_ai_profile where workspace_id = $1::uuid`,
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
    if (row === undefined) return {};
    return {
      ...present("brandName", row.brand_name),
      ...present("company", row.company),
      ...present("website", row.website),
      ...present("audience", row.audience),
      ...present("voice", row.brand_voice),
      ...present("customInstructions", row.custom_instructions),
    };
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
    const rows = await sql.query<ExemplarRow>(
      `select id, raw_content, title
         from public.posts
        where workspace_id = $1::uuid
          and is_voice_exemplar = true
          and raw_content is not null
        order by updated_at desc
        limit $2`,
      [String(context.tenantId), limit],
    );
    return rows.map((row) => ({
      postDraftId: row.id as never,
      // Trimmed to something a prompt can carry several of. The whole body of twenty posts is not context, it
      // is the budget.
      excerpt: (row.raw_content ?? row.title ?? "").slice(0, 500),
    }));
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
