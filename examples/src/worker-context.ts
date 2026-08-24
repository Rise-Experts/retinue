/**
 * The worker's execution context — its own module because it is a security decision (#164).
 *
 * It lived inside the app module, which cannot be imported by a test: loading `index.ts` runs the wiring and
 * that refuses to start without the dev-auth flag. So the one function that decides *who a background run acts
 * as* was the one function with no test. It had `principalId: "example-worker", roleIds: ["editor"]` hardcoded.
 */

import { parseExecutionContext } from "@agentkit/backend";
import type { ExecutionContext, Run } from "@agentkit/backend";

/**
 * The caller's identity, from the run — #164.
 *
 * The worker has no request, so the context is rebuilt from the run row. This used to read
 * `principalId: "example-worker", roleIds: ["editor"]`, with a comment arguing that a worker finishing an
 * admitted run must be able to call the tools that run was allowed to call. The argument was wrong twice over:
 *
 * - Every principal's memories, usage and audit entries were attributed to one fabricated identity. That is
 *   the bug behind "I told it my country and it did not know" — the fact was stored under `example-worker`,
 *   and so was everybody else's.
 * - `roleIds: ["editor"]` meant a `viewer` whose run was admitted at the API boundary executed in the worker
 *   with editor rights, because the worker re-authorizes with the context it is handed. The catalogue
 *   filtering that makes `viewer` read-only held only on the API side.
 *
 * **Refused rather than substituted** when the run carries no identity. A run created before #164 cannot be
 * attributed, and guessing is what produced both bugs. `parseExecutionContext` would reject an empty
 * principal anyway; failing here says why.
 */
export const buildWorkerContext = (run: Run): ExecutionContext => {
  if (run.principalId === undefined || run.roleIds === undefined) {
    throw new Error(
      `Run ${run.id} carries no principal: it was admitted before identity was recorded (#164). ` +
        `Start a new conversation rather than running it under a substituted identity.`,
    );
  }
  return parseExecutionContext({
    tenantId: run.tenantId,
    principalId: run.principalId,
    roleIds: run.roleIds,
    locale: "en",
    timezone: "UTC",
    requestId: `worker-${run.id}`,
    conversationId: run.conversationId,
    runId: run.id,
  });
};
