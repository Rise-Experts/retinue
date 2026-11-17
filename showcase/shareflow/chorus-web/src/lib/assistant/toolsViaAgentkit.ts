/**
 * The remaining `/api/ai/*` routes, served by the agentkit backend.
 *
 * One module rather than a file per route, unlike `generateViaAgentkit` and `campaignViaAgentkit`: these
 * five are thin — a tool call, a shape change, and a refusal where the contracts differ. Their *reasons*
 * are what needs writing down, and keeping them together is what makes the differences visible.
 *
 * Every one of them is reached only by a workspace whose flag says `agentkit`, and only when
 * `ASSISTANT_AGENTKIT_URL` is set. That variable was missing from `docker-compose.oracle.yml` until
 * today, which means none of the repointing had ever run in production: each route degrades to Agno when
 * it is unset, and `/api/assistant/runs` even said so in a header nobody was reading.
 *
 * ## What each one maps to, and what it loses
 *
 * | Old | New | Note |
 * |---|---|---|
 * | `POST /vision/describe` | `describe_image` | takes a **signed URL** rather than base64 — see below |
 * | `POST /capture` | `capture_website` | the tool stores the screenshot; the path comes back inside the reference |
 * | `POST /plan-video-scenes` | `plan_video_scenes` | straight through |
 * | `POST /enhance-media-prompt` | `enhance_media_prompt` | no longer swallows a model failure |
 * | `POST /repurpose` | `repurpose_source` | `hashtags` comes back empty by design |
 *
 * `llm` is dropped from all five: BYO per-workspace models are out of scope for the cutover, by
 * decision. `tone` is dropped too — the workspace's brand voice is read by the backend itself.
 */

import { createAgentkitClient } from './agentkitClient.ts';

import { parseMediaRef } from './mediaRef.ts';

export type ToolCall = (name: string, body: unknown) => Promise<{ status: number; body: unknown }>;

export type AgentkitTarget = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly callTool?: ToolCall;
};

export type Failure = { readonly status: 400 | 422 | 502; readonly body: { readonly error: string } };

const callerFor = (target: AgentkitTarget): ToolCall =>
  target.callTool ??
  (async (name, body) => {
    const client = createAgentkitClient({ baseUrl: target.baseUrl, token: async () => target.secret });
    return client.callTool({ name, body, workspaceId: target.workspaceId, userId: target.userId });
  });

/**
 * A backend that cannot be reached is a 502, not a 500 — 500 says this route is broken, 502 says the
 * thing it depends on is. The caller shows a retryable error either way; the log reader needs the
 * difference.
 */
const unreachable = (thrown: unknown): Failure => ({
  status: 502,
  body: { error: thrown instanceof Error ? thrown.message : 'the assistant backend could not be reached' },
});

const refusal = (body: unknown, fallback: string): Failure => {
  const named = (body as { error?: unknown }).error;
  return { status: 422, body: { error: typeof named === 'string' ? named : fallback } };
};

