---
sidebar_position: 10
---

# Guardrails

A guardrail is a check the runtime runs for you, on the way in and on the way out. Retinue ships the seam and
you supply the policy — because what counts as unacceptable input is a property of your deployment, not of an
agent framework.

## What is already handled, and is not a guardrail

Before adding one, know what you do not have to write.

**Prompt-injection containment is structural and always on.** Every context section carries an origin. Content
from outside the tenant — a web page, an MCP tool result, an extracted document — is wrapped in a
nonce-delimited envelope with delimiter forgery neutralised, preceded by a standing instruction about *the
block*. That works whether or not anything recognises an attack, which is exactly why it is not modelled as a
guardrail: a detector that misses is a detector that lets something through, and containment does not depend on
recognising anything.

**External writes already stop for a person.** That is the [approval gate](./human-in-the-loop.md), not a
guardrail.

Guardrails are for *inspection*: PII, moderation, topic restriction, an output shape you require.

## The contract

```ts
import type { Guardrail } from "@retinue/agentkit/guardrails";
```

Two hooks, both optional. Implement whichever you need:

- `inspectInput` runs **before the model sees the turn**. A refusal here costs nothing — no provider call.
- `inspectOutput` runs **before anything leaves the model**, and that includes a **tool call**.

A verdict is one of three things: `pass`, `redacted` (with `what` naming the fields or entity types touched —
never their contents), or `refused` (with a code and a message the person will read).

## A worked example

A guardrail that refuses a turn containing something shaped like a payment card, and strips credentials out of
tool arguments:

```ts
import { createAgent } from "@retinue/agentkit/providers";
import type { Guardrail } from "@retinue/agentkit/guardrails";

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const noCardNumbers: Guardrail = {
  name: "no-card-numbers",
  inspectInput(input) {
    const candidate = input.text.match(/\b(?:\d[ -]?){13,19}\b/)?.[0]?.replace(/[ -]/g, "");
    // Checksum, not just shape: a 16-digit order number that fails Luhn is an order number, and flagging it
    // teaches people to ignore the guardrail.
    if (candidate && luhn(candidate)) {
      return { kind: "refused", code: "card_number", message: "Please remove the card number and try again." };
    }
    return { kind: "pass" };
  },
  inspectOutput(output) {
    if (output.kind !== "tool-call") return { kind: "pass" };
    const input = output.input as Record<string, unknown>;
    if (typeof input.token !== "string") return { kind: "pass" };
    // A tool argument is the interesting exfiltration path — checking only the final message misses it.
    return { kind: "redacted", value: { ...output, input: { ...input, token: "[redacted]" } }, what: ["token"] };
  },
};

const agent = createAgent({
  manifest: { id: "assistant", name: "Assistant", instructions: "Be concise.", modelPolicy: { role: "smart" } },
  guardrails: [noCardNumbers],
});
```

Composing the runtime yourself instead? Pass the same array as the `guardrails` service and turn the capability
on.

## Four rules worth knowing before you write one

**Order is yours, and it matters.** Guardrails run in the order you declare, and each sees what the previous one
produced. That is what lets two redacting guardrails compose rather than one undoing the other — and it is why
the set is an array and not a record.

**Failing closed is not configurable.** A guardrail that throws refuses the turn, attributed to that guardrail.
The alternative is a guardrail that silently stops guarding the day its dependency times out, while every run
still looks normal.

**A refusal short-circuits.** The remaining guardrails are not consulted; the turn is over.

**Every verdict is recorded.** Each one emits a `guardrail.verdict` run event — including a pass, because "no
guardrail ran" and "a guardrail ran and allowed it" are different facts during an incident review. The event
names *what* was redacted and never its value, or the audit trail becomes the leak it exists to record.

## What a guardrail cannot do

It cannot see history. `inspectInput` receives the newest user turn, not the conversation, because a guardrail
that re-inspects the past would re-refuse a conversation over something already allowed — and a check that
changes its mind about history makes a conversation impossible to continue.
