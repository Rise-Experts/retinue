# Glossary

Status: decided
REQ reference: REQ-035 (#184) · SPEC #200
Enforced by: `npm run check:terminology`, which reads **this file** as its configuration

Two things live here. The first is a decision about how far "our own terms" goes, recorded so it is not
re-litigated every quarter. The second is the vocabulary itself, each term marked *standard* or *ours*, and each
with the one line of reason that makes the mark defensible.

The tables are the configuration for the check that enforces them. Editing a table changes what the pipeline
allows, which is the only arrangement under which a glossary and a codebase cannot drift.

---

## The decision

The request was to use "our own terms instead of generic ones". The narrow reading is the one taken here, and
the reasoning is the part worth keeping.

**Keep the industry-standard nouns.** *Agent, tool, run, message, conversation, context, token* are what a
customer searches for, what every provider's documentation says, and what an engineer evaluating us already
knows. Renaming `Tool` means every reader translates before they can evaluate, and translation is where
evaluation stops.

**Keep `flow` and `team` too** — which is narrower than the recommendation in #200, and deliberately. The
argument for coining a word was that the multi-agent unit and the workflow unit are genuinely ours and have no
established name. Half of that is true: *crew* is CrewAI's and *swarm* is OpenAI's, so those are unavailable.
But `flow` and `team` are not competitors' coinages — they are plain English for exactly the thing, and `Team`
in particular is what AutoGen and Agno both call it, which by the criterion above makes it the standard noun
rather than a generic one. Coining a replacement would cost every page an explanation and buy a word that means
what the obvious word already meant.

**Brand the properties instead**, because that is where the difference actually is and the names already exist
in the code: the *suppressed write*, the *approval gate*, the *shadow run*, the *parity gate*, the *reachability
guard*, the *conformance matrix*, the *capability map*. Nobody else ships these, and a reader who learns them
has learned something about this runtime rather than a synonym for something they knew.

**What is still a product decision, and therefore not decided here:** the product name (currently *Retinue*,
which the scope, repository, docs site and board all use), the platform product's name (REQ-041), and the CLI
verb. Those are marketing, not engineering, and blocking a glossary on them would produce neither.

**This decision has a deadline, which is the first publish.** Every term below is a public identifier or a
documented word; changing one afterwards costs a major version and a migration guide (#189, #193). So the cheap
moment to overrule any of it is now. If the narrow reading is rejected and the units get coined names, the work
is a rename of `FlowDefinition`/`TeamDefinition` and their subpath — an afternoon today, a deprecation cycle
later.

### One thing this decision found

`approval envelope` appeared exactly once in the whole repository: in `docs/21-platform.md`, written by me two
hours earlier, having been carried across from an issue comment. The codebase's word — 49 occurrences, in code
and prose — is **approval gate**. That is the drift this glossary exists to stop, and it had happened once
before the glossary was written. It is now a rejected spelling, so it cannot happen again silently.

---

## Standard terms

Kept because they are what the industry says. "Maps to" names where a reader will already have met the word.

| Term | Maps to elsewhere | Why we keep it |
|---|---|---|
| agent | every framework; the AI SDK, Agno, CrewAI, AutoGen | The unit of "a model with instructions and tools". Universal, and unambiguous |
| tool | function calling / tool use, all providers | What the model may invoke. Renaming it would fight every provider's own documentation |
| run | Agno, LangGraph, OpenAI's runs | One execution of an agent against an input. Ours is durable and cancellable, which is a property of the run, not a different noun |
| conversation | thread in OpenAI's API, chat elsewhere | The ordered history a run appends to. We keep *thread* for the session-state layer, so the two words do different jobs on purpose |
| message | universal | A turn's content, typed as parts |
| turn | universal in chat UIs | One request/response pair inside a conversation |
| context | universal | What is assembled into the prompt. The interesting part is the pruning, not the noun |
| token, context window | every provider's billing page | Counting and limits. A customer reconciling our invoice against a provider's needs the same word in both |
| thread, session | Agno's sessions | Cross-run state above a conversation, with its own compaction |
| skill | Anthropic's skills, Agno's | An instruction bundle a model can load on demand |
| memory | universal | Principal-scoped facts that follow a user across conversations |
| knowledge, RAG, embedding, vector store | universal | Retrieval. Coining here would be actively unhelpful |
| provider, model | universal | Who serves the model, and which one |
| adapter, port | hexagonal architecture, twenty years old | The infrastructure seam. A reader who knows the pattern knows the layout of this repository |
| tenant, principal | every multi-tenant system | Who the work belongs to, and who is asking |
| flow | generic; CrewAI also has *flows* | A versioned, durable workflow definition. Plain English for exactly the thing — see the decision above |
| team | AutoGen's `Team`, Agno's `Team` | Several agents working on one task. The standard noun, not a generic one |
| step | universal in workflow engines | One node of a flow, and the unit an idempotency key is scoped to |
| trigger | every automation product | What starts a flow: a schedule, a webhook, an account event |
| checkpoint | universal in durable execution | A resumable point in a run |
| HITL, approval | universal | A person deciding before an external write happens |
| idempotency key | Stripe's, and every payments API since | The key that makes a retry safe. Borrowed on purpose: the guarantee is the one people already expect |
| quota, usage | universal billing vocabulary | What was spent, and the ceiling on it |
| trace, span, metric | OpenTelemetry | Telemetry. The words are the standard's, and so is the wire format |
| MCP | Anthropic's Model Context Protocol | The protocol name. Not ours to rename |
| egress policy | networking | What a tool may reach on the network |

## Ours

Terms we use because nobody else has a name for the thing. Each must appear in the codebase with the spelling
given here — the check enforces it, so a term that stops being used stops being documented.

| Term | In code | Why it earns its cost |
|---|---|---|
| suppressed write | `SuppressedWrite` | A tool call that succeeded and deliberately did not write, recorded rather than executed. "Blocked" or "denied" would read as an error to whoever finds it in a log, and the whole point is that nothing went wrong |
| approval gate | `ApprovalPolicy`, `PendingApproval` | The point at which a run stops and a person decides. *Gate* rather than *prompt* because it is in the execution path and cannot be routed around |
| shadow run | `shadow` | A run whose external writes are suppressed and recorded, so a change can be evaluated against real traffic without acting on it |
| delegating tool | `defineDelegatingTool` | A tool whose execution is delegated through the envelope that applies authorization, idempotency and approval. The distinction matters because suppression happens in the envelope, so a tool outside it is not covered |
| result envelope | `ToolResult` | The one shape every tool result has, so a model never has to learn a tool's private error format |
| run event | `RunEvent` | The append-only record of what a run did. Not a "log": it is queried, retained by policy and is what a trace is assembled from |
| capability map | `CapabilityMap` | The declaration of what a runtime can do, resolved at composition and enforced at the call. A capability that is off refuses rather than silently no-ops |
| parity gate | `scripts/…` and `shareflow/` | The check that a replacement runtime does everything the old one did, on evidence rather than assertion |
| reachability guard | `scripts/check-reachability.mjs` | The check that a built capability is wired to something a user can reach. Named because this repository's most common defect is code that is built, tested and unreachable |
| conformance matrix | `scripts/conformance-matrix.mjs` | Every port × every adapter, with the cell that is not covered named rather than absent |

## Rejected spellings

Any occurrence outside the allowed paths fails `npm run check:terminology`. "Allowed in" is a path prefix; `—`
means nowhere.

| Rejected | Concept | Allowed in | Why it is rejected |
|---|---|---|---|
| crew | the multi-agent unit | — | CrewAI's word. Using it invites the comparison on their terms |
| swarm | the multi-agent unit | — | OpenAI's word, and it implies emergent coordination we do not do |
| group chat | the multi-agent unit | — | AutoGen's word, and it describes a mechanism rather than the unit |
| approval envelope | the approval gate | — | Invented in an issue comment and used once. The code and 49 other references say *approval gate*, and the envelope is a different thing (the delegating tool's) |
| capability manifest | the capability map | — | The type is `CapabilityMap`; *manifest* suggests a file rather than a resolved object |
| blocked write | the suppressed write | — | Reads as an error. The tool call succeeded; the write did not happen because it was a shadow run |

### Why the list is this short

A rejected-synonym check is only as good as its precision. `workflow` is not on it, although *flow* is our noun:
the word legitimately means a GitHub Actions workflow, a ShareFlow workflow and the generic category, and a rule
that fires 337 times on correct prose is a rule someone deletes within a week. The same reasoning excludes
`pipeline` (CI, and the tool pipeline). What is listed here is what is *unambiguously* wrong wherever it appears.

`CHANGELOG.md` and `plan.archive/` are excluded from the scan: both are history. A rejected word in a commit
subject cannot be edited without rewriting published history, and a check that can only ever stay red is a check
people learn to ignore.