/** `data` off a successful tool result, or `undefined`. */
const dataOf = (body: unknown): Record<string, unknown> | undefined => {
  const data = (body as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
};

// ---------------------------------------------------------------------------------------------------
// Resolving the target
// ---------------------------------------------------------------------------------------------------

/**
 * Where to send a tool call, or `undefined` when this deployment has no backend configured.
 *
 * **The flag read is gone from here, and its removal is the point.** This used to resolve
 * `assistant_runtime_flags` first and return `undefined` when a workspace said `agno`, which was right
 * while there were two runtimes. There is one now — `ai_backend` is deleted — so a flag saying `agno`
 * would name a process that does not exist, and since that table has no rows *every* workspace said
 * `agno`. Keeping the read would have pointed all six workspaces at a removed container.
 *
 * So `undefined` means exactly one thing: no `ASSISTANT_AGENTKIT_URL`, or no `SHARED_API_SECRET`. Every
 * caller answers that with a **503 naming the variable**, because there is no fallback left to degrade
 * to — and a silent degrade is precisely how `ASSISTANT_AGENTKIT_URL` stayed missing from compose for a
 * day without anyone noticing.
 *
 * Synchronous now, too: reading two environment variables never needed to be async, and the `await`
 * only existed for the flag's database round trip.
 */
export const agentkitTarget = (input: {
  readonly workspaceId: string;
  readonly userId: string;
}): AgentkitTarget | undefined => {
  const baseUrl = process.env.ASSISTANT_AGENTKIT_URL;
  const secret = process.env.SHARED_API_SECRET;
  if (baseUrl === undefined || baseUrl === '' || secret === undefined || secret === '') return undefined;
  return { baseUrl, secret, workspaceId: input.workspaceId, userId: input.userId };
};

/** The sentence every caller uses when the backend is absent. Named once, so the wording cannot drift. */
export const AGENTKIT_NOT_CONFIGURED =
  'The assistant backend is not configured for this deployment (ASSISTANT_AGENTKIT_URL).';

// ---------------------------------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------------------------------

export type VisionOutcome =
  | { readonly status: 200; readonly body: { readonly text: string; readonly mode: string } }
  | Failure;

/**
 * `POST /api/ai/vision`, which the composer calls for alt text and for a caption seeded from a picture.
 *
 * **A signed URL, not base64.** The route used to read the preview bytes in the browser, base64-encode
 * them and post them; `describe_image` takes an asset id or a URL, and the composer's media items carry
 * a storage *path*. So the route signs that path — `POST /api/internal/media-url`, whose whole job is
 * exactly this, and whose workspace-prefix check is the authorisation — and hands over a URL.
 *
 * That is better than the alternatives rather than merely different: no megabyte of base64 crosses two
 * hops, no image is uploaded a second time for a free operation, and the tool's model-facing schema
 * keeps refusing byte payloads, which is what stops a model hallucinating one.
 */
export const describeImageViaAgentkit = async (
  input: AgentkitTarget & {
    readonly request: { readonly imageUrl: string; readonly mode: 'alt_text' | 'caption' | 'competitor' };
  },
): Promise<VisionOutcome> => {
  const { imageUrl, mode } = input.request;
  if (typeof imageUrl !== 'string' || imageUrl.trim() === '') {
    return { status: 400, body: { error: 'there is no image to describe' } };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('describe_image', {
      source: { kind: 'url', url: imageUrl.trim() },
      mode,
    });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'the image could not be described');

  const text = dataOf(answer.body)?.['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    return { status: 502, body: { error: 'the description came back empty — try again' } };
  }
  return { status: 200, body: { text: text.trim(), mode } };
};

// ---------------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------------

export type CaptureOutcome =
  | {
      readonly status: 200;
      readonly body: {
        /** Where the screenshot was stored, for the caller's own `campaign_assets` row. */
        readonly storagePath: string;
        readonly sourceUrl: string;
        readonly title: string;
      };
    }
  | Failure;

/**
 * `POST /api/ai/capture`.
 *
 * **The tool stores the screenshot now**, where the route used to upload the bytes itself. So the
 * route's remaining job is the `campaign_assets` row, and what it needs from here is the storage path —
 * which is recoverable from the `chorus-media:` reference, because that scheme *is* the scheme plus the
 * path. Parsed with `parseMediaRef` rather than a `slice`, so one function owns the format.
 *
 * One visible consequence: screenshots land under `generated/` rather than `captures/`, because the
 * store-media endpoint chooses the folder. A cosmetic move, recorded because a person looking in the
 * bucket for old captures will not find new ones beside them.
 *
 * `query` (search, then capture the top hit) is **refused**: `capture_website` takes a URL, deliberately
 * — the assistant has `search_web` and can pick the result itself, visibly, rather than a tool
 * screenshotting whatever came first.
 */
export const captureViaAgentkit = async (
  input: AgentkitTarget & { readonly request: { readonly url?: string | null; readonly query?: string | null } },
): Promise<CaptureOutcome> => {
  const { url, query } = input.request;
  if ((url === undefined || url === null || url.trim() === '') && typeof query === 'string' && query.trim() !== '') {
    return {
      status: 422,
      body: {
        error:
          'Give a URL to capture. Capturing screenshots a page you name rather than searching and ' +
          'capturing whichever result came first — search for the page, then capture it.',
      },
    };
  }
  if (typeof url !== 'string' || url.trim() === '') {
    return { status: 400, body: { error: 'url is required' } };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('capture_website', { url: url.trim() });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'the page could not be captured');

  const data = dataOf(answer.body) ?? {};
  const storagePath = parseMediaRef(typeof data['reference'] === 'string' ? data['reference'] : null);
  if (storagePath === null) {
    /**
     * A capture with no usable reference is a failure, not a success with a missing field.
     *
     * The route is about to write a `campaign_assets` row keyed on the path; a null there would record
     * an asset pointing at nothing, which reads as a stored screenshot until somebody opens it.
     */
    return { status: 502, body: { error: 'the screenshot was taken but not stored where it could be recorded' } };
  }
  return {
    status: 200,
    body: {
      storagePath,
      sourceUrl: typeof data['url'] === 'string' ? data['url'] : url.trim(),
      title: typeof data['title'] === 'string' ? data['title'] : '',
    },
  };
};

// ---------------------------------------------------------------------------------------------------
// Media prompts
// ---------------------------------------------------------------------------------------------------

export type ScenesOutcome =
  | { readonly status: 200; readonly body: { readonly scenes: readonly string[] } }
  | Failure;

/** `POST /api/ai/generate-media`'s scene planner. Straight through; the order is the film. */
export const planScenesViaAgentkit = async (
  input: AgentkitTarget & { readonly request: { readonly prompt: string; readonly sceneCount: number } },
): Promise<ScenesOutcome> => {
  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('plan_video_scenes', {
      concept: input.request.prompt,
      sceneCount: input.request.sceneCount,
    });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'the scenes could not be planned');

  const scenes = dataOf(answer.body)?.['scenes'];
  const prompts = Array.isArray(scenes)
    ? scenes.map((scene) => String((scene as { prompt?: unknown }).prompt ?? '')).filter((prompt) => prompt !== '')
    : [];
  if (prompts.length !== input.request.sceneCount) {
    /**
     * All or nothing, which is the tool's own rule and the caller's too: the route queues one generation
     * job per scene, so a film missing its middle is not a shorter film.
     */
    return { status: 502, body: { error: 'Scene planning failed — try again or generate a single clip.' } };
  }
  return { status: 200, body: { scenes: prompts } };
};

