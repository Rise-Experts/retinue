# GraphQL and Frontend Packages

## GraphQL boundary

GraphQL is the primary authenticated product API for conversations, configuration, interactions, usage and live updates. REST remains appropriate for OAuth callbacks, third-party webhooks, health endpoints and specialized file transfer.

Resolvers are thin: authenticate, validate, construct execution context and call platform services.

## Queries

- Conversations, messages and runs.
- Agents and versions.
- Skills and versions.
- Models and availability.
- Permission-filtered tool catalog.
- Usage and evaluations.
- Knowledge collections and sources.
- Files and processing state.
- Artifacts and versions.
- The pending question or approval a run is parked on (#163). Every mutation that resolves a human interaction
  needs a query that describes it, or a client can decide something it cannot display — see below.

## Mutations

- Create/rename/archive/delete conversation.
- Send/retry/cancel run.
- Answer question.
- Decide approval.
- Create/update/version agent.
- Create/update/activate skill.
- Begin/complete attachment upload.
- Create collection and ingest/remove source.
- Create/update/export artifact.

### Interactions need a read side (#163)

`answerQuestion` and `decideApproval` shipped with no counterpart, and the suspending events carry only an
`interactionId` — events are thin on purpose, and a payload duplicating the question would be a second copy to
keep in step with the stored one. The consequence was that the worker raised an interaction, a browser was told
its id, and had nothing else: a question rendered as an empty text box, and an approval card fell back to
"Run a tool?".

- `pendingQuestion(runId)` returns each spec's `prompt`, `options`, `multiple` and `allowOther`, with the
  optional fields **resolved** — a client made to treat `null`, `undefined` and `false` as the same thing will
  eventually treat one of them as `true`.
- `pendingApproval(runId)` returns the tool name, summary, risk category and the normalized input, so what runs
  is what was shown.

Both return null once the interaction is resolved, so a stale card cannot be used to decide the same thing
twice.

## Subscriptions

- Conversation/run events.
- File-processing events.
- Knowledge-ingestion events.

Subscriptions carry stable platform events and support resuming after a cursor. The client reconciles subscription data with authoritative query state.

## Headless React package

Required hooks:

- `useConversations`
- `useConversation`
- `useSendMessage`
- `useRunSubscription`
- `usePendingInteraction`
- `useAnswerQuestion`
- `useDecideApproval`
- `useCancelRun`
- `useAttachmentUpload`
- `useArtifact`

The package provides typed part reducers, optimistic sends, cursor catch-up, retry and cancellation. It contains no product styling. `useRunSubscription` exposes a `retry` state (attempt, max attempts, next-attempt time, reason) derived from the `run.retry-pending` event, which the "Error, retry and processing states" component renders as a live indicator.

## Optional UI package

Components:

- Chat shell, thread list and composer.
- Message and typed-part renderers.
- Tool execution and reasoning displays.
- Question and approval cards.
- Attachment upload/preview.
- Image gallery and PDF viewer.
- Source/citation display.
- Artifact panel and version history.
- Error, retry and processing states.

Components support theming, internationalization, accessibility and custom part renderers.
Internationalization is a locale-keyed message catalog that resolves stable backend codes (tool
names, statuses, retry indicators, error codes) to display strings with ICU interpolation and a
default-locale/raw-id fallback; a consuming app can register its own catalog. See docs/14.

## Mobile

The headless protocol is client-neutral. React Native may use the same GraphQL operations and event reducer while supplying native renderers. The DOM UI package is not a mobile dependency.

## Acceptance criteria

- A second frontend can consume the API without internal runtime knowledge.
- Subscription reconnect produces no missing or duplicated rendered parts.
- Question/approval actions are accessible and idempotent.
- Custom applications can replace every UI component while retaining headless state.

## SSE wire format

The SSE streaming path (SPEC #37, framing corrected in #111) speaks the **`graphql-sse`** wire format,
so a `twenty-client-sdk` client consumes it unmodified — twenty-sdk already streams GraphQL over
graphql-sse, and matching it was recorded as a decision in
[`extraction/twenty-sdk-comparison.md`](extraction/twenty-sdk-comparison.md).

```
id: 3
event: next
data: {"data":{"runEvents":{"type":"part.added","runId":"…","sequence":3,…}}}

event: complete
data:
```

| Line | Carries | Why |
|---|---|---|
| `id:` | `RunEvent.sequence` | A browser resends it as `Last-Event-ID`; `cursorFromLastEventId` maps it straight back to a resume cursor |
| `event: next` | An `ExecutionResult` | The protocol's data frame. The field name matches the SDL's `runEvents` subscription |
| `event: complete` | — | Says the response is finished. A stream that merely stops is indistinguishable from a truncated one |

A **failed run** arrives as a `next` frame carrying both `data` and `errors`, not as a protocol error
frame: `run.failed` is a durable event with a sequence, and an error frame has no `id:`, so delivering
it that way would make a failed run unresumable. A **stream-level** failure — the event log being
unreadable — does use the protocol's error shape, because there is no sequence to preserve.

### Reaching the endpoint

Two request shapes, because two kinds of consumer exist and neither can use the other's:

| Consumer | Request | Resume mechanism |
|---|---|---|
| `graphql-sse` client (what `twenty-client-sdk` ships) | `POST` with `{query, variables}` and `accept: text/event-stream` | **`after` in `variables`** — see below |
| Browser `EventSource` | `GET` with `?runId=&conversationId=` | `Last-Event-ID` header, sent automatically |

`Last-Event-ID` takes precedence when both are present: it is the transport's own mechanism and
reflects what the client actually received, whereas an `after` baked into a retried operation may be
stale and would replay events already delivered.

### The one accommodation beyond the raw protocol (#112)

**The `graphql-sse` client never sends `Last-Event-ID`.** It is absent from the library's source: on a
broken connection the client retries with exponential backoff and **re-subscribes from the beginning**.
Cursor resume exists only in its single-connection mode, via a reservation token.

So for that client, an interrupted stream replays. Nothing is lost and everything already seen arrives
again — which is safe, since run events carry a monotonic `sequence` a consumer can dedupe on, but it
is not resume.

A consumer that wants genuine resume passes the cursor itself, as `after` in the operation variables:

```ts
client.subscribe(
  { query: RUN_EVENTS, variables: { runId, conversationId, after: lastSequenceSeen } },
  sink,
);
```

That is supported deliberately rather than incidentally, and it is the only place this endpoint asks a
client to do something the protocol does not already do for it.


## Citation rendering (#138)

The provenance work in #137 has no user-facing effect until a citation is something a person can click and a
grounded claim looks different from an unsupported one.

### Markers inline, panels after the message

A citation arriving mid-stream appends a marker to the claim it grounds and appends a panel to the list below.
It never inserts above the reader's position, and it never renumbers — numbers are assigned once in **arrival
order**, because renumbering as citations stream in would change text the reader is already looking at, which
is the most disorienting form of a layout jump.

That gives the requirement a testable form: **the view model for N citations is a prefix of the one for N+1**.
Every panel already on screen keeps its position and its number, and every marker already rendered keeps its
number. A panel expanding in place between paragraphs would satisfy no such property, which is why the list
goes last — expanding one only ever grows the bottom of the message.

Panels are always in the tree with `hidden` toggled rather than mounted on expand. Mounting on expand changes
the document's height as the reader clicks, and `hidden` keeps the panel out of the accessibility tree too, so
nothing is announced that is not shown.

### Grounded vs ungrounded, without colour

Two mechanisms, because the requirement has two halves:

- **Visual:** a dotted underline on the paragraph and a superscript marker. Neither is a hue, so both survive
  greyscale, colour-blindness and forced-colours mode. A test asserts the shipped stylesheet contains no hex
  colour, no `rgb()`/`hsl()`, and no `color:` property at all — `currentColor` is the one exception and it
  cannot introduce a hue of its own.
- **Non-visual:** visually-hidden text saying whether the claim is supported. A marker and an underline are
  invisible to a screen reader, so the visual treatment alone would leave the distinction unavailable to
  exactly the readers who most need it stated.

`data-grounded` is derived from the citation graph, never from the prose. A claim reading *"According to the Q3
report [1]…"* is **not** grounded unless a citation names it — asserted, because that sentence is what a
heuristic would get wrong.

### Keyboard and semantics

The marker is a real `<button>`: focusable, activating on Enter *and* Space, announcing its expanded state —
none of which has to be reimplemented, and all of which a styled `<div>` with a click handler lacks entirely.
`aria-expanded` and `aria-controls` tie it to its panel, and a test checks the id it claims to control actually
exists.

Its accessible name is the **source**, not the number. A list of buttons all called "[1]", "[2]" tells a
screen-reader user nothing about where they lead.

The focus ring is an `outline`, for the same reason the grounded treatment is an underline.

### Localisation

Every user-visible string goes through `t`, including the brackets around a marker number — not every locale
brackets footnotes, and a component that wrapped the number itself would be unlocalisable in the way hardest to
notice. Ids live in `CITATION_IDS` rather than as literals at call sites, so a component cannot spell one
differently from the catalogue: a mistyped id renders as the id, which looks like a translation gap rather than
a typo.

The sharpest test of "nothing hardcoded" is rendering with the *identity* translator: every user-visible string
is then an id, so any literal in the component shows up as prose among the ids.

### An unresolvable source is a sentence

Three cases, kept apart because a reader needs different sentences:

| Resolution | Meaning |
|---|---|
| `linkable` | A web source with a URL a browser can open |
| `not-linkable` | A retrieval citation — inside the workspace, no external URL ever existed |
| `unresolvable` | Had a URL that no longer works |

Collapsing the last two would tell someone a document was deleted when it never left. Neither renders an
anchor, both render the excerpt — the excerpt is the evidence and it is stored on the part — and both use one
error format, differing only in the sentence.

### Testing note

React is a **peer** dependency the host provides, so it was not installed and components could not be rendered
at all. It is now a *dev* dependency and the tests render to static markup with `react-dom/server` — no DOM, no
jsdom, no test-library. What that cannot exercise is a click, so the expanded state is rendered directly rather
than toggled. Said plainly, because "we tested the component" should not imply interaction was covered.

The ordering logic sits in a React-free `citationViewModel`, for the same reason `part-summary.ts` is
React-free: the append-only property is provable about a list and merely observable about a DOM tree.

## The usage and cost panel (#140)

#139 built the rollups. Without a panel nobody can see their own consumption, so the transparency goal is unmet.

### One query, extended — not a second endpoint

`usageReport(period, from, to)` extends the existing `usage` surface rather than adding a bespoke one. Headline
totals and buckets come from the **rollups**, so a page load never scans raw records however much a tenant has
used. Breakdowns by model and by conversation come from the ledger over the same bounded range.

That split is a deliberate trade. Rollups are keyed on `(tenant, period, bucket)`; adding a model and a
conversation dimension would multiply the row count by the product of both cardinalities to serve a panel
nobody opens per second. A breakdown over one period is a bounded scan served by an index — where the headline
total, read on every page load *and* every quota check, comes from a rollup.

Everything in one resolver, because a panel showing a total from one query and a breakdown from another can
show two moments at once, and the discrepancy looks like a bug in the numbers rather than in the fetching.

### The chart is semantic HTML

No charting dependency. A bar per period, drawn as a proportional element inside a table row, which is *more*
accessible than a canvas — a screen reader reads the numbers rather than an alt text summarising them. The bar
is `aria-hidden`, because the figure is in the next cell and announcing both reads every row twice.

Bars scale against the **peak** bucket, not the total. Against the total, every bar in a long range is a sliver
and the chart says nothing.

### Empty is a state, not a zero

A tenant with no usage sees a sentence explaining why, never a chart of zeroes — a zeroed graph says *"we
measured and it was nothing"*, which is a different and misleading claim from *"there is nothing to measure"*.

`state` is decided from `eventCount`, **not** from whether the bucket array is empty. A rollup job that ran over
a quiet period writes buckets whose totals are all zero, and deciding from the array's length would draw exactly
the chart the empty state exists to avoid.

The empty state still shows the quota: a new tenant's limit is worth knowing before they spend anything.

### The quota bar is never a lie

- Its status comes from the **server's own guard** — the same computation that refuses admission. A panel that
  recomputed a threshold would eventually show "you are fine" while runs are being refused.
- Its fraction is capped at 1. A bar wider than its track is a rendering bug, and past the limit the useful
  information is "full"; the exceeded label says the rest in words.
- "No limit configured" renders as **text**, not as an empty track — an empty bar reads as "plenty of room",
  which is a claim about a limit that does not exist.
- It is a real `<progress>`: it announces its value, responds to forced-colours mode, and needs no ARIA. A
  styled `div` would need all three reimplemented.

Warning and exceeded are also stated in words, because the styling is a border pattern and a border is not
announced. Exceeded uses `role="alert"` rather than `status`: work is being refused *now*.

### One locale, one place

Every figure is formatted by the component with the `locale` prop and passed to the catalogue already
localised, so a catalogue entry interpolates and never formats. The alternative — letting an entry call
`intl.dateTime` — formats with the **translator's** locale, which can differ from the prop: one panel would then
show a German date next to an English currency.

The division from minor units to major happens in `formatCost` and nowhere else; doing it at a call site is how
a figure ends up a hundred times wrong.

### Mobile first, and hue-free

The base rules stack each table row into a block and a `min-width: 480px` query restores the table layout. That
direction matters: a desktop-first sheet leaves a phone with the horizontally-scrolling table the requirement
rules out, and only fixes it if the query matches. Figures use `tabular-nums` so a column of costs compares.

No hue carries meaning — warning is a dashed border, exceeded a doubled one, and both are labelled. Asserted:
the stylesheet contains no hex colour and no `rgb()`/`hsl()`.
