/**
 * The capability seam: what a factory receives, what it must declare, and the helper that declares it.
 *
 * **Its own module, and that is not organisation — it is a cycle.** `tools/index.ts` re-exports every
 * factory file at the bottom, and each factory file needs `shareFlowTool`. While that was a *type* the
 * dependency was erased and the cycle was harmless; the moment it became a runtime value, ESM evaluated
 * `posts.ts` before `index.ts`'s body and every factory hit `shareFlowTool is not a function` at import
 * time. Importing from here instead breaks the cycle, and `index.ts` re-exports it so no caller notices.
 */
import type { DelegatingToolDeps, Tool } from "@retinue/agentkit";

import type { ShareFlowServices } from "../services/index.js";

/**
 * Everything a capability is built from.
 *
 * `deps` was missing from the first version of this type (#114), and writing the first capability
 * (#115) is what surfaced it: every ShareFlow tool is a `defineDelegatingTool`, and that needs the
 * authorization policy, the approval gate and the idempotency store. A factory that received only the
 * services could not build one — so each capability would have closed over its own copy of the deps,
 * which is precisely the "applied in one place, in one order" property the envelope exists to have.
 */
export type ShareFlowToolContext<R extends ShareFlowServiceName = ShareFlowServiceName> = {
  /**
   * **Only the services this capability declared.**
   *
   * `Pick`, not the whole interface, and that is the point: reading a service the factory did not
   * declare is a compile error rather than an `undefined` at execute time. Before this, every factory
   * received all ten and the declaration could not have been checked.
   */
  readonly services: Pick<ShareFlowServices, R>;
  readonly deps: DelegatingToolDeps;
};

/** A member of `ShareFlowServices`. Derived, so a new service is available here the moment it exists. */
export type ShareFlowServiceName = keyof ShareFlowServices;

/**
 * How a capability is registered: the services it needs, and a function from those to a tool.
 *
 * A factory rather than a constructed tool, so a capability is written against the seam and the
 * concrete services are supplied once at wiring time. It is also what keeps a capability testable —
 * pass a stub service, get a tool.
 *
 * ## Why `requires` exists
 *
 * A ShareFlow deployment does not necessarily have all ten services. Three of them have adapters in
 * this package; the rest are ports. Without a declaration, a partial deployment could only be served
 * by handing factories an object with seven holes in it, and the hole would surface as
 * `Cannot read properties of undefined` in the middle of somebody's conversation — or, worse, be
 * papered over with stubs that throw, which for a context provider takes the whole turn down (see
 * `adapters/index.ts` on `backend/src/context/assembler.ts:35`).
 *
 * With it, `createShareFlowToolProvider` refuses at construction. That is the property this file
 * already claimed to have and did not: *a wiring mistake should stop the process starting rather than
 * surface as a confusing catalog on someone's first conversation.*
 *
 * A declaration can go stale in two directions, and the type closes both: reading an undeclared
 * service does not compile, because `services` is a `Pick` of exactly `requires`; and declaring one
 * that is never read is caught by `noUnusedLocals` only if destructured, so the test asserts each
 * factory touches every service it asks for.
 */
export type ShareFlowToolFactory<R extends ShareFlowServiceName = ShareFlowServiceName> = {
  readonly requires: readonly R[];
  readonly build: (context: ShareFlowToolContext<R>) => Tool;
};

/**
 * Declares a capability and what it reads.
 *
 * The narrowing comes from the **constraint**, not from the `const` modifier: because `R extends
 * ShareFlowServiceName` is a union of string literals, `shareFlowTool(["content"], …)` infers
 * `R = "content"` and `Pick<ShareFlowServices, R>` is one member. I first wrote that `const` was what
 * prevented a widen to `string[]`, and a sabotage run disproved it — removing `const` changes nothing
 * here. It stays because it pins the argument as a readonly tuple, which is what it is.
 *
 * What *would* quietly undo this is anything that widens `R` to the whole union — a signature taking
 * `readonly ShareFlowServiceName[]`, or an explicit type argument at a call site. That degrades every
 * `Pick` back to the full interface with nothing else failing, so the narrowing is pinned by a
 * type-level equality in the tests rather than left to inference nobody checks.
 */
export const shareFlowTool = <const R extends ShareFlowServiceName>(
  requires: readonly R[],
  build: (context: ShareFlowToolContext<R>) => Tool,
): ShareFlowToolFactory<R> => ({ requires, build });
