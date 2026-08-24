# `@agentkit/example-app`

A runnable app module and a browser test surface (#155). This is what makes
`node server/dist/cli.js` boot: `AGENTKIT_APP_MODULE` needs a module that default-exports
`{ authenticate, deps, engine, buildContext }`, and until this existed there was none anywhere.

## What this is not

Example code is what people copy, so the disclaimers come first.

- **Not an auth reference.** `authenticate` reads the tenant from a request header, which is not authentication —
  any caller can claim any tenant. It refuses to start without `AGENTKIT_EXAMPLE_DEV_AUTH=1` for that reason.
- **Not a deployment template.** One process per role, no TLS, no rate limiting, GraphiQL on.
- **Not a product UI.** It is pleasant enough to read a model's answers in, because something you are meant to
  *use* while judging an assistant has to be — but nothing here is a component library, and the layout is not
  responsive below roughly 660px.

## Build it first

The composer is the one bundled thing here — Tiptap, with a `/` command menu — so the app needs a build before its
first run:

```bash
npm run build -w @agentkit/example-app
```

Started without it, the page still loads and says exactly this in red rather than presenting a dead input: the
server answers `/composer.js` with a script that reports itself missing. `npm run build:composer -w
@agentkit/example-app -- --watch` while working on it.

## Run it

```bash
cp .env.example .env      # then set AGENTKIT_MODEL_API_KEY
npm run build
npm run migrate -w @agentkit/example-app   # once — creates the schema and its tables
npm run app    -w @agentkit/example-app    # terminal 1: page + GraphQL + SSE
npm run worker -w @agentkit/example-app    # terminal 2: nothing executes without this
```

Then open <http://localhost:4000/>.

**The worker is a separate process on purpose.** The whole point of the durable runtime is that the API host and
the worker share nothing but Postgres and the queue. One process doing both would be the shape the platform
exists to avoid — and #144 recorded that this boundary had never actually been exercised.

## Or run it with nothing installed

```bash
AGENTKIT_MODEL_API_KEY=sk-… AGENTKIT_EXAMPLE_DEV_AUTH=1 npm run memory -w @agentkit/example-app
```

One process, in-memory adapters, an in-process queue. No database, no Redis, no migration, no second terminal.
Same manifest, same tools, same engine, same page — only the adapters differ, which is the claim
ports-and-adapters makes and this is where it gets tested rather than asserted.

**What this mode cannot demonstrate**, which is the more useful half:

| | |
|---|---|
| **Durability** | Every store is a `Map`. Restarting loses everything. Checkpointing still happens and you can watch it, so it proves the mechanism and not the guarantee. |
| **The API/worker split** | One process makes the boundary a function call. #144 recorded that this boundary had never been exercised; running here does not exercise it either — which is how #161 (a no-op publisher) and #157 (an unwired message store) survived. |
| **Lease recovery** | Nothing else can claim a run, so the atomic claim is never contended. |
| **Slot contention** | The queue drains inline, so two runs never race. The FIFO serialisation is real code doing nothing. |
| **RLS** | No database to enforce it. Isolation rests on the adapters partitioning by tenant — checked by conformance, but defence in depth minus a layer. |
| **SQL** | A query that is wrong against Postgres is not wrong here, because there are none. |

Use `npm run app` for anything past a first look.

## Prove the durable path actually recovers

```bash
npm run app -w @agentkit/example-app        # terminal 1
npm run test:kill -w @agentkit/example-app  # terminal 2 — starts and kills its own workers
```

Starts a run that performs an external write, `SIGKILL`s the worker mid-run, starts a replacement, and asserts
the run completes with the side effect having happened **exactly once**. `SIGKILL` and not `SIGTERM`: a graceful
shutdown drains, which is the opposite of what is being tested.

It cannot prove the kill landed at the worst moment — the window between "tool has fired" and "result is
checkpointed" is milliseconds wide, and a pass is evidence rather than proof. It is written to be run repeatedly.

## Measure it at size

```bash
npm run loadtest -w @agentkit/example-app -- --messages=2000
```

Percentiles rather than averages at three sizes, so a linear scan hiding behind a small fixture shows up as a
slope. It is what found #167 — reported context utilization was identical at 100, 500 and 2000 messages, because
the figure described the read cap and not the conversation.

## Configuration

Everything is in `.env` at the repository root; `.env.example` documents each variable. `.env` is gitignored and
`.env.example` is committed, and never the other way round.

| Variable | Notes |
|---|---|
| `AGENTKIT_MODEL_API_KEY` | **Required, no default.** A key for whatever `AGENTKIT_MODEL_BASE_URL` points at. |
| `AGENTKIT_MODEL_ID` | Defaults to `gpt-4o`. Mini is enough to prove the plumbing works and not enough to show the agent behaving. |
| `AGENTKIT_MODEL_BASE_URL` | Unset for `api.openai.com`; set for a local server. |
| `AGENTKIT_DATABASE_URL` | Any Postgres. |
| `AGENTKIT_EXAMPLE_SCHEMA` | A **dedicated schema**, default `agentkit_example`. |
| `AGENTKIT_REDIS_URL` | Include a database number (`/9`) if the Redis is shared. |
| `AGENTKIT_SCHEMA_MODE` | `off`, so booting never migrates. Migration is a command you run on purpose. |
| `AGENTKIT_EXAMPLE_DEV_AUTH` | Must be `1`. There is no implicit way to enable header auth. |

### The model needs tool calling

An agent without tool calls is not much of an agent. Verified before choosing a default: a local 8B GGUF returned
an empty message with `tool_calls: null` for a request a hosted model answered with a correct call. If your
endpoint cannot call tools, the example fails on the first turn — which is the correct outcome, not a bug.

### It shares a database, and stays out of the way

`AGENTKIT_EXAMPLE_SCHEMA` exists so the example can run inside a database that belongs to something else. All 20
migrations land in that schema; nothing touches `public`. `npm run migrate -w @agentkit/example-app -- --down`
drops the schema and everything in it. The migrate script **asserts the `search_path` actually took effect**,
because a silently ignored connection option would put every table in `public` — which here is another project's
schema.

## What it exercises

| | |
|---|---|
| `list_notes`, `recall` | The ordinary read path; a tool result becoming a `tool-result` part. |
| `share_note` | The HITL approval gate — suspend, decide, resume, execute **exactly once**. |
| `write_note`, `remember` | Internal writes, and what plan mode excludes. |
| `ask_user` | A batch of questions, the run parking on them, and the answers reaching the model. |
| `load_skill` | A named, versioned block of instructions pulled into context on demand — the catalogue is in the prompt, the bodies are not. |
| `fetch_url` | The platform's egress policy where the *model* chooses the argument: SSRF refusals, no redirects, and the page fenced as untrusted content. |
| `mcp__agentkit-docs__*` | A real MCP server (this repo's own docs, over stdio) imported through the same registry as the first-party tools. |
| `calculate` | A recursive-descent parser behind a character whitelist. Not `eval`, deliberately. |
| role selector | `viewer` cannot *see* `share_note` in the catalogue, rather than being refused after asking. |
| note `n3` | Its body is a prompt-injection payload. Watch the model not comply. |

That last one is the point of the `external`-origin context section: note bodies are written by whoever created
the note, so they are exactly the content the untrusted-content envelope (#145) exists for. A unit test can show
the bytes are enclosed; only running it shows the model treating them as data. It called `n3` "a misleading
instruction not to follow".

## Modes

A selector in the sidebar, and each mode is a naming of a configuration the approval machinery already
supported rather than a new mechanism:

| Mode | Mechanically |
|---|---|
| **Plan** | Writing tools are excluded from the **catalogue**, keyed on *effect* rather than tool name. The model plans with an accurate picture of what it can do. |
| **Ask first** | The default. Gated tools raise an approval and the run suspends. |
| **Auto** | A real conversation-scoped `ApprovalGrant`. Leaving the mode revokes it. |

Plan mode is deliberately *not* "ask and always deny": a model that can see a tool it may never call learns to
keep trying, and writes plans that assume actions it will not be allowed to take.

When a plan is ready, an **Execute plan** button appears under it. It lands in **Ask first**, never Auto —
approving a plan is not granting standing approval for whatever the steps turn out to involve, with arguments
you have not seen. It sends a real user turn, so the transcript records that you asked for it.

## Questions

`ask_user` takes a **batch**. They appear above the input as tabs: answer each, move between them freely, and
nothing is sent until Submit — one `answerQuestion` call with everything, so the run resumes once.

Above the composer rather than in the transcript, because a card in the message flow scrolls away while you read
back through what you were told, and a run parked on a question nobody can find stays parked. The panel also
comes back on reload: `/api/history` reports the parked run, and the platform's `pendingQuestion` query supplies
the prompts and options.

## The composer

Tiptap, in `src/composer/` — the one built file. What it does, and why each part is there rather than decorative:

| | |
|---|---|
| `/` commands | Opens only when the slash opens the message: a slash mid-sentence is a date or a path, and a menu that appears while you type `and/or` interrupts four times a day. Matching is ranked, so a name beats an alias — typing `a` offers `/auto` and `/ask` before `/compact`. Aliases exist because nobody's first guess for "condense the history" is `/compact`; `/summarise` finds it. |
| The four commands | `/compact`, `/auto`, `/ask`, `/plan` — every one implemented, checked by a test that reads `runCommand` out of the page. A menu listing something unimplemented is worse than no menu: the person now believes the app can do it. |
| The mode chip | The same state as the sidebar selector, painted by the same function call, and both call `setMode`. The mode decides whether the message can change anything, so it belongs beside the message. |
| `+` | Types a slash. The menu opens *because* the text starts with one, which is the path a keystroke takes — one way in, not two. Not an attachment button: there is nothing here to attach to. |
| Dictation | The browser's own `SpeechRecognition`, and **hidden** where there is none rather than shown disabled. A control that is present and never works reads as a broken app. Interim results are not inserted — watching your sentence rewrite itself is worse than waiting. |
| The model label | Read from `GET /api/model`, because the model is resolved from configuration the page cannot see and a label naming the wrong one is worse than none. Host only, never the endpoint URL — a base URL can carry credentials (#145 SEC-001). |
| Enter / Shift+Enter | Send / new line. The hard break survives into the message as `\n`, checked live. |

Commands from the menu and commands typed as text both go through `runCommand`, so the two entry points cannot
diverge.

## Limits an admin can set

`POST /api/limits`, admin role only. A limit is `(principal, window)` — omit the principal for a workspace
default — and every field is optional, where omitted means **unbounded** rather than zero: a misconfigured limit
that blocks nothing is a bill, and one that blocks everything is an outage.

```bash
# 500 minor units in any five hours, for one person (#181)
curl -X POST localhost:4000/api/limits -H 'content-type: application/json' \
  -H 'x-agentkit-tenant: demo' -H 'x-agentkit-principal: you' -H 'x-agentkit-roles: admin' \
  -d '{"principalId":"you","window":"rolling:300","costMinorUnits":500}'
```

`window` is either a calendar period — `hour`, `day`, `week`, `month` — or `rolling:<minutes>`. Several can apply
at once; the **shortest span** binds, so being stopped by the five-hour limit tells you sooner than being stopped
by the month.

A **rolling** window slides: "no more than X in any five hours", always the last five hours up to now. It is not
an anchored session that resets on a boundary, and the refusal says so — `The oldest of it falls outside the
window at …` rather than `It resets at …`, because a sliding window frees up gradually and claiming a reset would
promise back an allowance you do not get.

| | Calendar | Rolling |
|---|---|---|
| Read from | The rollup for the bucket | The ledger, over `[now − length, now)` |
| Exactness | As fresh as the last rollup rebuild | Always exact |
| The message says | "It resets at T" — a true boundary | "The oldest of it falls outside the window at T" |

That first row is worth knowing, and running the two side by side is what made it visible: with the same spend, a
five-hour rolling limit reported 4 and a daily limit reported 2. The rolling figure was right. Rollups here are
rebuilt on demand by `/api/usage` rather than by a scheduled job — fine for a chart, and it means **a calendar
limit in this app can under-count** until something rebuilds the bucket. A deployment runs `createRollupJob` on a
schedule; the example does not, and that is a property of the example's wiring rather than of the platform.

## Things running this found

The wiring being *correct* was where the surprises were, as the issue predicted. Every one of these was in the
platform rather than here, and every one is fixed — see the issues for detail.

1. **`createServer(host)` could not serve a single request** — the composed handler's callable body is the
   WHATWG `fetch`, and Node calls a listener with `(IncomingMessage, ServerResponse)`. Every request died on
   `Failed to parse URL from [object Object]`. The tests call `host.fetch(new Request(…))`: the one path that
   worked.
2. **`instanceof Request` was the wrong check** — `@whatwg-node/server` ponyfills its own `Request`, so a
   genuine request arriving through the Node adapter is not `instanceof` the global one.
3. **#157 — `MessageStore` was read-only, and the assistant's turn was never persisted.** Both adapters carried
   an `append` documented as a test-only affordance, so no host could record what the user said without casting
   past the port; and nothing wrote the assistant's side at all, so on turn two the model saw only the user's
   half of turn one. This app compensated by folding the run event log. It no longer needs to.
4. **#159 — every tool reached the model undocumented.** `streamModelTurn` discarded JSON schemas and
   substituted a permissive one, so the model called tools with `{}`. `tool-error` chunks vanished into a
   `default: break`.
5. **#160 — a model definition's `maxOutputTokens` bounded nothing.** Generation parameters never reached
   `streamText`, and the engine treated the declared limit as a default an agent could raise.
6. **#161 — the documented worker command threw every run event away.** `publisher: { async publish() {} }`,
   hard-coded, so no client ever saw a token mid-run. It looks exactly like a working system with no streaming.
7. **#156 — a resumed run was silently dropped.** `runJobId` is deterministic and BullMQ retains completed
   jobs, so re-enqueueing after an approval was a no-op.
8. **#162 — a missing approval check refused identically to an unapproved call.** Both fail-closed layers said
   `approval_required`, so a wiring bug presented as the system working correctly. It cost two debugging rounds
   and a wrongly-filed platform issue (#158, closed as my own error).
9. **#163 — questions could be asked but never answered.** `question.requested` was in the event union and the
   worker turned it into `waiting-for-question`, and nothing could emit one: the question was stored, the model
   was told it had asked, and the run completed. Then the other half — `approvals` had a resume path and
   questions had none, so an answered question was invisible to the run that asked it and the model asked
   again. Both were watched happening in the browser: an empty text box where the picker should be, then the
   identical picker returning after answering it.

Nine platform defects, and the list above stops there deliberately — #164 onward were found the same way but by
then the app had grown enough to be worth suspecting itself.

### And things this app got wrong (#178)

Worth recording separately, because all four are the same shape: **correct-looking state that nothing could
observe**, which is why none of them failed a test.

- **The docs MCP provider was built with a literal tenant.** Every other tenant's connection record claimed to
  belong to `demo`. Inert — a stdio client ignores it — until an `McpConnectionStore` registration, a
  `redactConnection` render or an audit trail reads it. The first test written for the fix asserted
  `connectionId` was stable across tenants and **passed against the bug**, because the connection *id* never
  depended on the tenant. The provider now exposes `connectionFor(context)` so the tenant is observable at all.
- **The provider `id` was a hand-written copy of the platform's `mcp:` format.** Now taken from the platform's
  own derivation and pinned by a test.
- **`postgresBackend` built the run coordinator eagerly** with `runner as TransactionRunner`, so the worker —
  handed no runner, and never using the coordinator — held one constructed over `undefined`. It also left the
  API process with two coordinators on one run-slot table. Both processes now share the lazy one, which fails at
  *use* with a message naming the missing piece.
- **`.ctx { display:inline-flex }` outran the `hidden` attribute.** `[hidden] { display: none }` is a UA rule,
  so any class that sets `display` beats it: an empty context meter rendered as a stray bar on every fresh page
  while the element reported `hidden === true`. The DOM said hidden and the screen said otherwise.

`memoryAuthorization` was also removed — an exported policy builder nothing called, kept alive only by an import
`tsc` had no reason to complain about (`noUnusedLocals` is not set).
