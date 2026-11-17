import type { ExecutionContext } from "@retinue/agentkit";
import type { CreditService } from "../services/index.js";

/**
 * The credit service — #499. Both decisions are the app's: it knows the plan, the counter and whether
 * the workspace has its own key, and it holds the only function that may add to the counter.
 *
 * Absent the app (a local checkout with no `WEB_INTERNAL_URL`), nothing is metered: `reserve` says so
 * and `charge` records nothing. That is a narrower deployment, not a free one in production — every
 * deployed container has the route, which `app/__tests__/services.test.ts` asserts.
 */
export type CreditDeps = {
  readonly check?: (input: { readonly context: ExecutionContext; readonly credits: number; readonly tool: string }) => Promise<{ readonly byo: boolean }>;
  readonly charge?: (input: { readonly context: ExecutionContext; readonly credits: number; readonly tool: string }) => Promise<{ readonly charged: number }>;
};

export const createCreditService = (deps: CreditDeps): CreditService => ({
  async reserve(context, input) {
    if (deps.check === undefined) return { byo: false, metered: false };
    // Throws the app's refusal (`invalid_input`, the plan's upgrade message) when credits are short.
    const { byo } = await deps.check({ context, credits: input.credits, tool: input.tool });
    return { byo, metered: true };
  },
  async charge(context, input) {
    if (deps.charge === undefined || input.credits <= 0) return { charged: 0 };
    return deps.charge({ context, credits: input.credits, tool: input.tool });
  },
});