export type PromptOutcome =
  | { readonly status: 200; readonly body: { readonly prompt: string; readonly changed: boolean } }
  | Failure;

/**
 * `POST /api/ai/generate-media`'s prompt director.
 *
 * **It no longer swallows a model failure**, which is the one behavioural change. The old route returned
 * the user's original prompt on any error — *"enhancement must never block generation"* — and the caller
 * already keeps the raw prompt in a `try`/`catch` around this call, so the guarantee holds on its side
 * either way. Swallowing it twice only cost the ability to tell a degraded run from a working one.
 */
export const enhanceMediaPromptViaAgentkit = async (
  input: AgentkitTarget & { readonly request: { readonly prompt: string; readonly kind: 'image' | 'video' } },
): Promise<PromptOutcome> => {
  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('enhance_media_prompt', {
      brief: input.request.prompt,
      kind: input.request.kind,
    });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'the prompt could not be expanded');

  const data = dataOf(answer.body) ?? {};
  const prompt = typeof data['prompt'] === 'string' ? data['prompt'].trim() : '';
  if (prompt === '') return { status: 502, body: { error: 'the expanded prompt came back empty' } };
  return { status: 200, body: { prompt, changed: data['changed'] === true } };
};

// ---------------------------------------------------------------------------------------------------
// Repurpose
// ---------------------------------------------------------------------------------------------------

export type RepurposePiece = {
  readonly caption: string;
  readonly hashtags: string;
  readonly platform: string;
  readonly angle: string;
};

export type RepurposeOutcome =
  | { readonly status: 200; readonly body: { readonly pieces: readonly RepurposePiece[]; readonly truncatedSource: boolean } }
  | Failure;

