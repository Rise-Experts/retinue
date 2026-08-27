/**
 * Neutral model-turn streaming — `docs/03-intelligence-runtime.md`.
 *
 * The one place the Vercel AI SDK's `streamText` tool loop is used (boundary rule R3 keeps the SDK
 * inside `models/`). It runs a multi-step turn — the model calls tools, their results feed back, it
 * continues — and yields provider-neutral chunks. The agent engine consumes these chunks without
 * ever importing the SDK, so switching providers changes nothing above this layer.
 */

import { Output, jsonSchema, stepCountIs, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { AgentPlatformError } from "../core/errors.js";
import type { InputModality } from "./index.js";

/** Opaque handle to a provider model. Aliased here so layers above `models/` never import the SDK. */
export type ResolvedModel = LanguageModel;

/** A conversation turn message the engine hands down (text-only for v1; multimodal is additive). */
/**
 * One piece of a turn's content — #185.
 *
 * `image` and `file` exist because the platform has always accepted them: `ImagePart` and `FilePart` are in the
 * message contract, `InputModality` covers image, audio, video and pdf, and `resolveModel` filters on
 * `requiredModalities`. What was missing was the last hop — the bridge to the provider took a string, so an
 * attachment was stored, authorized, rendered and billed for, and then not mentioned to the model.
 *
 * A URL or a data payload rather than a platform file id, deliberately: this layer is the SDK boundary and knows
 * nothing about the file store. The caller resolves a `FilePart` into bytes or a URL **through the mediated read
 * path**, which is what keeps the modality bridge from becoming a way around file authorization.
 */
export type TurnContentPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly image: string | URL; readonly mediaType?: string }
  | { readonly kind: "file"; readonly data: string | URL; readonly mediaType: string; readonly filename?: string };

export type TurnMessage = {
  readonly role: "system" | "user" | "assistant";
  /**
   * A string for a text turn, parts when the turn carries an attachment.
   *
   * A union rather than `text` plus an optional `parts`, which was the other option and is worse: two fields
   * that can both carry text leave the relationship between them undefined, and somebody eventually sets one and
   * reads the other.
   */
  readonly content: string | readonly TurnContentPart[];
};

/** The text of a turn, for callers that count tokens or log. Non-text parts contribute nothing. */
export const turnText = (message: TurnMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part): part is Extract<TurnContentPart, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n");

/** The modalities a turn actually needs, so a model can be checked against it rather than assumed. */
/**
 * What non-text input a turn is carrying — REQ-036 (#185), AC-4.
 *
 * Counted, not inferred: one image part is one image. Audio is not counted yet and the field is deliberately
 * absent rather than zero — a `TurnContentPart` has no duration, so the only honest answer is "this layer does
 * not know", and a zero would be indistinguishable from a silent audio turn.
 */
export const nonTextCounts = (
  messages: readonly TurnMessage[],
): { readonly imageCount?: number } => {
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) if (part.kind === "image") images += 1;
  }
  return images === 0 ? {} : { imageCount: images };
};

export const modalitiesOf = (messages: readonly TurnMessage[]): readonly InputModality[] => {
  const found = new Set<InputModality>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.kind === "image") found.add("image");
      // A file's modality is its media type: a PDF needs `pdf`, an audio file needs `audio`. Anything else is
      // sent as a file and left to the provider — guessing a modality we cannot name would defeat the check.
      if (part.kind === "file") {
        if (part.mediaType === "application/pdf") found.add("pdf");
        else if (part.mediaType.startsWith("audio/")) found.add("audio");
        else if (part.mediaType.startsWith("video/")) found.add("video");
        else if (part.mediaType.startsWith("image/")) found.add("image");
      }
    }
  }
  return [...found];
};

/**
 * What the provider tells us about a call it is making.
 *
 * Only the id, and only because a wrapper needs a key: an execution that resolved to a *different* tool than the
 * one the model named — `execute_tool` — has to be able to say which call it was, or the run event log records
 * the indirection and loses the action.
 */
export type ModelToolCallOptions = {
  readonly toolCallId?: string;
  /**
   * Report what actually ran, when it is not the tool the model named.
   *
   * Best effort by construction: the platform's execution path knows the fact and the *host's* `execute` closure
   * is the only thing standing between the two, so a host that does not call this leaves the field absent. Absent
   * therefore means "nobody reported an indirection", not "there was none" — which is why the run event log keeps
   * the model's own tool name as the primary record and treats this as an addition to it.
   */
  readonly report?: (fact: { readonly ranToolName: string }) => void;
};

