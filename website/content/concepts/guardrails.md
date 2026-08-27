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

## The two in the box

### PII — offline, checksummed, consistent

```ts
import { createPiiGuardrail } from "@retinue/agentkit/guardrails";

const pii = createPiiGuardrail({
  // Everything by default: email, phone, card_number, iban, ssn, ip_address
  entities: ["email", "phone", "card_number"],
  // Per entity, because the right answer differs. Anything unlisted uses `defaultAction`.
  actions: { card_number: "refuse" },
  defaultAction: "redact",
});
```

**No network call, no model call.** A guardrail costing a round trip per turn is one a deployment disables under
load, and that is exactly when it was needed.

**Checksums, not just shapes.** Card numbers are Luhn-checked and IBANs mod-97-checked. A sixteen-digit order
number matches every card regex ever written, and flagging it teaches people this guardrail cries wolf — after
which they route around it.

**Redaction is referentially consistent.** The placeholder is derived from a hash of the value, so one value
always yields one placeholder: `[email:7a3f19]`. That is not cosmetic. A model asked to compare two records and
handed two *different* placeholders for one email concludes the records differ, and reasons wrongly about data it
was never allowed to see. It preserves equality and nothing else — no plaintext, not reversible.

**All three paths.** The turn, tool arguments, and **tool results** — the last being the likeliest source of
personal data in a whole run, because a document read by a tool contains whatever the document contains.

Measured over a labelled corpus that includes negatives designed to trip it (an order number, an epoch
timestamp, an invoice reference, a date): **100% precision and 100% recall**. That corpus is a regression guard
rather than proof of general accuracy — eighteen cases on our own detector — and it exists because the first
version of the phone pattern scored 78.6% precision and would have fired on invoice numbers.

### Moderation — an adapter, and off unless you declare it

```ts
import { createModerationGuardrail } from "@retinue/agentkit/guardrails";

const moderation = createModerationGuardrail({
  classify: async (text) => {
    const result = await yourClassifier(text);       // OpenAI's endpoint, a local model, a keyword list
    return { flagged: result.flagged, categories: result.categories };
  },
  subjects: ["input", "message"],                     // the default: two calls per turn
});
```

The classifier is **yours**. That is a cost decision rather than a technical one — a model call per turn doubles
the latency floor and adds a charge — and a runtime that imposed one would be spending your money on a policy you
did not choose.

**The cost, stated:** one classifier call per inspected subject, in series with the model rather than parallel to
it, because a turn already answered cannot be un-answered. `subjects: ["input"]` halves it and leaves generated
content unchecked — right for an internal tool, wrong for anything public. Tool arguments are never classified:
a JSON object is not prose, and a classifier asked about one returns confident nonsense.

**A classifier outage stops turns.** That is the expensive-looking choice, taken deliberately: the alternative is
an outage during which moderation silently stops happening and every run still looks normal.

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
