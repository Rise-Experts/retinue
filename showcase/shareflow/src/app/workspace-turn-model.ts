/**
 * The workspace's own model on a **conversational turn** — the half of #462 that was left open.
 *
 * ## Why this was "impossible" and what changed
 *
 * `@retinue/agentkit` resolves a turn's model through `resolveModel(manifest, context)`. It receives
 * the `ExecutionContext`, so it *looks* like the natural place for a per-tenant lookup — the shareflow
 * README says exactly that. But it is called **synchronously**:
 *
 * ```js
 * const resolved = deps.resolveModel(manifest, context);   // dist/agents/engine.js:141 — not awaited
 * ```
 *
 * so a database read cannot happen inside it, and returning a promise hands the engine a
 * `ResolvedModelInfo` whose `.model` is `undefined`. That is why #462 shipped covering content
 * generation only, and why the assistant kept answering on the deployment's key — which, with the
 * platform's Google credits depleted, means it stopped answering at all.
 *
 * The way through is that **the model itself is allowed to be lazy**. `resolveModel` must return an
 * object synchronously; nothing says that object has to know which provider it will talk to. The AI
 * SDK's `wrapLanguageModel` middleware is asynchronous — `wrapStream({ doStream, params })` returns a
 * promise — and it receives the call's `params`. So the wrapper can do the lookup at the moment of the
 * first model call and hand `params` to a different provider's model entirely.
 *
 * A synchronous cache primed in the background was the obvious alternative and is the wrong one: the
 * first turn for every workspace would quietly run on the platform's key. That is this exact defect
 * made rarer, and rare-and-silent is harder to find than always-wrong.
 *
 * ## What still comes from the deployment, and is honest about it
 *
 * `ResolvedModelInfo` also carries `modelId`, `definition` and `price`, and those are decided before
 * anybody knows whether this turn is BYO. So:
 *
 * - **`price` is handled**, because getting it wrong means billing a customer's tokens to the
 *   platform's ledger. The wrapper and the price function are built together per turn and share a
 *   flag, so a turn that ran on the workspace's own model reports a platform cost of zero — which is
 *   the truth: those tokens were billed to the customer's provider account.
 * - **`modelId` and `definition` are not**, and remain the deployment's. They drive the usage row's
 *   label and the declared limits (`contextTokens: 0`, i.e. no ceiling). A BYO turn is therefore
 *   labelled with the deployment's model id. Recorded here rather than hidden, and worth fixing when
 *   `resolveModel` can be awaited upstream — Rise-Experts/retinue#279.
 */

import { AgentPlatformError, type ExecutionContext, type ModelProvider } from "@retinue/agentkit";

import type { WorkspaceModel, WorkspaceModelResolver } from "../adapters/model/workspace-model.js";
import { manageCallContext } from "./context-management.js";
import { modelContextWindow } from "./context-window.js";
import { effortOptions, withEffort } from "./model-catalogue.js";
import { asRetryable, withRetryableStreamErrors, withStepRetry } from "./provider-errors.js";
import { promptFingerprint, type PromptFingerprint } from "./prompt-fingerprint.js";
import { measuredCharsPerToken } from "./token-ratio.js";
import { withEmptyCandidateRetry } from "./retry-empty-candidate.js";
import { withoutToolRecordEcho, withoutToolRecordEchoInContent } from "./tool-record-echo.js";
import { failedToolCalls, withFailureAcknowledged, withFailureNote } from "./failed-tool-guard.js";
import type { TurnSettings } from "./turn-settings.js";
import type { CallGate, CallTicket } from "./token-budget.js";

/**
 * One provider client per distinct credential.
 *
 * Keyed on the **credential**, never on the tenant. Keying on the tenant would keep a rotated key
 * working until the process restarted; building one client for everybody would serve one workspace
 * another workspace's key.
 */
