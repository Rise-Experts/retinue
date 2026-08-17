import { describe, expect, it } from "vitest";
import { asId } from "../../../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../../../core/ids.js";
import {
  createMemoryConversationBindingStore,
  createMemoryConversationRunCoordinator,
  createMemorySessionStateStore,
  createMemoryUnitOfWork,
} from "../index.js";
import {
  advanceConversation,
  commitTurn,
  resolveAgentVersionForResume,
  startOrEnqueueRun,
  type JobDispatcher,
} from "../../../runtime/index.js";

const T = asId<TenantId>("t1");
const C = asId<ConversationId>("c1");

describe("per-conversation serialization", () => {
  it("runs two queued runs one at a time, in FIFO order", async () => {
    const coord = createMemoryConversationRunCoordinator();
    const dispatched: RunId[] = [];
    const dispatcher: JobDispatcher = {
      async enqueueRun({ runId }) {
        dispatched.push(runId);
      },
    };
    const a = asId<RunId>("A");
    const b = asId<RunId>("B");
    const c = asId<RunId>("C");

    expect(await startOrEnqueueRun(coord, { tenantId: T, conversationId: C, runId: a })).toBe("started");
    // B and C arrive while A is active — they queue, never run concurrently.
    expect(await startOrEnqueueRun(coord, { tenantId: T, conversationId: C, runId: b })).toBe("queued");
    expect(await startOrEnqueueRun(coord, { tenantId: T, conversationId: C, runId: c })).toBe("queued");
    expect(await coord.active({ tenantId: T, conversationId: C })).toBe(a);
    expect(await coord.depth({ tenantId: T, conversationId: C })).toBe(2);

    // A finishes → B promoted; B finishes → C promoted; C finishes → idle.
    expect(await advanceConversation(coord, dispatcher, { tenantId: T, conversationId: C, runId: a })).toBe(b);
    expect(await coord.active({ tenantId: T, conversationId: C })).toBe(b);
    expect(await advanceConversation(coord, dispatcher, { tenantId: T, conversationId: C, runId: b })).toBe(c);
    expect(await advanceConversation(coord, dispatcher, { tenantId: T, conversationId: C, runId: c })).toBeNull();
    expect(await coord.active({ tenantId: T, conversationId: C })).toBeNull();
    expect(dispatched).toEqual([b, c]); // promoted in enqueue order
  });

  it("a second claimant cannot take an active conversation", async () => {
    const coord = createMemoryConversationRunCoordinator();
    expect((await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: asId<RunId>("A") })).status).toBe("started");
    expect((await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: asId<RunId>("B") })).status).toBe("queued");
    // Re-claim by the holder is idempotent.
    expect((await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: asId<RunId>("A") })).status).toBe("started");
  });

  it("release+promote is atomic — a run arriving in the gap cannot double-occupy the slot", async () => {
    const coord = createMemoryConversationRunCoordinator();
    const a = asId<RunId>("A");
    const b = asId<RunId>("B");
    const c = asId<RunId>("C");
    await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: a });
    await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: b }); // queued behind A
    // A terminates → B is promoted atomically and becomes active.
    expect(await coord.releaseAndPromote({ tenantId: T, conversationId: C, runId: a })).toBe(b);
    expect(await coord.active({ tenantId: T, conversationId: C })).toBe(b);
    // A third run arriving now sees B active and must queue — it cannot run concurrently.
    expect((await coord.claimOrEnqueue({ tenantId: T, conversationId: C, runId: c })).status).toBe("queued");
  });
});

describe("session state — optimistic concurrency & bounds", () => {
  it("rejects a stale write so concurrent writers cannot clobber each other", async () => {
    const store = createMemorySessionStateStore({ clock: () => "t" });
    const v1 = await store.put({ tenantId: T, conversationId: C, expectedVersion: 0, data: { step: 1 } });
    expect(v1.version).toBe(1);
    // Two readers both saw v1; both try to write v2 — only the first wins.
    const v2 = await store.put({ tenantId: T, conversationId: C, expectedVersion: 1, data: { step: 2 } });
    expect(v2.version).toBe(2);
    await expect(
      store.put({ tenantId: T, conversationId: C, expectedVersion: 1, data: { step: 99 } }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces the size ceiling instead of silently truncating", async () => {
    const store = createMemorySessionStateStore({ maxBytes: 64 });
    await expect(
      store.put({ tenantId: T, conversationId: C, expectedVersion: 0, data: { blob: "x".repeat(200) } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("bound-agent resume", () => {
  it("a pinned thread resumes its recorded version even when a newer one exists", async () => {
    const bindings = createMemoryConversationBindingStore();
    await bindings.bind({ tenantId: T, conversationId: C, agentId: asId("agent-1"), agentVersionPolicy: "pinned", agentVersion: 3 });
    const binding = await bindings.get({ tenantId: T, conversationId: C });
    expect(resolveAgentVersionForResume(binding!, 7)).toBe(3);
  });

  it("a latest-policy thread tracks the newest version", async () => {
    const bindings = createMemoryConversationBindingStore();
    await bindings.bind({ tenantId: T, conversationId: C, agentId: asId("agent-1"), agentVersionPolicy: "latest" });
    const binding = await bindings.get({ tenantId: T, conversationId: C });
    expect(resolveAgentVersionForResume(binding!, 7)).toBe(7);
  });
});

describe("atomic turn commit", () => {
  it("commits session-state and message writes together", async () => {
    const uow = createMemoryUnitOfWork();
    const db = { sessionState: 0, messages: [] as string[] };
    await commitTurn(uow, [
      { do: async () => (db.sessionState = 2) },
      { do: async () => db.messages.push("assistant reply") },
    ]);
    expect(db).toEqual({ sessionState: 2, messages: ["assistant reply"] });
  });

  it("rolls back the session-state write when finalizing the run fails", async () => {
    const uow = createMemoryUnitOfWork();
    const db = { sessionState: 1, messages: ["prior"] as string[] };
    await expect(
      commitTurn(uow, [
        {
          do: async () => {
            const prior = db.sessionState;
            db.sessionState = 2;
            return prior;
          },
          undo: (prior) => {
            db.sessionState = prior as number;
          },
        },
        {
          do: async () => {
            throw new Error("run finalize failed");
          },
        },
      ]),
    ).rejects.toThrow("run finalize failed");
    // The state write was compensated — the turn is all-or-nothing.
    expect(db.sessionState).toBe(1);
    expect(db.messages).toEqual(["prior"]);
  });
});