/** A tool the model may call this turn. `execute` is the platform's guarded execution path. */
export type ModelTurnTool = {
  readonly name: string;
  readonly description?: string;
  /** Zod schema or JSON-schema object; a permissive object schema is used when absent. */
  readonly inputSchema?: unknown;
  execute(input: unknown, options?: ModelToolCallOptions): Promise<unknown>;
  /**
   * The tool's category, when the caller knows it — task #244.
   *
   * Optional and never sent to the provider. It exists so a caller can express a policy *about* categories —
   * `AgentManifest.toolPolicy.categories` names the ones that must stay resident when the catalogue is bounded —
   * without the engine having to reach back into the registry for a descriptor it was already handed.
   */
  readonly category?: string;
};

export type ModelTurnRequest = {
  readonly model: ResolvedModel;
  readonly system?: string;
  readonly messages: readonly TurnMessage[];
  /**
   * What the resolved model accepts — #185. Optional, and its absence means "do not check".
   *
   * Absent rather than defaulting to `["text"]`, because a caller that has not said what the model takes has not
   * said the model takes text only. Defaulting would refuse every image turn from every caller that has not been
   * updated, which is an outage dressed as a safety check.
   */
  readonly modelModalities?: readonly InputModality[];
  readonly tools?: readonly ModelTurnTool[];
  readonly maxSteps?: number;
  readonly abortSignal?: AbortSignal;
  /**
   * Generation parameters — #160.
   *
   * None of these existed, and none was sent: `streamText` was called with model, system, messages, tools and
   * `stopWhen` only. So `ModelDefinition.limits.maxOutputTokens` was **decorative** in the text path — a
   * definition declaring a 4,096-token cap capped nothing, and a run got whatever the provider's default
   * happened to be. `models/vision.ts` was the only place that applied it.
   *
   * `temperature` matters for a second reason: the evaluation harness (#141) rests its reproducibility argument
   * partly on temperature zero, and there was no way to ask for it on a real run.
   */
  /**
   * Ask the model for a value conforming to a schema, rather than prose — task #243.
   *
   * Neutral on purpose: this layer sits below `agents/`, so it takes a schema rather than an
   * `AgentManifest["responseFormat"]`. The engine does the mapping.
   *
   * The schema must be validatable by this process — see `structuredValidator`. A bare JSON schema is refused,
   * because the AI SDK's `jsonSchema()` wrapper leaves `validate` undefined: it constrains the provider request
   * and checks nothing on the way back, which would make "structured" a request rather than a guarantee. That
   * distinction is the entire point of the task.
   */
  readonly structuredOutput?: { readonly schema: unknown };
  /**
   * Where this turn's prompt prefix may be cached, and how — task #247.
   *
   * `"explicit"` makes this layer emit the provider's cache directive; `"automatic"` and `"none"` emit nothing,
   * for opposite reasons — one needs no help and the other would reject the field. Mapped by the engine from
   * `ModelDefinition.capabilities.promptCaching`, so a caller that supplies no definition sends nothing, which
   * is the behaviour every existing host already has.
   */
  readonly promptCaching?: "automatic" | "explicit" | "none";
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
};

export type NeutralUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Input tokens served from a prompt cache — a **subset** of `inputTokens`, not an addition to it.
   *
   * Read from the provider's `inputTokenDetails.cacheReadTokens` (task #247). It used to be read from
   * `totalUsage.cachedInputTokens`, **a field the AI SDK does not send** — so this was zero on every turn, and
   * `computeModelCostMinorUnits` billed cached tokens at the full input rate. Measured against a live model, a
   * turn reusing a 9,700-token prefix reported 9,472 cache-read tokens and this platform recorded none of them.
   */
  readonly cachedInputTokens: number;
  /**
   * Input tokens written *into* a prompt cache — also a subset of `inputTokens`.
   *
   * Its own quantity because it is priced differently and, on some providers, priced **higher** than a fresh
   * input token: Anthropic charges 1.25× to write a cache entry. Folding it into fresh input under-bills a
   * cache write and over-credits the first turn of every conversation, which is the direction that looks like a
   * saving and is not.
   *
   * Absent means "not reported", not "none" — the rule `imageCount` already follows.
   */
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  /**
   * Non-text input, counted from what **we sent** rather than from what the provider reported — #185 AC-4.
   *
   * Deliberately not read out of the provider's usage object. The AI SDK's neutral usage has no modality
   * breakdown, and the providers that expose one put it in provider-specific metadata under provider-specific
   * names — so a platform reading it would work for one vendor and silently report zero for the rest, which is
   * worse than not reporting at all because it looks like data.
   *
   * We know exactly what went out: the turn's parts. Counting there is provider-independent, always available,
   * and auditable against the transcript — and it is the number a per-image price is charged against anyway.
   */
  readonly imageCount?: number;
  readonly audioSeconds?: number;
};

