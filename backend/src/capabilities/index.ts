/**
 * What a runtime does, declared — #198.
 *
 * ## Why a declaration exists at all
 *
 * Capabilities were already switchable: `usage?`, `messages?`, `quota?`, `approvals?`, `questions?`,
 * `citations?` are all optional, and a host that wants a lean automation runtime passes fewer of them. The
 * mechanism is right. The ergonomics are not, because **an unwired capability and a deliberately disabled one
 * are indistinguishable**, and that ambiguity is this codebase's most repeated defect: #157, #159, #161, #163,
 * #165 and #185 were each a capability that existed, passed its tests, and was wired to nothing.
 * `check-reachability.mjs` exists because of it — and it can only ever check *this* repository, never a
 * customer's.
 *
 * ## Why not just booleans
 *
 * A boolean cannot carry its dependency. `memory: true` still needs a store, so true-with-nothing-wired is a
 * crash or a silent no-op — the same failure with a friendlier spelling. Twelve booleans is also 4,096
 * combinations, almost none of them ever exercised.
 *
 * ## So: both, cross-checked
 *
 * The host declares, the host wires, and `resolveCapabilities` refuses to return a runtime whose declaration and
 * wiring disagree — **in either direction**. Declared-on-but-unwired is the obvious one. Wired-but-undeclared
 * matters just as much: it means the declaration has drifted into a lie, and the next reader trusts it.
 *
 * One error listing every mismatch, never the first one found. A caller fixing these one restart at a time is
 * why configuration surfaces get abandoned.
 */

import { AgentPlatformError } from "../core/errors.js";

/**
 * The switchable capabilities.
 *
 * Deliberately **not** including approvals or quota enforcement. An automation with no human is a legitimate
 * case, and a flag that removes the enforcement is not the way to express it — that is an approval *policy*
 * which auto-approves a stated set of effects, and is auditable afterwards where a flag leaves no record. The
 * difference is between "nobody had to approve this" and "we cannot tell whether anyone should have".
 */
