# Tool Selection at Scale

Status: measured, 27 Aug 2026 · REQ-045 ([#204](https://github.com/Rise-Experts/retinue/issues/204)), task [#221](https://github.com/Rise-Experts/retinue/issues/221)
Harness: `evals/tool-selection-scale.mjs` · raw output: `evals/tool-selection-scale.json`

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
| A catalog **budget**, with dropped tools named in the run event log | **Justified.** 10,142 tokens per turn at 200 tools is the finding, and it is paid before any conversation |
| **Per-tenant toolsets** | **Justified.** Same reason: the cheapest tool is one a tenant switched off |
| **`find_tools`** semantic search | **Not justified by accuracy.** It may still earn its place as a *cost* mechanism — it is how a budget stays usable once the catalogue exceeds it — but the accuracy argument for it is now known to be false and should not be repeated |

Latency is worth its own line: 2.4 s → 4.5 s per case is a user-visible change, and it comes from prompt size
rather than from tool count as such. That makes it a second argument for the budget and none at all for search.

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

Needs `RETINUE_MODEL_API_KEY`; costs a few dollars of `gpt-4o` for a full run. `--cases N` truncates for a smoke
test. Re-run this after any catalog change and compare against the table above — that is what the committed JSON
is for.
