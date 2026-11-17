import { describe, expect, it } from 'vitest';

/**
 * **The fixtures below are the real contract, and they were not always.** — #471
 *
 * Every mock in this file used to answer `{ data: { versions: [{ platformId, ok, caption }] } }`, a
 * shape `generate_content` has never returned. The adapter read it, the tests agreed with the adapter,
 * and the suite was green while every compose generation failed with *"The post could not be written
 * for that platform."*
 *
 * They now use what a real production response contains: `variants` for what was written (no `ok`
 * flag — being in the array is what written means) and `failed` for what was not. Transcribed from a
 * response printed out of the container, not reasoned about.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateViaAgentkit } from '../generateViaAgentkit';

/**
 * `POST /api/ai/generate` on the new backend.
 *
 * WHY THIS TEST EXISTS: the old route's contract and `generate_content` do not agree, and the tempting
 * move is to paper over the gaps — default a platform, quietly drop `variants`, return an empty
 * caption. Each of those is a silent regression in a publishing tool. So the adapter **refuses with a
 * reason** where there is no equivalent, and these assert the refusals as much as the mapping.
 *
 * Only a workspace switched to `agentkit` can reach any of this; the flag keeps everyone else on the
 * old path.
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

const written = (caption: string) => ({
  status: 200,
  body: { ok: true, data: { saved: false, variants: [{ platformId: 'instagram', caption, attempts: 1 }], failed: [] } },
});

describe('the mapping', () => {
  it('sends the prompt as the brief and the platform as a destination list', async () => {
    const { callTool, calls } = call(written('A caption.'));
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: '  oat milk launch  ', platform: 'instagram' },
      callTool,
    });
    expect(outcome.status).toBe(200);
    expect(calls[0]?.name).toBe('generate_content');
    // Trimmed, and the platform is a list because the tool writes one version per destination.
    expect(calls[0]?.body).toEqual({ brief: 'oat milk launch', platformIds: ['instagram'] });
  });

  it('returns the caption in the shape the composer already reads', async () => {
    const { callTool } = call(written('Oat milk is here. ☕ #oatmilk'));
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram' }, callTool });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ caption: 'Oat milk is here. ☕ #oatmilk', hashtags: '' });
  });

  it('leaves hashtags empty rather than guessing at them', async () => {
    /**
     * The one gap with no clean answer, asserted so it is a decision rather than an oversight. The new
     * generator writes hashtags into the caption because placement is a platform convention — the
     * `post-composition` skill treats it as style with no store behind it. Splitting them back out
     * would mean guessing at model output shape, and they are not always trailing.
     */
    const { callTool } = call(written('Mid #sentence hashtags happen too.'));
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram' }, callTool });
    expect((outcome.body as { hashtags: string }).hashtags).toBe('');
    expect((outcome.body as { caption: string }).caption).toContain('#sentence');
  });
});

describe('the refusals', () => {
  it('requires a platform rather than choosing one', async () => {
    /**
     * The new generator writes per-platform captions and has no generic mode. Defaulting to a platform
     * would be inventing a destination on the user's behalf, which for a publishing tool is the wrong
     * kind of guess.
     */
    const { callTool, calls } = call(written('never reached'));
    for (const platform of [undefined, null, '', '   ']) {
      const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform }, callTool });
      expect(outcome.status, String(platform)).toBe(422);
      expect(JSON.stringify(outcome.body)).toContain('Choose a platform');
    }
    // Never called: refused before the request, not after it.
    expect(calls).toEqual([]);
  });

  it('sends a variant count to the tool that means that, rather than refusing it', async () => {
    /**
     * This **was** a refusal, and it was correct about `generate_content`: the old route returned N
     * alternatives for one platform, and the tool returns one version per *destination* — #115 found
     * the store holds one caption plus `target_platforms` with nowhere to put an authored variant.
     * Mapping one to the other would have filled a picker with captions for platforms the user did not
     * choose.
     *
     * What was wrong was leaving it there: the composer's quality-loop toggle sent `variants: 3` and
     * failed every time. `generate_alternatives` (REQ-014, #266) is the tool for the other meaning,
     * and the two stay separate. Covered fully in the suite at the bottom of this file.
     */
    const { callTool, calls } = call({ status: 200, body: { ok: true, data: { drafts: [{ caption: 'A.', overall: 8, critique: 'c' }] } } });
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram', variants: 3 }, callTool });
    expect(outcome.status).toBe(200);
    expect(calls[0]?.name).toBe('generate_alternatives');
  });

  it('allows variants of 1 and none at all, which mean the same thing', async () => {
    for (const variants of [undefined, null, 1]) {
      const { callTool } = call(written('fine'));
      expect((await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram', variants }, callTool })).status).toBe(200);
    }
  });

  it('requires a prompt', async () => {
    const { callTool } = call(written('never reached'));
    expect((await generateViaAgentkit({ ...base, request: { prompt: '   ', platform: 'instagram' }, callTool })).status).toBe(400);
  });
});

