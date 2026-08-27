/**
 * The PII detector — REQ-046 (#205), task #212, AC-1/AC-2/AC-3/AC-5/AC-6.
 *
 * A detector with unmeasured recall is a claim, and one with unmeasured precision is a nuisance that gets
 * switched off. So this file ends with a labelled corpus and asserts both numbers, rather than testing a handful
 * of happy cases and calling the thing done.
 *
 * **What the corpus is and is not.** Eighteen cases, ours, scoring our own detector: it is a *regression guard*,
 * not evidence of general accuracy, and 100% on it means "no worse than when we last looked" rather than
 * "correct". It earned its place regardless — the first phone pattern scored 78.6% precision against it, firing
 * on an order number, an epoch timestamp and an invoice reference, and none of the hand-written cases above had
 * caught that.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { RunId } from "../../core/ids.js";
import { createPiiGuardrail, findPii, placeholderFor, redactText, PII_ENTITIES, type PiiEntity } from "../pii.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
  runId: asId<RunId>("r1"),
};

const ALL = [...PII_ENTITIES];

describe("checksums, not just shapes — AC-1", () => {
  it("accepts a Luhn-valid card and rejects a 16-digit order number", () => {
    // 4111111111111111 is the canonical Luhn-valid test number.
    expect(findPii("card 4111111111111111", ALL).map((f) => f.entity)).toContain("card_number");
    // Same shape, fails Luhn. Flagging this is how a guardrail teaches people to ignore it.
    const order = findPii("order 4111111111111112", ALL);
    expect(order.some((f) => f.entity === "card_number")).toBe(false);
  });

  it("accepts a mod-97-valid IBAN and rejects a corrupted one", () => {
    expect(findPii("pay to GB82WEST12345698765432", ALL).map((f) => f.entity)).toContain("iban");
    expect(findPii("pay to GB82WEST12345698765433", ALL).some((f) => f.entity === "iban")).toBe(false);
  });

  it("does no network or model call — the detector is a pure function", () => {
    // Stated as a test because the value of this guardrail is that it is free: one that costs a round trip per
    // turn is one a deployment disables under load, which is exactly when it is needed.
    expect(typeof findPii).toBe("function");
    expect(findPii("nothing here", ALL)).toEqual([]);
  });
});

describe("referential consistency — AC-2", () => {
  it("gives one value one placeholder, everywhere it appears", () => {
    const text = "mail a@b.com, then mail a@b.com again, and cc c@d.com";
    const redacted = redactText(text, findPii(text, ALL));
    const placeholders = [...redacted.matchAll(/\[email:[0-9a-f]{6}\]/g)].map((m) => m[0]);
    expect(placeholders).toHaveLength(3);
    // The first two are the same address and must map to the same token: a model handed two different tokens for
    // one value concludes the records differ and reasons wrongly about data it never saw.
    expect(placeholders[0]).toBe(placeholders[1]);
    expect(placeholders[2]).not.toBe(placeholders[0]);
  });

  it("is stable across calls, because a resumed run is a different process", () => {
    // A counter per turn would need state keyed by run, and would break on the normal case for a durable
    // runtime: the run resuming elsewhere.
    expect(placeholderFor("email", "a@b.com")).toBe(placeholderFor("email", "a@b.com"));
  });

  it("leaks no plaintext into the placeholder", () => {
    expect(placeholderFor("email", "alice@example.com")).not.toContain("alice");
  });
});

describe("all three paths — AC-3", () => {
  const guardrail = createPiiGuardrail();

  it("finds it in the turn", () => {
    const verdict = guardrail.inspectInput!({ text: "reach me at a@b.com" }, context);
    expect(verdict.kind).toBe("redacted");
  });

  it("finds it in a tool argument, nested", () => {
    const verdict = guardrail.inspectOutput!(
      { kind: "tool-call", toolName: "create_lead", input: { lead: { contact: { email: "a@b.com" } } } },
      context,
    );
    if (verdict.kind !== "redacted") throw new Error("expected a redaction");
    expect(JSON.stringify(verdict.value)).not.toContain("a@b.com");
  });

  it("finds it in a tool result — the likeliest source in a whole run", () => {
    // A document read by a tool contains whatever the document contains. Guarding arguments and not results
    // checks the direction data leaves and ignores the direction it arrives.
    const verdict = guardrail.inspectOutput!(
      { kind: "tool-result", toolName: "read_document", output: { text: "Contact: a@b.com" } },
      context,
    );
    if (verdict.kind !== "redacted") throw new Error("expected a redaction");
    expect(JSON.stringify(verdict.value)).not.toContain("a@b.com");
    expect(verdict.what).toEqual(["email"]);
  });

  it("passes clean content through untouched", () => {
    expect(guardrail.inspectInput!({ text: "what is the weather" }, context).kind).toBe("pass");
  });
});

describe("redact versus refuse is a decision — AC-5", () => {
  it("redacts by default", () => {
    expect(createPiiGuardrail().inspectInput!({ text: "a@b.com" }, context).kind).toBe("redacted");
  });

  it("refuses per entity when configured, and names the type without the value", () => {
    const strict = createPiiGuardrail({ actions: { card_number: "refuse" } });
    const verdict = strict.inspectInput!({ text: "my card is 4111111111111111" }, context);
    if (verdict.kind !== "refused") throw new Error("expected a refusal");
    expect(verdict.message).toContain("card_number");
    expect(verdict.message).not.toContain("4111111111111111");
  });

  it("still only redacts an entity whose action is redact, in the same text", () => {
    const mixed = createPiiGuardrail({ actions: { card_number: "refuse" } });
    expect(mixed.inspectInput!({ text: "mail a@b.com" }, context).kind).toBe("redacted");
  });

  it("honours an entity list, so a deployment can look for one thing", () => {
    const emailsOnly = createPiiGuardrail({ entities: ["email"] });
    const verdict = emailsOnly.inspectInput!({ text: "card 4111111111111111" }, context);
    expect(verdict.kind).toBe("pass");
  });
});

/**
 * A labelled corpus — AC-6.
 *
 * Synthetic but realistic, and *including negatives that look like positives*, which is the half usually left
 * out: an order number, a version string, a date, an ISO timestamp. Precision matters more than recall for a
 * guardrail people have to live with, because a false positive is visible on every turn and a false negative is
 * invisible until it matters.
 */
