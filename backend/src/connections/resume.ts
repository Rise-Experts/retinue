/**
 * Resuming a run once consent completes — REQ-063 (#259), task #264, AC-3, AC-5, AC-6 and AC-7.
 *
 * The mirror of `hitl`'s `resumeRun`: transition back to `queued` and enqueue. The run picks up from its
 * checkpoint and re-attempts the tool call that paused it, so nothing before the pause is repeated — the same
 * idempotency the approval path already relies on.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import type { RunId } from "../core/ids.js";
import type { RunEventLog } from "../core/events.js";
import type { JobDispatcher } from "../runtime/index.js";
import type { RunStore } from "../persistence/index.js";

export type ConsentResumeDeps = {
  readonly runs: RunStore;
  readonly dispatcher: JobDispatcher;
  readonly events?: RunEventLog;
  readonly now?: () => string;
};

/**
 * Resumes a run that was waiting for a connection.
 *
 * ## Only the right principal — AC-5
 *
 * This is the security property of the whole feature, and it is not about the run: it is about the **login
 * URL**. That URL is rendered in a UI, appears in screenshots and may be pasted into a chat. If completing the
 * flow it points at could resume *anyone's* run, a leaked URL would let a stranger attach their own account to
 * somebody else's tenant — and every subsequent action the agent took against that provider would be theirs.
 *
 * So the run must belong to the caller's tenant. The OAuth flow has already bound its `state` to the tenant and
 * the principal who began it (#262), which is the other half: the state cannot be redeemed by another person,
 * and the resume cannot be driven from another tenant.
 *
 * ## Idempotent — AC-6
 *
 * A double-click, a retried redirect, a browser prefetch: the callback firing twice must queue the run **once**.
 * `transition` is guarded by the current status, so a run already moved out of `waiting-for-connection` is
 * reported as `resumed: false` rather than enqueued again — and a second job would mean the tool call that
 * paused the run runs twice.
 */
export const resumeAfterConsent = async (
  deps: ConsentResumeDeps,
  input: {
    readonly context: ExecutionContext;
    readonly runId: RunId;
    readonly provider: string;
    readonly connectionId: string;
  },
): Promise<{ readonly resumed: boolean; readonly reason?: string }> => {
  const now = deps.now ?? (() => new Date().toISOString());
  const run = await deps.runs.findById({ tenantId: input.context.tenantId, id: input.runId });

  if (run === null) {
    /**
     * Absent and not-yours are the same answer, deliberately.
     *
     * Distinguishing them tells a caller whether a run id exists in another tenant, which is exactly the probe
     * a leaked login URL would be used for. `findById` is already tenant-scoped, so this branch covers both.
     */
    throw new AgentPlatformError({
      code: "not_found",
      message: `no run "${input.runId}" for this workspace`,
      retryable: false,
    });
  }

  if (run.status !== "waiting-for-connection") {
    // Not an error: a retried callback on an already-resumed run is a normal thing a browser does.
    return { resumed: false, reason: `the run is ${run.status}, not waiting for a connection` };
  }

  if (deps.events !== undefined) {
    // Recorded before the transition, so a crash between the two leaves a log that says what happened rather
    // than a run that moved for no visible reason.
    await deps.events.append({
      tenantId: input.context.tenantId,
      event: {
        type: "connection.completed",
        runId: input.runId,
        sequence: 0,
        occurredAt: now(),
        provider: input.provider,
        connectionId: input.connectionId,
      },
    });
  }

  await deps.runs.transition({
    tenantId: input.context.tenantId,
    id: input.runId,
    workerId: "connections",
    to: "queued",
    now: now(),
  });
  await deps.dispatcher.enqueueRun({ tenantId: input.context.tenantId, runId: input.runId });
  return { resumed: true };
};

/**
 * Fails a run that has been waiting for a connection longer than the deployment allows — AC-7.
 *
 * A pause with no ceiling is a run that holds a row for ever, and the reaper does not sweep it: the reaper
 * exists for *abandoned* runs, and this one is not abandoned — it is waiting for a person who is never coming
 * back. So it needs its own ceiling, and failing with a reason beats a row nobody can explain.
 */
export const expireStaleConsents = async (
  deps: ConsentResumeDeps & { readonly listWaiting: (before: string) => Promise<readonly { readonly tenantId: string; readonly id: RunId }[]> },
  input: { readonly olderThanMs: number },
): Promise<number> => {
  const now = deps.now ?? (() => new Date().toISOString());
  const cutoff = new Date(Date.parse(now()) - input.olderThanMs).toISOString();
  const stale = await deps.listWaiting(cutoff);
  let failed = 0;
  for (const run of stale) {
    await deps.runs.transition({
      tenantId: run.tenantId as never,
      id: run.id,
      workerId: "connections",
      to: "failed",
      now: now(),
    });
    failed += 1;
  }
  return failed;
};
