# Prompt Caching

Measured for REQ-058 ([#246](https://github.com/Rise-Experts/retinue/issues/246)), task
[#247](https://github.com/Rise-Experts/retinue/issues/247). Reproduce with:

```
node --env-file=.env evals/prompt-caching.mjs
```

Raw per-turn data in `evals/prompt-caching.json`.

## Why this was the largest cost lever available

`docs/24` measured that going from 20 tools to 200 leaves selection accuracy **flat** (73.1% → 73.1%) and
multiplies catalogue tokens by **12.5×**. It concluded that per-tenant toolsets are the lever and a catalogue
*budget* is not, because truncation costs 19-23 points of accuracy.

There was a second lever it did not consider. The system prompt and the tool catalogue are **byte-identical on
every turn of a conversation**, which is precisely the input prompt caching exists for — and unlike a budget, it
costs nothing in accuracy. The platform had none: no `cacheControl`, no cache breakpoints, nothing.

## The defect underneath: a discount already being received and not recorded

Before any feature work, the platform was already getting cache hits on OpenAI and **recording none of them**.

`NeutralUsage.cachedInputTokens` was read from `totalUsage.cachedInputTokens`. The AI SDK does not send that
field. It sends:

```json
"inputTokenDetails": { "noCacheTokens": 222, "cacheReadTokens": 9472, "cacheWriteTokens": 0 }
```

So the read yielded `undefined`, `num()` made it `0`, and `computeModelCostMinorUnits` billed 9,472 discounted
tokens at the full input rate. `cacheWritePerMillion` was in `ModelPricing` and read by nothing at all.

This is worth separating from the feature: **a name that does not exist cannot be caught by any test that goes
through a fake.** Every unit test passed the whole time. Only a live call found it, which is why the eval exists.

## Results

200-tool catalogue (~8,100 input tokens per turn), 12-turn conversations, 2 independent conversations per
scenario, `gpt-4o`, temperature 0. Each scenario uses a distinct first line so no scenario inherits another's
warm cache — the first version of this measurement did not, and reported the mutated run as *better* than the
stable one, which is impossible.

| Prefix treatment | Cache hit rate | Cost saving | Median latency |
|---|---|---|---|
| **Stable** — never mutated | **65.2%** | **31.9%** | 1,616 ms |
| Summary **appended after** the prefix at turn 6 | 48.8% | 24.3% | 1,478 ms |
| Summary **prepended before** the prefix at turn 6 | 28.5% | 13.8% | 1,792 ms |

**When a hit lands it is nearly total.** Every hit read 7,936 or 8,064 of ~8,100 input tokens — 97-98% of the
prefix — and halved that turn's cost. There is no partial-hit regime to tune.

**There is no latency saving.** The medians differ by less than the run-to-run spread, and the *slowest* scenario
is the one with the fewest hits, which is the wrong direction for a causal story. Reported because it is a
negative result: this is a cost optimisation, not a speed one. `docs/26` had to record the same thing about the
reranker.

## The finding that matters operationally: automatic caching is best-effort

A perfectly stable prefix hit **65.2%**, not the ~92% that "turn 1 misses, turns 2-12 hit" would predict. The
per-turn pattern makes it plain — `H` is a hit, `.` a miss, across 24 turns:

```
stable   ....H.HHHHHH.H.HHHHH.HHH
append   ..H.H.HHHH.H.....HH..HHH
prepend  .......H.H.H..HHH....H..
```

OpenAI's caching is automatic: there is no directive to send and **no guarantee of a hit**. So a deployment
should treat the discount as a statistical saving on a large repetitive prefix, not as a property it can rely on
per turn. A cost estimate that assumed a hit would be wrong roughly a third of the time.

That is also why `CostEstimate.cachedInputTokens` is optional and defaults to assuming **no** cache. Over-reserving
refuses a turn slightly early; under-reserving admits a turn that then breaks the ceiling. Only the second costs
money.

## Compaction: append, do not rewrite

A provider matches a **prefix**. So where a summary goes decides whether the catalogue above it survives:

- **Appended after** the stable prefix: everything before the insertion point still matches. Cost 16 points of
  hit rate against never mutating — a real cost, because the appended text itself is new on the turn it appears
  and shifts what follows.
- **Prepended before** it: byte 0 changes, so nothing matches. Cost 37 points, more than halving the saving.

Both are plausible implementations of "compaction rewrites history", and they differ by the entire discount.
`context/compaction.ts` should therefore **append** its summary after the system prompt and tool catalogue, never
before them.

Stated with a caveat: the ordering is monotonic and well outside the per-turn noise at n=24, but the absolute
gaps come from one provider whose caching is best-effort. The direction is the finding; the exact point spread is
not a constant to design against.

## What the platform now does

- `ModelCapabilities.promptCaching` is `"automatic"` | `"explicit"` | `"none"`, absent meaning `"none"`. The
  three exist because they change what must be **sent**, not merely what to expect back: OpenAI needs no
  directive, Anthropic caches only what carries a `cache_control` breakpoint, and a provider with no caching
  would treat the field as unknown at best.
- For `"explicit"`, the breakpoint goes on the **system** block — where the stable prefix is. Anthropic caches
  everything up to a breakpoint, so that covers the prompt and the tool definitions together.
- `NeutralUsage` carries `cachedInputTokens` and `cacheWriteTokens`, both **subsets** of `inputTokens`. Measured:
  `noCacheTokens + cacheReadTokens + cacheWriteTokens === inputTokens`, so adding them on top would double-bill.
- `computeModelCostMinorUnits` prices all three kinds apart. **A cache write costs *more*** — Anthropic charges
  1.25× a fresh input token to write an entry — so folding writes into fresh input under-bills the first turn of
  every conversation, which is the direction that looks like a saving and is not.

## Not measured

**Anthropic's explicit path.** The breakpoint emission is implemented and unit-tested; it has not been run
against a live Anthropic model, for want of a key. Given that provider's 90% cache-read discount against
OpenAI's 50%, the ceiling there is roughly double what is reported above — but that is arithmetic, not a
measurement, and it is stated as such.

**A cross-provider comparison**, and **the interaction with a per-turn catalogue budget**. The budget is off by
default (#210), and `cache-prefix-stability.test.ts` asserts that a varying tool list changes the prefix — so the
mechanism by which a budget would destroy caching is pinned down even though the cost of it is not.