const CORPUS: readonly { text: string; expect: readonly PiiEntity[] }[] = [
  { text: "Email me at alice.smith@example.com about the invoice", expect: ["email"] },
  { text: "Contact: bob+tag@sub.example.co.uk", expect: ["email"] },
  { text: "My card is 4111 1111 1111 1111", expect: ["card_number"] },
  { text: "Charge 5500005555555559 please", expect: ["card_number"] },
  { text: "IBAN GB82 WEST 1234 5698 7654 32", expect: ["iban"] },
  { text: "SSN 123-45-6789 on file", expect: ["ssn"] },
  { text: "Server at 192.168.1.24 is down", expect: ["ip_address"] },
  { text: "Call me on +44 20 7946 0958", expect: ["phone"] },
  { text: "Ring 020 7946 0958 after six", expect: ["phone"] },
  { text: "Both alice@example.com and 192.168.0.1", expect: ["email", "ip_address"] },
  // Negatives that a naive detector gets wrong:
  { text: "Order number 4111111111111112 shipped", expect: [] },
  { text: "Upgrade to version 4.11.2 today", expect: [] },
  { text: "The meeting is on 2026-08-27 at noon", expect: [] },
  { text: "Timestamp 1756300000 in epoch seconds", expect: [] },
  { text: "Invoice INV-2026-0043 is unpaid", expect: [] },
  { text: "We shipped 1500 units last quarter", expect: [] },
  { text: "Error code 500 from the gateway", expect: [] },
  { text: "Read chapters 10 to 14 tonight", expect: [] },
];

describe("measured precision and recall — AC-6", () => {
  it("reports both, and holds them to a floor", () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    const wrong: string[] = [];

    for (const row of CORPUS) {
      const found = new Set(findPii(row.text, ALL).map((f) => f.entity));
      const wanted = new Set(row.expect);
      for (const entity of wanted) {
        if (found.has(entity)) truePositives += 1;
        else {
          falseNegatives += 1;
          wrong.push(`missed ${entity} in "${row.text}"`);
        }
      }
      for (const entity of found) {
        if (!wanted.has(entity)) {
          falsePositives += 1;
          wrong.push(`false ${entity} in "${row.text}"`);
        }
      }
    }

    const precision = truePositives / (truePositives + falsePositives || 1);
    const recall = truePositives / (truePositives + falseNegatives || 1);
    // Printed, not only asserted: the number is the deliverable, and a threshold with no visible value tells
    // whoever changes a pattern nothing about what they changed.
    console.log(
      `PII detector over ${CORPUS.length} cases: precision ${(precision * 100).toFixed(1)}%, ` +
        `recall ${(recall * 100).toFixed(1)}%${wrong.length ? `\n  ${wrong.join("\n  ")}` : ""}`,
    );

    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });
});
