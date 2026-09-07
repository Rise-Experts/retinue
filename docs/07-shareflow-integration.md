# ShareFlow Integration Specification

ShareFlow is the first consumer and remains outside generic packages.

## Registered agents

Initial user-facing experience exposes one primary Social Assistant. Internal/versioned agent manifests may specialize execution without asking users to select an architecture.

## Context providers

- Brand profile and approved/forbidden claims.
- Audience segments.
- Products, offers and differentiators.
- Campaign brief and active dates.
- Connected social accounts and health.
- Current post/campaign/page context.
- Relevant approved examples and recent similar posts.
- Measured performance insights when the request needs them.

## Tool providers

| Category | Initial tools |
|---|---|
| Posts | Read, create, update and duplicate drafts |
| Accounts | List destinations and connection health |
| Publishing | Validate, schedule, publish and retry |
| Campaigns | Read, create and update campaigns |
| Media | List, inspect, attach and convert |
| Analytics | Post/campaign metrics and attribution |
| Engagement | Comments, assignment and replies |
| Leads | Create/update attributed leads |
| Research | Search and read sources |

## Workflow 1: create post

1. Interpret objective, audience, offer and channel request.
2. Resolve relevant brand/product/campaign context.
3. Ask only for consequential missing information.
4. Generate distinct strategic angles.
5. Select or present an angle according to workflow policy.
6. Produce structured channel variants.
7. Validate claims, duplication, platform limits and media.
8. Repair bounded validation failures.
9. Save a draft and return verified previews.

## Workflow 2: publish/schedule

1. Resolve exact draft and destinations.
2. Validate role, account health, content and media.
3. Request action approval.
4. Execute existing publishing service with an idempotency key.
5. Persist per-target status.
6. Report only verified outcomes and remediation.

## Workflow 3: campaign planning

Collect or infer goal, audience, offer, dates, channels and cadence. Produce themes and a content calendar, obtain approval, then create campaign and drafts. Paid operations remain out of the initial workflow.

## Workflow 4: repurpose

Read an authorized source, extract reusable ideas with citations, propose formats, create channel-native drafts and preserve source provenance.

## Workflow 5: analytics

Retrieve and calculate metrics deterministically. The model explains observed patterns, labels hypotheses, and recommends a measurable next experiment. It may not invent causal explanations.

## Workflow 6: engagement

Retrieve supported comments/mentions, propose grounded replies, request approval where policy requires it, send idempotently and optionally create an attributed lead.

## Service adapters

Four of the ten services declared in `packages/shareflow/src/services/` now have adapters in that package:
`content`, `brand` and `publishing` over ShareFlow's own tables, and `generator` over the host's model.
`publishing` is the first whose methods are external writes, which is what gives a shadow run something to
suppress — the three before it were all reads and internal writes, so a shadow record was correctly empty.

Publishing rests on facts the schema does not enforce, and they are worth stating at specification level.
`scheduled_items` has **no unique constraint** on `(post_id, social_account_id)`, so publish-once is the
service's responsibility, not the database's; the adapter takes a row lock on the draft inside a transaction,
which serialises its own callers but not ShareFlow's app, whose route takes no lock. Closing that needs a
partial unique index in ShareFlow's schema. The adapter also does not enqueue: it writes a `PENDING` row and
relies on ShareFlow's reconciliation sweep, which trades seconds for minutes and is a real behavioural
difference between the two runtimes. And two states this specification describes are not reachable in the
deployment — there is no `awaiting-platform` status and no 24-hour give-up rule, so "stuck" is derived from
the sweep's own alert threshold.

`connectors` completes the publish path: `list_accounts` is the only capability that surfaces an account id,
and without it an assistant with working publishing capabilities could only guess where to send a post. Two of
its three methods depend on facts no database holds — whether a platform's OAuth app has credentials (a
runtime environment read in ShareFlow's own process) and what connecting a platform requires (redirect URLs,
console field labels, scopes, variable names) — so both are supplied by the deployment rather than derived.
Re-checking an account against its platform refuses outright when no probe is wired, because answering from
the stored status would be a false claim presented as a live check.