/** Provider-neutral stream chunk — the engine maps these to `RunEvent`s. */
export type NeutralStreamChunk =
  | { readonly type: "text-delta"; readonly id: string; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly toolCallId: string; readonly toolName: string; readonly output: unknown }
  | { readonly type: "finish"; readonly usage: NeutralUsage }
  /** A validated structured answer — emitted once, at the end, only when `structuredOutput` was asked for. */
  | { readonly type: "structured-output"; readonly value: unknown }
  | { readonly type: "error"; readonly error: unknown };

/**
 * A schema this process can actually check, or a refusal — task #243.
 *
 * The rule: **only a schema with a validator is accepted for structured output.** Zod (a direct dependency) and
 * anything else implementing Standard Schema qualify. A bare JSON-schema object does not, and refusing it is a
 * deliberate choice rather than an omission:
 *
 * - The AI SDK's `jsonSchema()` wrapper returns `{ _type, jsonSchema, validate }` with **`validate` undefined**.
 *   It constrains the provider's generation and validates nothing coming back. Accepting one would mean the
 *   platform says "structured", the provider mostly complies, and nobody checks — which is a softer version of
 *   the bug being fixed, not a fix.
 * - Validating JSON schema properly needs `ajv`, and that is a new runtime dependency for every consumer of a
 *   package whose entire dependency list is `ai` and `zod`. Not worth it when `z.object({...})` is one line and
 *   already validates.
 *
 * So this fails closed, at wiring time, with a message naming the fix. Tools keep taking JSON schema — a tool's
 * arguments are validated by the provider and a bad call is a tool error the model can see and retry, which is
 * a different situation from a guarantee made to a caller about a return value.
 */
