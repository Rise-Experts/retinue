/**
 * `POST /api/ai/generate`, served by the agentkit backend — the composer's generate button.
 *
 * The old runtime's `POST /generate` and the new `generate_content` tool do not have the same contract,
 * and pretending otherwise is how a repoint becomes a silent regression. What maps, maps. What does not
 * is **refused with a message naming why**, which only a workspace on the new runtime can even reach —
 * the flag keeps everyone else on the old path.
 *
 * | Old field | New | Note |
 * |---|---|---|
 * | `prompt` | `brief` | Straight through |
 * | `platform` | `platformIds: [platform]` | **Required now.** See below |
 * | `variants: N` | `generate_alternatives` | Its own tool — see below |
 * | `tone` | — | Workspace brand voice, not per request |
 * | `llm` | — | Not forwarded, and no longer needed — see below |
 * | `brand_context`, `voice_examples` | — | The backend reads the brand profile itself |
 *
 * **`llm` is not forwarded, and does not need to be.** It was dropped at the cutover with the
 * consequence recorded in `shareflow/README.md`: a workspace with its own provider was served by the
 * platform's model, its key unused, while this route billed `credits_spent: 0` *because* a BYO row
 * existed. That is closed (#462) — but not here. The backend resolves the workspace's provider itself
 * from `workspace_llm_configs`, keyed on the tenant in the `X-Workspace-Id` header this client already
 * sends, so a decrypted customer key never crosses the network. Adding an `llm` field to this request
 * would put one there for no gain.
 *
 * **`platform` is required.** The new generator writes *per-platform* captions — "one caption per
 * platform named, written for that platform's conventions" — so it has no generic mode. The old route
 * allowed none and produced an untargeted caption. Defaulting to a platform here would be inventing a
 * destination on the user's behalf, which for a publishing tool is the wrong kind of guess.
 *
 * **`variants: N` means something different from `generate_content`'s versions, so it has its own
 * tool.** The old route returned N alternatives for one platform, for a variant picker;
 * `generate_content` returns one version per *destination*, deliberately — #115 found the store holds
 * one caption plus `target_platforms` with nowhere to put an authored variant. Mapping one to the
 * other would fill the picker with captions for platforms the user did not choose.
 *
 * This was a **refusal** until #266, which made the composer's quality-loop toggle fail every time it
 * was ticked. `generate_alternatives` (REQ-014) is the tool for the other meaning: N drafts for one
 * destination, scored against a rubric, the best refined once. It comes back best-first with a score
 * and a one-line critique per candidate, and `caption` is the winner — so a client that ignores
 * `variants` still gets the right answer.
 *
 * **`hashtags` comes back empty**, and that is the one gap with no clean answer. The new generator
 * writes hashtags into the caption because placement is a platform convention — the `post-composition`
 * skill treats it as style with no store behind it. Splitting them back out would mean guessing at model
 * output shape, and they are not always trailing. So the caption carries them and the field is empty;
 * the composer shows the caption as written.
 */

import { createAgentkitClient } from './agentkitClient.ts';

export type GenerateRequest = {
  readonly prompt: string;
  readonly platform?: string | null;
  readonly variants?: number | null;
};

/** One ranked alternative, as the composer's picker renders it — REQ-014, #266. */
export type GeneratedAlternative = {
  readonly caption: string;
  readonly hashtags: string;
  /** The rubric's mean, 0-10. The picker shows it next to the caption. */
  readonly score: number;
  /** One line on what held this one back — more useful to a person than the number alone. */
  readonly critique: string;
};

export type GenerateOutcome =
  | {
      readonly status: 200;
      readonly body: {
        readonly caption: string;
        readonly hashtags: string;
        /** Present only when alternatives were asked for. Best first; the caption above is `[0]`. */
        readonly variants?: readonly GeneratedAlternative[];
      };
    }
  | { readonly status: 400 | 422 | 502; readonly body: { readonly error: string } };

/** What `generate_alternatives` answers with, per candidate. */
type Draft = { readonly caption: string; readonly overall: number; readonly critique: string };

/**
 * What `generate_content` actually answers with — #471.
 *
 * Transcribed from the tool's own return rather than assumed:
 *
 *     { saved: false,
 *       variants: [{ platformId, caption, attempts }],
 *       failed:   [{ platformId, attempts, issues: [{ code, message, ... }] }] }
 *
 * This file previously read `data.versions`, looking for entries with `ok: true`. **Neither exists.**
 * The written ones are in `variants` and carry no `ok` flag — being in that array is what "written"
 * means — and the refused ones are in `failed`. So the lookup found nothing every time, had no
 * refusal to quote, and fell through to the generic sentence: *"The post could not be written for
 * that platform."* Every compose generation, on every platform.
 *
 * Both sides were tested, and each against its own belief about the contract. Nothing compared them
 * until a real response was printed.
 */
type WrittenVariant = { readonly platformId: string; readonly caption: string; readonly attempts?: number };
type FailedVariant = {
  readonly platformId: string;
  readonly issues?: readonly { readonly message?: string; readonly reason?: string }[];
};