describe('what comes back from the tool', () => {
  it('surfaces a refused destination with its reason, not an empty caption', async () => {
    /**
     * `generate_content` reports a destination it could not write **with the reason** rather than
     * returning a caption that would be rejected — a forbidden claim, a near-duplicate of a recent post,
     * a length it cannot meet. A 200 with an empty caption would hand the composer an empty box and no
     * explanation.
     */
    const { callTool } = call({
      status: 200,
      body: { ok: true, data: { saved: false, variants: [], failed: [{ platformId: 'instagram', attempts: 3, issues: [{ message: 'forbidden claim: "cures"' }] }] } },
    });
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram' }, callTool });
    expect(outcome.status).toBe(422);
    expect(JSON.stringify(outcome.body)).toContain('forbidden claim');
  });

  it('still says something when a refusal carries no reason', async () => {
    const { callTool } = call({ status: 200, body: { ok: true, data: { saved: false, variants: [], failed: [{ platformId: 'instagram', attempts: 3 }] } } });
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram' }, callTool });
    expect(outcome.status).toBe(422);
    expect(JSON.stringify(outcome.body)).toMatch(/could not be written/);
  });

  it('passes the backend’s own error message through on a non-200', async () => {
    // The tool route answers 422 with the schema's field-level message. Replacing it with "generation
    // failed" would throw away the only sentence that says what to fix.
    const { callTool } = call({ status: 422, body: { error: 'Invalid input for generate_content: path ["brief"] Required' } });
    const outcome = await generateViaAgentkit({ ...base, request: { prompt: 'x', platform: 'instagram' }, callTool });
    // The parsed value, not `JSON.stringify` of it: stringify escapes the quotes in `path ["brief"]`,
    // so a substring check against the raw text fails on a message that came through perfectly.
    expect((outcome.body as { error: string }).error).toContain('path ["brief"]');
  });

  it('reports an unreachable backend as 502, not 500', async () => {
    /**
     * The distinction matters to whoever reads the log: 500 says this route is broken, 502 says the
     * thing it depends on is.
     */
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'x', platform: 'instagram' },
      callTool: async () => {
        throw new Error('the agentkit application at http://backend.test could not be reached');
      },
    });
    expect(outcome.status).toBe(502);
    expect(JSON.stringify(outcome.body)).toContain('could not be reached');
  });
});