export const structuredValidator = (
  schema: unknown,
): ((value: unknown) => { readonly ok: true } | { readonly ok: false; readonly detail: string }) => {
  const standard = (schema as { "~standard"?: { validate?: (v: unknown) => unknown } } | null)?.["~standard"];
  if (schema !== null && typeof schema === "object" && typeof standard?.validate === "function") {
    return (value) => {
      const result = standard.validate!(value) as { issues?: readonly { message?: string; path?: unknown[] }[] };
      // Standard Schema is allowed to return a promise; a validator that cannot answer synchronously is not
      // usable here, and silently treating a pending promise as success is how this would pass having checked
      // nothing. Refuse instead.
      if (result instanceof Promise)
        return { ok: false, detail: "the schema validates asynchronously, which this path cannot await" };
      if (result.issues === undefined || result.issues.length === 0) return { ok: true };
      return {
        ok: false,
        detail: result.issues
          .map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`)
          .join("; "),
      };
    };
  }
  if (isZodSchema(schema)) {
    const parse = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { message?: string } } })
      .safeParse;
    return (value) => {
      const result = parse.call(schema, value);
      return result.success ? { ok: true } : { ok: false, detail: result.error?.message ?? "invalid" };
    };
  }
  throw new AgentPlatformError({
    code: "capability_unavailable",
    message:
      "a structured response format needs a schema this process can validate — a Zod schema, or anything " +
      "implementing Standard Schema. A plain JSON-schema object is refused: the AI SDK sends it to the " +
      "provider but validates nothing on the way back, so the platform would be promising a shape it never " +
      "checks. Use `z.object({ … })`.",
    retryable: false,
  });
};

const isZodSchema = (s: unknown): boolean =>
  typeof s === "object" && s !== null && typeof (s as { safeParse?: unknown }).safeParse === "function";

/** A JSON-schema-shaped object: `{ type: "object", … }`. Enough to tell one from a Zod schema or from absence. */
const isJsonSchema = (s: unknown): boolean =>
  typeof s === "object" && s !== null && typeof (s as { type?: unknown }).type === "string";

const toToolSet = (tools: readonly ModelTurnTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      ...(t.description ? { description: t.description } : {}),
      /**
       * A **JSON schema is honoured**, not discarded — #159.
       *
       * `ModelTurnTool.inputSchema` documents itself as "Zod schema or JSON-schema object", and every tool the
       * platform builds carries a JSON schema: that is what `defineDelegatingTool` takes and what
       * `ToolDescriptor.inputSchema` holds. The previous version kept only a Zod schema and replaced everything
       * else with a permissive `{ type: "object", additionalProperties: true }`.
       *
       * A permissive schema tells the model the tool takes *any* object — so it has no parameter names to fill in
       * and emits calls with **empty arguments**. Every JSON-schema tool in the platform was reaching the model
       * effectively undocumented, and the work it was asked to do silently did not happen: the assistant was
       * asked to remember a fact, called `remember` with `{}`, and two turns later said it knew nothing.
       *
       * Wrapping with `jsonSchema()` is all that was missing. The permissive fallback stays for a tool that
       * genuinely declares nothing, which is the only case it was meant for.
       */
      inputSchema: isZodSchema(t.inputSchema)
        ? (t.inputSchema as never)
        : isJsonSchema(t.inputSchema)
          ? jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0])
          : jsonSchema({ type: "object", additionalProperties: true }),
      // The options are *forwarded*, not dropped. Without the call id a wrapper cannot attribute what it ran,
      // which is how a tool executed through `execute_tool` became an unattributable entry in the audit trail.
      // The options are *forwarded*, not dropped. Without the call id a wrapper cannot attribute what it ran,
      // which is how a tool executed through `execute_tool` became an unattributable entry in the audit trail.
      execute: (input: unknown, options: { toolCallId?: string }) => t.execute(input, { toolCallId: options?.toolCallId }),
    });
  }
  return set;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Run one turn and yield neutral chunks. `streamText` drives the model↔tool loop up to `maxSteps`;
 * this reads its `fullStream` and normalizes the pieces the engine cares about (text deltas, tool
 * calls/results, final usage, errors).
 */
/**
 * A short, safe message for a thrown tool error.
 *
 * Bounded and message-only. The model needs enough to decide whether to retry or explain, and a validation
 * message ("expected string, received undefined") is exactly that — but the value lands in the durable event log,
 * so it is truncated and the object itself never travels.
 */
const errorCodeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "tool-failed";
};

const errorMessageOf = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  return message.slice(0, 200);
};

/**
 * A turn's parts, in the SDK's shape.
 *
 * A message whose content is a plain string stays a plain string rather than being wrapped in a single text
 * part. Providers treat the two identically, but the wire form differs, and a change that rewrites every
 * existing text turn is a change whose blast radius is every conversation rather than the ones with an
 * attachment in them.
 */
const toModelContent = (content: TurnMessage["content"]): ModelMessage["content"] => {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.kind === "text"
      ? { type: "text" as const, text: part.text }
      : part.kind === "image"
        ? { type: "image" as const, image: part.image, ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }) }
        : {
            type: "file" as const,
            data: part.data,
            mediaType: part.mediaType,
            ...(part.filename === undefined ? {} : { filename: part.filename }),
          },
  ) as ModelMessage["content"];
};

/**
 * The cache-read count, from wherever the provider put it — task #247.
 *
 * Exported so the arithmetic is testable without a provider: the whole defect this fixes was a field name that
 * did not exist, which no amount of testing *through* a fake could reveal.
 */
export const cacheRead = (usage: Record<string, unknown>): number => {
  const details = usage.inputTokenDetails as { cacheReadTokens?: unknown } | undefined;
  if (details?.cacheReadTokens !== undefined) return num(details.cacheReadTokens);
  return num(usage.cachedInputTokens);
};

/** The cache-write count, or `undefined` when the provider did not report one. */
export const cacheWrite = (usage: Record<string, unknown>): number | undefined => {
  const details = usage.inputTokenDetails as { cacheWriteTokens?: unknown } | undefined;
  if (details?.cacheWriteTokens !== undefined) return num(details.cacheWriteTokens);
  return usage.cacheWriteTokens === undefined ? undefined : num(usage.cacheWriteTokens);
};

export async function* streamModelTurn(req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> {
  /**
   * Refuse a modality the model cannot take — #185.
   *
   * Fail closed, and loudly. The alternatives are both worse: dropping the attachment sends the model a turn
   * that reads as if the user attached nothing, and it answers confidently about a message it never saw; and
   * substituting a text description silently makes the transcript a record of something that did not happen.
   *
   * `resolveModel` already refuses to *hand out* a model that lacks a required modality, so in the normal path
   * this never fires. It fires when a caller resolved a model for a text turn and an attachment arrived later in
   * the conversation — which is exactly the case the resolution-time check cannot see.
   */
  if (req.modelModalities !== undefined) {
    const needed = modalitiesOf(req.messages);
    const missing = needed.filter((m) => !req.modelModalities!.includes(m));
    if (missing.length > 0)
      throw new AgentPlatformError({
        code: "capability_unavailable",
        message:
          `this turn carries ${missing.join(", ")} and the resolved model accepts only ` +
          `${req.modelModalities.join(", ")}. Resolve a model with the required modalities, or remove the ` +
          `attachment from the turn.`,
        retryable: false,
      });
  }

  const messages: ModelMessage[] = req.messages.map(
    (m) => ({ role: m.role, content: toModelContent(m.content) }) as ModelMessage,
  );
  /**
   * Validated before the call, not after — task #243 AC-2/AC-3.
   *
   * A schema this process cannot check makes "structured" a request rather than a guarantee, and finding that
   * out after a paid generation is finding it out in the worst place. `structuredValidator` throws here.
   */
  const validate = req.structuredOutput === undefined ? undefined : structuredValidator(req.structuredOutput.schema);

  const result = streamText({
    model: req.model,
    ...(req.system ? { system: req.system } : {}),
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: toToolSet(req.tools) } : {}),
    /**
     * `output` rather than `streamObject`, because tools must keep working — AC-4.
     *
     * `streamObject` has no tool loop at all, so a structured agent would silently lose every tool. This keeps
     * `streamText`'s model↔tool loop and constrains only the final answer.
     *
     * The option is `output`, **not** `experimental_output`. It was named the latter in `ai@4` and the name was
     * dropped in `ai@7`; passing the old one is not an error, it is *ignored* — `streamText` accepts the unknown
     * key, the model is never constrained, and `result.output` comes back as ordinary prose. Written down
     * because that is the whole defect class this task exists to close, met again inside the fix: the first
     * version of this code passed `experimental_output`, typechecked, and did nothing. Only the live check
     * against a real model found it.
     */
    ...(req.structuredOutput === undefined
      ? {}
      : { output: Output.object({ schema: req.structuredOutput.schema as never }) }),
    /**
     * The cache breakpoint, for providers that need one told — task #247.
     *
     * Only `"explicit"`. Anthropic caches nothing unless a block carries `cache_control`, so a platform that
     * emitted nothing got no caching there at all — which is what this did. OpenAI needs no directive and would
     * treat one as an unknown field, so `"automatic"` deliberately sends nothing.
     *
     * The breakpoint goes on the **system** block, which is where the stable prefix is: the system prompt and
     * the tool catalogue are byte-identical across every turn of a conversation, and the history after them is
     * not. Anthropic caches everything *up to* a breakpoint, so marking the system block caches the prompt and
     * the tool definitions together.
     *
     * `providerOptions` rather than a top-level field, because this is provider-specific by construction and the
     * AI SDK's neutral surface has no cache concept. A provider that ignores the namespace is unaffected.
     */
    ...(req.promptCaching === "explicit"
      ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      : {}),
    stopWhen: stepCountIs(req.maxSteps ?? 8),
    ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    // Spread conditionally so an unset parameter leaves the provider's own default alone, rather than pinning it
    // to a value this layer invented. #160: none of these was sent at all before.
    ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.topP === undefined ? {} : { topP: req.topP }),
    ...(req.stopSequences === undefined ? {} : { stopSequences: [...req.stopSequences] }),
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        /**
         * Swallowed on a structured turn — AC-5.
         *
         * With `experimental_output` the model's text *is* the JSON, arriving a fragment at a time. Forwarding it
         * would put half-built JSON in the transcript as prose and leave a reader watching `{"na` appear. The
         * decision is one complete part at the end instead; tool calls still stream, so the turn is not silent.
         */
        if (req.structuredOutput !== undefined) break;
        yield { type: "text-delta", id: (chunk as { id?: string }).id ?? "text", text: (chunk as { text?: string }).text ?? "" };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          input: (chunk as { input?: unknown }).input,
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          output: (chunk as { output?: unknown }).output,
        };
        break;
      /**
       * A tool whose `execute` threw — #159.
       *
       * The SDK runs the tools itself and emits `tool-error` when one throws. This case did not exist, so the
       * chunk fell into `default: break` and the failure produced **no neutral chunk at all**: the model never
       * learned the call failed, the projection was left with a `tool-call` and no matching `tool-result`, and
       * the dangling call was only finalised as `tool.failed` at the end of the run — after the answer had
       * already been written. A user asked the assistant to remember something and was told, two turns later,
       * that it knew nothing about them.
       *
       * Mapped to a `tool-result` carrying an error payload rather than to a bare `error`, and that choice is the
       * point: a bare error is a *run* failure, but a tool failing is a normal thing the model should see and
       * respond to. Emitting it as the call's result both resolves the dangling call and puts the failure in the
       * model's own history, so it can retry or say what went wrong.
       */
      case "tool-error":
        yield {
          type: "tool-result",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          output: {
            ok: false,
            // The message only, never the thrown object: a stack or a cause chain routinely carries a URL with a
            // token in it, and this value goes into the run's durable event log. Same rule as #143's `recordError`.
            error: {
              code: errorCodeOf((chunk as { error?: unknown }).error),
              message: errorMessageOf((chunk as { error?: unknown }).error),
            },
          },
        };
        break;
      case "error":
        yield { type: "error", error: (chunk as { error: unknown }).error };
        break;
      case "finish": {
        const usage = (chunk as { totalUsage?: Record<string, unknown> }).totalUsage ?? {};
        yield {
          type: "finish",
          usage: {
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
            /**
             * From `inputTokenDetails`, with the old field as a fallback — task #247.
             *
             * The AI SDK reports the breakdown as
             * `inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }`, and **not** as
             * `cachedInputTokens`. Reading the latter — which is what this did — yielded `undefined` on every
             * provider, so `num()` made it zero and every cached token was billed at the full input rate.
             *
             * The fallback is kept because the field is what a *host-supplied* `streamTurn` would most naturally
             * set, and because a future SDK may reinstate it. Order matters: the detailed breakdown wins, since
             * it is the one a real provider fills in.
             */
            cachedInputTokens: cacheRead(usage),
            ...(cacheWrite(usage) === undefined ? {} : { cacheWriteTokens: cacheWrite(usage) }),
            ...(usage.reasoningTokens !== undefined ? { reasoningTokens: num(usage.reasoningTokens) } : {}),
            /**
             * Non-text input, counted from the request rather than read from the response — #185 AC-4.
             *
             * This is the only place that knows both things at once: what went out, and that the turn has
             * finished. The provider's usage object has no modality breakdown in the SDK's neutral shape, and
             * the vendors that expose one bury it under vendor-specific metadata — so reading it there would
             * work for one provider and silently report zero for the others, which is worse than reporting
             * nothing because it looks like data.
             *
             * Only emitted when there is something to say. A text-only turn carries no `imageCount: 0`, so a
             * pricing record that charges per image cannot be handed a zero it might treat as "unknown".
             */
            ...nonTextCounts(req.messages),
          },
        };
        break;
      }
      default:
        break;
    }
  }

  if (validate === undefined) return;

  /**
   * The structured answer, after the loop and after validation — AC-2.
   *
   * Read from the SDK's resolved output rather than reassembled from the text deltas that were swallowed above:
   * the SDK has already parsed the JSON, and re-parsing a string this layer discarded would be two chances to
   * get it wrong.
   *
   * Every failure here is a **run failure**, deliberately. The alternative is emitting the text as an ordinary
   * answer, which is precisely the defect this task fixes: an agent that asked for a schema, got prose, and had
   * no way to tell. A caller who wanted best-effort prose did not set a structured response format.
   */
  let value: unknown;
  try {
    value = await (result as unknown as { output: Promise<unknown> }).output;
  } catch (thrown) {
    throw new AgentPlatformError({
      code: "provider_error",
      message:
        "the model produced no value conforming to the structured response format: " +
        errorMessageOf(thrown) +
        ". The turn is failed rather than returning the raw text, which would be prose presented as a " +
        "validated object.",
      retryable: true,
    });
  }

  // Belt and braces over the SDK's own parse. `Output.object` validates a Standard Schema, but this layer is
  // where the guarantee is made, and a guarantee that depends on a dependency's internals is a guarantee that
  // changes when the dependency does.
  const verdict = validate(value);
  if (!verdict.ok)
    throw new AgentPlatformError({
      code: "provider_error",
      message:
        `the model's answer does not satisfy the structured response format — ${verdict.detail}. ` +
        "The turn is failed rather than returning it unchecked.",
      retryable: true,
    });

  yield { type: "structured-output", value };
}