export const createWorkspaceModelFactory = () => {
  const models = new Map<string, unknown>();

  return async (workspace: WorkspaceModel): Promise<unknown> => {
    const cacheKey = [workspace.provider, workspace.apiKey ?? "", workspace.baseUrl ?? ""].join("|");
    const existing = models.get(cacheKey);
    if (existing !== undefined) return existing;

    const { createProviderFactory } = await import("@retinue/agentkit/providers");
    const factory = createProviderFactory({
      credentials: {
        [workspace.provider]: {
          ...(workspace.apiKey === undefined ? {} : { apiKey: workspace.apiKey }),
          ...(workspace.baseUrl === undefined ? {} : { baseURL: workspace.baseUrl }),
          name: "shareflow",
        },
      },
    } as never);

    const definition = {
      id: workspace.modelId,
      provider: workspace.provider as ModelProvider,
      modelId: workspace.modelId,
      displayName: workspace.modelId,
      capabilities: { tools: true, streaming: true, structuredOutput: true },
      // #630: the model's real window, declared — it was 0 ("undeclared") and every model was sized alike.
      limits: { contextTokens: modelContextWindow(workspace.modelId), maxOutputTokens: 8_192 },
    };

    /**
     * The empty-candidate retry applies to a workspace's model too.
     *
     * Redirecting inside middleware **bypasses the middleware underneath**, so a BYO turn would
     * otherwise lose the protection `retry-empty-candidate.ts` exists for: a candidate with no content
     * becomes a completed run with zero parts, which from the app is a message sent and nothing at all
     * in reply. That behaviour was measured on one provider, and there is no reason to assume the
     * others never do it.
     */
    const built = withEmptyCandidateRetry(
      (factory as { languageModel: (d: unknown) => unknown }).languageModel(definition),
    );
    models.set(cacheKey, built);
    return built;
  };
};

export type WorkspaceTurnModel = {
  /** Hand this to `ResolvedModelInfo.model`. It decides which provider to call on first use. */
  readonly model: unknown;
  /** True once this turn has actually run on the workspace's own model. Read *after* the call. */
  readonly ranOnWorkspaceModel: () => boolean;
  /**
   * #630: the provider and model this turn runs on — the chat's choice, the workspace's key or the
   * deployment's — so history and the meter are sized against the model that answers. Undefined only when
   * no deployment target was given (tests).
   */
  readonly target: () => Promise<{ readonly provider: string; readonly modelId: string } | undefined>;
  /** #657: whose key this turn runs on — a workspace's own key is not held to the platform's history cap. */
  readonly source: () => Promise<"deployment" | "workspace">;
};

