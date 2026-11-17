/**
 * Retry a model call that came back with **nothing in it**.
 *
 * Gemini sometimes answers a perfectly ordinary request with an empty candidate: `finishReason: "STOP"`,
 * a candidate carrying no `parts` key at all, and no `candidatesTokenCount`. Recorded from the real
 * worker:
 *
 * ```
 * data: {"candidates":[{"content":{"role":"model"},"finishReason":"STOP","index":0}],
 *        "usageMetadata":{"promptTokenCount":5046,"totalTokenCount":5046}}
 * ```
 *
 * The platform's `finish` handler reads `chunk.totalUsage` and never inspects `finishReason`, so that
 * ends the turn as `run.completed` with zero parts. From the app it is the worst possible failure: the
 * message is sent, nothing appears, and there is nothing to retry because nothing looks wrong.
 *
 * **The tool list made it far more likely and was not the cause.** Preloading all 58 tools put 61
 * function declarations and 12,162 tokens in every prompt and 7 of 29 calls came back empty; with 21
 * declarations and ~5,500 tokens it was 0 of 95 locally. But the same prompt that answered at 10:14
 * came back empty at 10:47 in production, 5,053 tokens against 5,046 — so the trigger is not size, and
 * the rate is not zero. It is a provider behaviour to be defended against rather than reasoned about.
 *
 * **Why here and not in the platform.** The engine's `finish` handling belongs to `@retinue/agentkit`
 * and this application cannot change it. What it can do is decline to pass an empty answer upward: the
 * model is wrapped, so an empty stream is re-issued before the engine ever sees it, and every caller —
 * the turn, the shadow runner, structured generation — inherits it.
 *
 * **Why it does not cost streaming.** An empty candidate produces a stream with *no content chunk at
 * all*, so this only buffers up to the **first** content chunk and then replays it and pipes the rest.
 * A normal turn is delayed by one chunk; an empty one is retried. Nothing waits for a whole answer.
 */

import { wrapLanguageModel } from "ai";

/** How many times a turn will ask, in total, before it accepts an answer with nothing in it. */
export const EMPTY_CANDIDATE_ATTEMPTS = 3;

type StreamPart = { readonly type: string; readonly delta?: unknown };

/**
 * Did this chunk carry something the run can show?
 *
 * `text-start` and `text-end` do not: the provider brackets an empty text block in exactly those two
 * when it produces no text. An `error` chunk **does** count — an error is a real outcome and the run
 * must report it rather than silently asking again.
 */
const isContent = (part: StreamPart): boolean => {
  if (part.type === "text-delta") return typeof part.delta === "string" && part.delta.length > 0;
  if (part.type === "reasoning-delta") return typeof part.delta === "string" && part.delta.length > 0;
  return (
    part.type.startsWith("tool-") ||
    part.type === "file" ||
    part.type === "source" ||
    part.type === "error"
  );
};

type Peeked = {
  readonly hasContent: boolean;
  /** The same stream, with whatever was read to decide replayed at the front. */
  readonly stream: ReadableStream<unknown>;
  /**
   * What the provider said about stopping, when it produced nothing.
   *
   * Recorded because an empty candidate is not always random. A *deterministic* one — three attempts,
   * three empty answers — means something about that particular request, and the only place the reason
   * appears is the provider's own `finish` chunk and its metadata. Production logs neither, so a
   * repeatable empty answer was unexplainable from the outside; observed for real on a prompt that
   * answered locally and failed every time in production.
   */
  readonly finish: { readonly finishReason?: unknown; readonly providerMetadata?: unknown } | undefined;
  /**
   * The tokens this attempt cost, off its own `finish` chunk.
   *
   * Recorded because a discarded attempt was still **billed**. An empty candidate carries no
   * `candidatesTokenCount`, but the prompt was sent and charged — and the whole prompt, which for this
   * assistant is the system prompt, the context block and twenty tool schemas. Dropping the stream
   * dropped that number with it, so three attempts were reported to the ledger as one and spend was
   * under-counted by up to 3×. `withCarriedUsage` adds it back onto the surviving attempt.
   */
  readonly usage: Readonly<Record<string, unknown>> | undefined;
};

/** Per-attempt token totals, summed field by field so a new provider field is carried, not dropped. */
type CarriedUsage = Readonly<Record<string, number>>;

