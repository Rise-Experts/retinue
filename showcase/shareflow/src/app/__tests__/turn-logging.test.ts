import { describe, expect, it, vi } from "vitest";

import { withTurnLogging } from "../turn-logging.js";

/**
 * A turn narrates itself — #467.
 *
 * Measured before this existed: a real production turn ran 5.3 seconds, chose a provider, called no
 * tools, streamed an answer and spent 8,296 input tokens, and the entire record in `docker logs` was
 * one line — which was only there because it had been added an hour earlier for something else. A turn
 * that *failed* logged nothing at all, which is what made "did a turn even happen?" unanswerable while
 * debugging the BYO wire.
 */

const log = () => {
  const lines: string[] = [];
  return { lines, write: (message: string) => lines.push(message), all: () => lines.join("\n") };
};

const appended: Array<unknown> = [];
const sink = () => {
  appended.length = 0;
  return {
    append: async (input: { event: unknown }) => {
      appended.push(input.event);
    },
    listAfter: async () => [],
    latestSequence: async () => 0,
  };
};

const TENANT = "2db71d16-4fad-4ef7-a41a-eee95b65fc4a";
const RUN = "ca3ac1a6-d531-40e4-ac7d-696b31704e37";

const send = async (wrapped: { append: (i: { tenantId: unknown; event: unknown }) => Promise<void> }, events: unknown[]) => {
  for (const event of events) await wrapped.append({ tenantId: TENANT, event });
};

describe("turn logging", () => {
  it("still persists every event — logging must never cost a run its history", async () => {
    /**
     * The decorator's first duty is to be invisible. `run_events` is what a run is replayed and
     * streamed from, so an event lost here would be a turn that cannot be resumed.
     */
    const inner = sink();
    const out = log();
    const wrapped = withTurnLogging(inner, out.write);
    const events = [
      { type: "run.started", runId: RUN },
      { type: "part.added", runId: RUN, text: "hello" },
      { type: "run.completed", runId: RUN },
    ];
    await send(wrapped, events);
    expect(appended).toEqual(events);
  });

  it("reports a turn's start, its tools and how long it took", async () => {
    const out = log();
    const wrapped = withTurnLogging(sink(), out.write);
    await send(wrapped, [
      { type: "run.started", runId: RUN },
      { type: "tool.started", runId: RUN, toolName: "read_pdf" },
      { type: "tool.started", runId: RUN, toolName: "create_post_draft" },
      { type: "part.added", runId: RUN, text: "here is a draft" },
      { type: "run.completed", runId: RUN },
    ]);
    const all = out.all();
    expect(all).toMatch(/started for workspace 2db71d16/);
    expect(all).toMatch(/tool read_pdf/);
    expect(all).toMatch(/completed in \d+ms/);
    // What the turn did, on the completion line, so one line answers "was that turn useful?"
    expect(all).toMatch(/1 part\(s\)/);
    expect(all).toMatch(/tools: read_pdf, create_post_draft/);
  });

  it("never writes message text or tool arguments to the log", async () => {
    /**
     * The rule this file exists to hold. `part.added` carries what a customer wrote and what the
     * assistant answered; tool arguments carry captions, briefs and URLs. A container log is not a
     * confidential store, and a per-part line would quietly make it one.
     */
    const out = log();
    const wrapped = withTurnLogging(sink(), out.write);
    await send(wrapped, [
      { type: "run.started", runId: RUN },
      { type: "part.added", runId: RUN, text: "CUSTOMER-SECRET-CONTENT" },
      { type: "part.updated", runId: RUN, text: "MORE-SECRET-CONTENT" },
      { type: "tool.started", runId: RUN, toolName: "create_post_draft", arguments: { caption: "SECRET-CAPTION" } },
      { type: "run.completed", runId: RUN },
    ]);
    const all = out.all();
    expect(all).not.toMatch(/SECRET-CONTENT/);
    expect(all).not.toMatch(/SECRET-CAPTION/);
    // ...while still saying a draft tool ran, which is the part a log needs.
    expect(all).toMatch(/create_post_draft/);
  });

  it("puts a failure on console.error with its code and message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wrapped = withTurnLogging(sink(), () => undefined);
    await send(wrapped, [
      { type: "run.started", runId: RUN },
      { type: "run.failed", runId: RUN, error: { code: "provider_unavailable", message: "credits are depleted" } },
    ]);
    const said = error.mock.calls.flat().join(" ");
    expect(said).toMatch(/FAILED after \d+ms/);
    expect(said).toMatch(/provider_unavailable/);
    expect(said).toMatch(/credits are depleted/);
    error.mockRestore();
  });

  it("puts a failing tool on console.warn, named", async () => {
    // The most useful line in the file when somebody reports "it said it could not do that".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wrapped = withTurnLogging(sink(), () => undefined);
    await send(wrapped, [
      { type: "run.started", runId: RUN },
      { type: "tool.failed", runId: RUN, toolName: "publish_post_now", error: { message: "token expired" } },
    ]);
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toMatch(/publish_post_now FAILED/);
    expect(said).toMatch(/token expired/);
    warn.mockRestore();
  });

  it("distinguishes a turn waiting on a person from a stalled one", async () => {
    const out = log();
    const wrapped = withTurnLogging(sink(), out.write);
    await send(wrapped, [
      { type: "run.started", runId: RUN },
      { type: "approval.requested", runId: RUN },
    ]);
    expect(out.all()).toMatch(/waiting for approval/);
  });

  it("reports tokens and cost, and says the model id is what was billed rather than what ran", async () => {
    /**
     * `usage.updated` carries the **deployment's** model id even when the workspace's own provider
     * served the turn, because `ResolvedModelInfo.modelId` is fixed before anyone knows. Measured on
     * production: a turn on `qwen3.8-max` reported `modelId: "gemini-2.5-flash"` with
     * `costMinorUnits: 0`. The counts and the zero are right; the label is not, so the line says
     * "billed-as" rather than implying it ran.
     */
    const out = log();
    const wrapped = withTurnLogging(sink(), out.write);
    await send(wrapped, [
      { type: "usage.updated", runId: RUN, modelId: "gemini-2.5-flash", inputTokens: 8296, outputTokens: 121, costMinorUnits: 0 },
    ]);
    expect(out.all()).toMatch(/8296 in \/ 121 out/);
    expect(out.all()).toMatch(/cost 0/);
    expect(out.all()).toMatch(/billed-as gemini-2\.5-flash/);
  });

  it("does not grow a map for the life of the worker", async () => {
    /**
     * A worker process is long-lived and handles many runs a day. Per-run state that was never
     * released would be a leak measured in runs rather than bytes, and the completion line is the
     * natural place to release it — so this asserts the release actually happens, by showing a second
     * turn with the same id still reports a duration rather than "?".
     */
    const out = log();
    const wrapped = withTurnLogging(sink(), out.write);
    await send(wrapped, [{ type: "run.started", runId: RUN }, { type: "run.completed", runId: RUN }]);
    // Completing again without a start means the state was dropped: no duration is known.
    await send(wrapped, [{ type: "run.completed", runId: RUN }]);
    const lines = out.lines.filter((l) => l.includes("completed"));
    expect(lines[0]).toMatch(/completed in \d+ms/);
    expect(lines[1], "per-run state outlived its run").toMatch(/completed in \?/);
  });
});