describe('alternatives for one destination — REQ-014, #266', () => {
  /**
   * `variants > 1` was a **refusal** — *"the agentkit runtime returns one version per destination
   * rather than several alternatives for one"*. That was true of `generate_content`, and it made the
   * composer's quality-loop toggle fail every time somebody ticked it: a shipped control that could
   * not work, on a message explaining why.
   *
   * `generate_alternatives` is the tool for the other meaning. The two stay separate on purpose —
   * per-destination versions are what gets *saved* (#115), alternatives are what gets *chosen
   * between* — and mapping one onto the other would have filled the picker with captions for
   * platforms the user did not pick.
   */
  const draft = (caption: string, overall: number, critique = 'c') => ({ caption, overall, critique });

  it('calls the alternatives tool, not the content one', async () => {
    const { callTool, calls } = call({
      status: 200,
      body: { ok: true, data: { drafts: [draft('A.', 8.5), draft('B.', 6)] } },
    });
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'new hours', platform: 'linkedin', variants: 3 },
      callTool,
    });
    expect(calls[0]?.name).toBe('generate_alternatives');
    expect(calls[0]?.body).toEqual({ brief: 'new hours', platformId: 'linkedin', count: 3 });
    expect(outcome.status).toBe(200);
  });

  it('still calls generate_content when one caption was asked for', async () => {
    const { callTool, calls } = call({
      status: 200,
      body: { ok: true, data: { saved: false, variants: [{ platformId: 'linkedin', caption: 'One.', attempts: 1 }], failed: [] } },
    });
    await generateViaAgentkit({ ...base, request: { prompt: 'new hours', platform: 'linkedin', variants: 1 }, callTool });
    expect(calls[0]?.name).toBe('generate_content');
  });

  it('returns the best one as the caption, so a client ignoring variants is still right', async () => {
    /*
     * Which is what the composer does when the quality loop is off — the same response shape has to
     * work for both, or turning the toggle on changes more than it should.
     */
    const { callTool } = call({
      status: 200,
      body: { ok: true, data: { drafts: [draft('best.', 9), draft('second.', 7)] } },
    });
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'p', platform: 'linkedin', variants: 2 },
      callTool,
    });
    expect((outcome.body as { caption: string }).caption).toBe('best.');
  });

  it('carries the score and the critique, not just the text', async () => {
    /*
     * The picker shows the score; the critique is what makes it actionable. A bare 6.8 says which to
     * pick and nothing about why the others lost.
     */
    const { callTool } = call({
      status: 200,
      body: { ok: true, data: { drafts: [draft('A.', 8.5, 'the ask is vague'), draft('B.', 6)] } },
    });
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'p', platform: 'linkedin', variants: 2 },
      callTool,
    });
    const variants = (outcome.body as { variants: readonly { score: number; critique: string }[] }).variants;
    expect(variants.map((v) => v.score)).toEqual([8.5, 6]);
    expect(variants[0]?.critique).toBe('the ask is vague');
  });

  it('refuses an empty result rather than handing back an empty picker', async () => {
    // A 200 carrying nothing is not a success, and an empty picker with no error is exactly the shape
    // the old refusal existed to avoid.
    const { callTool } = call({ status: 200, body: { ok: true, data: { drafts: [] } } });
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'p', platform: 'linkedin', variants: 3 },
      callTool,
    });
    expect(outcome.status).toBe(502);
  });

  it('still requires a platform, because alternatives are for one destination', async () => {
    const { callTool, calls } = call({ status: 200, body: { ok: true, data: { drafts: [draft('A.', 8)] } } });
    const outcome = await generateViaAgentkit({
      ...base,
      request: { prompt: 'p', platform: null, variants: 3 },
      callTool,
    });
    expect(outcome.status).toBe(422);
    expect(calls).toEqual([]);
  });
});

