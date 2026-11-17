/**
 * `/api/ai/campaign/suggest` and `/api/ai/campaign/evaluate`, served by the agentkit backend.
 *
 * Same shape as `generateViaAgentkit`: the route keeps everything that is the *workspace's* business —
 * membership, credits, the `agent_runs` row, the channel resolution — and this module is only the
 * backend call. What maps, maps; what does not is refused with a message naming why, which only a
 * workspace on the new runtime can reach.
 *
 * ## What is dropped, and why it is safe
 *
 * | Old field | New | Note |
 * |---|---|---|
 * | `theme`, `goal`, `count`, `channels`, `media_type` | straight through | |
 * | `tone` | — | workspace brand voice, not per request — same as `/api/ai/generate` |
 * | `brand_context` | — | the backend reads the brand profile itself |
 * | `llm` | — | BYO providers are out of scope for the cutover, by decision |
 * | `stats` (evaluate) | — | **the point of the new tool**: see below |
 *
 * ## `stats` is not sent, and that is the improvement
 *
 * The old `/campaign/evaluate` took a formatted results block from this route and told the model *"use
 * only the numbers provided — never invent metrics"*. This route built that block honestly, but the
 * instruction was unenforceable in principle: whoever calls the endpoint supplies the numbers it is then
 * told to stick to. `evaluate_campaign` takes only a campaign id and reads the metrics itself, under the
 * caller's own tenant scope — so the numbers in the evaluation are the numbers in the database, and it
 * returns them alongside the prose so the summary can be checked against them.
 *
 * The consequence for this route is that `formatStatsForEvaluation`, `computeCampaignPostStats` and the
 * KPI roll-up are no longer *inputs* on the agentkit path. They are still needed: the route uses the KPIs
 * for its own `no_results` guard and its `agent_runs` output, and those must keep working on both paths.
 */

import { createAgentkitClient } from './agentkitClient';

/** What the composer and the campaign page already render. `tip` is a string there, never absent. */
export type CampaignIdeaView = {
  readonly angle: string;
  readonly hook: string;
  readonly cta: string;
  readonly format: string;
  readonly channels: readonly string[];
  readonly tip: string;
};

export type SuggestOutcome =
  | {
      readonly status: 200;
      readonly body: {
        readonly ideas: readonly CampaignIdeaView[];
        /**
         * Whether a live trends search actually happened.
         *
         * Additive — the old response had no such field, and the UI ignores it today. It is here because
         * the old route *implied* grounding it could not confirm: `websearch.py` is fail-soft, so its
         * trends block was simply absent when the search failed and an idea from the model's own priors
         * looked exactly like one grounded in this morning's findings.
         */
        readonly trendGrounded?: boolean;
      };
    }
  | { readonly status: 400 | 422 | 502; readonly body: { readonly error: string } };

export type EvaluateOutcome =
  | { readonly status: 200; readonly body: { readonly summary: string } }
  | { readonly status: 400 | 422 | 502; readonly body: { readonly error: string } };

type ToolCall = (name: string, body: unknown) => Promise<{ status: number; body: unknown }>;

const callerFor = (input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly callTool?: ToolCall;
}): ToolCall =>
  input.callTool ??
  (async (name, body) => {
    const client = createAgentkitClient({ baseUrl: input.baseUrl, token: async () => input.secret });
    return client.callTool({ name, body, workspaceId: input.workspaceId, userId: input.userId });
  });

/**
 * A backend that cannot be reached is a 502, not a 500 — the distinction matters to whoever reads the
 * log: 500 says this route is broken, 502 says the thing it depends on is.
 */
const unreachable = (thrown: unknown) => ({
  status: 502 as const,
  body: { error: thrown instanceof Error ? thrown.message : 'the generation backend could not be reached' },
});

const refusal = (body: unknown, fallback: string) => {
  const named = (body as { error?: unknown }).error;
  return { status: 422 as const, body: { error: typeof named === 'string' ? named : fallback } };
};

