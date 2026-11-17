/**
 * The auto-reply classifier, as the ingest worker sees it.
 *
 * Its own file because the adapter has its own file, and for the same reason: this is the worker's
 * path, not a route's. See `autoReplyViaAgentkit.ts` for why the two are separated.
 *
 * The assertions here are almost all about **degraded answers**, because this adapter's failure mode
 * is not a broken panel — it is a reply sent to a stranger's public comment with nobody having read
 * it. A malformed confidence, a missing escalation flag and an unreachable backend all have to end
 * with "no draft, human review", never with a draft carrying a number this layer invented.
 */
import { describe, expect, it } from 'vitest';

import { draftAutoReplyViaAgentkit } from '../autoReplyViaAgentkit';

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

const ok = (data: unknown) => ({ status: 200, body: { ok: true, data } });

/**
 * The auto-reply classifier.
 *
 * This adapter is the one whose failure mode is not a broken panel but a **reply sent to a stranger's
 * public comment with nobody having read it**. So the assertions here are about what happens when the
 * answer is not what was expected: a malformed confidence, a missing escalation flag, an unreachable
 * backend. Every one of them has to end with "no draft, human review" rather than with a draft carrying
 * a number this layer invented.
 */
describe('auto-reply drafting', () => {
  const request = {
    comment: 'What are your pricing plans?',
    rules: [{ title: 'Pricing questions', description: 'Help with pricing and plans' }],
    accountName: 'Jane Doe',
    persona: { accountType: 'personal', emojiPreference: 'off' },
    threadContext: [{ role: 'commenter' as const, content: 'earlier question' }],
  };

  it('passes the comment, rules, account, persona and thread through unchanged', async () => {
    const stub = call(
      ok({
        reply: 'Our plans are on the pricing page.',
        confidence: 1,
        ruleTitle: 'Pricing questions',
        escalate: false,
        lead: { isLead: true, valueCents: null, reason: "buying-intent keyword 'pricing'" },
      }),
    );
    const result = await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool });

    expect(stub.calls[0]?.name).toBe('draft_auto_reply');
    expect(stub.calls[0]?.body).toEqual({
      comment: 'What are your pricing plans?',
      rules: [{ title: 'Pricing questions', description: 'Help with pricing and plans' }],
      accountName: 'Jane Doe',
      persona: { accountType: 'personal', emojiPreference: 'off' },
      threadContext: [{ role: 'commenter', content: 'earlier question' }],
    });
    /**
     * Nothing is recomputed on this side. The confidence, the rule and the lead are the backend's,
     * whose scoring is a transcription of the Python's — a second scoring rule here would be a second
     * answer to whether this reply may be auto-sent.
     */
    expect(result).toEqual({
      reply: 'Our plans are on the pricing page.',
      confidence: 1,
      ruleTitle: 'Pricing questions',
      escalate: false,
      lead: { isLead: true, valueCents: null, reason: "buying-intent keyword 'pricing'" },
    });
  });

  it('omits an empty thread and a blank account rather than sending them', async () => {
    const stub = call(ok({ reply: 'Hi!', confidence: 0, ruleTitle: null, escalate: false, lead: { isLead: false } }));
    await draftAutoReplyViaAgentkit({
      ...base,
      request: { comment: 'hello', rules: [], accountName: '  ', threadContext: [] },
      callTool: stub.callTool,
    });
    // The tool's schema is `.strict()`; an empty thread and a blank name are absences, not values.
    expect(stub.calls[0]?.body).toEqual({ comment: 'hello', rules: [] });
  });

  it('is null for a blank comment, without calling the backend', async () => {
    const stub = call(ok({ reply: 'x', confidence: 1, ruleTitle: null }));
    expect(await draftAutoReplyViaAgentkit({ ...base, request: { comment: '   ', rules: [] }, callTool: stub.callTool })).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it('is null on an unreachable backend rather than throwing', async () => {
    /**
     * The worker's contract: null means "leave the comment in `needs_review` with an empty draft". A
     * throw would abort the whole account's cycle, so every comment after this one goes unprocessed.
     */
    const boom = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: boom })).toBeNull();
  });

  it('is null on a refusal', async () => {
    const stub = call({ status: 422, body: { error: 'there is no comment to reply to' } });
    expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool })).toBeNull();
  });

  it('is null on a non-200 even when the body looks like a valid answer', async () => {
    /**
     * The status is authoritative over the body, and this is the test that says so. The refusal test
     * above does not: its body carries no `reply`, so it comes back null through the type check
     * whether the status guard exists or not — removing that guard left it passing, which the sabotage
     * run is how I found out. This one fails without the guard, because the body would otherwise parse
     * cleanly into a confident, sendable draft.
     */
    const stub = call({
      status: 502,
      body: { ok: true, data: { reply: 'Sure!', confidence: 1, ruleTitle: 'Pricing questions', escalate: false } },
    });
    expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool })).toBeNull();
  });

  it('is null when confidence is not a number, rather than coercing it', async () => {
    /**
     * `'1' >= 0.7` is true in JavaScript. A string confidence passed through would auto-send on the
     * strength of a value the backend never produced as a number.
     */
    const stub = call(ok({ reply: 'Sure!', confidence: '1', ruleTitle: 'Pricing questions' }));
    expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool })).toBeNull();
  });

  it('is null when the reply is not a string', async () => {
    const stub = call(ok({ reply: { text: 'Sure!' }, confidence: 1, ruleTitle: null }));
    expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool })).toBeNull();
  });

  it('is null when confidence is NaN or Infinity', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const stub = call(ok({ reply: 'Sure!', confidence: bad, ruleTitle: null }));
      expect(await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool })).toBeNull();
    }
  });

  it('fails CLOSED on an unreadable escalate flag — true, not false', async () => {
    /**
     * The opposite direction from every other degraded field, and the reason is what the flag does: it
     * blocks auto-send regardless of confidence. A wrong `true` costs a person reading a comment; a
     * wrong `false` auto-answers a refund complaint.
     */
    const stub = call(ok({ reply: 'Sorry!', confidence: 1, ruleTitle: 'Escalate', escalate: 'yes' }));
    expect((await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool }))?.escalate).toBe(true);
  });

  it('treats a missing escalate as escalation too', async () => {
    const stub = call(ok({ reply: 'Sorry!', confidence: 1, ruleTitle: 'Escalate' }));
    expect((await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool }))?.escalate).toBe(true);
  });

  it('degrades a malformed lead to "not a lead" rather than dropping the draft', async () => {
    // A lead is a CRM row, not a send decision — losing one is worse than losing the reply it came with.
    const stub = call(ok({ reply: 'Sure!', confidence: 1, ruleTitle: 'Pricing questions', escalate: false, lead: 'yes' }));
    const result = await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool });
    expect(result?.reply).toBe('Sure!');
    expect(result?.lead).toEqual({ isLead: false, valueCents: null, reason: null });
  });

  it('nulls a non-string ruleTitle, which is what the worker reads as "no rule matched"', async () => {
    const stub = call(ok({ reply: 'Sure!', confidence: 1, ruleTitle: 42, escalate: false }));
    expect((await draftAutoReplyViaAgentkit({ ...base, request, callTool: stub.callTool }))?.ruleTitle).toBeNull();
  });
});
