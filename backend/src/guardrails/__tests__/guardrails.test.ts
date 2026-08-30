/**
 * The guardrail contract — REQ-046 (#205), task #211.
 *
 * Every test here corresponds to a property that, if it silently inverted, would leave a deployment believing it
 * had a check it did not have. That is the whole risk with this kind of code: a guardrail that stops working
 * looks exactly like a guardrail that keeps passing everything.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId } from "../../core/ids.js";
import {
  applyInputGuardrails,
  applyOutputGuardrails,
  recordCarriesOnlyMetadata,
  type Guardrail,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
  runId: asId<RunId>("r1"),
};

const passing = (name: string): Guardrail => ({ name, inspectInput: () => ({ kind: "pass" }) });

describe("composition", () => {
  it("runs in the declared order, never a sorted one", async () => {
    const order: string[] = [];
    const watch = (name: string): Guardrail => ({
      name,
      inspectInput: () => {
        order.push(name);
        return { kind: "pass" };
      },
    });
    // Deliberately not alphabetical: a set whose behaviour depends on key ordering changes when somebody
    // reformats a config, and the order decides the outcome when two of them redact.
    await applyInputGuardrails([watch("zebra"), watch("alpha"), watch("middle")], { text: "hi" }, context);
    expect(order).toEqual(["zebra", "alpha", "middle"]);
  });

  it("threads the value, so two redactions compose instead of one undoing the other", async () => {
    const first: Guardrail = {
      name: "emails",
      inspectInput: (input) => ({ kind: "redacted", value: { text: input.text.replace("a@b.c", "[email]") }, what: ["email"] }),
    };
    const second: Guardrail = {
      name: "phones",
      inspectInput: (input) => ({ kind: "redacted", value: { text: input.text.replace("555-0100", "[phone]") }, what: ["phone"] }),
    };
    const decision = await applyInputGuardrails([first, second], { text: "a@b.c and 555-0100" }, context);
    expect(decision.outcome).toBe("allowed");
    // Both redactions present. If the second had inspected the original instead of the first's output, one
    // would have been lost — and the run would have carried a value somebody thought was removed.
    if (decision.outcome === "allowed") expect(decision.value.text).toBe("[email] and [phone]");
  });

  it("skips a guardrail that does not implement the hook rather than treating it as a pass", async () => {
    const outputOnly: Guardrail = { name: "output-only", inspectOutput: () => ({ kind: "pass" }) };
    const decision = await applyInputGuardrails([outputOnly, passing("both")], { text: "hi" }, context);
    // One record, not two: a guardrail with no opinion on inputs did not inspect this one, and recording a pass
    // it never made would overstate the coverage.
    expect(decision.records).toHaveLength(1);
    expect(decision.records[0]?.guardrail).toBe("both");
  });
});

describe("refusal", () => {
  it("short-circuits, so the rest are not consulted", async () => {
    const later = vi.fn(() => ({ kind: "pass" as const }));
    const decision = await applyInputGuardrails(
      [
        { name: "no", inspectInput: () => ({ kind: "refused", code: "policy", message: "not allowed" }) },
        { name: "after", inspectInput: later },
      ],
      { text: "hi" },
      context,
    );
    expect(decision.outcome).toBe("refused");
    // The turn is over; running the rest would spend money to annotate a decision already taken.
    expect(later).not.toHaveBeenCalled();
  });

  it("attributes the refusal, because 'which check stopped this' is the only useful question", async () => {
    const decision = await applyInputGuardrails(
      [passing("first"), { name: "pii", inspectInput: () => ({ kind: "refused", code: "pii_present", message: "no" }) }],
      { text: "hi" },
      context,
    );
    if (decision.outcome !== "refused") throw new Error("expected a refusal");
    expect(decision.by).toBe("pii");
    expect(decision.code).toBe("pii_present");
  });
});

describe("fail closed — AC-4", () => {
  it("a guardrail that throws refuses the turn", async () => {
    const decision = await applyInputGuardrails(
      [{ name: "flaky", inspectInput: () => { throw new Error("upstream timeout"); } }],
      { text: "hi" },
      context,
    );
    // The inverse default is how a guardrail stops guarding the day its dependency times out, while the run
    // looks entirely normal afterwards.
    expect(decision.outcome).toBe("refused");
    if (decision.outcome === "refused") {
      expect(decision.by).toBe("flaky");
      expect(decision.code).toBe("guardrail_failed");
      expect(decision.records.at(-1)?.threw).toBe(true);
    }
  });

  it("a rejected promise fails closed too, not only a synchronous throw", async () => {
    const decision = await applyInputGuardrails(
      [{ name: "async-flaky", inspectInput: async () => { throw new Error("nope"); } }],
      { text: "hi" },
      context,
    );
    expect(decision.outcome).toBe("refused");
  });

  it("does not consult later guardrails after one throws", async () => {
    const later = vi.fn(() => ({ kind: "pass" as const }));
    await applyInputGuardrails(
      [{ name: "boom", inspectInput: () => { throw new Error("x"); } }, { name: "after", inspectInput: later }],
      { text: "hi" },
      context,
    );
    expect(later).not.toHaveBeenCalled();
  });
});

describe("records carry metadata and never a value — AC-4", () => {
  it("names what was redacted and not its contents", async () => {
    const secret = "4111111111111111";
    const decision = await applyInputGuardrails(
      [{ name: "cards", inspectInput: () => ({ kind: "redacted", value: { text: "[card]" }, what: ["card_number"] }) }],
      { text: `pay with ${secret}` },
      context,
    );
    const serialized = JSON.stringify(decision.records);
    // The assertion that matters: an audit trail that carries the value it redacted is the leak it exists to
    // record.
    expect(serialized).not.toContain(secret);
    expect(decision.records[0]?.what).toEqual(["card_number"]);
  });

  it("has no field that could hold inspected content — on every outcome, not just a pass", async () => {
    /**
     * All three outcomes, deliberately.
     *
     * An earlier version of this test only produced a *pass* record, so adding a `value` field to the redaction
     * branch passed the whole suite — found by sabotage. The redacted record is precisely the one that has a
     * value in scope to leak, so checking only the harmless case is checking the wrong one.
     */
    const decision = await applyInputGuardrails(
      [
        passing("clean"),
        { name: "redactor", inspectInput: () => ({ kind: "redacted", value: { text: "[x]" }, what: ["thing"] }) },
        { name: "refuser", inspectInput: () => ({ kind: "refused", code: "nope", message: "no" }) },
      ],
      { text: "hi" },
      context,
    );
    expect(decision.records.map((r) => r.outcome)).toEqual(["pass", "redacted", "refused"]);
    for (const record of decision.records) {
      expect(recordCarriesOnlyMetadata(record), `${record.guardrail} carries more than metadata`).toBe(true);
    }
  });

  it("records a pass, so 'nothing ran' and 'it ran and allowed it' are distinguishable", async () => {
    const decision = await applyInputGuardrails([passing("a"), passing("b")], { text: "hi" }, context);
    expect(decision.records.map((r) => r.outcome)).toEqual(["pass", "pass"]);
  });
});

