/**
 * The capability declaration — #198.
 *
 * Every case here is about one of two failures: a capability declared on with nothing behind it, or something
 * wired that nobody declared. The first is a crash waiting for a code path; the second is a lie in the
 * configuration, and it is how six defects in this repository survived their own tests.
 */

import { describe, expect, it } from "vitest";
import { AgentPlatformError } from "../../core/errors.js";
import {
  CAPABILITIES,
  CAPABILITY_REQUIRES as REQUIRES,
  PROFILES,
  profileToMap,
  requireCapability,
  resolveCapabilities,
  type CapabilityMap,
} from "../index.js";

const wired = (...names: string[]) => new Set(names);
const caught = (fn: () => unknown): AgentPlatformError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as AgentPlatformError;
  }
};

describe("resolving a declaration", () => {
  it("defaults everything off when nothing is declared", () => {
    // A capability nobody mentioned is one nobody asked for. Defaulting to on would resurrect the exact problem
    // this exists to solve — a feature quietly present, wired to nothing, until the day it matters.
    const map = resolveCapabilities({ wired: wired() });
    for (const c of CAPABILITIES) expect(map[c], c).toBe("off");
  });

  it("accepts a declaration whose wiring matches", () => {
    const map = resolveCapabilities({
      capabilities: { history: "on", usage: "on" },
      wired: wired("messages", "usage"),
    });
    expect(map.history).toBe("on");
    expect(map.usage).toBe("on");
    expect(map.memory).toBe("off");
  });

  it("refuses a capability declared on with nothing wired, naming what is missing", () => {
    const error = caught(() => resolveCapabilities({ capabilities: { memory: "on" }, wired: wired() }));
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error?.code).toBe("invalid_input");
    // The dependency by name, so the message is actionable rather than a complaint.
    expect(error?.message).toContain("memory is on but principalMemory was not supplied");
    expect(error?.retryable).toBe(false);
  });

  it("refuses a capability wired but not declared", () => {
    /**
     * The direction that is easy to dismiss and matters just as much: it means the declaration has drifted into
     * a lie. A reader who trusts "memory: off" while a memory store is wired will look for the recall bug
     * everywhere except the configuration.
     */
    const error = caught(() => resolveCapabilities({ capabilities: { memory: "off" }, wired: wired("principalMemory") }));
    expect(error?.message).toContain("memory is off but principalMemory was supplied");
  });

  it("names every disagreement in one error, not the first", () => {
    // A caller fixing these one restart at a time is why configuration surfaces get abandoned.
    const error = caught(() =>
      resolveCapabilities({
        capabilities: { memory: "on", history: "on", skills: "on" },
        wired: wired("citations"),
      }),
    );
    const message = error?.message ?? "";
    expect(message).toContain("memory is on");
    expect(message).toContain("history is on");
    expect(message).toContain("skills is on");
    // And the wired-but-undeclared one, in the same breath.
    expect(message).toContain("citations is off but citations was supplied");
  });

  it("reports a half-wired capability even when it is declared off", () => {
    /**
     * `compaction` needs a store *and* a summariser. Wiring one and declaring it off is two contradictory
     * statements, and the half-wiring is the likelier mistake — it usually means they meant to turn it on.
     */
    const error = caught(() => resolveCapabilities({ capabilities: { compaction: "off" }, wired: wired("summaries") }));
    expect(error?.message).toContain("compaction is off but summaries was supplied");
  });

  it("names both dependencies when a capability needs two and has neither", () => {
    const error = caught(() => resolveCapabilities({ capabilities: { compaction: "on" }, wired: wired() }));
    expect(error?.message).toContain("summaries and summarizer were not supplied");
  });

  it("rejects a capability name that does not exist", () => {
    // A typo in a configuration key is otherwise the quietest possible failure: the intended capability stays
    // off and the declaration looks deliberate.
    const error = caught(() =>
      resolveCapabilities({ capabilities: { memroy: "on" } as never, wired: wired("principalMemory") }),
    );
    expect(error?.message).toContain('"memroy" is not a capability');
  });

  it("returns a frozen map, so nothing edits the declaration after the check", () => {
    const map = resolveCapabilities({ wired: wired() });
    expect(Object.isFrozen(map)).toBe(true);
  });
});

describe("profiles", () => {
  it("expands to exactly the same thing as writing the capabilities out", () => {
    /**
     * A profile is only a set of defaults. If it could express something the explicit form cannot, it would be a
     * second configuration language and the two would drift.
     */
    for (const name of ["assistant", "automation"] as const) {
      const viaProfile = resolveCapabilities({
        profile: name,
        wired: wiredFor(profileToMap(name)),
      });
      const viaExplicit = resolveCapabilities({
        capabilities: profileToMap(name),
        wired: wiredFor(profileToMap(name)),
      });
      expect(viaProfile, name).toEqual(viaExplicit);
    }
  });

  it("lets an override turn one thing off without restating the rest", () => {
    const map = resolveCapabilities({
      profile: "assistant",
      capabilities: { citations: "off", mcp: "off" },
      wired: wiredFor({ ...profileToMap("assistant"), citations: "off", mcp: "off" }),
    });
    expect(map.citations).toBe("off");
    expect(map.history).toBe("on");
  });

  it("gives an automation no conversation-scoped capabilities, and keeps metering on", () => {
    /**
     * The shape #197 is about. `usage` stays on deliberately: an unattended automation is precisely the one
     * whose spend nobody is watching, so metering off by default there would be the expensive mistake.
     */
    const automation = PROFILES.automation;
    expect(automation.history).toBe("off");
    expect(automation.memory).toBe("off");
    expect(automation.compaction).toBe("off");
    expect(automation.questions).toBe("off");
    expect(automation.usage).toBe("on");
  });

  it("does not offer approvals or quota as switchable", () => {
    /**
     * An automation with no human is legitimate; a flag that removes the enforcement is not the way to say it.
     * That is an approval *policy* auto-approving stated effects, which survives an audit where a flag leaves no
     * record of what would have needed approval.
     */
    expect(CAPABILITIES).not.toContain("approvals");
    expect(CAPABILITIES).not.toContain("quota");
  });
});

describe("using a capability at the point of use", () => {
  const map = (over: Partial<CapabilityMap> = {}): CapabilityMap =>
    ({ ...profileToMap("automation"), ...over }) as CapabilityMap;

  it("passes silently when the capability is on", () => {
    expect(() => requireCapability(map({ history: "on" }), "history", "loading history")).not.toThrow();
  });

  it("throws when it is off, naming the capability and what needs it", () => {
    // Returning a boolean would leave every caller to remember the `if`, and the ones that forgot are the six
    // defects this module exists for.
    const error = caught(() => requireCapability(map(), "memory", "recalling what the user told us"));
    expect(error?.message).toContain('"memory"');
    expect(error?.message).toContain("recalling what the user told us");
    expect(error?.message).toContain("principalMemory");
  });
});

/** The wiring a map implies, so a test does not restate `CAPABILITY_REQUIRES` and drift from it. */
function wiredFor(map: CapabilityMap): ReadonlySet<string> {
  const names = new Set<string>();
  for (const c of CAPABILITIES) if (map[c] === "on") for (const n of REQUIRES[c]) names.add(n);
  return names;
}