export const CAPABILITIES = [
  "history",
  "memory",
  "compaction",
  "citations",
  "questions",
  "skills",
  "mcp",
  "usage",
  "guardrails",
  "shell",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = "on" | "off";
export type CapabilityMap = Readonly<Record<Capability, CapabilityState>>;

/**
 * What each capability cannot work without, by the name a host wires it under.
 *
 * Names rather than types, because the check is about *presence*: the compiler already proves a supplied store
 * is the right shape, and what it cannot prove is that one was supplied at all.
 */
export const CAPABILITY_REQUIRES: Readonly<Record<Capability, readonly string[]>> = {
  history: ["messages"],
  memory: ["principalMemory"],
  // Two, and both: a summariser with nowhere to put the summary compacts on every turn and never remembers
  // having done it.
  compaction: ["summaries", "summarizer"],
  citations: ["citations"],
  questions: ["interactions"],
  skills: ["skills"],
  mcp: ["mcpConnections", "mcpClient"],
  usage: ["usage"],
  // A guardrail set, supplied by the host. Declaring the capability without wiring one is refused at
  // construction — which is the point: "guardrails: on" must mean a check exists, not that somebody intended one.
  guardrails: ["guardrails"],
  /**
   * A sandbox for `shell_exec` — REQ-047 (#206), task #215.
   *
   * The only capability whose *absence* is a security property rather than a missing feature. `shell_exec` is
   * arbitrary code execution with a natural-language trigger, so it takes two switches: a sandbox wired, and this
   * declared. Declaring it with no sandbox is refused at construction, and wiring a sandbox without declaring it
   * leaves the tool present and refusing — which is the safe direction of the two.
   */
  shell: ["sandbox"],
};

const OFF: CapabilityMap = Object.freeze(
  Object.fromEntries(CAPABILITIES.map((c) => [c, "off"])) as Record<Capability, CapabilityState>,
);

/**
 * Named starting points, so the two common shapes are one line.
 *
 * A profile is **only** a set of defaults and must be expressible by writing the capabilities out — otherwise it
 * is a second configuration language, and the two drift. `profileToMap` and a test hold that.
 */
export const PROFILES = {
  /** A chat assistant: everything a person interacts with, on. */
  assistant: {
    history: "on",
    memory: "on",
    compaction: "on",
    citations: "on",
    questions: "on",
    skills: "on",
    mcp: "off",
    usage: "on",
    // Off in both profiles, deliberately. A guardrail set is the host's — and a profile that turned this on
    // would be a profile that refuses to construct until somebody supplies one, which is a poor default for a
    // named starting point.
    guardrails: "off",
    // Off in both profiles, and this one should never be otherwise: no named starting point gets to decide that
    // an application can run shell commands.
    shell: "off",
  },
  /**
   * A headless automation: no conversation, no person, no recall.
   *
   * `usage` stays on because an automation that runs unattended is precisely the one whose spend nobody is
   * watching. Turning metering off by default there would be the expensive mistake.
   */
  automation: {
    history: "off",
    memory: "off",
    compaction: "off",
    citations: "off",
    questions: "off",
    skills: "off",
    mcp: "off",
    usage: "on",
    guardrails: "off",
    shell: "off",
  },
} as const satisfies Readonly<Record<string, CapabilityMap>>;

export type ProfileName = keyof typeof PROFILES;

/** A profile as a plain map, so a caller can read a default before adopting it. */
export const profileToMap = (profile: ProfileName): CapabilityMap => ({ ...PROFILES[profile] });

export type ResolveCapabilitiesInput = {
  readonly profile?: ProfileName;
  /** Overrides on top of the profile, or the whole declaration when no profile is named. */
  readonly capabilities?: Partial<CapabilityMap>;
  /**
   * The names the host actually wired, as supplied. A `Set` rather than the objects themselves: this function's
   * job is the *cross-check*, and taking the objects would tempt it into validating their shapes, which the
   * compiler already does better.
   */
  readonly wired: ReadonlySet<string>;
};

/**
 * The effective capability map, or a refusal naming every disagreement.
 *
 * Absent from both profile and overrides means **off**. That direction is deliberate: a capability nobody
 * mentioned is one nobody asked for, and defaulting to on would resurrect the problem this exists to solve — a
 * feature quietly present, wired to nothing, until the day it matters.
 */
export const resolveCapabilities = (input: ResolveCapabilitiesInput): CapabilityMap => {
  const base = input.profile === undefined ? OFF : PROFILES[input.profile];
  const effective = { ...base, ...(input.capabilities ?? {}) } as CapabilityMap;

  const unknown = Object.keys(input.capabilities ?? {}).filter(
    (k) => !(CAPABILITIES as readonly string[]).includes(k),
  );

  const declaredNotWired: string[] = [];
  const wiredNotDeclared: string[] = [];

  for (const capability of CAPABILITIES) {
    const needs = CAPABILITY_REQUIRES[capability];
    const suppliedAll = needs.every((n) => input.wired.has(n));
    const suppliedAny = needs.some((n) => input.wired.has(n));

    if (effective[capability] === "on" && !suppliedAll) {
      const missing = needs.filter((n) => !input.wired.has(n));
      declaredNotWired.push(`${capability} is on but ${missing.join(" and ")} ${missing.length > 1 ? "were" : "was"} not supplied`);
    }
    /**
     * `suppliedAny`, not `suppliedAll`, for the reverse direction.
     *
     * A host that wired half of what a capability needs and declared it off has still told us two different
     * things, and the half-wiring is the more likely mistake — it usually means they meant to turn it on.
     */
    if (effective[capability] === "off" && suppliedAny) {
      const supplied = needs.filter((n) => input.wired.has(n));
      wiredNotDeclared.push(`${capability} is off but ${supplied.join(" and ")} ${supplied.length > 1 ? "were" : "was"} supplied`);
    }
  }

  const problems = [
    ...unknown.map((k) => `"${k}" is not a capability — the set is ${CAPABILITIES.join(", ")}`),
    ...declaredNotWired,
    ...wiredNotDeclared,
  ];
  if (problems.length === 0) return Object.freeze(effective);

  throw new AgentPlatformError({
    code: "invalid_input",
    message:
      `this runtime's capability declaration does not match what was wired:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\nEither supply what the capability needs, or declare it off. A capability that is present but ` +
      `undeclared is the defect this check exists to prevent: it works until the day nobody remembers it is there.`,
    retryable: false,
  });
};

/**
 * ## What is deliberately *not* here yet: a point-of-use gate
 *
 * The obvious companion to `resolveCapabilities` is a `requireCapability(map, cap, forWhat)` that a code path
 * calls to refuse when its capability is off. It was written, tested, and **removed before shipping** — because
 * nothing could call it.
 *
 * No runtime object holds a capability map today: a host wires `ResolverDeps` by hand, and the map produced here
 * is consulted by nobody. So the gate would have been exported, covered by its own tests, and reachable from
 * nothing — which is #157, #159, #161, #163, #165 and #185, in the module whose entire purpose is to stop that.
 * Leaving it in because it "will be used soon" is precisely the reasoning that produced those six.
 *
 * It returns with #196, when the composition root exists and there is something to consult the map. The check
 * that matters until then is the construction-time one above, and that one *is* called.
 */