type Middleware = {
  transformParams: (options: { params: unknown }) => Promise<unknown>;
  wrapGenerate: (options: { doGenerate: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown>;
  wrapStream: (options: { doStream: () => PromiseLike<unknown>; params: unknown }) => Promise<unknown>;
};

/**
 * Wrap the deployment's model so a turn can be served by the workspace's instead.
 *
 * Built **per turn**, because it closes over that turn's `context` — the whole point — and because the
 * flag it exposes describes that turn alone. Constructing it costs an object and no I/O; the lookup
 * happens on the first model call and only then.
 */
export const withWorkspaceModel = (input: {
  readonly model: unknown;
  readonly context: ExecutionContext;
  readonly resolve: WorkspaceModelResolver;
  readonly languageModelFor: (workspace: WorkspaceModel) => Promise<unknown>;
  readonly wrap?: (options: { model: unknown; middleware: unknown }) => unknown;
  /**
   * Each model call's usage, as it finishes — #518. The engine records only the turn's total, so this is
   * the one place a single call's input (the real context) and the number of calls are visible.
   */
  readonly onCall?: (usage: ModelCallUsage) => void;
  /** Each call's prompt as hashes (`prompt-fingerprint.ts`), so a broken prompt cache can be traced. */
  readonly onPrompt?: (fingerprint: PromptFingerprint) => void;
  /**
   * #551: the chat's model and effort for this turn. Absent (tests, direct calls), the turn behaves as it
   * always did: the workspace's own model when it has one, else the deployment's, at the provider's effort.
   */
  readonly turnSettings?: () => Promise<TurnSettings>;
  /** The deployment's provider and model id — what "the default" is, and what effort is mapped against. */
  readonly deployment?: { readonly provider: string; readonly modelId: string };
  /** Another model on the deployment's key, for a `chorus:<modelId>` choice (`RETINUE_MODEL_CHOICES`). */
  readonly deploymentModelFor?: (modelId: string) => Promise<unknown>;
  readonly allowedDeploymentModels?: readonly string[];
  /**
   * #668: the platform key's per-minute token budget, asked before every model call. A turn on the workspace's own
   * key passes straight through; see `token-budget.ts`.
   */
  readonly gate?: CallGate;
  /**
   * #668: another model on the deployment's key (`SHAREFLOW_SIBLING_MODEL`), tried once when the turn's model is
   * rate-limited — Google's limits are per model, so a sibling has its own. Absent, a rate limit is retried as #651
   * does it and nothing else changes.
   */
  readonly sibling?: { readonly modelId: string; readonly model: () => Promise<unknown> };
}): WorkspaceTurnModel => {
  let ranOnWorkspaceModel = false;

  /**
   * Resolved at most once per turn, even though a turn makes many model calls.
   *
   * A tool-calling turn is a loop — generate, call a tool, generate again — and each pass reaches the
   * model. Looking the workspace up every time would multiply one query by the loop's length for no
   * new information: a credential cannot meaningfully change inside a single turn, and the *next* turn
   * re-resolves, so a revoked key still stops working immediately in the sense that matters.
   */
  type Choice = {
    readonly override: unknown;
    /** Whose key the override is on: only a workspace override makes the turn free to the platform. */
    readonly source: "deployment" | "workspace";
    readonly target?: { provider: string; modelId: string };
    readonly settings?: TurnSettings;
  };
  let pending: Promise<Choice> | undefined;

  const workspaceOverride = async (): Promise<{ model: unknown; workspace: WorkspaceModel } | undefined> => {
    let workspace: WorkspaceModel | undefined;
    try {
      workspace = await input.resolve(input.context);
    } catch (error) {
      /**
       * A failed lookup falls back rather than failing the turn. Taking the assistant down for every
       * workspace because one optional table could not be read would be worse than the bug this
       * fixes.
       */
      console.warn(
        `[shareflow] resolving the BYO provider for workspace ${String(input.context.tenantId)} threw (${
          error instanceof Error ? error.message : String(error)
        }) — this turn uses the deployment's model.`,
      );
      return undefined;
    }
    if (workspace === undefined) return undefined;
    try {
      return { model: await input.languageModelFor(workspace), workspace };
    } catch (error) {
      console.warn(
        `[shareflow] could not build workspace ${String(input.context.tenantId)}'s ${workspace.provider} ` +
          `model "${workspace.modelId}" (${error instanceof Error ? error.message : String(error)}) — ` +
          "this turn uses the deployment's model.",
      );
      return undefined;
    }
  };

  /**
   * Which model this turn runs on, decided once — #462 and #551.
   *
   * No choice: the workspace's own model when it has one, else the deployment's (the #462 behaviour).
   * `chorus:<id>`: the deployment's key, on that model if the deployment offers it. `workspace:<id>`:
   * the workspace's own key. A choice that cannot be honoured falls back to the no-choice behaviour and
   * says why in the log.
   */
  const choose = async (): Promise<Choice> => {
    pending ??= (async (): Promise<Choice> => {
      const settings = input.turnSettings === undefined ? undefined : await input.turnSettings().catch(() => undefined);
      const wanted = settings?.model;
      const deploymentTarget = input.deployment;
      if (wanted !== undefined && wanted.startsWith("chorus:") && deploymentTarget !== undefined) {
        const modelId = wanted.slice("chorus:".length);
        if (modelId === deploymentTarget.modelId) return { override: undefined, source: "deployment", target: deploymentTarget, settings };
        if ((input.allowedDeploymentModels ?? []).includes(modelId) && input.deploymentModelFor !== undefined) {
          try {
            return { override: await input.deploymentModelFor(modelId), source: "deployment", target: { provider: deploymentTarget.provider, modelId }, settings };
          } catch (error) {
            console.warn(`[shareflow] could not build "${modelId}" on the deployment's key (${error instanceof Error ? error.message : String(error)}); using the default.`);
          }
        } else {
          console.warn(`[shareflow] this chat asked for "${wanted}", which this deployment does not offer; using the default.`);
        }
      }
      const byo = await workspaceOverride();
      if (byo !== undefined) {
        if (wanted !== undefined && wanted.startsWith("workspace:") && wanted.slice("workspace:".length) !== byo.workspace.modelId) {
          console.warn(`[shareflow] this chat asked for "${wanted}"; the workspace's key serves "${byo.workspace.modelId}".`);
        }
        return { override: byo.model, source: "workspace", target: { provider: byo.workspace.provider, modelId: byo.workspace.modelId }, settings };
      }
      if (wanted !== undefined && wanted.startsWith("workspace:")) {
        console.warn(`[shareflow] this chat asked for "${wanted}", but the workspace has no key configured; using the deployment's model.`);
      }
      return { override: undefined, source: "deployment", ...(deploymentTarget === undefined ? {} : { target: deploymentTarget }), settings };
    })();
    return pending;
  };

  /*
   * #658: the run's own chars-per-token ratio — the last call's prompt characters over its measured input. The next
   * call's tool-output clearing is sized with it, so a Gemini run clears at 60% of its window in Gemini's tokens.
   * Before the first measurement, `manageCallContext` uses the model's default.
   */
  let sentPrompt: { readonly promptChars: number; readonly hasMedia: boolean } | undefined;
  let runCharsPerToken: number | undefined;

  /** The call's usage to the meter and (#668) to the budget's reservation. Unreadable usage keeps the estimate. */
  const report = (usage: unknown, ticket?: CallTicket) => {
    const call = modelCallUsage(usage);
    if (call === undefined) return;
    if (sentPrompt !== undefined) runCharsPerToken = measuredCharsPerToken({ ...sentPrompt, inputTokens: call.inputTokens }) ?? runCharsPerToken;
    try {
      ticket?.settle(call);
      input.onCall?.(call);
    } catch {
      // Measuring must never break the turn it measures.
    }
  };

  /**
   * #668: once per turn, a rate-limited call is tried again at once on the sibling model, and the rest of the turn
   * stays there — the turn's own model is refusing for the rest of this minute. Only a `rate_limited` refusal (the
   * #651 classification) moves it, only on the deployment's key (a sibling would bill a BYO turn to the platform),
   * and when the sibling fails too the turn goes back to its own model and #651's retry takes over.
   */
  let siblingTried = false;
  let onSibling = false;
  const viaSibling = async <T>(
    choice: { readonly source: "deployment" | "workspace"; readonly target?: { readonly modelId: string } },
    own: () => PromiseLike<T>,
    on: (model: unknown) => PromiseLike<T>,
  ): Promise<T> => {
    const mapped = (call: () => PromiseLike<T>): Promise<T> =>
      Promise.resolve()
        .then(call)
        .catch((thrown: unknown) => {
          throw asRetryable(thrown);
        });
    const sibling = input.sibling;
    const runSibling = async (): Promise<T> => {
      try {
        const model = await sibling!.model();
        return await mapped(() => on(model));
      } catch (thrown) {
        onSibling = false;
        throw thrown;
      }
    };
    if (onSibling && sibling !== undefined) return runSibling();
    try {
      return await mapped(own);
    } catch (thrown) {
      const rateLimited = thrown instanceof AgentPlatformError && thrown.code === "rate_limited";
      if (!rateLimited || sibling === undefined || siblingTried || choice.source !== "deployment" || choice.target?.modelId === sibling.modelId) throw thrown;
      siblingTried = true;
      onSibling = true;
      console.warn(
        `[shareflow] run ${String(input.context.runId ?? "?")}: "${choice.target?.modelId ?? "the model"}" is rate-limited; ` +
          `trying the call once on its sibling "${sibling.modelId}" (#668).`,
      );
      return runSibling();
    }
  };

  const logEcho = (): void => {
    console.warn(`[shareflow] run ${String(input.context.runId ?? "?")}: the model wrote a tool record into its reply; it was removed (#650).`);
  };

  const middleware: Middleware = {
    /**
     * #551: the chat's effort, as the options the chosen model's provider understands. `medium` sends
     * nothing; a model with no such knob gets nothing and the log says effort was ignored.
     */
    async transformParams({ params }) {
      const choice = await choose();
      let next = params;
      const effort = choice.settings?.effort ?? "medium";
      if (effort !== "medium" && choice.target !== undefined) {
        const result = effortOptions(choice.target, effort, params as { maxOutputTokens?: number });
        if (result.applied) {
          next = withEffort(params as { providerOptions?: unknown; maxOutputTokens?: number }, result);
        } else {
          console.info(`[shareflow] effort "${effort}" ignored: ${choice.target.provider} "${choice.target.modelId}" has no reasoning setting.`);
        }
      }
      /*
       * #630: sized against the model that actually answers — old tool outputs cleared when a run outgrows its
       * working window, and the provider's prompt-cache hints set.
       */
      const conversationId = input.context.conversationId === undefined ? undefined : String(input.context.conversationId);
      const managed =
        choice.target === undefined
          ? next
          : manageCallContext(next as never, choice.target, {
              ...(conversationId === undefined ? {} : { cacheKey: conversationId }),
              ...(runCharsPerToken === undefined ? {} : { charsPerToken: runCharsPerToken }),
            });
      // #689: after a failed tool call, the model is told it failed — at the end, so the cached prefix is untouched.
      const final = withFailureNote(managed as { prompt?: unknown });
      try {
        const fingerprint = promptFingerprint(final);
        sentPrompt = { promptChars: fingerprint.promptChars, hasMedia: fingerprint.hasMedia };
        input.onPrompt?.(fingerprint);
      } catch {
        // Measuring must never break the call it measures.
      }
      return final;
    },
    async wrapGenerate({ doGenerate, params }) {
      const choice = await choose();
      const override = choice.override;
      if (override !== undefined && choice.source === "workspace") ranOnWorkspaceModel = true;
      const signal = (params as { abortSignal?: AbortSignal }).abortSignal;
      // #668: the platform's per-minute budget, before the call — over it, the turn waits instead of being refused.
      const ticket = await input.gate?.({ params, source: choice.source, signal });
      // #651: a provider's "slow down" becomes an error the run retries, instead of failing it on the spot.
      let result: unknown;
      try {
        result = await withStepRetry(
          () =>
            viaSibling(
              choice,
              () => (override === undefined ? doGenerate() : (override as { doGenerate: (p: unknown) => PromiseLike<unknown> }).doGenerate(params)),
              (model) => (model as { doGenerate: (p: unknown) => PromiseLike<unknown> }).doGenerate(params),
            ),
          { signal, runId: input.context.runId },
        );
      } catch (thrown) {
        ticket?.settle(undefined);
        throw thrown;
      }
      report((result as { usage?: unknown } | undefined)?.usage, ticket);
      // #650: a tool record the model wrote itself is cut before it is saved.
      const content = (result as { content?: unknown } | undefined)?.content;
      return content === undefined ? result : { ...(result as object), content: withoutToolRecordEchoInContent(content, logEcho) };
    },
    async wrapStream({ doStream, params }) {
      const choice = await choose();
      const override = choice.override;
      if (override !== undefined && choice.source === "workspace") ranOnWorkspaceModel = true;
      const signal = (params as { abortSignal?: AbortSignal }).abortSignal;
      // #668: the platform's per-minute budget, before the call. A queued first call throws a retryable `queued`
      // error from here, outside the step retry, so the engine shows the wait as `run.retry-pending`.
      const ticket = await input.gate?.({ params, source: choice.source, signal });
      // #651: a provider's "slow down" — thrown at the request or sent as an error part — is made retryable, and a
      // call refused before it produced anything is retried here, where no output can be duplicated.
      let result: { stream?: unknown };
      try {
        result = (await withStepRetry(
          () =>
            viaSibling(
              choice,
              () => (override === undefined ? doStream() : (override as { doStream: (p: unknown) => PromiseLike<unknown> }).doStream(params)),
              (model) => (model as { doStream: (p: unknown) => PromiseLike<unknown> }).doStream(params),
            ),
          { signal, runId: input.context.runId },
        )) as { stream?: unknown };
      } catch (thrown) {
        ticket?.settle(undefined);
        throw thrown;
      }
      // #650: a tool record the model wrote itself is cut before it is shown or saved.
      // #689: a final answer after a failed call that does not say so gets a line that does.
      const failed = failedToolCalls((params as { prompt?: never }).prompt);
      const stream = withFailureAcknowledged(withoutToolRecordEcho(withRetryableStreamErrors(result.stream), logEcho), failed, () => {
        console.warn(`[shareflow] run ${String(input.context.runId ?? "?")}: the reply did not mention ${failed.map((call) => call.toolName).join(", ")} failing; a line saying so was added (#689).`);
      });
      return {
        ...result,
        stream: input.onCall === undefined && ticket === undefined ? stream : tapFinish(stream, (usage) => report(usage, ticket)),
      };
    },
  };

  const model =
    input.wrap === undefined
      ? lazyWrap(input.model, middleware)
      : input.wrap({ model: input.model, middleware });

  return {
    model,
    ranOnWorkspaceModel: () => ranOnWorkspaceModel,
    target: async () => (await choose()).target,
    source: async () => (await choose()).source,
  };
};

/**
 * `wrapLanguageModel`, imported on first use.
 *
 * The engine builds this synchronously inside `resolveModel`, so there is nowhere to `await` an
 * import. A thin proxy whose two methods await the real wrapper keeps the construction synchronous
 * while the SDK import stays dynamic, the same way every other `ai` import in `app/` is done.
 */
const lazyWrap = (model: unknown, middleware: unknown): unknown => {
  let wrapped: Promise<{ doGenerate: (p: unknown) => unknown; doStream: (p: unknown) => unknown }> | undefined;
  const real = async () => {
    wrapped ??= (async () => {
      const { wrapLanguageModel } = await import("ai");
      return wrapLanguageModel({ model: model as never, middleware: middleware as never }) as never;
    })();
    return wrapped;
  };
  const source = model as Record<string, unknown>;
  return {
    // Carried across so the engine and the SDK see a well-formed model before the first call.
    specificationVersion: source["specificationVersion"],
    provider: source["provider"],
    modelId: source["modelId"],
    supportedUrls: source["supportedUrls"] ?? {},
    doGenerate: async (params: unknown) => (await real()).doGenerate(params),
    doStream: async (params: unknown) => (await real()).doStream(params),
  };
};


/** One model call's usage — #518. */
export type ModelCallUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

/** The provider's usage object, read defensively: the fields are optional and their shape varies by SDK version. */
export const modelCallUsage = (usage: unknown): ModelCallUsage | undefined => {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const count = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    // AI SDK v5+ may report `{ total, … }` objects for token counts.
    if (value !== null && typeof value === "object" && typeof (value as { total?: unknown }).total === "number") {
      return (value as { total: number }).total;
    }
    return 0;
  };
  const input = count(u["inputTokens"]);
  const output = count(u["outputTokens"]);
  if (input === 0 && output === 0) return undefined;
  /*
   * #630: at this layer (the model middleware, LanguageModelV3) a cache read is `inputTokens.cacheRead`; the
   * top-level `cachedInputTokens` is the older and the `streamText` shape. Reading only the latter reported
   * every turn as uncached — found on production, a 20k-token gpt-4.1 prompt resent within a minute at 0.
   */
  const nestedRead =
    u["inputTokens"] !== null && typeof u["inputTokens"] === "object" ? (u["inputTokens"] as { cacheRead?: unknown }).cacheRead : undefined;
  const cached = count(u["cachedInputTokens"]) || count(nestedRead);
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached };
};

/** The stream, unchanged, with each call's `finish` part reported as it passes. */
const tapFinish = (stream: unknown, report: (usage: unknown) => void): unknown => {
  if (typeof TransformStream === "undefined" || stream === null || typeof stream !== "object" || typeof (stream as { pipeThrough?: unknown }).pipeThrough !== "function") {
    return stream;
  }
  return (stream as ReadableStream<unknown>).pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(chunk, controller) {
        if (chunk !== null && typeof chunk === "object" && (chunk as { type?: unknown }).type === "finish") {
          report((chunk as { usage?: unknown }).usage);
        }
        controller.enqueue(chunk);
      },
    }),
  );
};
