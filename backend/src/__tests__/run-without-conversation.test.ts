/**
 * A run that belongs to no conversation — #198.
 *
 * `NewRun.conversationId` was required, so a triggered automation — a webhook, a schedule, a flow step — had to
 * invent a conversation id to exist at all. That is #164's shape: `Run` carried no principal, every host
 * fabricated one, the shipped example used `"example-worker"`, and every per-person figure silently became a
 * machine's. Nothing failed then, and nothing would have failed here — a fabricated conversation id looks
 * exactly like data.
 *
 * These cover the two halves that make the change safe: nothing is invented, and nothing is silently empty.
 */

import { describe, expect, it, vi } from "vitest";
import { asId } from "../core/ids.js";
import { AgentPlatformError } from "../core/errors.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../core/ids.js";
import { createMemoryRunStore } from "../adapters/memory/runtime.js";
import { conversationScoped, startOrEnqueueRun, type Run } from "../runtime/index.js";
import type { ConversationRunCoordinator } from "../persistence/index.js";

const T1 = asId<TenantId>("t1");
const AGENT = asId<AgentId>("a1");
const CONVO = asId<ConversationId>("c1");
const run = (s: string) => asId<RunId>(s);

/** A coordinator that records every call, so "was a slot claimed" is answerable rather than assumed. */
const recordingCoordinator = () => {
  const claims: { conversationId: string; runId: string }[] = [];
  const coordinator: ConversationRunCoordinator = {
    async claimOrEnqueue({ conversationId, runId }) {
      claims.push({ conversationId: String(conversationId), runId: String(runId) });
      return { status: "started", position: 0 };
    },
    async releaseAndPromote() {
      return null;
    },
    async active() {
      return null;
    },
    async depth() {
      return 0;
    },
  };
  return { coordinator, claims };
};

describe("admission without a conversation", () => {
  it("claims no slot, and does not invent a conversation to claim one with", async () => {
    /**
     * The heart of it. A tenant-level slot was the first proposal and it was wrong: it would serialise every
     * automation a tenant owns, so two unrelated webhooks would queue behind each other for no reason. The
     * conversation slot exists because turns in one conversation have an order a person can see; an automation
     * has no such requirement.
     */
    const { coordinator, claims } = recordingCoordinator();
    const status = await startOrEnqueueRun(coordinator, { tenantId: T1, runId: run("r1") });
    expect(status).toBe("started");
    expect(claims).toEqual([]);
  });

  it("still claims the conversation's slot when there is one", async () => {
    // The change must not quietly disable serialisation for chat, which is the property #144's load harness
    // was built to prove.
    const { coordinator, claims } = recordingCoordinator();
    await startOrEnqueueRun(coordinator, { tenantId: T1, conversationId: CONVO, runId: run("r2") });
    expect(claims).toEqual([{ conversationId: "c1", runId: "r2" }]);
  });

  it("still emits run.queued, so admission stays observable", async () => {
    // #170: `run.queued` was in the event union, mapped by the reducer, and emitted by nothing. An automation
    // admitted invisibly would be the same defect with a new shape.
    const { coordinator } = recordingCoordinator();
    // Parameters declared, so `mock.calls` carries the arguments the assertions below read.
    const append = vi.fn(async (_input: unknown) => undefined);
    await startOrEnqueueRun(coordinator, {
      tenantId: T1,
      runId: run("r3"),
      eventLog: { append, listAfter: async () => [], latestSequence: async () => 0 },
      now: () => "2020-01-01T00:00:00.000Z",
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      tenantId: T1,
      event: { type: "run.queued", runId: "r3", sequence: 1 },
    });
  });
});

describe("conversation-scoped access on a run that has none", () => {
  const free = (): Run => ({
    id: run("free"),
    tenantId: T1,
    agentId: AGENT,
    agentVersion: 1,
    status: "running",
    createdAt: "2020-01-01T00:00:00.000Z",
  });

  it("throws, naming the capability that needs a conversation", async () => {
    /**
     * Silently empty is the worse failure, and it is the one that would have happened by default.
     *
     * An automation whose history came back empty looks like a fresh conversation: the model is prompted as if
     * nothing had happened and produces a confident answer built on an absence nobody reported. The same class
     * of defect as a scan returning zero references for a directory it could not read.
     */
    const error = (() => {
      try {
        conversationScoped(free(), "history");
        return null;
      } catch (e) {
        return e as AgentPlatformError;
      }
    })();
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error?.code).toBe("invalid_input");
    // Names the capability asked for, so the caller knows which switch to turn off.
    expect(error?.message).toContain("history");
    expect(error?.message).toContain("free");
    expect(error?.retryable).toBe(false);
  });

  it("returns the conversation when there is one, without ceremony", () => {
    expect(conversationScoped({ ...free(), conversationId: CONVO }, "history")).toBe(CONVO);
  });
});

describe("the store keeps absence absent", () => {
  it("does not write a placeholder conversation id", async () => {
    /**
     * `toBeUndefined` is not enough on its own — an empty string is also falsy in the places that matter, and
     * an empty string is what a NOT NULL column forces a caller to invent. So the key must be missing, which is
     * what makes `"conversationId" in run` a usable question.
     */
    const store = createMemoryRunStore();
    const created = await store.create({ tenantId: T1, id: run("x"), agentId: AGENT, agentVersion: 1 });
    expect("conversationId" in created).toBe(false);
    expect(created.conversationId).toBeUndefined();
  });
});
