import { describe, expect, it } from 'vitest';

import { evaluateCampaignViaAgentkit, suggestCampaignViaAgentkit } from '../campaignViaAgentkit';

/**
 * `/api/ai/campaign/suggest` and `/api/ai/campaign/evaluate` on the new backend.
 *
 * WHY THESE TESTS EXIST: both old routes returned a shape the campaign page renders directly, and the
 * new tools return a richer one. The tempting move is to hand the tool's body straight through and let
 * the page cope — which shows up as an empty list or the literal string "undefined" in a tip.
 *
 * The evaluate adapter also carries the one real behavioural change in the cutover: it does **not**
 * send the stats block. That is the point — the old prompt said "use only the numbers provided" while
 * the caller provided them — so a test asserts the absence, because an absence is easy to "fix" back.
 *
 * Only a workspace switched to `agentkit` reaches any of this; the flag keeps everyone else on the old
 * path.
 */

const base = { baseUrl: 'http://backend.test', secret: 's', workspaceId: 'ws-1', userId: 'user-1' };

const call = (result: { status: number; body: unknown }) => {
  const calls: { name: string; body: unknown }[] = [];
  return {
    calls,
    callTool: async (name: string, body: unknown) => {
      calls.push({ name, body });
      return result;
    },
  };
};

const idea = (over: Record<string, unknown> = {}) => ({
  angle: 'the price objection',
  hook: 'You are not paying for seats.',
  cta: 'Read the note',
  format: 'text',
  channels: ['linkedin'],
  ...over,
});

const suggested = (ideas: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ok: true, data: { ideas, ...extra } },
});

describe('suggest — the mapping', () => {
  it('sends the campaign’s own fields and nothing the tool would refuse', async () => {
    const { callTool, calls } = call(suggested([idea()], { trendGrounded: true }));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: '  packaging  ', goal: ' grow signups ', count: 3, channels: ['linkedin', 'x'], mediaType: 'image' },
      callTool,
    });
    expect(outcome.status).toBe(200);
    expect(calls[0]?.name).toBe('suggest_campaign_ideas');
    // Trimmed, and `tone`/`brand_context`/`llm` are absent — the schema is strict and would refuse them.
    expect(calls[0]?.body).toEqual({
      theme: 'packaging',
      count: 3,
      channels: ['linkedin', 'x'],
      goal: 'grow signups',
      mediaType: 'image',
    });
  });

  it('maps a media type of none to text rather than passing it through', async () => {
    /**
     * `campaigns.media_type` is `none | image | video`; the tool's enum is `text | image | video`. So
     * `none` is not "no media type" — it is this campaign saying its posts are text. Passed through, a
     * strict enum refuses it and the whole call is lost.
     */
    const { callTool, calls } = call(suggested([idea()]));
    await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 2, channels: [], mediaType: 'none' },
      callTool,
    });
    expect((calls[0]?.body as { mediaType?: string }).mediaType).toBe('text');
  });

  it('omits an empty channel list instead of sending one the tool refuses', async () => {
    // `channels` is `platformList`, which requires at least one entry. An unresolved list means "no
    // restriction" to the tool, and it expresses that by being absent.
    const { callTool, calls } = call(suggested([idea()]));
    await suggestCampaignViaAgentkit({ ...base, request: { theme: 'packaging', count: 2, channels: [] }, callTool });
    expect('channels' in (calls[0]?.body as Record<string, unknown>)).toBe(false);
  });

  it('omits a goal the campaign never set', async () => {
    const { callTool, calls } = call(suggested([idea()]));
    await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', goal: null, count: 2, channels: [] },
      callTool,
    });
    expect('goal' in (calls[0]?.body as Record<string, unknown>)).toBe(false);
  });

  it('returns ideas in the shape the campaign page already renders', async () => {
    const { callTool } = call(suggested([idea({ tip: 'Post it on a Tuesday.' })]));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: ['linkedin'] },
      callTool,
    });
    expect(outcome.body).toEqual({
      ideas: [
        {
          angle: 'the price objection',
          hook: 'You are not paying for seats.',
          cta: 'Read the note',
          format: 'text',
          channels: ['linkedin'],
          tip: 'Post it on a Tuesday.',
        },
      ],
    });
  });

  it('turns an absent tip into an empty string, never the word undefined', async () => {
    /**
     * `tip` is optional on the new tool — an idea with nothing practical to add omits it. The page has
     * always rendered a string, and `String(undefined)` is the classic way that becomes "undefined" in
     * front of a user.
     */
    const { callTool } = call(suggested([idea()]));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: [] },
      callTool,
    });
    expect((outcome.body as { ideas: readonly { tip: string }[] }).ideas[0]?.tip).toBe('');
  });

  it('carries the grounding flag through when the tool reported one', async () => {
    // Additive: the old response had no such field. It is here because the old route implied grounding
    // it could not confirm — a fail-soft search made "found nothing" and "never looked" the same value.
    const { callTool } = call(suggested([idea()], { trendGrounded: false, trendReason: 'not-configured' }));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: [] },
      callTool,
    });
    expect((outcome.body as { trendGrounded?: boolean }).trendGrounded).toBe(false);
  });

  it('treats an empty idea list as a failure, not as a result', async () => {
    /**
     * The page renders the ideas into a list, and an empty one reads as "the AI had no ideas" — which is
     * never what happened. The tool refuses rather than returning nothing, so an empty array here means
     * something went wrong upstream.
     */
    const { callTool } = call(suggested([]));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: [] },
      callTool,
    });
    expect(outcome.status).toBe(502);
  });

  it('passes the tool’s own refusal message through', async () => {
    const { callTool } = call({ status: 422, body: { ok: false, error: 'There is no theme to suggest ideas for.' } });
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: [] },
      callTool,
    });
    expect(outcome).toEqual({ status: 422, body: { error: 'There is no theme to suggest ideas for.' } });
  });

  it('refuses a campaign with no theme before calling anything', async () => {
    const { callTool, calls } = call(suggested([idea()]));
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: '   ', count: 1, channels: [] },
      callTool,
    });
    expect(outcome.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('reports an unreachable backend as 502, not 500', async () => {
    // 500 says this route is broken; 502 says the thing it depends on is. The page shows a retryable
    // error either way, and the log reader is the one who needs the difference.
    const outcome = await suggestCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: [] },
      callTool: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(outcome.status).toBe(502);
    expect((outcome.body as { error: string }).error).toContain('ECONNREFUSED');
  });
});

