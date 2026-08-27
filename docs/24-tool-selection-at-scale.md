# Tool Selection at Scale

Status: measured, 27 Aug 2026 · REQ-045 ([#204](https://github.com/Rise-Experts/retinue/issues/204)), tasks [#221](https://github.com/Rise-Experts/retinue/issues/221) and [#210](https://github.com/Rise-Experts/retinue/issues/210)
Harness: `evals/tool-selection-scale.mjs` · raw output: `evals/tool-selection-scale.json`,
`evals/tool-selection-scale-budget-1500.json`, `evals/tool-selection-scale-budget-3000.json`

REQ-045 assumed a large catalogue costs *tokens and accuracy*. Only the first half had been measured. This is
the second half, and **the hypothesis did not survive.**

## Result

26 `tool-selection` eval cases, scored through the real registry against `gpt-4o`:

| Tools | Catalog tokens | Accuracy | Δ baseline | ms/case |
|---|---|---|---|---|
| 20 | 811 | 73.1% (19/26) | — | 2,432 |
| 50 | 2,357 | 69.2% (18/26) | −3.9 pp | 3,243 |
| 200 | 10,142 | 73.1% (19/26) | 0.0 pp | 4,532 |

**Accuracy is flat from 20 tools to 200.** The 50-tool dip is one case, and with 26 cases one case is 3.8
percentage points — the entire observed swing is within a single case of noise. Ten times the catalogue produced
no measurable loss of selection accuracy.

What *does* scale is cost: **12.5× the catalog tokens** and **1.9× the latency**, both roughly linear in
catalogue size, both paid on every turn whether or not a tool is used.

## What this changes

REQ-045 narrows to the half that is real:

| Planned | Verdict |
|---|---|
| A catalog **budget**, with dropped tools named in the run event log | **Justified as a mechanism, expensive in practice.** 10,142 tokens per turn at 200 tools is real and paid before any conversation — but the budget arm below costs 19–23 pp of selection accuracy, so it ships off by default with the number in the docs |
| **Per-tenant toolsets** | **Justified, and now the recommended lever.** The cheapest tool is one a tenant switched off — and unlike a budget, switching off a category removes the confusable near-duplicates with it |
| **`find_tools`** semantic search | **Not justified by accuracy.** It may still earn its place as a *cost* mechanism — it is how a budget stays usable once the catalogue exceeds it — but the accuracy argument for it is now known to be false and should not be repeated |

Latency is worth its own line: 2.4 s → 4.5 s per case is a user-visible change, and it comes from prompt size
rather than from tool count as such. That makes it a second argument for the budget and none at all for search.

## The budget, measured — task #210, AC-6

A budget bounds the cost. The question AC-6 asks is what it costs in *accuracy*, and the answer is: **a lot,
more than the token saving is worth on a catalogue like this one.**

Same 26 cases, same 200-tool catalogue, `find_tools` + `learn_tools` + `execute_tool` in the model's hands, and
the system prompt telling it the list is partial:

| Arm | Resident tool tokens | Accuracy | Δ vs 200-tool baseline | Searched | ms/case |
|---|---|---|---|---|---|
| 200 tools, no budget | ~6,200 (10,142 as a compact catalog) | **73.1%** | — | n/a | 4,532 |
| 200 tools, budget 3,000 | ≤3,000 | **53.8%** | **−19.3 pp** | 14/26 | 5,630 |
| 200 tools, budget 1,500 | ≤1,500 | **50.0%** | **−23.1 pp** | 17/26 | 4,696 |

**AC-6 is not met, and that is the finding.** Resident tokens are bounded — 4× and 2× reductions, enforced, with
every dropped tool named in a `catalog.truncated` run event. Accuracy is 19–23 points below baseline, which is
far outside the ±4 pp of noise this dataset shows.

### Why, from the transcripts

Three distinct failures, and only one of them is the recovery mechanism:

| Failure | Cases | What happened |
|---|---|---|
| **Preferred a resident near-duplicate** | ts-005, ts-020, ts-023, ts-025 | `archive_accounts` instead of `list_accounts`. The model never searched: a plausible tool was right there. **This is the dominant cost and it is not fixable in the mechanism** — it is what happens when a budget drops the right tool and keeps a confusable one |
| **Searched, then stopped** | ts-002, ts-011, ts-018, ts-022 | Called `find_tools` and then answered in prose rather than following through with `learn_tools`/`execute_tool` |
| **Searched and recovered** | ts-024 and others that now pass | `find_tools` → `learn_tools` → `execute_tool` → the real tool. The loop works end to end |

### Two defects this measurement found

Both were mechanism bugs, and both would have shipped invisibly.

**`find_tools` ranked padded near-duplicates first.** `archive_post_metrics` above `get_post_metrics`: identical
term matches, so the raw scores tied and the tie-break — alphabetical by name — decided it. In a catalogue whose
duplicates are `<verb>_<object>`, alphabetical order is *systematically* wrong. Fixed with BM25-style length
normalisation: a short focused description beats a long one that matches incidentally. Worth **+11.5 pp** on its
own (38.5% → 50.0%).

**A call made through `execute_tool` was unattributable.** The run event log recorded `execute_tool` and lost the
tool that actually ran — so a `destructive` action taken that way would appear in an audit trail as the name of
the mechanism rather than the name of the action. `ToolResult`, `ToolResultPart` and `ToolEvent` now carry
`ranToolName`. It also meant the first budgeted run scored the *working* recovery path as a failure, which is a
reminder that a harness reporting a low number is a claim about the harness until it is checked.

**And one that was missing entirely:** `learn_tools` and `execute_tool` had been in `META_TOOLS` since the
registry was written with **nothing implementing either**. `find_tools` alone would have returned a name the
model could not call, and the catalogue documented both as "built".

### What to do with a large catalogue, given these numbers

1. **Per-tenant toolsets first.** Switching off a category the tenant does not want removes the near-duplicates
   *with* the tools, so it costs nothing in accuracy. A budget drops by position and leaves the confusable
   neighbours behind, which is exactly the population that causes the loss.
2. **Preload the categories you actually use.** Preloaded tools are charged against the budget and never dropped,
   so a deployment that names its own working set keeps it and truncates only the tail.
3. **Turn a budget on only when the catalogue is genuinely too large for the window**, and read the number above
   first. −20 pp of tool selection is not a fair trade for 5,000 tokens in most deployments.
4. **`find_tools` earns its place as the recovery path for (3)** — not as an accuracy improvement. #221 already
   showed accuracy does not degrade with size; this arm shows search cannot fully repair a truncation either.

## Honest limits of this measurement

**The baseline is 73.1%, not ~100%.** Seven cases fail with *exactly* the twenty tools the dataset needs and no
distractors at all. So the absolute number measures this harness — stub descriptions written for the experiment,
against a dataset authored for ShareFlow's real toolset — and **only the delta across sizes is the signal.** The
delta is what was being asked about, and the delta is zero.

**The six persistent failures are expectation mismatches, not selection failures.** Every one is stable across
all three sizes, and each is explicable:

| Case | Expected | Model called | Reading |
|---|---|---|---|
| ts-010, ts-017, ts-018, ts-024 | `attach_media` / `convert_media` / `read_source` / `read_document` | `list_attachments` | The model lists before it acts. That is reasonable behaviour, and the case scores only the named tool |
| ts-023 | `read_document` | `list_attachments`, `read_attachment` | "the attached PDF" is an *attachment*. The model's choice is arguably the better one |
| ts-026 | `read_attachment` **not** called | `list_attachments`, `read_attachment` | "What is in the attached CSV?" — reading it is the obvious action. This expectation may simply be wrong |
| ts-009 | `reply_to_comment` | `list_accounts` | A genuine miss |

That is a finding **for the eval dataset**, not for the runtime: four of these encode a list-before-act
expectation the harness scores as failure, and two disagree with a defensible model choice. Recorded here so
nobody "fixes" selection to satisfy a questionable case — which would be optimising the runtime against a bug in
its own benchmark.

## How the distractors were built, because a benchmark whose inputs are undescribed is not one

A catalogue degrades because entries *resemble* each other, so 180 obviously-distinct tools would have shown
nothing and "no degradation at 200" would have been evidence of nothing.

Each distractor keeps a real tool's object and changes its verb — `publish_post` spawns `release_post`,
`push_post`, `broadcast_post` — carrying that tool's own description plus a qualifier such as *"Bulk variant that
accepts several identifiers."* That is the population a hundred real integrations actually has: forty ways to
send a message. Generation is deterministic, so a re-run measures the same set.

Sizes start at **20**, not the 15 the task asked for: the dataset references twenty distinct tools, so a
fifteen-tool catalogue cannot contain them all and some cases would be unpassable by construction — measuring
which cases were *possible* rather than how well selection works.

## Re-running it

```bash
node evals/tool-selection-scale.mjs --sizes 20,50,200
```

And the budget arm, one file per budget so the curve keeps both points:

```bash
node evals/tool-selection-scale.mjs --sizes 200 --budget 1500
```

Needs `RETINUE_MODEL_API_KEY`; costs a few dollars of `gpt-4o` for a full run. `--cases N` truncates for a smoke
test. Re-run this after any catalog change and compare against the table above — that is what the committed JSON
is for.
