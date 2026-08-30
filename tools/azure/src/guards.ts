/**
 * Local validation, converted **once** into a refusal a model can act on — REQ-054 (#232), task #236, AC-5.
 *
 * The parsers in `resource-id.ts` throw `InvalidResourceIdError`, which is the right thing for a pure function
 * to do and the wrong thing to let reach `defineTool`: anything that is not an `AgentPlatformError` is mapped
 * to `{ code: "internal" }`. So a resource id with a typo in it — the single most likely bad input this package
 * receives — came back as an internal fault rather than `invalid_input`.
 *
 * That is worse than cosmetic. `internal` says *this tool is broken*, and the reasonable response to it is to
 * report a bug or retry the identical call; `invalid_input` says *that argument is wrong*, and the reasonable
 * response is to fix the argument. The first version of this package got that wrong for three of the four
 * guards, because only `parseResourceId` was wrapped and the other three were called directly.
 *
 * Hence this file, and hence the tools importing **only** from here. A guard that can be called raw is one that
 * eventually is.
 */

import { AgentPlatformError } from "@retinue/agentkit";

import {
  assertApiVersion,
  assertResourceGroup,
  assertSubscriptionId,
  InvalidResourceIdError,
  parseResourceId,
  type ResourceId,
} from "./resource-id.js";

/** Runs a local check, turning its refusal into `invalid_input`. Anything else is a real fault and is rethrown. */
const locally = <T>(check: () => T): T => {
  try {
    return check();
  } catch (error) {
    if (error instanceof InvalidResourceIdError) {
      throw new AgentPlatformError({ code: "invalid_input", message: error.message, retryable: false });
    }
    throw error;
  }
};

export const checkedId = (raw: string): ResourceId => locally(() => parseResourceId(raw));
export const checkedSubscription = (raw: string): string => locally(() => assertSubscriptionId(raw));
export const checkedGroup = (raw: string): string => locally(() => assertResourceGroup(raw));
export const checkedApiVersion = (raw: string): string => locally(() => assertApiVersion(raw));

/** A refusal that did not come from a parser — a range, a missing field, a type this package will not restart. */
export const refuse: (message: string) => never = (message) => {
  throw new AgentPlatformError({ code: "invalid_input", message, retryable: false });
};
