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

Three of the ten services declared in `packages/shareflow/src/services/` now have adapters in that package:
`content` and `brand` over ShareFlow's own tables, and `generator` over the host's model. They are the set
`create-post` needs, which makes them the smallest set that lets shadow capture produce real parity data.

The seven remaining — connectors, media, publishing, engagement, leads, research and analytics — are ports
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

