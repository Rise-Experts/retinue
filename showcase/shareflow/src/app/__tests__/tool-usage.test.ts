import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionContext } from "@retinue/agentkit";
import { TOOL_STEP_PREFIX, toolUsageRecorder } from "../tool-usage.js";

/** A tool's own model calls on the usage ledger — #499 AC-1. */
const here = dirname(fileURLToPath(import.meta.url));
const inRun = { tenantId: "ws-1", principalId: "u-1", runId: "run-1", conversationId: "conv-1" } as unknown as ExecutionContext;

const recorderInto = (rows: unknown[]) =>
  toolUsageRecorder({
    store: { async append(input: unknown) { rows.push(input); } } as never,
    env: {},
    now: () => "2026-09-27T12:00:00.000Z",
    id: () => "id-1",
  });

describe("toolUsageRecorder", () => {
  it("records the tokens against the run and conversation, with a step id the meter can tell apart", async () => {
    const rows: { event: Record<string, unknown> }[] = [];
    await recorderInto(rows)(inRun, { modelId: "gemini-2.5-flash", inputTokens: 1_000, outputTokens: 200, ranOnWorkspaceModel: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      runId: "run-1",
      conversationId: "conv-1",
      principalId: "u-1",
      stepId: `${TOOL_STEP_PREFIX}id-1`,
      modelId: "gemini-2.5-flash",
      inputTokens: 1_000,
      outputTokens: 200,
      currency: "USD",
    });
    // Priced like the turn's own steps, so the 30-day spend includes post drafting.
    expect(rows[0]!.event["costMinorUnits"]).toBeGreaterThanOrEqual(0);
  });

  it("costs the platform nothing when the workspace's own key ran it", async () => {
    const rows: { event: Record<string, unknown> }[] = [];
    await recorderInto(rows)(inRun, { modelId: "gemini-2.5-flash", inputTokens: 5_000_000, outputTokens: 5_000_000, ranOnWorkspaceModel: true });
    expect(rows[0]!.event["costMinorUnits"]).toBe(0);
  });

  it("charges a platform call something when it is large enough to", async () => {
    const rows: { event: Record<string, unknown> }[] = [];
    await recorderInto(rows)(inRun, { modelId: "gemini-2.5-flash", inputTokens: 5_000_000, outputTokens: 5_000_000, ranOnWorkspaceModel: false });
    expect(rows[0]!.event["costMinorUnits"]).toBeGreaterThan(0);
  });

  it("records nothing outside a run, which the ledger's foreign key requires", async () => {
    const rows: unknown[] = [];
    const noRun = { tenantId: "ws-1", principalId: "u-1" } as unknown as ExecutionContext;
    await recorderInto(rows)(noRun, { modelId: "gpt-4o", inputTokens: 10, outputTokens: 10, ranOnWorkspaceModel: false });
    expect(rows).toEqual([]);
  });
});

describe("the wiring", () => {
  it("gives the worker's generator the recorder, and keeps tool rows out of the context meter", () => {
    const engine = readFileSync(resolve(here, "../engine.ts"), "utf8");
    expect(engine).toMatch(/structuredGenerateFrom\(env, \{ workspaceModel, recordUsage \}\)/);
    const main = readFileSync(resolve(here, "../main.ts"), "utf8");
    expect(main).toContain("startsWith(TOOL_STEP_PREFIX)");
    expect(main).toContain("step_id NOT LIKE '${TOOL_STEP_PREFIX}%'");
    const deployment = readFileSync(resolve(here, "../deployment.ts"), "utf8");
    expect(deployment).toContain("await deps.recordUsage(context, {");
  });
});