describe('evaluate — the numbers are not sent', () => {
  it('sends only the campaign id', async () => {
    /**
     * The whole reason this adapter exists. The old route posted a formatted `stats` block alongside a
     * prompt saying *"use only the numbers provided — never invent metrics"*; the new tool reads the
     * metrics itself, so that instruction finally means something. Sending stats again would compile,
     * be ignored by a strict schema, and quietly restore the old hazard for the next reader.
     */
    const { callTool, calls } = call({ status: 200, body: { ok: true, data: { evaluation: 'Post 1 did best.' } } });
    await evaluateCampaignViaAgentkit({ ...base, request: { campaignId: ' c-1 ' }, callTool });
    expect(calls[0]?.name).toBe('evaluate_campaign');
    expect(calls[0]?.body).toEqual({ campaignId: 'c-1' });
  });

  it('returns the prose under the key the page already reads', async () => {
    const { callTool } = call({
      status: 200,
      body: { ok: true, data: { evaluation: '  Post 1 did best.\n- Try video.  ', grounding: { totals: [] } } },
    });
    const outcome = await evaluateCampaignViaAgentkit({ ...base, request: { campaignId: 'c-1' }, callTool });
    expect(outcome).toEqual({ status: 200, body: { summary: 'Post 1 did best.\n- Try video.' } });
  });

  it('passes the not-yet-published refusal through in the tool’s own words', async () => {
    /**
     * "No results yet — publish the campaign first" is a state the user can act on; a generic
     * "evaluation failed" turns it into an error they cannot. This route's own guard says the same
     * thing in its own words, so the two paths stay consistent.
     */
    const { callTool } = call({
      status: 409,
      body: { ok: false, error: 'No results yet — publish the campaign first, and give the platforms time to report.' },
    });
    const outcome = await evaluateCampaignViaAgentkit({ ...base, request: { campaignId: 'c-1' }, callTool });
    expect(outcome.status).toBe(422);
    expect((outcome.body as { error: string }).error).toContain('publish the campaign first');
  });

  it('treats an empty evaluation as a failure', async () => {
    // An empty summary renders as a blank panel with no explanation.
    const { callTool } = call({ status: 200, body: { ok: true, data: { evaluation: '   ' } } });
    const outcome = await evaluateCampaignViaAgentkit({ ...base, request: { campaignId: 'c-1' }, callTool });
    expect(outcome.status).toBe(502);
  });

  it('refuses a missing campaign id before calling anything', async () => {
    const { callTool, calls } = call({ status: 200, body: {} });
    const outcome = await evaluateCampaignViaAgentkit({ ...base, request: { campaignId: '' }, callTool });
    expect(outcome.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
