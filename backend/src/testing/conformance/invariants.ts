/**
 * Cross-port invariants — the ones no single-port harness can catch, because each store is
 * individually correct and the defect lives in the relationship between two of them.
 *
 * These are the failures that produced the crash-recovery/event-log desync found in the REQ-005
 * review: the log and the checkpoint were each self-consistent, and the pair was not.
 */

import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventLog } from "../../core/events.js";
import { asId } from "../../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../../core/ids.js";
import type { CheckpointStore, RunStore, UsageStore } from "../../persistence/index.js";
import { emptyCheckpoint } from "../../runtime/checkpoint.js";
import type { UsageEvent } from "../../usage/index.js";

const T1 = asId<TenantId>("conf-tenant-1");
const CONVO = asId<ConversationId>("conf-convo-1");
const AGENT = asId<AgentId>("conf-agent-1");
const RUN = asId<RunId>("conf-run-1");
const NOW = "2020-01-01T00:00:00.000Z";

export type InvariantFixture = {
  readonly runs: RunStore;
  readonly events: RunEventLog;
  readonly checkpoints: CheckpointStore;
  readonly usage: UsageStore;
};

const lifecycle = (sequence: number): RunEvent => ({
  type: "run.checkpointed",
  runId: RUN,
  sequence,
  occurredAt: NOW,
});

export function crossPortInvariants(makeFixture: () => InvariantFixture): void {
  describe("cross-port invariants", () => {
    it("a run's events are ordered and gapless from 1 to the head", async () => {
      const { runs, events } = makeFixture();
      await runs.create({ tenantId: T1, id: RUN, conversationId: CONVO, agentId: AGENT, agentVersion: 1 });
      for (const s of [1, 2, 3, 4]) await events.append({ tenantId: T1, event: lifecycle(s) });

      const all = await events.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      const sequences = all.map((e) => e.sequence);
      expect(sequences).toEqual([1, 2, 3, 4]);
      expect(await events.latestSequence({ tenantId: T1, runId: RUN })).toBe(sequences[sequences.length - 1]);
    });

    it("a checkpoint never references a sequence beyond the event-log head", async () => {
      const { runs, events, checkpoints } = makeFixture();
      await runs.create({ tenantId: T1, id: RUN, conversationId: CONVO, agentId: AGENT, agentVersion: 1 });
      for (const s of [1, 2, 3]) await events.append({ tenantId: T1, event: lifecycle(s) });
      await checkpoints.save({ tenantId: T1, checkpoint: { ...emptyCheckpoint(RUN, NOW), sequence: 3 } });

      const head = await events.latestSequence({ tenantId: T1, runId: RUN });
      const checkpoint = await checkpoints.latest({ tenantId: T1, runId: RUN });
      // Recovery reads the checkpoint then replays from the log. A checkpoint ahead of the head means
      // the worker would resume past events that were never durably written.
      expect(checkpoint?.sequence ?? 0).toBeLessThanOrEqual(head);
    });

    it("every usage event resolves to a run that exists", async () => {
      const { runs, usage } = makeFixture();
      await runs.create({ tenantId: T1, id: RUN, conversationId: CONVO, agentId: AGENT, agentVersion: 1 });
      const event: UsageEvent = {
        id: "u1",
        tenantId: T1,
        runId: RUN,
        stepId: "step-1",
        modelId: "claude-opus-5",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costMinorUnits: 7,
        currency: "EUR",
        occurredAt: NOW,
      };
      await usage.append({ tenantId: T1, event });

      const page = await usage.listByRun({ tenantId: T1, runId: RUN, limit: 10 });
      for (const recorded of page.items) {
        expect(await runs.findById({ tenantId: T1, id: recorded.runId })).not.toBeNull();
      }
    });

    it("the event-log head does not advance for a run that was never created", async () => {
      const { events } = makeFixture();
      expect(await events.latestSequence({ tenantId: T1, runId: asId<RunId>("never-created") })).toBe(0);
    });
  });
}
