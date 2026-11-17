/**
 * What a turn actually did, on stdout — because until now a whole turn produced one line.
 *
 * ## The gap this closes, measured
 *
 * A real conversational turn was driven against production on 2026-09-15. It ran for 5.3 seconds,
 * selected a workspace's own provider, streamed an answer, and spent 8,296 input tokens. The entire
 * record in `docker logs` was:
 *
 * ```
 * [shareflow] workspace 2db71d16… generates with its own openai-compatible model "qwen3.8-max" at …
 * ```
 *
 * One line, and only because that line had been added an hour earlier for a different reason. A turn
 * that *failed* would have produced nothing at all — which is exactly what debugging the BYO wire ran
 * into: the question "did a turn even happen?" could not be answered from a log.
 *
 * ## Why here rather than in the engine
 *
 * `AgentEngineDeps` has no lifecycle hooks — no `onStarted`, no `onCompleted`, no observer. What it
 * does have is `eventLog`, and **every** run event already flows through it on its way to
 * `run_events`: started, each tool call, usage, completion, failure. So the sink is the seam, and a
 * decorator over it gets the whole lifecycle without the engine knowing.
 *
 * It also means the log cannot silently diverge from what the app sees. These are the same events the
 * SSE stream carries and the same rows `listAfter` replays; there is no second source of truth to
 * drift.
 *
 * ## What it deliberately does not print
 *
 * **Message text.** `part.added` and `part.updated` carry what the user wrote and what the assistant
 * answered — a per-part line would put a customer's content, and anything they pasted into the chat,
 * into a container log that is not treated as confidential. The count is printed at completion
 * instead, which is what tells you a turn produced an answer.
 *
 * **Tool arguments**, for the same reason: they carry captions, briefs and URLs. The tool's *name* and
 * whether it succeeded are what a log needs.
 */

/** The subset of a `RunEvent` this reads. Structural, so no platform type is imported for it. */
type LoggableEvent = {
  readonly type: string;
  readonly runId?: unknown;
  readonly toolName?: string;
  readonly modelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMinorUnits?: number;
  readonly error?: { readonly message?: unknown; readonly code?: unknown };
};

/** The minimum an event log must do. Matches `RunEventLog` without importing it. */
type EventLogLike = {
  append(input: { readonly tenantId: unknown; readonly event: unknown }): Promise<void>;
};

/** A short run id: enough to correlate lines, short enough to read. */
const shortId = (value: unknown): string => String(value ?? "").slice(0, 8);

type TurnState = { started: number; tools: string[]; parts: number };

/**
 * Wrap an event log so every turn narrates itself.
 *
 * Pass-through first and logging second, and never the other way round: persistence is what the app
 * replays a run from, and a logging mistake must not be able to lose an event. A throw from `console`
 * is not a thing that happens, but the ordering is free and the alternative is a failure mode nobody
 * would look for.
 */
export const withTurnLogging = <T extends EventLogLike>(
  eventLog: T,
  log: (message: string) => void = (message) => console.info(message),
): T => {
  /**
   * Per-run state, so a completion line can report a duration and what the turn did.
   *
   * Keyed by run id and deleted on the terminal event, because a worker process is long-lived and a
   * map that only ever grew would be a leak measured in runs per day. A run that ends in a way this
   * does not recognise leaks one small object, which is the acceptable side of that trade.
   */
  const runs = new Map<string, TurnState>();

  const append: EventLogLike["append"] = async (input) => {
    await eventLog.append(input);

    const event = input.event as LoggableEvent;
    const run = shortId(event.runId);
    const tenant = shortId(input.tenantId);

    switch (event.type) {
      case "run.started": {
        runs.set(run, { started: Date.now(), tools: [], parts: 0 });
        log(`[turn ${run}] started for workspace ${tenant}`);
        break;
      }
      case "part.added": {
        const state = runs.get(run);
        if (state !== undefined) state.parts += 1;
        break;
      }
      case "tool.started": {
        const state = runs.get(run);
        if (state !== undefined && event.toolName !== undefined) state.tools.push(event.toolName);
        log(`[turn ${run}] tool ${event.toolName ?? "?"}`);
        break;
      }
      case "tool.failed": {
        // Logged at `warn`, not `info`: a failing tool is the single most useful line in this file
        // when somebody reports "the assistant said it could not do it".
        console.warn(
          `[turn ${run}] tool ${event.toolName ?? "?"} FAILED: ${String(event.error?.message ?? "")}`,
        );
        break;
      }
      case "approval.requested": {
        // A turn parked on a human is not a stalled turn, and the two look identical without this.
        log(`[turn ${run}] waiting for approval`);
        break;
      }
      case "usage.updated": {
        /**
         * The model id here is **the deployment's**, even on a turn served by the workspace's own
         * provider — `ResolvedModelInfo.modelId` is decided before anyone knows whether the turn is
         * BYO. The BYO line from `workspace-model.ts` is what names the real one. Printed anyway
         * because the token counts and the cost are right, and `costMinorUnits: 0` on a BYO turn is
         * the honest figure rather than a missing one.
         */
        log(
          `[turn ${run}] usage ${event.inputTokens ?? 0} in / ${event.outputTokens ?? 0} out ` +
            `· cost ${event.costMinorUnits ?? 0} · billed-as ${event.modelId ?? "?"}`,
        );
        break;
      }
      case "run.completed":
      case "run.failed":
      case "run.cancelled": {
        const state = runs.get(run);
        runs.delete(run);
        const took = state === undefined ? "?" : `${Date.now() - state.started}ms`;
        const did =
          state === undefined
            ? ""
            : ` · ${state.parts} part(s)` + (state.tools.length === 0 ? "" : ` · tools: ${state.tools.join(", ")}`);
        if (event.type === "run.failed") {
          console.error(
            `[turn ${run}] FAILED after ${took}${did} — ${String(event.error?.code ?? "")} ` +
              `${String(event.error?.message ?? "")}`,
          );
        } else {
          log(`[turn ${run}] ${event.type === "run.cancelled" ? "cancelled" : "completed"} in ${took}${did}`);
        }
        break;
      }
      default:
        break;
    }
  };

  // Spread rather than subclass: the platform's log has methods beyond `append` that must keep
  // working, and listing them here would be a copy to keep in step.
  return { ...eventLog, append } as T;
};