export const suggestCampaignViaAgentkit = async (input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly request: {
    readonly theme: string;
    readonly goal?: string | null;
    readonly count: number;
    readonly channels: readonly string[];
    readonly mediaType?: string | null;
  };
  readonly callTool?: ToolCall;
}): Promise<SuggestOutcome> => {
  const { theme, goal, count, channels, mediaType } = input.request;
  if (typeof theme !== 'string' || theme.trim() === '') {
    return { status: 400, body: { error: 'the campaign has no theme to suggest ideas for' } };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('suggest_campaign_ideas', {
      theme: theme.trim(),
      count,
      ...(channels.length === 0 ? {} : { channels: [...channels] }),
      ...(goal === undefined || goal === null || goal.trim() === '' ? {} : { goal: goal.trim() }),
      /**
       * Only the three the tool accepts.
       *
       * `campaigns.media_type` is `none | image | video` and the tool's enum is `text | image | video`
       * — so `none` is not "no media type", it is *this* campaign saying its posts are text. Passing it
       * through would be refused by a `.strict()` enum and lose the whole call.
       */
      ...(mediaType === 'image' || mediaType === 'video' ? { mediaType } : {}),
      ...(mediaType === 'none' ? { mediaType: 'text' } : {}),
    });
  } catch (thrown) {
    return unreachable(thrown);
  }

  if (answer.status !== 200) return refusal(answer.body, 'the ideas could not be produced');

  const data = (answer.body as {
    data?: {
      ideas?: readonly {
        angle?: unknown;
        hook?: unknown;
        cta?: unknown;
        format?: unknown;
        channels?: readonly unknown[];
        tip?: unknown;
      }[];
      trendGrounded?: unknown;
    };
  }).data;

  const ideas: CampaignIdeaView[] = (data?.ideas ?? []).map((idea) => ({
    angle: String(idea.angle ?? ''),
    hook: String(idea.hook ?? ''),
    cta: String(idea.cta ?? ''),
    format: String(idea.format ?? 'text'),
    channels: (idea.channels ?? []).map((channel) => String(channel)),
    // Optional on the new tool — an idea with nothing practical to add omits it rather than padding.
    // The UI has always rendered a string, so an absent tip becomes an empty one here and not "undefined".
    tip: idea.tip === undefined || idea.tip === null ? '' : String(idea.tip),
  }));

  if (ideas.length === 0) {
    /**
     * An empty list is a failure, not a result.
     *
     * The page renders the ideas into a list and an empty one reads as "the AI had no ideas", which is
     * never what happened — the tool refuses rather than returning nothing.
     */
    return { status: 502, body: { error: 'No ideas came back — try again' } };
  }

  return {
    status: 200,
    body: {
      ideas,
      ...(typeof data?.trendGrounded === 'boolean' ? { trendGrounded: data.trendGrounded } : {}),
    },
  };
};

export const evaluateCampaignViaAgentkit = async (input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly request: { readonly campaignId: string };
  readonly callTool?: ToolCall;
}): Promise<EvaluateOutcome> => {
  if (typeof input.request.campaignId !== 'string' || input.request.campaignId.trim() === '') {
    return { status: 400, body: { error: 'campaignId is required' } };
  }

  let answer: { status: number; body: unknown };
  try {
    // Only the id. The numbers are the backend's to read — see the header.
    answer = await callerFor(input)('evaluate_campaign', { campaignId: input.request.campaignId.trim() });
  } catch (thrown) {
    return unreachable(thrown);
  }

  if (answer.status !== 200) {
    /**
     * The tool's own message is passed through, and it is worth passing through.
     *
     * "No results yet — publish the campaign first, and give the platforms time to report" is exactly
     * what this route's own `no_results` guard says in its own words. A generic "evaluation failed"
     * would turn a state the user can act on into an error they cannot.
     */
    return refusal(answer.body, 'the evaluation could not be produced');
  }

  const summary = (answer.body as { data?: { evaluation?: unknown } }).data?.evaluation;
  if (typeof summary !== 'string' || summary.trim() === '') {
    return { status: 502, body: { error: 'The evaluation came back empty — try again' } };
  }
  return { status: 200, body: { summary: summary.trim() } };
};