export const generateViaAgentkit = async (input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly request: GenerateRequest;
  /**
   * How long to wait for the backend — #470.
   *
   * The client's default is 120s, which was sized for a request somebody was watching. Since
   * generation became a job that number is wrong for this caller in particular: `generate_alternatives`
   * measured **102s** in production and exceeded 120s on the first real run through the queue, so the
   * job failed with a timeout after the ceiling above it had just been removed.
   *
   * A background job has no such deadline. Left optional so the interactive callers keep the default —
   * a person clicking a button should be told something is wrong long before ten minutes.
   */
  readonly timeoutMs?: number;
  readonly callTool?: (name: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}): Promise<GenerateOutcome> => {
  const { prompt, platform, variants } = input.request;

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { status: 400, body: { error: 'prompt is required' } };
  }

  if (platform === undefined || platform === null || platform.trim() === '') {
    return {
      status: 422,
      body: {
        error:
          'Choose a platform. This workspace generates with the agentkit runtime, which writes a caption ' +
          'for each destination using that platform\'s conventions rather than one generic caption.',
      },
    };
  }

  const call =
    input.callTool ??
    (async (name: string, body: unknown) => {
      const client = createAgentkitClient({
        baseUrl: input.baseUrl,
        token: async () => input.secret,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      return client.callTool({ name, body, workspaceId: input.workspaceId, userId: input.userId });
    });

  /**
   * Several alternatives for one destination — REQ-014, #266.
   *
   * This used to be a refusal: *"the agentkit runtime returns one version per destination rather than
   * several alternatives for one"*. That was true of `generate_content` and it made the composer's
   * quality-loop toggle fail every time somebody ticked it — a shipped control that could not work.
   *
   * `generate_alternatives` is the tool for the other meaning, and the two stay separate on purpose:
   * per-destination versions are what gets **saved** (#115 — the store holds one caption plus
   * `target_platforms`), and alternatives are what gets **chosen between**. Mapping one to the other
   * would have filled the picker with captions for platforms the user did not pick.
   */
  const wantsAlternatives = typeof variants === 'number' && variants > 1;

  let answer: { status: number; body: unknown };
  try {
    answer = wantsAlternatives
      ? await call('generate_alternatives', {
          brief: prompt.trim(),
          platformId: platform.trim(),
          count: variants as number,
        })
      : await call('generate_content', { brief: prompt.trim(), platformIds: [platform.trim()] });
  } catch (thrown) {
    /**
     * A backend that cannot be reached is a 502, not a 500.
     *
     * The distinction matters to whoever reads the log: 500 says this route is broken, 502 says the
     * thing it depends on is. The composer shows a retryable error either way.
     */
    return {
      status: 502,
      body: { error: thrown instanceof Error ? thrown.message : 'the generation backend could not be reached' },
    };
  }

  if (answer.status !== 200) {
    const body = answer.body as { error?: unknown };
    return {
      status: 422,
      body: { error: typeof body.error === 'string' ? body.error : 'generation was refused' },
    };
  }

  /**
   * The refusal-carrying result, unwrapped.
   *
   * `generate_content` reports a destination it could not write **with the reason** rather than
   * returning a caption that would be rejected — a forbidden claim, a near-duplicate of a recent post,
   * a length it cannot meet. Turning that into a 200 with an empty caption would hand the composer an
   * empty box and no explanation.
   */
  if (wantsAlternatives) {
    const drafts = (answer.body as { data?: { drafts?: readonly Draft[] } }).data?.drafts ?? [];
    if (drafts.length === 0) {
      /*
       * A 200 carrying nothing is not a success. The tool throws when the rubric judged none of the
       * candidates, so this is the belt to that braces — and an empty picker with no error is exactly
       * the shape the old `variants` refusal existed to avoid.
       */
      return { status: 502, body: { error: 'No alternatives came back — try again.' } };
    }
    /*
     * The caption is the best one, so a client that ignores `variants` still gets the right answer —
     * which is what the composer does today when the quality loop is off.
     */
    const best = drafts[0] as Draft;
    return {
      status: 200,
      body: {
        caption: best.caption,
        // Empty by design, the same as the single-caption path: the caption carries them.
        hashtags: '',
        variants: drafts.map((draft) => ({
          caption: draft.caption,
          hashtags: '',
          score: draft.overall,
          critique: draft.critique,
        })),
      },
    };
  }

  const data = (answer.body as { data?: { variants?: readonly WrittenVariant[]; failed?: readonly FailedVariant[] } })
    .data;
  const written = (data?.variants ?? []).find((variant) => typeof variant.caption === 'string' && variant.caption !== '');

  if (written === undefined) {
    /**
     * The reason comes from `failed[].issues`, which is where the tool puts it.
     *
     * `message` first and `reason` second: the tool's `issueView` emits `message`, and `reason` is
     * kept as a fallback because a refusal with no explanation is the answer that sends somebody
     * looking in the wrong place — which is exactly what the generic sentence below did for a week.
     */
    const reason = (data?.failed ?? [])
      .flatMap((entry) => entry.issues ?? [])
      .map((issue) => issue.message ?? issue.reason)
      .filter((text): text is string => typeof text === 'string' && text !== '')
      .join('; ');
    return {
      status: 422,
      body: {
        error:
          reason !== ''
            ? `The post could not be written: ${reason}`
            : 'The post could not be written for that platform.',
      },
    };
  }

  // `hashtags` is empty by design — see the header. The caption carries them.
  return { status: 200, body: { caption: written.caption, hashtags: '' } };
};
