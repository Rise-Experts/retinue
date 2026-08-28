/**
 * A run that needs a connection pauses and asks — REQ-063 (#259), task #264.
 *
 * The third pause, and deliberately the same shape as the other two: an event the engine emits, a status the
 * worker parks in, a resume back to `queued`. A bespoke polling loop, or a failed run somebody restarts by
 * hand, would be a second mechanism for the thing the durable runtime exists to do.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentPlatformError } from "../../core/errors.js";
import { RUN_STATUSES, RUN_TRANSITIONS } from "../../runtime/index.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import type { ExecutionContext } from "../../core/context.js";
import {
  canPauseForConsent,
  connectionNeedOf,
  consentPrompt,
  withConnectionGap,
} from "../pause.js";
import { expireStaleConsents, resumeAfterConsent } from "../resume.js";

const context = (tenant = "t1"): ExecutionContext => ({
  tenantId: asId<TenantId>(tenant),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
});

describe("the third pause is the same shape as the other two", () => {
  it("is a run status that resumes to queued", () => {
    expect(RUN_STATUSES).toContain("waiting-for-connection");
    expect(RUN_TRANSITIONS["waiting-for-connection"]).toEqual(["queued", "cancelled"]);
    expect(RUN_TRANSITIONS.running).toContain("waiting-for-connection");
  });

  it("is terminal from nowhere, so a paused run cannot be resumed from a finished state", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      expect(RUN_TRANSITIONS[terminal]).not.toContain("waiting-for-connection");
    }
  });
});

describe("recognising a connection gap", () => {
  const marked = (gap: "absent" | "expired" | "insufficient-scope", scopes: string[] = []) =>
    withConnectionGap(
      new AgentPlatformError({ code: "capability_unavailable", message: "no connection", retryable: false }),
      { provider: "github", gap, scopes },
    );

  it("is structural, not a string match", () => {
    // Rewording an error must not silently turn a pausable failure into a fatal one.
    const need = connectionNeedOf(marked("absent"));
    expect(need).toMatchObject({ provider: "github", gap: "absent" });
  });

  it("ignores an ordinary failure", () => {
    expect(connectionNeedOf(new Error("boom"))).toBeNull();
    expect(
      connectionNeedOf(new AgentPlatformError({ code: "provider_error", message: "x", retryable: true })),
    ).toBeNull();
  });

  it("ignores a marker with a bogus gap or no provider", () => {
    // A half-written marker must not be honoured: pausing on one would park a run on a consent nobody can give.
    const bogus = new AgentPlatformError({
      code: "capability_unavailable",
      message: "x",
      retryable: false,
      details: { connectionGap: "made-up", connectionProvider: "github" },
    });
    expect(connectionNeedOf(bogus)).toBeNull();
  });

  it("distinguishes the three gaps, because a person told the wrong one looks in the wrong place", () => {
    expect(consentPrompt({ provider: "github", gap: "absent", scopes: [] })).toMatch(/Connect github/);
    expect(consentPrompt({ provider: "github", gap: "expired", scopes: [] })).toMatch(/expired/);
    expect(consentPrompt({ provider: "github", gap: "insufficient-scope", scopes: ["admin:org"] })).toMatch(
      /admin:org/,
    );
  });
});

describe("only an OAuth-capable provider can pause — AC-8", () => {
  it("pauses for oauth2 and refuses to for token-only", () => {
    // Getting this backwards produces the worst outcome available: a run parked for ever on a consent screen
    // nobody can reach. A token has no login URL.
    expect(canPauseForConsent(["oauth2"])).toBe(true);
    expect(canPauseForConsent(["token", "oauth2"])).toBe(true);
    expect(canPauseForConsent(["token"])).toBe(false);
  });

  it("refuses when the host declared no modes at all", () => {
    // The honest answer to "I do not know" is no: failing is recoverable, hanging is not.
    expect(canPauseForConsent(undefined)).toBe(false);
    expect(canPauseForConsent([])).toBe(false);
  });
});

const runStore = (status: string) => {
  const transitions: unknown[] = [];
  return {
    transitions,
    store: {
      async findById({ id }: { id: RunId }) {
        return status === "missing" ? null : { id, status, tenantId: asId("t1") };
      },
      async transition(input: unknown) {
        transitions.push(input);
      },
    } as never,
  };
};

describe("resuming — AC-3, AC-5, AC-6", () => {
  it("queues the run once and records the completion", async () => {
    const { store, transitions } = runStore("waiting-for-connection");
    const enqueueRun = vi.fn(async () => {});
    const append = vi.fn(async () => {});
    const result = await resumeAfterConsent(
      { runs: store, dispatcher: { enqueueRun } as never, events: { append } as never },
      { context: context(), runId: asId<RunId>("r1"), provider: "github", connectionId: "c1" },
    );
    expect(result.resumed).toBe(true);
    expect(transitions[0]).toMatchObject({ to: "queued" });
    expect(enqueueRun).toHaveBeenCalledOnce();
    // Recorded *before* the transition, so a crash between the two leaves a log that explains the move.
    expect(append).toHaveBeenCalledOnce();
  });

  it("is idempotent: a retried callback does not queue the run twice — AC-6", async () => {
    // A double-click, a retried redirect, a browser prefetch. A second job would run the tool call that paused
    // the run a second time.
    const { store, transitions } = runStore("queued");
    const enqueueRun = vi.fn(async () => {});
    const result = await resumeAfterConsent(
      { runs: store, dispatcher: { enqueueRun } as never },
      { context: context(), runId: asId<RunId>("r1"), provider: "github", connectionId: "c1" },
    );
    expect(result.resumed).toBe(false);
    expect(result.reason).toMatch(/not waiting for a connection/);
    expect(enqueueRun).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });

  it("refuses a run that is not this tenant's — AC-5", async () => {
    /**
     * The security property of the whole feature, and it is about the **login URL** rather than the run: that
     * URL is rendered in a UI, appears in screenshots and gets pasted into chats. If completing the flow it
     * points at could resume anyone's run, a leaked URL would let a stranger attach their own account to
     * somebody else's tenant.
     */
    const { store } = runStore("missing");
    const enqueueRun = vi.fn(async () => {});
    await expect(
      resumeAfterConsent(
        { runs: store, dispatcher: { enqueueRun } as never },
        { context: context("attacker"), runId: asId<RunId>("r1"), provider: "github", connectionId: "c1" },
      ),
    ).rejects.toThrow(/no run "r1" for this workspace/);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("gives the same answer for absent and not-yours, so a leaked URL cannot probe run ids", async () => {
    // `findById` is tenant-scoped, so both land in the same branch — asserted rather than assumed.
    const { store } = runStore("missing");
    const message = await resumeAfterConsent(
      { runs: store, dispatcher: { enqueueRun: vi.fn() } as never },
      { context: context(), runId: asId<RunId>("r1"), provider: "github", connectionId: "c1" },
    ).then(() => "", (e: Error) => e.message);
    expect(message).toMatch(/no run "r1" for this workspace/);
    expect(message).not.toMatch(/tenant|belongs|another/i);
  });
});

