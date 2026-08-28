/**
 * The Connect button's state — REQ-063 (#259), task #264, AC-9.
 *
 * Folded by the reducer rather than derived per client, so a reconnecting client sees the button exactly when
 * the run is actually waiting: the durable log replays both events in order, and the fold gives the same answer
 * as if it had been watching live.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_RUN_VIEW, applyRunEvent, projectRunEvents } from "../reducers.js";
import type { RunEvent } from "@retinue/agentkit";

const event = (over: Partial<RunEvent> & { type: RunEvent["type"] }, sequence: number): RunEvent =>
  ({ runId: "r1", sequence, occurredAt: "2026-08-28T00:00:00.000Z", ...over }) as RunEvent;

const requested = (sequence: number, expiresAt = "2999-01-01T00:00:00.000Z") =>
  event(
    {
      type: "connection.requested",
      provider: "github",
      loginUrl: "https://app.example.com/oauth/github/start?state=abc",
      scopes: ["repo"],
      toolName: "github_list_issues",
      expiresAt,
    } as never,
    sequence,
  );

describe("the run enters and leaves the third pause", () => {
  it("holds the request and reports the status", () => {
    const view = applyRunEvent(EMPTY_RUN_VIEW, requested(1));
    expect(view.status).toBe("waiting-for-connection");
    expect(view.connectionRequest).toMatchObject({ provider: "github", scopes: ["repo"] });
  });

  it("clears it when consent completes, and the run is running again", () => {
    const view = projectRunEvents([
      requested(1),
      event({ type: "connection.completed", provider: "github", connectionId: "c1" } as never, 2),
    ]);
    expect(view.connectionRequest).toBeUndefined();
    expect(view.status).toBe("running");
  });

  it("clears it on every terminal event, so a finished run never shows a dead link", () => {
    for (const [type, extra] of [
      ["run.completed", {}],
      ["run.cancelled", {}],
      ["run.failed", { error: { code: "internal", message: "x", retryable: false } }],
    ] as const) {
      const view = projectRunEvents([requested(1), event({ type, ...extra } as never, 2)]);
      expect(view.connectionRequest, type).toBeUndefined();
    }
  });

  it("gives a reconnecting client the same answer as one that watched live", () => {
    // The whole reason this is folded rather than derived: a client that reconnects mid-consent replays the log
    // and must land in the same state.
    const live = applyRunEvent(applyRunEvent(EMPTY_RUN_VIEW, event({ type: "run.started" } as never, 1)), requested(2));
    const replayed = projectRunEvents([event({ type: "run.started" } as never, 1), requested(2)]);
    expect(replayed.connectionRequest).toEqual(live.connectionRequest);
    expect(replayed.status).toBe(live.status);
  });

  it("does not resurrect a request from an out-of-order replay", () => {
    // The projector drops anything at or below its cursor, so a duplicated delivery cannot re-open a pause the
    // completion already closed.
    const view = projectRunEvents([
      requested(1),
      event({ type: "connection.completed", provider: "github", connectionId: "c1" } as never, 2),
      requested(1),
    ]);
    expect(view.connectionRequest).toBeUndefined();
  });
});
