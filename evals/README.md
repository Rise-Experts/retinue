# Evaluation dataset

The versioned, representative cases that are the parity gate for every runtime phase
(SPEC #13). The grading engine that runs these against a live runtime lands in Phase 12
(`@retinue/evals`, SPEC-050); this folder is the **data + schema + loader + coverage**.

## Layout
- `schema.mjs` — the `EvalCase` shape + `validateCase()` (zero deps).
- `cases/<dimension>.json` — an array of cases per dimension.
- `load.mjs` — `loadCases()`: reads, validates, checks unique ids.
- `coverage.mjs` — CLI report; exits non-zero if invalid, under 100, or a dimension is empty.
- `load.test.mjs` — integrity tests (`node --test`).

## Dimensions
`task-completion`, `tool-selection`, `authorization`, `external-action-safety`, `groundedness`, `retrieval`.

`retrieval` is scored by a harness of its own rather than by the agent grader, because its subject is the
retriever and not a model's answer: `input.message` is the query and `expect.relevant` is a list of
`{ source, mustContain }` **predicates** — a relevant hit is a chunk from that document containing that phrase.
Judging by chunk id would break the dataset every time the chunker changed its boundaries, which is exactly the
change somebody would want to evaluate.

## A case
```json
{
  "id": "ts-001",
  "dimension": "tool-selection",
  "title": "Publish means publish tool",
  "input": { "message": "Publish the 'Spring sale' draft to LinkedIn now." },
  "expect": { "kind": "tool-called", "tool": "publish_post" },
  "tags": ["publishing"]
}
```
`expect.kind` ∈ `contains | tool-called | tool-not-called | requires-approval | refuses | cites-source | structured-valid | retrieves`.

## The two harnesses that cost money

Neither is in `ci:local`, because a gate that spends money on every run is a gate somebody switches off.

| Harness | What it answers | Cost |
|---|---|---|
| `tool-selection-scale.mjs` | Does selection degrade as the catalogue grows, and what does a budget cost? See `docs/24` | a few dollars |
| `retrieval-quality.mjs` | Is hybrid better than its parts, is the reranker worth it, and how does a vector-less mode compare? See `docs/26` | about two cents, or fifteen with the `navigate` arm |

Both write their raw output next to this file, and both are worth re-running before a release that touches what
they measure.

## Adding a case
Append to the matching `cases/<dimension>.json` with a unique id, then:
```bash
npm run evals:coverage   # from the repo root
```
