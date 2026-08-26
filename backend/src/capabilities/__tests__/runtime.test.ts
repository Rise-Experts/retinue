/**
 * The composition root — #196 AC-10 to AC-13, inherited from #198.
 *
 * Two properties that `resolveCapabilities` alone could not give:
 *
 * 1. The wired set is **derived** from the objects supplied, not hand-written beside them. Two lists that must
 *    agree, neither derived from what they describe, is the shape of the problem rather than a fix for it.
 * 2. A capability that is off is **enforced**, not merely absent. Access is the gate, so no caller has to
 *    remember to check — and the ones who forget are the six defects this module exists for.
 */

import { describe, expect, it, vi } from "vitest";
import { AgentPlatformError } from "../../core/errors.js";
import { createMemoryRunStore } from "../../adapters/memory/runtime.js";
import { CAPABILITIES, CAPABILITY_REQUIRES } from "../index.js";
import { createRuntime } from "../runtime.js";

const floor = () => ({ runs: createMemoryRunStore() });
const store = () => ({}) as never;
const caught = (fn: () => unknown): AgentPlatformError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as AgentPlatformError;
  }
};

describe("the minimum configuration", () => {
  it("runs an automation with no conversation, no memory and no human", () => {
    /**
     * #196 AC-12, and the shape #197 is about. Nothing but a run store: no messages, no memory, no
     * interactions, no summariser. If this needed more, "one runtime for a chat assistant and a headless
     * automation" would be a claim rather than a fact.
     */
    const runtime = createRuntime({ profile: "automation", floor: floor(), stores: { usage: store() } });
    expect(runtime.capabilities.history).toBe("off");
    expect(runtime.capabilities.memory).toBe("off");
    expect(runtime.capabilities.questions).toBe("off");
    // Metering stays on: an unattended automation is precisely the one whose spend nobody is watching.
    expect(runtime.capabilities.usage).toBe("on");
    expect(runtime.floor.runs).toBeDefined();
  });

  it("needs nothing at all beyond the floor when every capability is off", () => {
    const runtime = createRuntime({ floor: floor() });
    for (const c of CAPABILITIES) expect(runtime.capabilities[c], c).toBe("off");
    expect(runtime.enabled("usage")).toBe(false);
  });
});

describe("the wired set is derived, not declared", () => {
  it("infers what is wired from what was supplied", () => {
    // No hand-written list. Supplying the store *is* the declaration of fact; `capabilities` is the declaration
    // of intent; the cross-check compares them.
    const runtime = createRuntime({
      capabilities: { history: "on", memory: "on" },
      floor: floor(),
      stores: { messages: store(), principalMemory: store() },
    });
    expect(runtime.capabilities.history).toBe("on");
    expect(runtime.capabilities.memory).toBe("on");
  });

  it("treats an explicitly undefined store as not wired", () => {
    /**
     * `{ messages: undefined }` is what a spread of optional config produces, and it means "not there". Counting
     * the key would refuse a runtime for a store that does not exist — an error about the wrong thing, which is
     * worse than no error.
     */
    const error = caught(() =>
      createRuntime({ capabilities: { history: "on" }, floor: floor(), stores: { messages: undefined } }),
    );
    expect(error?.message).toContain("history is on but messages was not supplied");
  });

  it("refuses a store supplied with nothing declaring it", () => {
    const error = caught(() => createRuntime({ floor: floor(), stores: { principalMemory: store() } }));
    expect(error?.message).toContain("memory is off but principalMemory was supplied");
  });

  it("reports every mismatch at once", () => {
    const error = caught(() =>
      createRuntime({ capabilities: { history: "on", skills: "on" }, floor: floor(), stores: { usage: store() } }),
    );
    const message = error?.message ?? "";
    expect(message).toContain("history is on");
    expect(message).toContain("skills is on");
    expect(message).toContain("usage is off but usage was supplied");
  });
});

describe("a capability that is off is enforced, not merely absent", () => {
  it("throws when something reaches for a store whose capability is off", () => {
    /**
     * #196 AC-11, restating #198's AC-7 — which asked for a counting fake with the capability off, a scenario
     * its own AC-6 forbids: wiring a store while declaring it off throws.
     *
     * The property that *is* testable: nothing can reach a capability that is off. Access is refused, so there is
     * no reference to hold and use later.
     */
    const runtime = createRuntime({ profile: "automation", floor: floor(), stores: { usage: store() } });
    const error = caught(() => runtime.stores.messages);
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error?.message).toContain('"history" off');
    expect(error?.message).toContain("stores.messages");
    // And it names what turning it on would need, so the message is actionable.
    expect(error?.message).toContain("messages");
  });

  it("allows access when the capability is on", () => {
    const messages = store();
    const runtime = createRuntime({
      capabilities: { history: "on" },
      floor: floor(),
      stores: { messages },
    });
    expect(runtime.stores.messages).toBe(messages);
  });

  it("governs services as well as stores", () => {
    const runtime = createRuntime({ floor: floor() });
    expect(caught(() => runtime.services.summarizer)?.message).toContain('"compaction" off');
    expect(caught(() => runtime.services.mcpClient)?.message).toContain('"mcp" off');
  });

  it("counts zero calls against a store whose capability is off, because none is reachable", () => {
    /**
     * The counting fake the original AC wanted, in the only form the design permits: the fake is wired *and*
     * declared on, so it is reachable — then a second runtime with it off cannot reach it at all. Zero calls,
     * because there is no reference to call.
     */
    const retrieve = vi.fn();
    const on = createRuntime({
      capabilities: { memory: "on" },
      floor: floor(),
      stores: { principalMemory: { retrieve } as never },
    });
    (on.stores.principalMemory as unknown as { retrieve: () => void }).retrieve();
    expect(retrieve).toHaveBeenCalledTimes(1);

    const off = createRuntime({ profile: "automation", floor: floor(), stores: { usage: store() } });
    /**
     * The refusal specifically, not "it threw".
     *
     * `.toThrow()` alone passed with the gate removed: reading an absent store gives `undefined`, and calling a
     * method on it throws a `TypeError`. The test was green for the wrong reason — the same shape as a scan
     * reporting zero references for a directory it could not read. Asserting the platform error is what makes it
     * a test of the gate rather than of JavaScript.
     */
    const error = caught(() => (off.stores.principalMemory as unknown as { retrieve: () => void }).retrieve());
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error?.message).toContain('"memory" off');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("does not gate a name no capability governs", () => {
    // The proxy must refuse only what it knows about. Refusing an unknown key would make adding a dependency a
    // breaking change for every host.
    const runtime = createRuntime({ floor: floor() });
    expect((runtime.stores as unknown as Record<string, unknown>).somethingElse).toBeUndefined();
  });
});