/**
 * The MCP server's `repurpose` tool.
 *
 * `hashtags` comes back empty, which is the same decision `generate_content` records: the generator
 * writes them into the caption because placement is a platform convention, and splitting them back out
 * would mean guessing at model output shape.
 *
 * `truncatedSource` is additive — the old engine cut the source at 6,000 characters silently, so posts
 * drawn from the first fifth of a transcript read exactly like posts drawn from all of it.
 */
export const repurposeViaAgentkit = async (
  input: AgentkitTarget & {
    readonly request: { readonly sourceText: string; readonly count: number; readonly platforms?: readonly string[] };
  },
): Promise<RepurposeOutcome> => {
  const { sourceText, count, platforms } = input.request;
  if (typeof sourceText !== 'string' || sourceText.trim() === '') {
    return { status: 400, body: { error: 'sourceText is required' } };
  }
  if (platforms === undefined || platforms.length === 0) {
    /**
     * `platformIds` is required by the tool, and rightly: a repurposed post is written for one
     * destination's style, so "any platform" is not a thing it can write for. Refused with the reason
     * rather than defaulted to a platform the workspace may not have.
     */
    return {
      status: 422,
      body: {
        error:
          'Name at least one platform. Each piece is written for a destination\'s own style rather than ' +
          'as one generic post.',
      },
    };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('repurpose_source', {
      sourceText: sourceText.trim(),
      count,
      platformIds: [...platforms],
    });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'the source could not be repurposed');

  const data = dataOf(answer.body) ?? {};
  const raw = Array.isArray(data['pieces']) ? (data['pieces'] as readonly Record<string, unknown>[]) : [];
  const pieces: RepurposePiece[] = raw.map((piece) => ({
    caption: String(piece['caption'] ?? ''),
    // Empty by design — see the header. The caption carries them.
    hashtags: '',
    platform: String(piece['platformId'] ?? ''),
    angle: String(piece['angle'] ?? ''),
  }));
  if (pieces.length === 0) {
    return { status: 502, body: { error: 'No posts came back — try a longer or more specific source' } };
  }
  return { status: 200, body: { pieces, truncatedSource: data['truncatedSource'] === true } };
};

// ---------------------------------------------------------------------------------------------------
// Campaign generation
// ---------------------------------------------------------------------------------------------------

/** What the route persists per post: one caption plus the campaign's channels. */
export type CampaignPost = {
  readonly caption: string;
  readonly hashtags: string;
  readonly angle: string;
  readonly funnel_stage?: string | null;
};

export type CampaignOutcome =
  | {
      readonly status: 200;
      readonly body: {
        readonly posts: readonly CampaignPost[];
        /** Whether the plan was drawn from a live search. Absent when grounding was not asked for. */
        readonly trendGrounded?: boolean;
      };
    }
  | Failure;

/**
 * `campaigns.persona` (jsonb) rendered to the sentence a model can use — REQ-018 AC-1.
 *
 * The form writes `{description: "..."}` and the MCP tools forward whatever a caller passed, so the
 * shape is genuinely unknown at this boundary. A string is itself; an object's string values are
 * joined as `key: value` so a richer persona (`{role, industry, pain}`) survives without this needing
 * to know the keys; anything else yields nothing, because a model shown `[object Object]` writes
 * about nothing in particular and would look like it had been given an audience.
 */
const personaToProse = (persona: unknown): string | undefined => {
  if (typeof persona === 'string') return persona.trim() === '' ? undefined : persona.trim();
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) return undefined;
  const parts = Object.entries(persona as Record<string, unknown>).flatMap(([key, value]) =>
    typeof value === 'string' && value.trim() !== ''
      ? [key === 'description' ? value.trim() : `${key}: ${value.trim()}`]
      : [],
  );
  return parts.length === 0 ? undefined : parts.join('. ');
};

/** The four stages `posts.funnel_stage` accepts. The column's CHECK constraint is the authority. */
const FUNNEL_STAGES = new Set(['awareness', 'consideration', 'conversion', 'retention']);

