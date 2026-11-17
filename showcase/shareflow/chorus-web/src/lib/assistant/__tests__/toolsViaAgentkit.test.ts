import { describe, expect, it } from 'vitest';

import {
  captureViaAgentkit,
  describeImageViaAgentkit,
  enhanceMediaPromptViaAgentkit,
  generateCampaignViaAgentkit,
  planScenesViaAgentkit,
  repurposeViaAgentkit,
} from '../toolsViaAgentkit';

/**
 * The five remaining `/api/ai/*` repoints.
 *
 * WHY THESE TESTS EXIST: each of these routes has a *shape* the UI already reads, and the tools return
 * a richer one. The tempting move is to pass the tool's body through and let the page cope — which shows
 * up as an empty panel, a `campaign_assets` row pointing at nothing, or the literal string "undefined"
 * in a caption. So these assert the mapping and, more importantly, the **refusals** where the two
 * contracts genuinely differ.
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

const ok = (data: unknown) => ({ status: 200, body: { ok: true, data } });

describe('vision', () => {
  it('sends a URL rather than base64', async () => {
    /**
     * The route used to read the preview bytes in the browser and post a megabyte of base64 through two
     * hops. The composer's media items carry a storage *path*, so the route signs it — which is what
     * `/api/internal/media-url` is for — and the tool takes a URL. The model-facing schema keeps
     * refusing byte payloads, which is what stops a model hallucinating one.
     */
    const { callTool, calls } = call(ok({ text: 'A tabby cat on a windowsill.', mode: 'alt_text' }));
    const outcome = await describeImageViaAgentkit({
      ...base,
      request: { imageUrl: '  https://storage.test/signed  ', mode: 'alt_text' },
      callTool,
    });
    expect(outcome).toEqual({ status: 200, body: { text: 'A tabby cat on a windowsill.', mode: 'alt_text' } });
    expect(calls[0]?.name).toBe('describe_image');
    expect(calls[0]?.body).toEqual({ source: { kind: 'url', url: 'https://storage.test/signed' }, mode: 'alt_text' });
  });

  it('refuses when there is no image, before calling anything', async () => {
    const { callTool, calls } = call(ok({ text: 'x' }));
    const outcome = await describeImageViaAgentkit({ ...base, request: { imageUrl: '   ', mode: 'caption' }, callTool });
    expect(outcome.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('treats an empty description as a failure', async () => {
    // The composer writes this straight into the alt-text field; an empty string reads as "described".
    const { callTool } = call(ok({ text: '  ' }));
    const outcome = await describeImageViaAgentkit({
      ...base,
      request: { imageUrl: 'https://storage.test/x', mode: 'alt_text' },
      callTool,
    });
    expect(outcome.status).toBe(502);
  });
});

describe('capture', () => {
  it('returns the storage path the route needs for its asset row', async () => {
    /**
     * The tool stores the screenshot now, so the route's remaining job is the `campaign_assets` row —
     * and what it needs is a path. `chorus-media:` *is* the scheme plus the path, so it is parsed back
     * out with `parseMediaRef` rather than a `slice`.
     */
    const { callTool, calls } = call(
      ok({ reference: 'chorus-media:ws-1/generated/abc.png', url: 'https://acme.test/', title: 'Acme' }),
    );
    const outcome = await captureViaAgentkit({ ...base, request: { url: 'https://acme.test/' }, callTool });
    expect(outcome).toEqual({
      status: 200,
      body: { storagePath: 'ws-1/generated/abc.png', sourceUrl: 'https://acme.test/', title: 'Acme' },
    });
    expect(calls[0]?.body).toEqual({ url: 'https://acme.test/' });
  });

  it('fails rather than recording an asset that points at nothing', async () => {
    /**
     * A null path in `campaign_assets.storage_path` records a screenshot that reads as stored until
     * somebody opens it.
     */
    const { callTool } = call(ok({ url: 'https://acme.test/', title: 'Acme' }));
    const outcome = await captureViaAgentkit({ ...base, request: { url: 'https://acme.test/' }, callTool });
    expect(outcome.status).toBe(502);
  });

  it('refuses search-then-capture with the reason, rather than picking a page itself', async () => {
    /**
     * `find_and_capture` is deliberately not carried over: the assistant has `search_web` and can pick
     * the result itself, visibly, rather than a tool screenshotting whichever hit came first.
     */
    const { callTool, calls } = call(ok({ reference: 'chorus-media:ws-1/generated/a.png' }));
    const outcome = await captureViaAgentkit({ ...base, request: { query: 'acme pricing' }, callTool });
    expect(outcome.status).toBe(422);
    expect((outcome.body as { error: string }).error).toMatch(/search for the page, then/i);
    expect(calls).toEqual([]);
  });
});

describe('scene planning', () => {
  it('flattens the numbered scenes into the prompt list the caller queues jobs from', async () => {
    const { callTool, calls } = call(
      ok({ sceneCount: 3, scenes: [{ scene: 1, prompt: 'one' }, { scene: 2, prompt: 'two' }, { scene: 3, prompt: 'three' }] }),
    );
    const outcome = await planScenesViaAgentkit({ ...base, request: { prompt: 'a barista', sceneCount: 3 }, callTool });
    expect(outcome).toEqual({ status: 200, body: { scenes: ['one', 'two', 'three'] } });
    expect(calls[0]?.body).toEqual({ concept: 'a barista', sceneCount: 3 });
  });

  it('fails when fewer scenes came back than the film needs', async () => {
    /**
     * All or nothing on both sides: the route queues one generation job per scene, so a film missing its
     * middle is not a shorter film. The message is the route's own wording.
     */
    const { callTool } = call(ok({ sceneCount: 2, scenes: [{ scene: 1, prompt: 'one' }, { scene: 2, prompt: '' }] }));
    const outcome = await planScenesViaAgentkit({ ...base, request: { prompt: 'a barista', sceneCount: 2 }, callTool });
    expect(outcome.status).toBe(502);
    expect((outcome.body as { error: string }).error).toMatch(/single clip/);
  });
});

describe('prompt enhancement', () => {
  it('passes the kind through, because a still and a clip are different instructions', async () => {
    const { callTool, calls } = call(ok({ prompt: 'A cat, 35mm, golden hour.', kind: 'video', changed: true }));
    const outcome = await enhanceMediaPromptViaAgentkit({ ...base, request: { prompt: 'a cat', kind: 'video' }, callTool });
    expect(outcome).toEqual({ status: 200, body: { prompt: 'A cat, 35mm, golden hour.', changed: true } });
    expect(calls[0]?.body).toEqual({ brief: 'a cat', kind: 'video' });
  });

  it('reports a failure instead of quietly returning the original', async () => {
    /**
     * The one behavioural change. *"Enhancement must never block generation"* still holds — the caller
     * keeps the raw prompt in a `try`/`catch` around this — so swallowing it here as well would only
     * cost the ability to tell a degraded run from a working one.
     */
    const { callTool } = call({ status: 502, body: { ok: false, error: 'the model is unavailable' } });
    const outcome = await enhanceMediaPromptViaAgentkit({ ...base, request: { prompt: 'a cat', kind: 'image' }, callTool });
    expect(outcome.status).toBe(422);
    expect((outcome.body as { error: string }).error).toBe('the model is unavailable');
  });

  it('carries the changed flag, so "enhanced" is not claimed over unchanged text', async () => {
    const { callTool } = call(ok({ prompt: 'a cat', changed: false }));
    const outcome = await enhanceMediaPromptViaAgentkit({ ...base, request: { prompt: 'a cat', kind: 'image' }, callTool });
    expect((outcome.body as { changed: boolean }).changed).toBe(false);
  });
});

describe('repurpose', () => {
  it('maps the pieces into the shape the MCP tool already returns', async () => {
    const { callTool, calls } = call(
      ok({
        requested: 2,
        truncatedSource: false,
        pieces: [
          { angle: 'the cost of doing nothing', platformId: 'linkedin', caption: 'One.', hashtags: '' },
          { angle: 'what changed', platformId: 'x', caption: 'Two.', hashtags: '' },
        ],
      }),
    );
    const outcome = await repurposeViaAgentkit({
      ...base,
      request: { sourceText: 'A long article.', count: 2, platforms: ['linkedin', 'x'] },
      callTool,
    });
    expect(outcome).toEqual({
      status: 200,
      body: {
        truncatedSource: false,
        pieces: [
          { caption: 'One.', hashtags: '', platform: 'linkedin', angle: 'the cost of doing nothing' },
          { caption: 'Two.', hashtags: '', platform: 'x', angle: 'what changed' },
        ],
      },
    });
    expect(calls[0]?.body).toEqual({ sourceText: 'A long article.', count: 2, platformIds: ['linkedin', 'x'] });
  });

  it('leaves hashtags empty rather than splitting them back out', async () => {
    // The same decision `generate_content` records: the caption carries them, because placement is a
    // platform convention.
    const { callTool } = call(ok({ pieces: [{ angle: 'a', platformId: 'linkedin', caption: 'One. #oat' }] }));
    const outcome = await repurposeViaAgentkit({
      ...base,
      request: { sourceText: 'x', count: 1, platforms: ['linkedin'] },
      callTool,
    });
    expect((outcome.body as { pieces: readonly { hashtags: string }[] }).pieces[0]?.hashtags).toBe('');
  });

  it('refuses with a reason when no platform was named', async () => {
    /**
     * The tool requires a destination, and rightly: a repurposed post is written for one platform's
     * style, so "any platform" is not something it can write for. Refused rather than defaulted to a
     * platform the workspace may not even have.
     */
    const { callTool, calls } = call(ok({ pieces: [] }));
    const outcome = await repurposeViaAgentkit({ ...base, request: { sourceText: 'x', count: 3 }, callTool });
    expect(outcome.status).toBe(422);
    expect((outcome.body as { error: string }).error).toMatch(/Name at least one platform/);
    expect(calls).toEqual([]);
  });

  it('carries the truncation flag the old engine never reported', async () => {
    const { callTool } = call(
      ok({ truncatedSource: true, pieces: [{ angle: 'a', platformId: 'linkedin', caption: 'One.' }] }),
    );
    const outcome = await repurposeViaAgentkit({
      ...base,
      request: { sourceText: 'x'.repeat(9000), count: 1, platforms: ['linkedin'] },
      callTool,
    });
    expect((outcome.body as { truncatedSource: boolean }).truncatedSource).toBe(true);
  });

  it('treats an empty piece list as a failure', async () => {
    const { callTool } = call(ok({ pieces: [] }));
    const outcome = await repurposeViaAgentkit({
      ...base,
      request: { sourceText: 'x', count: 1, platforms: ['linkedin'] },
      callTool,
    });
    expect(outcome.status).toBe(502);
  });
});

describe('campaign planning', () => {
  const post = (angle: string, caption: string) => ({ angle, rationale: 'r', versions: [{ platformId: 'linkedin', caption }] });

  it('maps the plan into one caption per post', async () => {
    /**
     * The store holds **one** caption plus `target_platforms` — #115 found there is nowhere to put a
     * per-platform variant — and the route sets the platforms itself from the campaign's channels.
     */
    const { callTool, calls } = call(ok({ postCount: 2, posts: [post('a', 'One.'), post('b', 'Two.')] }));
    const outcome = await generateCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 2, channels: ['linkedin'], researchFirst: false },
      callTool,
    });
    expect(outcome).toEqual({
      status: 200,
      body: {
        posts: [
          { caption: 'One.', hashtags: '', angle: 'a' },
          { caption: 'Two.', hashtags: '', angle: 'b' },
        ],
      },
    });
    expect(calls[0]?.body).toEqual({ theme: 'packaging', postCount: 2, platformIds: ['linkedin'] });
  });

  it('asks for grounding when the mode is autopilot', async () => {
    /**
     * `autopilot` used to mean the agentic planner. Its autonomy belongs to the conversation now, so
     * what the mode asks for here is a live search — and `trendGrounded` says whether it happened.
     */
    const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')], trendGrounded: false }));
    const outcome = await generateCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: ['linkedin'], researchFirst: true },
      callTool,
    });
    expect((calls[0]?.body as { researchFirst?: boolean }).researchFirst).toBe(true);
    expect((outcome.body as { trendGrounded?: boolean }).trendGrounded).toBe(false);
  });

  describe('the strategy layer — REQ-018, #291', () => {
    /**
     * This used to be a refusal. `generate_campaign` had no parameter for a persona, a primary goal or
     * a template's funnel plan, so a campaign created from a playbook was rejected with the reason —
     * honest, and a feature the create form could write to the database and never use.
     *
     * What is asserted here is the **translation**, because that is the part with judgement in it: the
     * store speaks jsonb and the tool speaks prose and a narrowed plan.
     */
    const strategyOf = (calls: { body: unknown }[]) =>
      (calls[0]?.body as { strategy?: Record<string, unknown> }).strategy;

    it('renders a persona object into the sentence the model is given', async () => {
      const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      await generateCampaignViaAgentkit({
        ...base,
        request: {
          theme: 'packaging',
          count: 1,
          channels: ['linkedin'],
          researchFirst: false,
          strategy: { persona: { description: 'operations leads at mid-size 3PLs' } },
        },
        callTool,
      });
      expect(strategyOf(calls)).toEqual({ audience: 'operations leads at mid-size 3PLs' });
    });

    it('keeps the keys of a richer persona, which it was never taught the names of', async () => {
      // The form writes `{description}`; the MCP tools forward whatever a caller passed. Joining as
      // `key: value` is what lets a `{role, industry}` persona survive a translator that knows neither.
      const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      await generateCampaignViaAgentkit({
        ...base,
        request: {
          theme: 'packaging',
          count: 1,
          channels: ['linkedin'],
          researchFirst: false,
          strategy: { persona: { role: 'head of ops', industry: 'logistics' } },
        },
        callTool,
      });
      expect(strategyOf(calls)).toEqual({ audience: 'role: head of ops. industry: logistics' });
    });

    it('sends the template\'s plan, and not the key that found it', async () => {
      /*
       * The key is how a caller *looks up* a plan; the planner needs the steps. Forwarding the key as
       * well would hand the tool a name for something it already holds — and the tool would refuse it,
       * since its schema is strict.
       */
      const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      await generateCampaignViaAgentkit({
        ...base,
        request: {
          theme: 'packaging',
          count: 1,
          channels: ['linkedin'],
          researchFirst: false,
          strategy: {
            templateKey: 'product_launch',
            postPlan: [
              { stage: 'awareness', angle: 'Tease the problem', cta: 'Follow for the reveal' },
              { stage: 'conversion' },
            ],
          },
        },
        callTool,
      });
      expect(strategyOf(calls)).toEqual({
        funnelPlan: [
          { stage: 'awareness', angle: 'Tease the problem', cta: 'Follow for the reveal' },
          { stage: 'conversion' },
        ],
      });
      expect(strategyOf(calls)).not.toHaveProperty('templateKey');
    });

    it('drops a step whose stage the posts table would reject, and keeps the rest', async () => {
      /*
       * The tool refuses the whole campaign over one unknown stage — deliberately, since a value that
       * passed validation and failed on insert would lose a campaign after the model calls were paid
       * for. A bad `campaign_templates` row is not something the person creating a campaign can fix,
       * so the playbook's usable steps survive it.
       */
      const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      await generateCampaignViaAgentkit({
        ...base,
        request: {
          theme: 'packaging',
          count: 1,
          channels: ['linkedin'],
          researchFirst: false,
          strategy: { postPlan: [{ stage: 'awareness' }, { stage: 'loyalty' }, 'nonsense', { stage: 'conversion' }] },
        },
        callTool,
      });
      expect(strategyOf(calls)).toEqual({ funnelPlan: [{ stage: 'awareness' }, { stage: 'conversion' }] });
    });

    it('sends no strategy at all when nothing usable survived', async () => {
      /*
       * `undefined`, not `{}`. An empty strategy shapes nothing and would still read, in a transcript
       * and in the tool's own branch, as a campaign that was planned.
       */
      const { callTool, calls } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      await generateCampaignViaAgentkit({
        ...base,
        request: {
          theme: 'packaging',
          count: 1,
          channels: ['linkedin'],
          researchFirst: false,
          strategy: { templateKey: 'product_launch', persona: { description: '   ' }, postPlan: [] },
        },
        callTool,
      });
      expect(calls[0]?.body).not.toHaveProperty('strategy');
    });

    it('carries the stage back out, under the name the posts table uses', async () => {
      // `posts.funnel_stage` has three write sites in this app and all three read this field.
      const { callTool } = call(
        ok({
          postCount: 2,
          posts: [
            { ...post('a', 'One.'), funnelStage: 'awareness' },
            { ...post('b', 'Two.'), funnelStage: 'conversion' },
          ],
        }),
      );
      const outcome = await generateCampaignViaAgentkit({
        ...base,
        request: { theme: 'packaging', count: 2, channels: ['linkedin'], researchFirst: false },
        callTool,
      });
      expect((outcome.body as { readonly posts: readonly { readonly funnel_stage?: string }[] }).posts.map((p) => p.funnel_stage)).toEqual([
        'awareness',
        'conversion',
      ]);
    });

    it('omits the stage entirely for an unplanned campaign', async () => {
      /*
       * Absent, not null. The route spreads this field conditionally, so an absent stage leaves
       * `posts.funnel_stage` at its own default rather than writing an explicit null over it — and a
       * field that is always present and always empty is what made this layer look finished.
       */
      const { callTool } = call(ok({ postCount: 1, posts: [post('a', 'One.')] }));
      const outcome = await generateCampaignViaAgentkit({
        ...base,
        request: { theme: 'packaging', count: 1, channels: ['linkedin'], researchFirst: false },
        callTool,
      });
      expect((outcome.body as { readonly posts: readonly Record<string, unknown>[] }).posts[0]).not.toHaveProperty('funnel_stage');
    });
  });

  it('fails rather than returning a campaign with holes in it', async () => {
    /**
     * All or nothing, which is the old engine's rule and the tool's: *"a campaign missing a post is
     * more confusing than a clean retry."* The route inserts one row per post and deletes the campaign
     * on failure, so a short plan would leave a campaign half-created.
     */
    const short = await generateCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 3, channels: ['linkedin'], researchFirst: false },
      callTool: call(ok({ postCount: 2, posts: [post('a', 'One.'), post('b', 'Two.')] })).callTool,
    });
    expect(short.status).toBe(502);

    const blank = await generateCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 1, channels: ['linkedin'], researchFirst: false },
      callTool: call(ok({ postCount: 1, posts: [post('a', '')] })).callTool,
    });
    expect(blank.status, 'an empty caption is a missing post, not a post').toBe(502);
  });

  it('refuses a campaign with no channels', async () => {
    const { callTool, calls } = call(ok({ posts: [] }));
    const outcome = await generateCampaignViaAgentkit({
      ...base,
      request: { theme: 'packaging', count: 2, channels: [], researchFirst: false },
      callTool,
    });
    expect(outcome.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('every adapter, on an unreachable backend', () => {
  it('reports 502 rather than 500', async () => {
    /**
     * 500 says this route is broken; 502 says the thing it depends on is. Asserted across all five
     * because it is the one behaviour they share, and the one a log reader relies on.
     */
    const boom = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const outcomes = await Promise.all([
      describeImageViaAgentkit({ ...base, request: { imageUrl: 'https://x.test/a', mode: 'alt_text' }, callTool: boom }),
      captureViaAgentkit({ ...base, request: { url: 'https://x.test/' }, callTool: boom }),
      planScenesViaAgentkit({ ...base, request: { prompt: 'x', sceneCount: 2 }, callTool: boom }),
      enhanceMediaPromptViaAgentkit({ ...base, request: { prompt: 'x', kind: 'image' }, callTool: boom }),
      repurposeViaAgentkit({ ...base, request: { sourceText: 'x', count: 1, platforms: ['linkedin'] }, callTool: boom }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe(502);
      expect((outcome.body as { error: string }).error).toContain('ECONNREFUSED');
    }
  });
});