describe("the names line up", () => {
  it("governs every dependency that CAPABILITY_REQUIRES names", () => {
    /**
     * The typo guard. A key in `RuntimeStores` that does not match `CAPABILITY_REQUIRES` would silently mean
     * "not wired", and the capability would be refused for a reason nobody could see. Asserting the inverse
     * mapping covers every name without restating it.
     */
    const governed = new Set(Object.values(CAPABILITY_REQUIRES).flat());
    const runtime = createRuntime({ floor: floor() });
    for (const name of governed) {
      const error = caught(() => (runtime.stores as unknown as Record<string, unknown>)[name]);
      const alsoService = caught(() => (runtime.services as unknown as Record<string, unknown>)[name]);
      // Whichever object it belongs to, one of the two must refuse it — nothing governed may be freely readable.
      expect(error ?? alsoService, `${name} must be governed`).not.toBeNull();
    }
  });
});

describe("supported combinations", () => {
  /**
   * All 256 of them — #197 AC-8.
   *
   * This test used to enumerate the two profiles and four hand-picked mixes, arguing that "enumerating the
   * matrix would assert that combinations nobody has thought about work". That reasoning is backwards for the
   * surface this actually is. The capability API is **eight independent booleans**, which is what was asked for
   * and what the profiles are sugar over — so a combination nobody has thought about is not a hypothetical, it
   * is the one a customer picks on their first afternoon. "A configuration surface nobody exercised is a set of
   * combinations that happen to compile" is the AC, and six of them is not the surface.
   *
   * It is also cheap: 2^8 constructions of small objects, and the whole file still runs in milliseconds. The
   * argument against was never about cost.
   */
  const DEPS = CAPABILITIES.flatMap((name) => CAPABILITY_REQUIRES[name] ?? []);

  const combinations = (): { on: readonly string[]; off: readonly string[] }[] => {
    const all: { on: readonly string[]; off: readonly string[] }[] = [];
    for (let mask = 0; mask < 1 << CAPABILITIES.length; mask += 1) {
      const on = CAPABILITIES.filter((_, index) => (mask & (1 << index)) !== 0);
      all.push({ on, off: CAPABILITIES.filter((name) => !on.includes(name)) });
    }
    return all;
  };

  it("constructs for every combination of the eight capabilities", () => {
    for (const { on } of combinations()) {
      const needed = on.flatMap((name) => CAPABILITY_REQUIRES[name] ?? []);
      // Wired to exactly what the on-set requires, and nothing else: an extra store would be refused by the
      // cross-check, which is a different test.
      const wired = Object.fromEntries(needed.map((dep) => [dep, store()])) as Record<string, never>;
      const label = on.length === 0 ? "(nothing on)" : on.join("+");
      expect(
        () =>
          createRuntime({
            capabilities: Object.fromEntries(on.map((name) => [name, "on"])) as never,
            floor: floor(),
            stores: wired,
            services: wired as never,
          }),
        label,
      ).not.toThrow();
    }
  });

  it("gates exactly the off ones, in every combination", () => {
    /**
     * The half that matters. Constructing proves the declaration is accepted; this proves the *runtime* it
     * produced draws the line in the same place — an off capability's dependency is unreachable and an on one's
     * is not. A surface where a flag is accepted and then ignored is worse than one that refuses it.
     */
    for (const { on, off } of combinations()) {
      const needed = on.flatMap((name) => CAPABILITY_REQUIRES[name] ?? []);
      const wired = Object.fromEntries(needed.map((dep) => [dep, store()])) as Record<string, never>;
      const runtime = createRuntime({
        capabilities: Object.fromEntries(on.map((name) => [name, "on"])) as never,
        floor: floor(),
        stores: wired,
        services: wired as never,
      });

      for (const dep of needed) {
        expect(() => (runtime.stores as Record<string, unknown>)[dep], `${on.join("+")} → ${dep}`).not.toThrow();
      }
      const offDeps = off.flatMap((name) => CAPABILITY_REQUIRES[name] ?? []).filter((dep) => !needed.includes(dep));
      for (const dep of offDeps) {
        // Reading it is the gate, so nobody has to remember to check — which is the whole point of the module.
        expect(() => (runtime.stores as Record<string, unknown>)[dep], `off → ${dep}`).toThrow();
      }
    }
  });

  it("covers every dependency name at least once across the matrix", () => {
    // A guard on the guard: if `CAPABILITY_REQUIRES` gained a capability with no dependencies, the loops above
    // would still pass while testing nothing about it.
    const seen = new Set(combinations().flatMap(({ on }) => on.flatMap((n) => CAPABILITY_REQUIRES[n] ?? [])));
    expect([...seen].sort()).toEqual([...new Set(DEPS)].sort());
  });
});