/**
 * Sum two usage records, keeping only the numeric fields.
 *
 * Generic over the field names on purpose: the platform reads seven of them today
 * (`inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`,
 * `imageCount`, `audioSeconds`) and a hand-written list here would silently stop carrying the eighth.
 */
const addUsage = (
  base: CarriedUsage | undefined,
  extra: Readonly<Record<string, unknown>> | undefined,
): CarriedUsage | undefined => {
  if (extra === undefined) return base;
  const summed: Record<string, number> = { ...(base ?? {}) };
  let any = false;
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    summed[key] = (summed[key] ?? 0) + value;
    any = true;
  }
  return any || base !== undefined ? summed : undefined;
};

/**
 * The stream with earlier attempts' tokens folded into its `finish` chunk.
 *
 * The engine reads usage in exactly one place — the `finish` chunk (`agents/engine.js`, the `"finish"`
 * case, which yields `usage.updated`) — so this is the only point at which a discarded attempt's cost
 * can still reach the ledger. A pass-through when nothing was discarded, which is the ordinary case.
 */
const withCarriedUsage = (
  stream: ReadableStream<unknown>,
  carried: CarriedUsage | undefined,
): ReadableStream<unknown> => {
  if (carried === undefined) return stream;
  const reader = stream.getReader();
  return new ReadableStream<unknown>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      const part = value as { type?: unknown; usage?: Readonly<Record<string, unknown>> };
      if (part.type !== "finish") {
        controller.enqueue(value);
        return;
      }
      /**
       * The original record first, then the summed numbers over the top.
       *
       * `addUsage` keeps only numeric fields — it has to, since it adds them — so writing its result
       * in as the whole record would drop everything else the provider sent. A `modelTier: "pro"` on
       * the finish chunk vanished exactly that way, on the retry path only, which is the half of the
       * behaviour no ordinary turn exercises.
       */
      controller.enqueue({ ...part, usage: { ...(part.usage ?? {}), ...(addUsage(carried, part.usage) ?? {}) } });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};

/**
 * Read until the first content chunk, then hand back an equivalent stream.
 *
 * The buffered chunks are re-enqueued rather than dropped: `stream-start`, `response-metadata` and
 * `text-start` all arrive before any content and the consumer needs them in order.
 */
const peekForContent = async (source: ReadableStream<unknown>): Promise<Peeked> => {
  const reader = source.getReader();
  const buffered: unknown[] = [];
  let hasContent = false;
  let finish: Peeked["finish"];
  let usage: Peeked["usage"];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered.push(value);
    const part = value as StreamPart & {
      finishReason?: unknown;
      providerMetadata?: unknown;
      usage?: Readonly<Record<string, unknown>>;
    };
    if (part.type === "finish") {
      finish = { finishReason: part.finishReason, providerMetadata: part.providerMetadata };
      usage = part.usage;
    }
    if (isContent(part)) {
      hasContent = true;
      break;
    }
  }

  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      if (!hasContent) {
        // The source ended while we were deciding; there is nothing left to pump.
        controller.close();
        reader.releaseLock();
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { hasContent, stream, finish, usage };
};

export type RetryEmptyCandidateOptions = {
  readonly attempts?: number;
  /** Reported on every retry. Defaults to `console.warn`; a test passes its own. */
  readonly onRetry?: (input: { readonly attempt: number; readonly attempts: number }) => void;
  /**
   * Reported when every attempt came back empty, with whatever the provider said about stopping.
   * Defaults to `console.error`.
   */
  readonly onExhausted?: (input: {
    readonly attempts: number;
    readonly finish: { readonly finishReason?: unknown; readonly providerMetadata?: unknown } | undefined;
  }) => void;
};

/**
 * What the run reports when the provider produced nothing every time.
 *
 * A *visible failure*, not a completed run with nothing in it. Three empty candidates in a row is not
 * bad luck — it means something about this request, and "the assistant finished without producing an
 * answer" tells the user nothing they can act on. This message at least says the model returned no
 * content and names the most common cause, and because it arrives as an `error` part the run is marked
 * failed rather than complete, which is what a retry button and a support conversation both need.
 */
export const EMPTY_CANDIDATE_MESSAGE =
  "The model returned no content three times in a row. This is usually the provider refusing a " +
  "particular request rather than a transient fault — the same message may work in a new conversation. " +
  "Nothing was left half-done: no tool ran.";