/**
 * The composition actually wraps its event log.
 *
 * Removing `withTurnLogging(...)` from `module.ts` left **1303 of 1303 tests passing** — a decorator
 * that was correct, unit-tested, and reached by nobody. That is the third time in this feature's
 * history that proving both halves separately missed the seam between them, and it is why this test
 * builds the real composition and drives the log it actually returns.
 */
describe("the deployment's event log narrates turns", () => {
  it("wraps the run event log it hands back", async () => {
    process.env["RETINUE_MODEL_API_KEY"] ??= "k";
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.resetModules();
    const { shareFlowDeps } = await import("../module.js");
    const deps = (await shareFlowDeps({
      config: { databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" },
      sql: { query: async () => [] },
    } as never)) as unknown as {
      eventLog: { append: (i: { tenantId: unknown; event: unknown }) => Promise<void> };
    };

    expect(deps.eventLog, "the composition returned no event log").toBeDefined();
    await deps.eventLog.append({
      tenantId: "2db71d16-4fad-4ef7-a41a-eee95b65fc4a",
      event: { type: "run.started", runId: "ca3ac1a6-d531-40e4-ac7d-696b31704e37" },
    });

    const said = info.mock.calls.flat().join(" ");
    expect(said, "a turn starting produced no log line — the decorator is not wired").toMatch(
      /\[turn ca3ac1a6\] started for workspace 2db71d16/,
    );
    info.mockRestore();
    vi.resetModules();
  });
});