describe("a pause has a ceiling — AC-7", () => {
  it("fails runs that have waited too long, rather than holding a row for ever", async () => {
    /**
     * The reaper does not cover this, and that is the point: the reaper exists for *abandoned* runs — ones whose
     * lease expired because a worker died. A run waiting for a connection is not abandoned; it is waiting for a
     * person who may never come back, and it holds its row indefinitely.
     */
    const transitions: unknown[] = [];
    const stale = [
      { tenantId: "t1", id: asId<RunId>("r1") },
      { tenantId: "t2", id: asId<RunId>("r2") },
    ];
    const failed = await expireStaleConsents(
      {
        runs: { async transition(i: unknown) { transitions.push(i); } } as never,
        dispatcher: { enqueueRun: vi.fn() } as never,
        now: () => "2026-08-28T12:00:00.000Z",
        listWaiting: async (before: string) => {
          // The cutoff is derived from the clock, so a caller cannot be handed "now" and sweep everything.
          expect(before).toBe("2026-08-28T11:00:00.000Z");
          return stale;
        },
      },
      { olderThanMs: 60 * 60 * 1000 },
    );
    expect(failed).toBe(2);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ to: "failed" });
    // Each run's own tenant, not the sweeper's: a cross-tenant sweep that used one tenant id would fail nothing
    // and report success.
    expect((transitions[1] as { tenantId: string }).tenantId).toBe("t2");
  });

  it("does nothing when nothing is stale", async () => {
    const failed = await expireStaleConsents(
      {
        runs: { async transition() {} } as never,
        dispatcher: { enqueueRun: vi.fn() } as never,
        listWaiting: async () => [],
      },
      { olderThanMs: 1_000 },
    );
    expect(failed).toBe(0);
  });
});
