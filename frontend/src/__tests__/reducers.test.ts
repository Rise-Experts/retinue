import { describe, expect, it } from "vitest";
import type { RunEvent, TextPart } from "../types/index.js";
import { applyRunEvent, createRunProjector, EMPTY_RUN_VIEW, projectRunEvents } from "../reducers.js";

const RUN = "run1";
const part = (id: string, text: string): TextPart => ({ id, type: "text", schemaVersion: 1, createdAt: "t", text } as TextPart);
const ev = (sequence: number, extra: Partial<RunEvent> & { type: RunEvent["type"] }): RunEvent =>
  ({ runId: RUN, sequence, occurredAt: `t${sequence}`, ...extra }) as RunEvent;
const partAdded = (seq: number, id: string, text: string) => ev(seq, { type: "part.added", messageId: "m1", part: part(id, text) } as never);

describe("run view reducer", () => {
  it("accumulates parts and tracks status through to completion", () => {
    const view = projectRunEvents([
      ev(1, { type: "run.started" }),
      partAdded(2, "p1", "hello"),
      partAdded(3, "p2", "world"),
      ev(4, { type: "run.completed" }),
    ]);
    expect(view.parts.map((p) => (p as TextPart).text)).toEqual(["hello", "world"]);
    expect(view.status).toBe("completed");
    expect(view.done).toBe(true);
    expect(view.lastSequence).toBe(4);
  });

  it("shows a retry indicator between attempts and clears it on progress", () => {
    const err = { code: "rate_limited" as const, message: "429", retryable: true };
    const retrying = projectRunEvents([
      ev(1, { type: "run.started" }),
      ev(2, { type: "run.retry-pending", attempt: 2, maxAttempts: 5, nextAttemptAt: "t9", error: err } as never),
    ]);
    expect(retrying.status).toBe("retry-pending");
    expect(retrying.retry).toMatchObject({ attempt: 2, maxAttempts: 5, reason: { code: "rate_limited" } });
    const resumed = applyRunEvent(retrying, partAdded(3, "p1", "back"));
    expect(resumed.retry).toBeUndefined();
    expect(resumed.status).toBe("running");
  });

  it("surfaces the failure error", () => {
    const view = projectRunEvents([
      ev(1, { type: "run.started" }),
      ev(2, { type: "run.failed", error: { code: "provider_error", message: "boom", retryable: false } } as never),
    ]);
    expect(view.status).toBe("failed");
    expect(view.error).toMatchObject({ code: "provider_error" });
  });

  it("maps waiting-for-question", () => {
    const view = projectRunEvents([ev(1, { type: "question.requested", interactionId: "i1" } as never)]);
    expect(view.status).toBe("waiting-for-question");
  });
});

describe("run projector — reconnect safety via the buffer", () => {
  it("orders out-of-order events and drops duplicates", () => {
    const projector = createRunProjector(0);
    projector.push(partAdded(2, "p2", "second")); // arrives first — held on the gap
    expect(projector.view().parts).toHaveLength(0);
    projector.push(partAdded(1, "p1", "first")); // fills the gap → both release in order
    expect(projector.view().parts.map((p) => (p as TextPart).text)).toEqual(["first", "second"]);
    projector.push(partAdded(2, "p2", "dup")); // duplicate — ignored
    expect(projector.view().parts).toHaveLength(2);
  });

  it("resumes from a cursor without replaying earlier parts", () => {
    const projector = createRunProjector(5); // reconnect after sequence 5
    projector.push(partAdded(3, "old", "stale")); // <= cursor → ignored
    projector.push(partAdded(6, "new", "fresh"));
    expect(projector.view().parts.map((p) => (p as TextPart).text)).toEqual(["fresh"]);
    expect(projector.cursor()).toBe(6);
  });

  it("starts from the empty view", () => {
    expect(createRunProjector(0).view()).toEqual({ ...EMPTY_RUN_VIEW, lastSequence: 0 });
  });
});
