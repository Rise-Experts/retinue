/**
 * Admitting a turn — the order is the guarantee.
 *
 * `claimOrEnqueue` coordinates the conversation's **slot**; it does not create the run. Calling only
 * that returns `started` and executes nothing, because the worker claims a job whose row does not
 * exist — a job enqueued before its row exists is a job pointing at nothing. `server.ts`'s own header
 * records the reference application making exactly this mistake.
 *
 * So these tests are about sequence, and about the one branch that must not fire.
 */
import { describe, expect, it } from "vitest";

import { createStartTurn } from "../turns.js";

const context = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;

const deps = (slot: "started" | "queued" = "started", existing: unknown = null) => {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const enqueued: unknown[] = [];
  return {
    calls,
    created,
    enqueued,
    turnDeps: {
      conversations: {
        async findById() {
          calls.push("conversations.findById");
          return existing;
        },
        async create(input: Record<string, unknown>) {
          calls.push("conversations.create");
          created.push(input);
          return input;
        },
      },
      messages: {
        async append(input: Record<string, unknown>) {
          calls.push("messages.append");
          created.push(input);
          return input;
        },
      },
      runs: {
        async create(input: Record<string, unknown>) {
          calls.push("runs.create");
          created.push(input);
          return input;
        },
      },
      coordinator: {
        async claimOrEnqueue() {
          calls.push("coordinator.claimOrEnqueue");
          return { status: slot, position: slot === "queued" ? 1 : 0 };
        },
      },
      dispatcher: {
        async enqueueRun(input: unknown) {
          calls.push("dispatcher.enqueueRun");
          enqueued.push(input);
          return undefined;
        },
      },
      limits: { maxToolCalls: 18 },
      agentId: "social-assistant",
      agentVersion: 1,
    } as never,
  };
};

describe("startTurn", () => {
  it("writes the run row before asking for the slot, and dispatches last", async () => {
    /**
     * The whole sequence, asserted as a sequence. Any other order is a run the worker cannot find, or a
     * job for a row that does not exist yet.
     */
    const { turnDeps, calls } = deps();
    await createStartTurn(turnDeps)({ context, message: "hello" });
    expect(calls).toEqual([
      "conversations.findById",
      "conversations.create",
      "messages.append",
      "runs.create",
      "coordinator.claimOrEnqueue",
      "dispatcher.enqueueRun",
    ]);
  });

  it("does not dispatch a queued run", async () => {
    /**
     * The coordinator promotes it when the active run finishes. Dispatching here as well would put two
     * runs on one conversation — the thing the slot exists to prevent — and the second would interleave
     * its parts into the same transcript.
     */
    const { turnDeps, calls, enqueued } = deps("queued");
    const result = await createStartTurn(turnDeps)({ context, message: "hello" });
    expect(result.started).toBe("queued");
    expect(enqueued).toEqual([]);
    expect(calls).not.toContain("dispatcher.enqueueRun");
  });

  it("reuses an existing conversation rather than creating a second", async () => {
    const { turnDeps, calls } = deps("started", { id: "c1" });
    await createStartTurn(turnDeps)({ context, message: "hello", conversationId: "c1" });
    expect(calls).not.toContain("conversations.create");
  });

  it("accepts a client-chosen conversation id", async () => {
    // What lets a client open a thread without a round trip whose only purpose is to learn an id it
    // already picked.
    const { turnDeps } = deps();
    const result = await createStartTurn(turnDeps)({ context, message: "hi", conversationId: "chosen-1" });
    expect(result.conversationId).toBe("chosen-1");
  });

  it("records the principal and roles from the context, not a substitute", async () => {
    /**
     * The run row is where the worker gets its identity back — `buildWorkerContext` reads exactly these
     * and refuses a run without them. A run created without a principal is a run that can never
     * execute, and it fails in the worker rather than here.
     */
    const { turnDeps, created } = deps();
    await createStartTurn(turnDeps)({ context, message: "hello" });
    const run = created.find((row) => row["agentId"] !== undefined);
    expect(run?.["principalId"]).toBe("p1");
    expect(run?.["roleIds"]).toEqual(["editor"]);
  });

  it("records the message as the run's input, so a replay is not an empty turn", async () => {
    const { turnDeps, created } = deps();
    await createStartTurn(turnDeps)({ context, message: "what can you do?" });
    const run = created.find((row) => row["agentId"] !== undefined);
    expect(run?.["input"]).toEqual({ message: "what can you do?" });
  });

  it("titles a new conversation from the message, and never leaves it blank", async () => {
    // The session list shows a title; an untitled thread reads as broken in it.
    const { turnDeps, created } = deps();
    await createStartTurn(turnDeps)({ context, message: "   " });
    expect(created[0]?.["title"]).toBe("New conversation");

    const named = deps();
    await createStartTurn(named.turnDeps)({ context, message: "Draft a post about oat milk" });
    expect(named.created[0]?.["title"]).toBe("Draft a post about oat milk");
  });

  it("returns ids the client can act on", async () => {
    const { turnDeps } = deps();
    const result = await createStartTurn(turnDeps)({ context, message: "hello" });
    for (const key of ["conversationId", "runId", "messageId"]) {
      expect(String((result as unknown as Record<string, string>)[key]), key).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