/**
 * `campaign_templates.post_plan` (jsonb) narrowed to the tool's funnel plan.
 *
 * Steps whose stage is not one the store accepts are **dropped, not sent**. The tool refuses the
 * whole campaign over one unknown stage — deliberately, since a stage that passed validation and
 * failed on insert would lose a generated campaign after the model calls were paid for — and a bad
 * row in `campaign_templates` is not something the person creating a campaign can do anything about.
 * Dropping keeps the rest of the playbook working; a plan left empty by it is simply absent.
 */
const toFunnelPlan = (postPlan: unknown): readonly { stage: string; angle?: string; cta?: string }[] | undefined => {
  if (!Array.isArray(postPlan)) return undefined;
  const steps = postPlan.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return [];
    const step = raw as Record<string, unknown>;
    const stage = step['stage'];
    if (typeof stage !== 'string' || !FUNNEL_STAGES.has(stage)) return [];
    const angle = typeof step['angle'] === 'string' && step['angle'].trim() !== '' ? step['angle'].trim() : undefined;
    const cta = typeof step['cta'] === 'string' && step['cta'].trim() !== '' ? step['cta'].trim() : undefined;
    return [{ stage, ...(angle === undefined ? {} : { angle }), ...(cta === undefined ? {} : { cta }) }];
  });
  return steps.length === 0 ? undefined : steps;
};

/**
 * The store's strategy, as the tool's `strategy` input — or nothing at all.
 *
 * `undefined` when no usable part survived translation, so the tool's "no strategy supplied" branch
 * stays reachable: sending `strategy: {}` would shape nothing and still read, in a transcript, as a
 * campaign that was planned.
 *
 * `templateKey` is deliberately not forwarded. The key is how a *caller* looks the plan up; the
 * planner needs the plan, and passing both would give it a name for something it already holds.
 */
export const toToolStrategy = (
  strategy: { readonly persona?: unknown; readonly primaryGoal?: unknown; readonly postPlan?: unknown } | undefined,
):
  | { audience?: string; primaryGoal?: string; funnelPlan?: readonly { stage: string; angle?: string; cta?: string }[] }
  | undefined => {
  if (strategy === undefined) return undefined;
  const audience = personaToProse(strategy.persona);
  const primaryGoal =
    typeof strategy.primaryGoal === 'string' && strategy.primaryGoal.trim() !== '' ? strategy.primaryGoal.trim() : undefined;
  const funnelPlan = toFunnelPlan(strategy.postPlan);
  if (audience === undefined && primaryGoal === undefined && funnelPlan === undefined) return undefined;
  return {
    ...(audience === undefined ? {} : { audience }),
    ...(primaryGoal === undefined ? {} : { primaryGoal }),
    ...(funnelPlan === undefined ? {} : { funnelPlan }),
  };
};

/**
 * `POST /api/ai/campaign`'s planner.
 *
 * ## The strategy layer, and one thing it loses
 *
 * **The strategy reaches the planner — REQ-018, #291.** A campaign carries a persona, a primary goal
 * and (from a template) a funnel plan, and every one of those was written to `campaigns` by the create
 * form and read by nothing: `generate_campaign` had no parameter for them, so this function refused a
 * request carrying one rather than returning a plan with every `funnel_stage` silently null. The tool
 * takes a `strategy` now and returns a stage per post, so the refusal is gone and the three write
 * sites for `posts.funnel_stage` finally receive a value.
 *
 * Two translations happen here and are worth naming. `persona` is **jsonb** in the store and prose to
 * a model, so it is rendered rather than forwarded. `postPlan` arrives in the store's spelling
 * (`{stage, angle, cta}` with unknown types, because it is jsonb the callers read straight out of
 * `campaign_templates`) and is narrowed to the tool's shape here — a step whose stage is not a string
 * is dropped rather than sent, because the tool refuses the whole campaign over one bad stage and a
 * template row is not something the user can fix.
 *
 * **`autopilot`'s screenshots are gone.** The old agentic planner captured competitor pages as
 * reference assets while it researched. `researchFirst` gives the grounding without the pictures, and
 * `capture_website` is the tool for a screenshot — two visible steps rather than one that quietly does
 * both. Recorded because an autopilot campaign will have fewer reference assets than it used to.
 *
 * `hashtags` comes back empty, the same decision `generate_content` records.
 */
