---
title: Testing
sidebar_position: 6
---

# Testing

`@retinue/agentkit/testing` carries two things, for two different jobs: the **conformance suite**, if you are
implementing a port, and **fakes**, if you are testing an agent or a tool you wrote.

Both need a test runner. `vitest` is an *optional peer* — install it if you import this subpath, and nothing in
a production bundle can reach these modules, because the only path to them is this entry.

```bash
npm install -D vitest
```

## Testing an agent without calling a provider

`createStubModel` is a scripted model. A script is a list of **turns**, and each call consumes the next one —
which is what lets you write "the model calls the tool, sees the result, then answers" separately from "the
first turn fails and the second succeeds".

```ts
import { createStubModel } from "@retinue/agentkit/testing";

const model = createStubModel([
  { call: [{ tool: "lookup_order", input: { id: "A-1" } }], then: "It shipped on Tuesday." },
]);

// Pass `model.streamTurn` as the engine's `streamTurn`, then assert on what the model was *given*:
const [first] = model.requests;
console.log(first?.tools?.map((tool) => tool.name));
```

Three details, each there because the obvious hand-written fake gets it wrong:

- **It does not emit its own `tool-result`.** The engine runs the tool, and that is the path under test. A stub
  that produced its own result would test the stub and hide an unwired tool completely.
- **Running past the end of the script throws.** An agent that took one more turn than you expected is a
  finding; an empty turn would let an assertion pass against a model that said nothing.
- **`{ fail: "…" }` defaults to retryable**, because the retry path is the one worth scripting — a
  non-retryable failure is just a thrown error.

`createMemoryStores` assembles every in-memory store in one call, so a test that needs a working backend does
not rebuild a list of sixteen — and does not silently miss the seventeenth when it lands.

```ts
import { createMemoryStores } from "@retinue/agentkit/testing";

const stores = createMemoryStores();
console.log(Object.keys(stores).length);
```

Call it **per test**. Here the factory *is* the state, so sharing one across tests shares the data; the Postgres
adapters take an executor and hold nothing, which is why those are safe to construct anywhere.

## Testing an adapter you wrote

Every port has a harness holding the same contract the built-in adapters are held to. Hand it a factory:

```ts
import { conversationStoreConformance } from "@retinue/agentkit/testing";
import { createMemoryConversationStore } from "@retinue/agentkit/persistence";

conversationStoreConformance(() => createMemoryConversationStore());
```

That is the whole integration. The suite covers tenant isolation, optimistic concurrency, pagination cursors
and idempotency — the properties that only show up under repetition or concurrency, and the ones a hand-written
test for a new adapter reliably omits.

:::tip Watch it fail before you trust it

A conformance suite nobody has seen reject anything has demonstrated nothing. Before wiring yours in, break it
on purpose — have `findById` ignore `tenantId` — and check the suite goes red. That specific bug is real: it
shipped once, in an adapter whose method accepted a tenant scope and destructured only the id.

This package's own release check does exactly that on every run, against an installed tarball, in both
directions: the in-memory adapter must pass and a deliberately leaky one must fail.

:::

`REGISTERED_PORTS` lists every port with a harness, so you can check what you still owe:

```ts
import { REGISTERED_PORTS } from "@retinue/agentkit/testing";

for (const { port, harness } of REGISTERED_PORTS) console.log(port, harness);
```

## Testing against real Postgres, without a server

`pgliteExecutor` runs the real migrations against an in-process Postgres, so a query that is wrong against
Postgres is wrong in your test too — which an in-memory adapter cannot tell you.

```bash
npm install -D @electric-sql/pglite
```
