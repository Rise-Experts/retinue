---
sidebar_position: 4
---

# Memory

## What is it?

Memory is what the agent knows beyond the current message. @agentkit layers it by **scope and
lifetime**, and assembles the relevant pieces into each prompt **under the model's token budget**.

| Scope | Keyed by | Lifetime |
|---|---|---|
| **Session** | conversation | one thread |
| **User** | tenant + principal | across the user's threads |
| **Tenant** | tenant | org-wide (knowledge + instructions) |

## Why would I use it?

So the assistant remembers what matters — the current thread, facts about the user, and org
knowledge — **without** blowing the context window. The naive "re-send the last N turns" approach
bloats prompts and fails on long threads; @agentkit budgets and compacts instead.

## Session memory

Durable working memory for a thread: a bounded, versioned document written by the runtime and
tools (never raw model output), read at the start of each turn, committed atomically with the
turn. See **[Sessions & threads](sessions)**.

## User memory

Cross-session, per-principal memory — the "remembers you" layer. Facts are **extracted and
deduped before commit**, retrieved as a budgeted context section ranked *below* recent turns,
and fully user-controllable (list / edit / delete / disable). Strictly tenant + principal
isolated.

```ts
// user memory enters a run as a context provider, not a raw dump
"User prefers a formal tone"        // source: user-stated
"Works in the EU (data residency)"  // source: extracted, deduped
```

## Tenant memory

Org-wide knowledge via **[retrieval / RAG](retrieval)** (permission-scoped, cited) plus standing
"tenant instructions" (brand voice, rules).

## The budget

Each turn, @agentkit computes a budget from the **selected model's** context limit, fills it by
priority (base policy, session state, recent turns, tool continuity are protected), prunes old
reasoning/tool detail first, **compacts** older history into a summary rather than dropping it,
and **fails loudly** if critical instructions can't fit — never silent truncation.

Next: **[Sessions & threads](sessions)**.