export const generateCampaignViaAgentkit = async (
  input: AgentkitTarget & {
    readonly request: {
      readonly theme: string;
      readonly goal?: string | null;
      readonly brief?: string | null;
      readonly count: number;
      readonly channels: readonly string[];
      /** `autopilot` asked the old runtime for the agentic planner; here it asks for grounding. */
      readonly researchFirst: boolean;
      /**
       * REQ-018's strategy layer, in the **store's** vocabulary — `#291`.
       *
       * `persona` is jsonb and `postPlan` is jsonb, because that is how the callers read them out of
       * `campaigns` and `campaign_templates`; `toToolStrategy` is what turns them into the tool's
       * input. Typed as `unknown` rather than narrowed at the boundary on purpose — three callers
       * hand these over and none of them validates, so the narrowing has to happen once, here, where
       * it can be tested.
       *
       * `templateKey` is accepted and not forwarded: the key is how a caller *finds* a plan, and the
       * planner needs the plan. A caller that sends only a key gets no funnel shape, which is why
       * both routes resolve the row before calling.
       */
      readonly strategy?: {
        readonly persona?: unknown;
        readonly primaryGoal?: unknown;
        readonly templateKey?: unknown;
        readonly postPlan?: unknown;
      };
    };
  },
): Promise<CampaignOutcome> => {
  const { theme, goal, brief, count, channels, researchFirst, strategy } = input.request;

  const toolStrategy = toToolStrategy(strategy);
  if (channels.length === 0) {
    return { status: 400, body: { error: 'A campaign needs at least one channel.' } };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('generate_campaign', {
      theme,
      postCount: count,
      platformIds: [...channels],
      ...(goal === undefined || goal === null || goal.trim() === '' ? {} : { goal: goal.trim() }),
      ...(brief === undefined || brief === null || brief.trim() === '' ? {} : { brief: brief.trim() }),
      ...(researchFirst ? { researchFirst: true } : {}),
      ...(toolStrategy === undefined ? {} : { strategy: toolStrategy }),
    });
  } catch (thrown) {
    return unreachable(thrown);
  }
  if (answer.status !== 200) return refusal(answer.body, 'Campaign generation failed — try again');

  const data = dataOf(answer.body) ?? {};
  const raw = Array.isArray(data['posts']) ? (data['posts'] as readonly Record<string, unknown>[]) : [];
  const posts: CampaignPost[] = raw.map((post) => {
    const versions = Array.isArray(post['versions']) ? (post['versions'] as readonly Record<string, unknown>[]) : [];
    return {
      /**
       * The first version's caption.
       *
       * The store holds **one** caption plus `target_platforms` — #115 found there is nowhere to put a
       * per-platform variant — and the route sets those platforms itself from the campaign's channels.
       * So a campaign post is one caption, exactly as it was.
       */
      caption: String(versions[0]?.['caption'] ?? ''),
      // Empty by design; the caption carries them.
      hashtags: '',
      angle: String(post['angle'] ?? ''),
      /*
       * Present only when the campaign was actually planned — REQ-018.
       *
       * The tool omits `funnelStage` for an unplanned campaign rather than reporting null, and that
       * distinction survives the trip: the route spreads this field conditionally, so an absent stage
       * leaves `posts.funnel_stage` at its own default instead of writing an explicit null over it.
       */
      ...(typeof post['funnelStage'] === 'string' ? { funnel_stage: post['funnelStage'] } : {}),
    };
  });

  if (posts.length !== count || posts.some((post) => post.caption === '')) {
    /**
     * All or nothing, which is the old engine's rule and the tool's: *"a campaign missing a post is
     * more confusing than a clean retry."* The route is about to insert one row per post and delete the
     * campaign on failure, so a short plan would leave a campaign with holes in it.
     */
    return { status: 502, body: { error: 'Campaign generation failed — try again' } };
  }
  return {
    status: 200,
    body: {
      posts,
      ...(typeof data['trendGrounded'] === 'boolean' ? { trendGrounded: data['trendGrounded'] } : {}),
    },
  };
};
