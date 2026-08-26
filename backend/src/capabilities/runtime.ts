/**
 * The composition root — #196.
 *
 * `resolveCapabilities` validates a declaration against a set of wired names. It works, and it left two gaps that
 * only a composition root can close.
 *
 * **The `wired` set was hand-written.** A host passed `new Set(["messages", "principalMemory", …])` beside the
 * stores it supplied, so the cross-check compared a declaration against *another declaration*. Two lists that
 * must agree, neither derived from the thing they describe — which is the shape of the problem, not a fix for it.
 * Here the set is derived from the objects actually supplied, so there is one statement of intent and one of
 * fact.
 *
 * **A capability that is off was unenforced.** Nothing consulted the map, so "off" meant "the host did not wire
 * it" and any code path that reached for it got `undefined`. `requireCapability` was written for this and
 * removed in 684bb1d for having no caller — which was correct then and is fixable now.
 *
 * The fix is that **access is the gate**. `runtime.stores.messages` throws when `history` is off, naming the
 * capability. Not a function a caller must remember to call first: the ones who forget are exactly the six
 * defects this module exists for. Every consumer of a store goes through the same property.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { RunEventLog } from "../core/events.js";
import type {
  InteractionStore,
  MessageStore,
  RunStore,
  SkillStore,
  ThreadSummaryStore,
  UsageStore,
} from "../persistence/index.js";
import type { PrincipalMemoryStore } from "../principal-memory/index.js";
import type { ThreadSummarizer } from "../context/compaction.js";
import type { CitationEmitter } from "../citations/index.js";
import type { McpClient, McpConnectionStore } from "../mcp/provider.js";
import { CAPABILITY_REQUIRES } from "./index.js";
import { resolveCapabilities, type Capability, type CapabilityMap, type ProfileName } from "./index.js";

/**
 * What every runtime needs, capability or not.
 *
 * A run must be durable — that is the floor, not a feature, and a runtime without it is a library for calling a
 * model. `eventLog` is separate and optional: a run without one still executes, it is simply unobservable while
 * it does, which is a legitimate trade for a batch job nobody is watching.
 */
export type RuntimeFloor = {
  readonly runs: RunStore;
  readonly eventLog?: RunEventLog;
};

/**
 * The capability-governed dependencies, keyed by the names `CAPABILITY_REQUIRES` uses.
 *
 * The key names are load-bearing: they are what the derived `wired` set is built from, so a key here and an
 * entry in `CAPABILITY_REQUIRES` must spell the same thing. A test holds that, because a typo would silently
 * mean "not wired" and the capability would be refused for a reason nobody could see.
 */
export type RuntimeStores = {
  readonly messages?: MessageStore;
  readonly principalMemory?: PrincipalMemoryStore;
  readonly summaries?: ThreadSummaryStore;
  readonly interactions?: InteractionStore;
  readonly skills?: SkillStore;
  readonly usage?: UsageStore;
  readonly citations?: CitationEmitter;
  readonly mcpConnections?: McpConnectionStore;
};

export type RuntimeServices = {
  readonly summarizer?: ThreadSummarizer;
  readonly mcpClient?: McpClient;
};

/** Which capability governs which supplied name — the inverse of `CAPABILITY_REQUIRES`. */
const GOVERNED_BY: Readonly<Record<string, Capability>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CAPABILITY_REQUIRES).flatMap(([capability, needs]) =>
      needs.map((name) => [name, capability as Capability]),
    ),
  ),
);

export type CreateRuntimeInput = {
  readonly profile?: ProfileName;
  readonly capabilities?: Partial<CapabilityMap>;
  readonly floor: RuntimeFloor;
  readonly stores?: RuntimeStores;
  readonly services?: RuntimeServices;
};

export type Runtime = {
  readonly capabilities: CapabilityMap;
  /** The floor, always available. */
  readonly floor: RuntimeFloor;
  /**
   * Capability-governed access. Reading a name whose capability is off **throws**, naming the capability.
   *
   * Reading, not calling — so a host cannot get a reference to a store it has turned off and use it later, which
   * is the loophole a `require()`-style check leaves open.
   */
  readonly stores: Required<RuntimeStores>;
  readonly services: Required<RuntimeServices>;
  /** True when the capability is on. For a host that wants to branch rather than be refused. */
  enabled(capability: Capability): boolean;
};

const refuse = (name: string, capability: Capability): never => {
  throw new AgentPlatformError({
    code: "invalid_input",
    message:
      `this runtime has "${capability}" off, so ${name} is not available. Something reached for it anyway, ` +
      `which means a code path is running that this configuration does not support — turn ${capability} on and ` +
      `supply ${CAPABILITY_REQUIRES[capability].join(" and ")}, or do not take that path.`,
    retryable: false,
  });
};

/**
 * A proxy rather than an object of getters.
 *
 * The same decision `lazyCoordinator` took, for the same reason: enumerating the keys means a dependency added
 * later is silently absent from the gate, and silently-absent is the failure being designed against. One rule
 * covers every name, present and future.
 */
const governed = <T extends object>(supplied: T, capabilities: CapabilityMap, label: string): Required<T> =>
  new Proxy(supplied, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      const capability = GOVERNED_BY[property];
      if (capability !== undefined && capabilities[capability] !== "on") refuse(`${label}.${property}`, capability);
      return Reflect.get(target, property);
    },
  }) as Required<T>;

/**
 * Assemble a runtime, or refuse to.
 *
 * The declaration and the wiring are cross-checked here — every mismatch in one error — so a misconfigured
 * runtime fails at construction rather than three hours into production.
 */
export const createRuntime = (input: CreateRuntimeInput): Runtime => {
  const stores = input.stores ?? {};
  const services = input.services ?? {};

  /**
   * Derived, not declared.
   *
   * `Object.entries` over what was supplied, keeping only the defined values — because an explicit
   * `messages: undefined` is how a spread of optional config produces a key that means nothing, and treating
   * that as wired would refuse a runtime for a store that is not there.
   */
  const wired = new Set(
    [...Object.entries(stores), ...Object.entries(services)]
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
  );

  const capabilities = resolveCapabilities({
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    wired,
  });

  return {
    capabilities,
    floor: input.floor,
    stores: governed(stores as RuntimeStores, capabilities, "stores"),
    services: governed(services as RuntimeServices, capabilities, "services"),
    enabled: (capability) => capabilities[capability] === "on",
  };
};
