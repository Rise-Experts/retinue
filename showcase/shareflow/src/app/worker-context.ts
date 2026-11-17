/**
 * Who a background run acts as — retinue REQ-041 (#190), and a security decision rather than plumbing.
 *
 * The worker has no request, so the execution context is rebuilt from the run row. The fourth member of
 * the `RETINUE_APP_MODULE` contract — `{ authenticate, deps, engine, buildContext }` — and the one that
 * decides identity.
 *
 * **Its own file, for the reason the reference application learned the hard way.** Theirs lived inside
 * the app module, which a test cannot import because loading it runs the wiring — so the one function
 * deciding who a run acts as was the one function with no test, and it had a fabricated principal
 * hardcoded. Two bugs followed from that, and both are worth stating because the fix looks like extra
 * strictness until you know them:
 *
 *  - **Every principal's memories, usage and audit entries were attributed to one invented identity.**
 *    That is the bug behind "I told it my country and it did not know": the fact was stored under the
 *    worker's fake principal, and so was everyone else's.
 *  - **A hardcoded `roleIds: ["editor"]` gave a viewer editor rights** in the worker, because the worker
 *    re-authorises with the context it is handed. The catalogue filtering that makes a viewer read-only
 *    held on the API side only.
 */

import { parseExecutionContext } from "@retinue/agentkit/runtime";
import type { ExecutionContext, Run } from "@retinue/agentkit";

/**
 * The caller's identity, from the run.
 *
 * **Refused rather than substituted** when the run carries none. A run admitted without a recorded
 * principal cannot be attributed, and guessing is what produced both bugs above.
 * `parseExecutionContext` would reject an empty principal anyway; failing here says why — and the
 * worker treats a `buildContext` refusal as a *failed* run rather than a retry, precisely because it
 * is deterministic: the next attempt has the same row and will say the same thing.
 */
export const buildWorkerContext = (run: Run): ExecutionContext => {
  if (run.principalId === undefined || run.roleIds === undefined) {
    throw new Error(
      `Run ${run.id} carries no principal, so there is no identity to execute it as. Start a new ` +
        `conversation rather than running it under a substituted one.`,
    );
  }
  return parseExecutionContext({
    tenantId: run.tenantId,
    principalId: run.principalId,
    roleIds: run.roleIds,
    /**
     * Locale and timezone are the deployment's, not the principal's, and that is a known gap rather
     * than a decision: the run row records neither. It matters for scheduling — the assistant is told
     * it does not know today's date and must ask, which is the mitigation — and for any date it
     * formats. Recording them on the run is the fix, and it belongs with the web app that has them.
     */
    locale: "en",
    timezone: "UTC",
    requestId: `worker-${run.id}`,
    conversationId: run.conversationId,
    runId: run.id,
  });
};
