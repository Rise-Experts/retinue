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

