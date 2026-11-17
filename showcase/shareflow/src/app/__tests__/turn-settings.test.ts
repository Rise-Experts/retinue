import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import { attachmentsIn, createTurnInputReader, parseTurnSettings, referencesIn } from "../turn-settings.js";

/** #543 — what the person chose for a turn, and what they pointed at. */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const POST = "9b2d1a4e-1111-4222-8333-944455556666";

describe("parseTurnSettings", () => {
  it("keeps known values", () => {
    expect(parseTurnSettings({ mode: "plan", effort: "high", model: "chorus:gemini-2.5-pro" })).toEqual({ mode: "plan", effort: "high", model: "chorus:gemini-2.5-pro" });
  });

  it("falls back field by field, never refusing: a bad setting is today's assistant", () => {
    expect(parseTurnSettings({ mode: "yolo", effort: 3, model: "rm -rf /" })).toEqual({ mode: "auto", effort: "medium" });
    expect(parseTurnSettings(null)).toEqual({ mode: "auto", effort: "medium" });
  });
});

describe("the run reader", () => {
  const context = (runId?: string) => ({ tenantId: WS, runId }) as unknown as ExecutionContext;

  it("reads a run once, however many callers ask", async () => {
    let reads = 0;
    const read = createTurnInputReader({
      async findById() {
        reads += 1;
        return { input: { message: "hi", settings: { mode: "chat_only" } } };
      },
    });
    const [a, b] = await Promise.all([read(context("r1")), read(context("r1"))]);
    expect(a.settings.mode).toBe("chat_only");
    expect(b.message).toBe("hi");
    expect(reads).toBe(1);
  });

  it("gives the defaults without a run, and after a failed read retries next time", async () => {
    let calls = 0;
    const read = createTurnInputReader({
      async findById() {
        calls += 1;
        if (calls === 1) throw new Error("db down");
        return { input: { settings: { mode: "plan" } } };
      },
    });
    expect((await read(context())).settings.mode).toBe("auto");
    expect((await read(context("r2"))).settings.mode).toBe("auto");
    expect((await read(context("r2"))).settings.mode).toBe("plan");
  });
});

describe("blocks inside the message", () => {
  const message = `Make it shorter\n\n[referenced]\nchorus:post/${POST} Team post\nchorus:project-asset/${WS} Logo\nnot a reference\n[/referenced]\n\n[attached-media]\n${WS}/a.png\n${WS}/../secret.png\n[/attached-media]`;

  it("reads references and ignores lines that are not one", () => {
    expect(referencesIn(message)).toEqual([
      { kind: "post", id: POST, label: "Team post" },
      { kind: "project_asset", id: WS, label: "Logo" },
    ]);
  });

  it("reads attachments and drops a path that climbs out of the workspace folder", () => {
    expect(attachmentsIn(message)).toEqual([`${WS}/a.png`]);
  });
});
