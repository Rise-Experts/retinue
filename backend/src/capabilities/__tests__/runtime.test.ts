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
  it("constructs every profile, and a few explicit mixes", () => {
    /**
     * #196 AC-13. The matrix is 2^8; enumerating it would assert that combinations nobody has thought about
     * work. So the *supported* set is enumerated — the two profiles and the mixes the docs describe — and
     * anything else is refused by the cross-check rather than left untested.
     */
    const wire = (...names: string[]) =>
      Object.fromEntries(names.map((n) => [n, store()])) as Record<string, never>;

    const supported: { label: string; input: Parameters<typeof createRuntime>[0] }[] = [
      { label: "automation", input: { profile: "automation", floor: floor(), stores: wire("usage") } },
      {
        label: "assistant",
        input: {
          profile: "assistant",
          floor: floor(),
          stores: wire("messages", "principalMemory", "summaries", "citations", "interactions", "skills", "usage"),
          services: wire("summarizer") as never,
        },
      },
      {
        label: "automation with memory",
        input: {
          profile: "automation",
          capabilities: { memory: "on" },
          floor: floor(),
          stores: wire("usage", "principalMemory"),
        },
      },
      {
        label: "chat without metering",
        input: {
          capabilities: { history: "on", questions: "on" },
          floor: floor(),
          stores: wire("messages", "interactions"),
        },
      },
    ];

    for (const { label, input } of supported) {
      expect(() => createRuntime(input), label).not.toThrow();
    }
  });
});
