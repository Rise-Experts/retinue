import type { ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";
import type { ModelCallUsage } from "./workspace-turn-model.js";

/**
 * One Compose turn, call by call — #518.
 *
 * The platform's usage ledger holds one row per turn with the SDK's `totalUsage`: the sum over every
 * model call. Shown as "Context", that made a 2k-token chat read 80k (7 calls × an ~11k fixed prompt).
 * This keeps what the meter needs: how many calls the turn made and the **last** call's input, which is
 * the real size of the context the model saw.
 */
export type RecordTurnStep = (context: ExecutionContext, call: ModelCallUsage) => Promise<void>;

export const turnStepsRecorder = (sql: SqlExecutor): RecordTurnStep => async (context, call) => {
  if (context.runId === undefined) return;
  await sql.query(
    `insert into public.assistant_turn_steps
       (run_id, workspace_id, conversation_id, steps, last_input_tokens, max_input_tokens,
        total_input_tokens, total_output_tokens, cached_input_tokens, updated_at)
     values ($1, $2::uuid, $3, 1, $4, $4, $4, $5, $6, now())
     on conflict (run_id) do update set
       steps = public.assistant_turn_steps.steps + 1,
       last_input_tokens = excluded.last_input_tokens,
       max_input_tokens = greatest(public.assistant_turn_steps.max_input_tokens, excluded.last_input_tokens),
       total_input_tokens = public.assistant_turn_steps.total_input_tokens + excluded.last_input_tokens,
       total_output_tokens = public.assistant_turn_steps.total_output_tokens + excluded.total_output_tokens,
       cached_input_tokens = public.assistant_turn_steps.cached_input_tokens + excluded.cached_input_tokens,
       updated_at = now()`,
    [
      String(context.runId),
      String(context.tenantId),
      context.conversationId === undefined ? null : String(context.conversationId),
      Math.round(call.inputTokens),
      Math.round(call.outputTokens),
      Math.round(call.cachedInputTokens),
    ],
  );
};

/**
 * #552: what the turn's prompt was made of, on the same row as its steps. Inserted when the row does not
 * exist yet (the prompt is assembled before the first model call), so the step counter starts at 0.
 */
export const contextSectionsRecorder = (sql: SqlExecutor) => async (context: ExecutionContext, summary: unknown): Promise<void> => {
  if (context.runId === undefined) return;
  await sql.query(
    `insert into public.assistant_turn_steps (run_id, workspace_id, conversation_id, steps, context_sections, updated_at)
     values ($1, $2::uuid, $3, 0, $4::jsonb, now())
     on conflict (run_id) do update set context_sections = excluded.context_sections`,
    [String(context.runId), String(context.tenantId), context.conversationId === undefined ? null : String(context.conversationId), JSON.stringify(summary)],
  );
};

/**
 * #630: which model answered the turn and how much it can read, on the same row. A separate statement from
 * the step counter, so a database without the columns yet (migration `20260929180000`) loses only this, never
 * the steps.
 */
export type TurnModelWindow = {
  readonly modelId: string;
  readonly contextWindow: number;
  readonly workingWindow: number;
  readonly historyCondensed: boolean;
  /** #657: the history budget the turn was planned against — where older turns are condensed. */
  readonly historyBudget?: number;
};

export const turnModelRecorder = (sql: SqlExecutor) => async (context: ExecutionContext, model: TurnModelWindow): Promise<void> => {
  if (context.runId === undefined) return;
  await sql.query(
    `insert into public.assistant_turn_steps
       (run_id, workspace_id, conversation_id, steps, model_id, context_window, working_window, history_condensed, updated_at)
     values ($1, $2::uuid, $3, 0, $4, $5, $6, $7, now())
     on conflict (run_id) do update set
       model_id = excluded.model_id,
       context_window = excluded.context_window,
       working_window = excluded.working_window,
       history_condensed = excluded.history_condensed`,
    [
      String(context.runId),
      String(context.tenantId),
      context.conversationId === undefined ? null : String(context.conversationId),
      model.modelId,
      Math.round(model.contextWindow),
      Math.round(model.workingWindow),
      model.historyCondensed,
    ],
  );
};

/**
 * #649 follow-up: the latest call's prompt as hashes, on the same row. Its own statement, so a database without
 * the column yet (migration `20261001090000`) loses only this.
 */
export const promptFingerprintRecorder = (sql: SqlExecutor) => async (context: ExecutionContext, fingerprint: unknown): Promise<void> => {
  if (context.runId === undefined) return;
  await sql.query(
    `insert into public.assistant_turn_steps (run_id, workspace_id, conversation_id, steps, prompt_fingerprint, updated_at)
     values ($1, $2::uuid, $3, 0, $4::jsonb, now())
     on conflict (run_id) do update set prompt_fingerprint = excluded.prompt_fingerprint`,
    [String(context.runId), String(context.tenantId), context.conversationId === undefined ? null : String(context.conversationId), JSON.stringify(fingerprint)],
  );
};

/** #657: the turn's history budget, in its own statement so a database without the column loses only this. */
export const turnHistoryBudgetRecorder = (sql: SqlExecutor) => async (context: ExecutionContext, historyBudget: number): Promise<void> => {
  if (context.runId === undefined) return;
  await sql.query(
    `insert into public.assistant_turn_steps (run_id, workspace_id, conversation_id, steps, history_budget, updated_at)
     values ($1, $2::uuid, $3, 0, $4, now())
     on conflict (run_id) do update set history_budget = excluded.history_budget`,
    [String(context.runId), String(context.tenantId), context.conversationId === undefined ? null : String(context.conversationId), Math.round(historyBudget)],
  );
};

export type TurnSteps = {
  readonly steps: number;
  readonly lastInputTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly cachedInputTokens: number;
  /** #552: the prompt's make-up, when it was recorded. */
  readonly contextSections?: unknown;
  /** #630: the answering model and its windows, when recorded. */
  readonly model?: TurnModelWindow;
  /** #649 follow-up: the latest call's prompt as hashes, when recorded. */
  readonly promptFingerprint?: unknown;
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0);

/**
 * The turn's row by run, or the conversation's latest — null when nothing was recorded.
 *
 * Read as `to_jsonb(row)` rather than by column list, so the #630 columns are simply absent on a database
 * that has not applied their migration — naming them would fail the whole read, and the meter with it.
 *
 * #651: a run that failed before its first model call has a row with no steps (its context was recorded,
 * nothing was measured). The meter then fell back to the ledger and lost its breakdown — the chat box went
 * blank exactly when the person most needed to see how full it was. So the conversation's latest *measured*
 * turn is read instead: by conversation directly, and for such a run through its conversation.
 */
export const readTurnSteps = async (
  sql: SqlExecutor,
  tenantId: string,
  by: { readonly runId: string } | { readonly conversationId: string },
): Promise<TurnSteps | null> => {
  const latestMeasured = `select to_jsonb(s) as r from public.assistant_turn_steps s where s.workspace_id = $1::uuid and s.conversation_id = $2
          and coalesce(s.steps, 0) > 0 order by s.updated_at desc limit 1`;
  let [found] = await sql.query<{ r: Record<string, unknown> }>(
    "runId" in by ? `select to_jsonb(s) as r from public.assistant_turn_steps s where s.workspace_id = $1::uuid and s.run_id = $2` : latestMeasured,
    [tenantId, "runId" in by ? by.runId : by.conversationId],
  );
  if (found !== undefined && "runId" in by && num(found.r["steps"]) === 0 && typeof found.r["conversation_id"] === "string") {
    [found] = await sql.query<{ r: Record<string, unknown> }>(latestMeasured, [tenantId, found.r["conversation_id"]]);
    if (found === undefined) return null;
  }
  if (found === undefined) return null;
  const row = found.r;
  const contextWindow = num(row["context_window"]);
  const workingWindow = num(row["working_window"]);
  return {
    steps: num(row["steps"]),
    lastInputTokens: num(row["last_input_tokens"]),
    totalInputTokens: num(row["total_input_tokens"]),
    totalOutputTokens: num(row["total_output_tokens"]),
    cachedInputTokens: num(row["cached_input_tokens"]),
    ...(row["context_sections"] === undefined || row["context_sections"] === null ? {} : { contextSections: row["context_sections"] }),
    ...(row["prompt_fingerprint"] === undefined || row["prompt_fingerprint"] === null ? {} : { promptFingerprint: row["prompt_fingerprint"] }),
    ...(typeof row["model_id"] === "string" && contextWindow > 0 && workingWindow > 0
      ? {
          model: {
            modelId: row["model_id"],
            contextWindow,
            workingWindow,
            historyCondensed: row["history_condensed"] === true,
            ...(num(row["history_budget"]) > 0 ? { historyBudget: num(row["history_budget"]) } : {}),
          },
        }
      : {}),
  };
};
