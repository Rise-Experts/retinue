import type { ExecutionContext } from "@retinue/agentkit";
import type { CreditService } from "../services/index.js";

/**
 * Credits for what a tool generated — #499: one per channel written, the price compose charged — recorded **after** the save.
 *
 * Charged for what was written, not what was asked for or how many attempts it took: a channel that
 * failed its checks costs nothing, and a repair loop is not billed twice. A failure to record is logged
 * rather than thrown, because the draft is already saved and failing now would tell the person it was
 * not; an under-charge is the app's to reconcile, a lost draft is theirs.
 */
export const chargeWritten = async (
  credits: CreditService,
  context: ExecutionContext,
  count: number,
  tool: string,
): Promise<number> => {
  if (count <= 0) return 0;
  try {
    return (await credits.charge(context, { credits: count, tool })).charged;
  } catch (error) {
    console.warn(`[shareflow] ${tool}: ${count} credit(s) not recorded — ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
};


/**
 * A tool whose successful call costs Chorus credits — #597.
 *
 * Wraps a delegate: the call runs, and only when it returns is the charge reported, as `units` (1 by
 * default). The app prices it from the tool's name (`creditPrices.ts`) and waives it when the
 * workspace's own provider for that modality pays, so the price never lives here. A failed call costs
 * nothing, and a failure to record is logged, never thrown (see `chargeWritten`).
 *
 * `tool` may depend on the input — `describe_image`'s free alt-text mode reports its own name.
 */
export const withCredit =
  <I, R, Rest extends unknown[]>(
    /** Read on each call, never while the tool is built — a provider may not have it yet. */
    credits: () => CreditService,
    tool: string | ((input: I) => string),
    run: (input: I, context: ExecutionContext, ...rest: Rest) => Promise<R>,
    units: (result: R) => number = () => 1,
  ) =>
  async (input: I, context: ExecutionContext, ...rest: Rest): Promise<R> => {
    const result = await run(input, context, ...rest);
    await chargeWritten(credits(), context, units(result), typeof tool === "string" ? tool : tool(input));
    return result;
  };
