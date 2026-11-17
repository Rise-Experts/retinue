/**
 * A chat turn's own Chorus credit — #597.
 *
 * The app charges one credit for a conversational turn served by the platform's model (the price is
 * the app's: `web/src/lib/billing/creditPrices.ts`). This file only reports that a turn completed, and
 * whether it ran on the workspace's own model, which only this process knows.
 *
 * ## Why the event log, again
 *
 * `AgentEngineDeps` has no lifecycle hooks; every run event passes through the event log on its way to
 * `run_events` (see `turn-logging.ts`). So `run.completed` is observed here, after it is persisted.
 *
 * ## Once per run
 *
 * The app keys the charge by the run (`chat_turn:<runId>`), so a replayed event, a retried worker or a
 * resumed run that completes again is never billed twice. Failed and cancelled runs are not charged.
 *
 * ## Never in the way
 *
 * The report is fire-and-forget: the terminal event is already persisted, and a slow or failing app
 * must not delay the run's completion. A failure is logged at `warn` with the run id, which is what a
 * reconciliation needs.
 */

/** The minimum an event log must do. Matches `RunEventLog` without importing it. */
type EventLogLike = {
  append(input: { readonly tenantId: unknown; readonly event: unknown }): Promise<void>;
};

export type ChargeTurn = (input: {
  readonly workspaceId: string;
  readonly runId: string;
  /** True when the turn ran on the workspace's own model; absent when this process cannot tell. */
  readonly workspaceModel?: boolean;
  /**
   * The chat the turn belongs to — #646. The run event carries only the run id, so without this every chat-turn
   * charge was stored with no conversation, and the composer's "this chat: N credits" always read 0.
   */
  readonly conversationId?: string;
}) => Promise<unknown>;

/**
 * Which model each in-flight run is served by — written by the engine's `resolveModel`, read on the
 * run's terminal event. Per process, like the engine that writes it; a run this process did not
 * resolve simply has no entry, and the app then decides from the workspace's text key.
 */
const turnModels = new Map<string, { readonly probe: () => boolean; readonly conversationId?: string }>();

/**
 * The engine records, per run, how to ask afterwards whether the workspace's own model served it — and (#646)
 * which chat the run is in, so the charge can be counted per chat.
 */
export const noteTurnModel = (runId: unknown, ranOnWorkspaceModel: () => boolean, conversationId?: unknown): void => {
  if (runId === undefined || runId === null || String(runId) === "") return;
  const chat = conversationId === undefined || conversationId === null || String(conversationId) === "" ? undefined : String(conversationId);
  turnModels.set(String(runId), { probe: ranOnWorkspaceModel, ...(chat === undefined ? {} : { conversationId: chat }) });
};

/**
 * Whether the workspace's own model served `runId`, without consuming the entry — #628.
 *
 * `withTurnCharging` deletes the entry on the terminal event; the run-error decorator sits *inside* it
 * (closer to persistence), so it reads first. `undefined` when this process did not resolve the run or the
 * probe throws — the caller then treats the turn as the platform's.
 */
export const peekTurnModel = (runId: unknown): boolean | undefined => {
  const probe = turnModels.get(String(runId ?? ""))?.probe;
  if (probe === undefined) return undefined;
  try {
    return probe();
  } catch {
    return undefined;
  }
};

/** Wrap an event log so each completed run reports its turn to the app's credit meter. */
export const withTurnCharging = <T extends EventLogLike>(
  eventLog: T,
  chargeTurn: ChargeTurn,
  warn: (message: string) => void = (message) => console.warn(message),
): T => {
  const append: EventLogLike["append"] = async (input) => {
    // Persistence first, always: a billing mistake must not be able to lose an event.
    await eventLog.append(input);

    const event = input.event as { readonly type?: string; readonly runId?: unknown };
    if (event.type !== "run.completed" && event.type !== "run.failed" && event.type !== "run.cancelled") return;
    const runId = String(event.runId ?? "");
    const noted = turnModels.get(runId);
    const probe = noted?.probe;
    turnModels.delete(runId);
    if (event.type !== "run.completed" || runId === "") return;

    let workspaceModel: boolean | undefined;
    try {
      workspaceModel = probe?.();
    } catch {
      workspaceModel = undefined;
    }
    void chargeTurn({
      workspaceId: String(input.tenantId),
      runId,
      ...(workspaceModel === undefined ? {} : { workspaceModel }),
      ...(noted?.conversationId === undefined ? {} : { conversationId: noted.conversationId }),
    }).catch((error: unknown) => {
      warn(
        `[turn ${runId.slice(0, 8)}] chat credit not recorded — ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  return { ...eventLog, append } as T;
};