describe("tool calls are outputs — AC-2", () => {
  it("inspects a tool call's arguments, and a redaction changes what runs", async () => {
    const guardrail: Guardrail = {
      name: "strip-token",
      inspectOutput: (output) =>
        output.kind === "tool-call"
          ? { kind: "redacted", value: { ...output, input: { ...(output.input as object), token: "[redacted]" } }, what: ["token"] }
          : { kind: "pass" },
    };
    const decision = await applyOutputGuardrails(
      guardrail ? [guardrail] : [],
      { kind: "tool-call", toolName: "http_write", input: { url: "https://x", token: "sk-live-123" } },
      context,
    );
    if (decision.outcome !== "allowed") throw new Error("expected allowed");
    if (decision.value.kind !== "tool-call") throw new Error("expected a tool call");
    expect((decision.value.input as { token: string }).token).toBe("[redacted]");
    expect(decision.records[0]?.subject).toBe("tool-call");
  });

  it("distinguishes a message from a tool call in the record", async () => {
    const decision = await applyOutputGuardrails([{ name: "p", inspectOutput: () => ({ kind: "pass" }) }], { kind: "message", text: "hello" }, context);
    expect(decision.records[0]?.subject).toBe("message");
  });

  it("can refuse a tool call, which is the exfiltration path prose-only checking misses", async () => {
    const decision = await applyOutputGuardrails(
      [{ name: "no-exfil", inspectOutput: (o) => (o.kind === "tool-call" ? { kind: "refused", code: "exfiltration", message: "no" } : { kind: "pass" }) }],
      { kind: "tool-call", toolName: "http_write", input: { body: "everything" } },
      context,
    );
    expect(decision.outcome).toBe("refused");
  });
});

describe("no guardrails", () => {
  it("allows, and records nothing", async () => {
    const decision = await applyInputGuardrails([], { text: "hi" }, context);
    expect(decision.outcome).toBe("allowed");
    expect(decision.records).toEqual([]);
  });
});