The five remaining — media, engagement, leads, research and analytics — are ports
without adapters, and the composer returns a narrower type rather than an object whose missing members throw.
The reason is measurable rather than stylistic: the context assembler runs providers in a bare loop with no
error handling, and the accounts provider reads `connectors` on every turn, so a declare-and-throw object plus
the standard provider list is a deployment where no turn completes at all.

A partial deployment is therefore a first-class configuration rather than a workaround. Each of the 37 tool
factories declares which services it reads; a factory receives only those, so reading another does not
compile; and the provider takes a partial service set and **refuses at construction** when a registered
capability needs one that is absent, naming the tools and the services to supply. Twelve capabilities read
only the three implemented services, which is the surface a rollout can serve today.

Two methods have **no store in this schema**. Nothing holds approved or forbidden claims, and the performance
brief needs a metrics join the port itself describes as too expensive for a routine request. Both answer empty
and both are marked in `BRAND_SUPPORTED`, so a caller can distinguish "this workspace forbids nothing" from
"nobody records that" — a distinction that matters because the first is a policy statement and the second is
an absence.

### The mapping is the work

The ports were specified here; the tables were built by ShareFlow. Every gap is a translation, and the
translations were wrong in ways only a live database revealed — statuses that do not exist in the column, a
cadence the CHECK constraint spells differently, a post-count formula that reported a third of a three-a-week
campaign, a publish state with no arm for the value that means "it went out", and two not-null columns whose
omitted optionals became explicit nulls and failed every campaign insert. None was visible to the compiler.

The suite for these adapters therefore runs against a real ShareFlow database and **skips rather than falling
back to a fake** when one is not configured. A fake executor can only confirm that the adapter sends the SQL
its author expected, which is the one thing already known.

## Shadow runs

`packages/shareflow/scripts/shadow-turn.mjs` drives a real turn against a real ShareFlow database with a real
model and every gated effect suppressed, and writes the result as a `ShadowRun`. Before it, the recorder, the
diff, the gates and the report all existed and nothing could produce a run.

Two things about what it measures. First, a workflow is not one turn: asked once for a post, the assistant
proposes angles and asks which to use, so a run has to be driven to its end before it is comparable. Second,
suppression covers external and destructive effects and not internal ones — a shadow run really does create
drafts, and it measures everything up to the external write and nothing after it, because what an agent does
after publishing cannot be observed without publishing.

The first real turns found seven defects that neither the compiler nor 52 adapter tests had: an authorization
role with no matching tool entry silently produced an empty catalogue; a required `repairable` field omitted
behind a cast disabled the whole generation repair loop; model-supplied ids and cursors reached SQL casts and
surfaced as `internal`; a draft could be attached to another workspace's campaign, because the foreign key
references the campaign table alone; an optional id field the model would not leave out defeated the workflow
entirely until "none" was made sayable; and the parity report crashed on a run with no old-runtime half.

The lesson generalises past this adapter: **every one arrived as a model argument**, and none of them was
reachable by reading the code. Two of the seven were the same defect twice — an optional scalar the model
fabricated rather than omitted, first an id and then a pagination cursor, each fixed by making the intent
sayable as a union. Where omitting a field carries meaning, the meaning needs a name.

One finding is about shadow mode itself and constrains how parity data may be read. The registry suppresses a
gated effect and returns before the tool executes, so the delegating envelope's read-only preflight is skipped
— and that preflight is what refuses a publish to a draft or account that does not exist. A shadow run can
therefore record a write that a real run would have refused, which in a diff against the old runtime is a
manufactured divergence rather than a difference. The harness labels such writes; fixing the ordering means
the registry trusting every preflight to be read-only, which is a decision in its own right.

A workflow can also be servable without being usable. `publish` has all five of its capabilities, and nothing
among them lists connected accounts — that needs the connector service — so the assistant cannot learn where
to publish and can only guess an account id.

## Migration behavior

- Current Agno workflows remain active until their replacement passes parity gates.
- Old and new systems may run in shadow mode, but shadow execution performs no external writes.
- Workspace rollout uses feature flags and supports rollback.
- Existing publishing, connector and database services are reused behind tools.

## ShareFlow acceptance criteria

- Create-post quality meets the evaluation target before default rollout.
- Publish/schedule has zero unauthorized or duplicate actions.
- Every claim and research citation has provenance.
- User-visible architecture is simpler than the current component/team selector.
- Analytics distinguishes facts from recommendations.