describe('the quality loop reaches the screen that asked for it', () => {
  /**
   * The adapter tests above prove the tool is called and the drafts come back. Neither says the
   * *route* passes them on, and that seam is where this feature was broken in the first place: the
   * composer has sent `variants: 3` since REQ-014 was specced, and everything behind it refused.
   *
   * Source assertions, because the seam is what is being checked. A sabotage that deleted the route's
   * spread left all seventeen adapter tests green.
   */
  const read = (path: string) =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', path), 'utf8');

  it('the variants survive the trip through the job, now that generation is async', () => {
    /**
     * This used to read the two passthroughs in `app/api/ai/generate/route.ts`, which answered the
     * generation inline. Since #470 that route enqueues and returns 202: a caption took 15-40s and the
     * quality loop 102s, against a Cloudflare proxy timeout of a fixed 100s, so the request could not
     * be where the user waited.
     *
     * The property is unchanged and the path is longer, so the test follows the path rather than being
     * deleted with it. Three hops, and the loop is lost at any one of them.
     */
    const stored = read('lib/generation/textJob.ts');
    expect(stored, 'the job does not store the variants').toMatch(
      /\.\.\.\(outcome\.body\.variants === undefined \? \{\} : \{ variants: outcome\.body\.variants \}\)/,
    );

    const polled = read('app/api/ai/generate/[jobId]/route.ts');
    expect(polled, 'the poll endpoint does not return the variants').toMatch(
      /\.\.\.\(result\.variants === undefined \? \{\} : \{ variants: result\.variants \}\)/,
    );

    // And the request still asks the backend for them in the first place.
    const enqueue = read('app/api/ai/generate/route.ts');
    expect(enqueue, 'the job is queued without the variant count').toMatch(/variants/);
  });

  it('the composer asks for them and renders what comes back', () => {
    // Since #479 the ask is per channel, from a card's "3 options", in the session's generation hook.
    const hook = read('app/(dashboard)/compose/useChannelGeneration.ts');
    expect(hook).toMatch(/\.\.\.\(wantVariants \? \{ variants: 3 \} : \{\}\)/);
    expect(hook).toMatch(/Array\.isArray\(payload\?\.variants\) \? payload\.variants : \[\]/);
    expect(hook).toMatch(/setOptions\(/);
  });

  it('the picker renders only when there is a choice to make', () => {
    // A "picker" offering one option is a control that does nothing, and `variants` is absent rather
    // than a one-element array when the loop was not asked for.
    // The picker moved from the Review step to each channel's card in #480.
    const board = read('app/(dashboard)/compose/ChannelBoard.tsx');
    expect(board).toMatch(/if \(variants\.length <= 1\) return null;/);
  });
});

/**
 * The shape the tool really answers with — #471.
 *
 * This adapter read `data.versions` and looked for entries with `ok: true`. **Neither exists.**
 * `generate_content` returns `data.variants` — written captions, with no `ok` flag, because being in
 * that array is what "written" means — and puts refusals in `data.failed`. So the lookup found nothing
 * every time, had no refusal to quote, and fell through to *"The post could not be written for that
 * platform."* on every platform, for every compose generation.
 *
 * Both sides were tested. Each was tested against its own belief about the contract, and the mocks in
 * this very file encoded the wrong one — which is why a green suite meant nothing. The fixture below
 * is **transcribed from a real production response**, printed from inside the container:
 *
 *     {"ok":true,"data":{"saved":false,"variants":[{"platformId":"linkedin","caption":"Winter mornings
 *      are quiet.\n\n…","attempts":1}],"failed":[]}}
 */
describe('against a transcribed production response', () => {
  const REAL_SUCCESS = {
    ok: true,
    data: {
      saved: false,
      variants: [{ platformId: 'linkedin', caption: 'Winter mornings are quiet.\n\nBefore the day starts…', attempts: 1 }],
      failed: [],
    },
  };

  const REAL_REFUSAL = {
    ok: true,
    data: {
      saved: false,
      variants: [],
      failed: [
        {
          platformId: 'instagram',
          attempts: 3,
          issues: [{ code: 'length', message: 'the caption is 340 characters over the limit' }],
        },
      ],
    },
  };

  it('reads a written caption out of `variants`, not `versions`', async () => {
    const outcome = await generateViaAgentkit({
      baseUrl: 'http://backend',
      secret: 's',
      workspaceId: 'w',
      userId: 'u',
      request: { prompt: 'winter mornings', platform: 'linkedin' },
      callTool: async () => ({ status: 200, body: REAL_SUCCESS }),
    });

    expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
    if (outcome.status !== 200) return;
    expect(outcome.body.caption).toMatch(/Winter mornings are quiet/);
  });

  it('quotes the reason out of `failed[].issues`, instead of the generic sentence', async () => {
    /**
     * The generic sentence is what the user saw for a week, and it names nothing they could act on.
     * A refusal that carries the tool's own words — "340 characters over the limit" — is the whole
     * difference between a dead end and a fix.
     */
    const outcome = await generateViaAgentkit({
      baseUrl: 'http://backend',
      secret: 's',
      workspaceId: 'w',
      userId: 'u',
      request: { prompt: 'winter mornings', platform: 'instagram' },
      callTool: async () => ({ status: 200, body: REAL_REFUSAL }),
    });

    expect(outcome.status).toBe(422);
    if (outcome.status === 200) return;
    expect(outcome.body.error).toMatch(/340 characters over the limit/);
    expect(outcome.body.error, 'fell back to the sentence that names nothing').not.toBe(
      'The post could not be written for that platform.',
    );
  });

  it('still says something when a refusal carries no issues at all', async () => {
    const outcome = await generateViaAgentkit({
      baseUrl: 'http://backend',
      secret: 's',
      workspaceId: 'w',
      userId: 'u',
      request: { prompt: 'x', platform: 'tiktok' },
      callTool: async () => ({ status: 200, body: { ok: true, data: { saved: false, variants: [], failed: [] } } }),
    });
    expect(outcome.status).toBe(422);
  });
});
