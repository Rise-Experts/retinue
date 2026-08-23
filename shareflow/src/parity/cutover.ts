/**
 * The cutover runbook — #128 AC-3.
 *
 * Beside the code for the same reason as `ROLLBACK_PROCEDURE`: a runbook in a wiki goes stale silently, and
 * the one moment it is read is the one moment nobody checks whether it is current.
 *
 * **The decision-maker is unnamed**, and that is not an omission I can fix. AC-3 requires the runbook to
 * *"name the decision-maker"*, and I do not know who that is — writing a plausible role in would be worse
 * than the blank, because a blank gets filled and a plausible guess gets followed.
 */

/** Filled in when a person is named. Until then, `canRemoveOldRuntime` blocks on it. */
export const CUTOVER_DECISION_MAKER: string | null = null;

export const CUTOVER_RUNBOOK = `# Cutting ShareFlow over to the new runtime

## Before anything

- [ ] Every parity gate in \`parity/gates.ts\` is \`agreed\`, by a named person, **with a date before the
      first shadow run**. A threshold agreed after the numbers are visible is not a gate.
- [ ] The historical-data question in \`DATA_DISPOSITION\` is answered in writing.
- [ ] The decision-maker below is named.
- [ ] The rollback procedure has been rehearsed against staging, and the measured time-to-effect written
      down. It is not the cache bound — see \`ROLLBACK_PROCEDURE\`.

**Decision-maker:** _not yet named_ — this runbook cannot be executed until it is.

## Order of workflows

Least reversible last. The order is the whole safety property:

1. **analytics**, **engagement-read** — read-only. Nothing they do can be wrong in a way a customer sees
   permanently. Also the two whose parity shadow data cannot decide, so they go first *and* carry the least
   evidence, which is only acceptable because they cannot cause damage.
2. **create-post**, **campaign-planning**, **repurpose** — internal writes. A wrong draft is visible and
   deletable; a human reviews it before it goes anywhere.
3. **engagement-reply** — public and irreversible, but one reply at a time.
4. **publish** — public, irreversible, and fans out. Last, always.

Never run step 4 for a workspace whose step 2 has not been stable for a full posting cycle. A campaign is
the case that matters: its drafts are created days before they publish, so a create-post regression only
becomes visible at publish time.

## Per-workspace sequence

1. Pick a workspace that posts often enough to produce signal within days, and whose brand can absorb a
   visible mistake. Ask them.
2. Shadow mode on for that workspace, new runtime suppressed (\`context.shadow = true\`). No external write
   happens. Let it accumulate to the gate's sample size.
3. Generate the parity report. If any measurable gate fails, stop — the point of shadow is that stopping
   here costs nothing.
4. Flag the workflow live for that workspace: \`controller.set({ tenantId, workflow, runtime: "agentkit" })\`.
5. Watch. Then the next workflow, then the next workspace.

## What to watch, and for how long

For at least one full posting cycle per workspace — a week for most, longer for a workspace on a weekly
cadence:

- **Approval-bearing writes per run**, against the old runtime's rate. The number that matters, and the one
  \`wouldPublishMoreThanBefore\` exists to surface without anyone counting.
- **\`unconfirmed\` publish outcomes.** A rise means the new runtime is reaching platforms differently, and
  \`awaiting-platform\` is normal for video, so compare like with like.
- **\`captionStoredInFull: false\`.** A truncated caption is a fragment published as a post.
- **\`droppedMedia\`.** A post announced with an attachment it does not have.
- **\`suppressed\` results after cutover.** These should be zero once live. A non-zero count means a
  workspace is still flagged shadow while someone believes it is live — silently doing nothing.
- **Support contacts mentioning the assistant.** The regression that matters will be reported by a customer
  before it is measured.

## When to roll back

Immediately, without discussion, on any of:

- a duplicate publish
- a publish to a destination the user did not name
- a forbidden claim reaching a platform
- a reply sent to the wrong comment

These are the four that cannot be undone by rolling back — the rollback stops the next one. Use
\`mode: "abandon-in-flight"\` and tell the affected users; a stopped run that looks slow is one they retry.

Roll back at the end of the day, with discussion, on: a rise in unconfirmed outcomes, a rise in validation
failures, or anything a customer noticed.

## Removing the old runtime

**Not part of cutover.** A separate, reviewed change, after every workspace is live and stable, and only
when \`canRemoveOldRuntime\` returns \`allowed: true\`.

It is 71 files across \`social_integgration\` — \`web/src\` and the whole of \`ai_backend\` — and it is in a
different repository from this one. Sequence it by the hotspots in \`OLD_RUNTIME_REFERENCE_SCOPE\`, and make
it a change that deletes and does nothing else: a removal PR that also fixes something is a removal PR
nobody can review.

Keep the ability to roll back until the deletion lands. That is the point of doing it last: until then, the
old path is still there.
`;
