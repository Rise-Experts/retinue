import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../../core/ids.js";
import { createMemoryRunEventLog } from "../../adapters/memory/index.js";
import { createMemoryEventBus } from "../../runtime/index.js";
import type { RunEvent } from "../../core/events.js";
import { cursorFromLastEventId, openRunEventSse, toSseFrame } from "../sse.js";

const T = asId<TenantId>("t1");
const RUN = asId<RunId>("run1");
const ev = (sequence: number, type: RunEvent["type"]): RunEvent => ({ type, runId: RUN, sequence, occurredAt: `t${sequence}` } as RunEvent);

describe("sse encoding", () => {
  it("encodes an event with id/event/data lines", () => {
    const frame = toSseFrame(ev(3, "part.added"));
    expect(frame).toContain("id: 3\n");
    expect(frame).toContain("event: part.added\n");
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("maps Last-Event-ID to a resume cursor", () => {
    expect(cursorFromLastEventId("5")).toBe(5);
    expect(cursorFromLastEventId(null)).toBe(0);
    expect(cursorFromLastEventId("garbage")).toBe(0);
  });

  it("streams resumable SSE frames from the durable log", async () => {
    const log = createMemoryRunEventLog();
    const bus = createMemoryEventBus();
    await log.append({ tenantId: T, event: ev(1, "run.started") });
    await log.append({ tenantId: T, event: ev(2, "run.completed") });
    const frames: string[] = [];
    for await (const f of openRunEventSse({ tenantId: T, runId: RUN, conversationId: asId<ConversationId>("c1"), after: 0, log, live: bus.live })) {
      frames.push(f);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("event: run.started");
    expect(frames[1]).toContain("event: run.completed");
  });
});