/**
 * Wrap a language model so a stream with no content in it is asked again.
 *
 * After the last attempt the empty stream is returned as-is: three empty answers in a row is a real
 * signal about the request, and looping would turn a bad turn into an unbounded one. The UI labels a
 * settled turn that produced nothing, so the user still sees *something* rather than silence.
 */
export const withEmptyCandidateRetry = <T>(model: T, options: RetryEmptyCandidateOptions = {}): T => {
  const attempts = Math.max(1, options.attempts ?? EMPTY_CANDIDATE_ATTEMPTS);
  const report =
    options.onRetry ??
    (({ attempt, attempts: total }: { attempt: number; attempts: number }) => {
      console.warn(
        `[shareflow] the model returned a candidate with no content (attempt ${attempt} of ${total}); ` +
          `asking again. This is the empty-candidate behaviour described in retry-empty-candidate.ts — ` +
          `without this the run would complete with no answer and nothing to retry.`,
      );
    });

  const exhausted =
    options.onExhausted ??
    (({ attempts: total, finish }: { attempts: number; finish: unknown }) => {
      console.error(
        `[shareflow] the model returned a candidate with no content on all ${total} attempts. ` +
          `This is deterministic rather than transient, so the request itself is what the provider ` +
          `declined. Provider finish: ${JSON.stringify(finish ?? null)}`,
      );
    });

  return wrapLanguageModel({
    model: model as never,
    middleware: {
      async wrapStream({ doStream }) {
        /**
         * What the attempts we are about to throw away already cost.
         *
         * Accumulated *after* the two return paths below, so it holds the discarded attempts only —
         * the surviving stream still carries its own `finish` chunk, and adding that attempt to the
         * carry would double-count it.
         */
        let carried: CarriedUsage | undefined;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const result = await doStream();
          const peeked = await peekForContent(result.stream as ReadableStream<unknown>);

          if (peeked.hasContent) {
            return { ...result, stream: withCarriedUsage(peeked.stream, carried) } as never;
          }

          if (attempt === attempts) {
            exhausted({ attempts, finish: peeked.finish });
            return {
              ...result,
              stream: withEmptyError(withCarriedUsage(peeked.stream, carried)),
            } as never;
          }

          carried = addUsage(carried, peeked.usage);
          report({ attempt, attempts });
        }
        // Unreachable: the loop returns on its last attempt. Kept so the type is not a lie.
        throw new Error("unreachable");
      },
    },
  }) as unknown as T;
};

/**
 * The exhausted stream, with an `error` part appended after everything else.
 *
 * ## Two corrections, both measured
 *
 * **The error is an `Error`, not a plain object.** The engine's chunk handler is
 * `throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))`. An object
 * literal takes the second branch, `String({…})` is `"[object Object]"`, and the user was shown
 * exactly that — the whole point of `EMPTY_CANDIDATE_MESSAGE` is a sentence someone can act on, and it
 * was being discarded on its way to the screen. The `code`/`retryable` fields went the same way, so
 * they are gone: an `Error` carries the message, and nothing downstream reads the rest.
 *
 * **It goes last, not first.** The earlier version put it in front, reasoning that the engine "stops at
 * `finish`". It does not: `engine.js` runs `for await (const chunk of chunks)` and dispatches each
 * chunk through `mapChunk`, whose `finish` case yields `usage.updated` and returns from *that* call
 * only. The loop keeps reading. So an error in front threw before `finish` was ever mapped and the
 * turn's tokens were never recorded — three billed attempts reported as zero. Appended, the usage is
 * emitted first and the throw still lands, which is both things at once.
 *
 * The comment this replaces claimed the old order preserved usage. It did not, and the claim is the
 * reason nobody checked.
 */
const withEmptyError = (stream: ReadableStream<unknown>): ReadableStream<unknown> => {
  const reader = stream.getReader();
  let raised = false;
  return new ReadableStream<unknown>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!raised) {
          raised = true;
          // Last, so `finish` has already been mapped and the attempts' tokens are on the ledger.
          controller.enqueue({ type: "error", error: new Error(EMPTY_CANDIDATE_MESSAGE) });
          return;
        }
        controller.close();
        reader.releaseLock();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};
