/**
 * A chat turn's own credit — #597. What is reported, when, and that billing can never lose an event.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { noteTurnModel, withTurnCharging } from "../turn-billing.js";
import { createInternalWebApp } from "../internal.js";
import { withCredit } from "../../tools/credits.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (charge: (input: unknown) => Promise<unknown> = async () => ({ charged: 1 })) => {
  const persisted: unknown[] = [];
  const charges: unknown[] = [];
  const warnings: string[] = [];
  const log = withTurnCharging(
    { append: async (input: { tenantId: unknown; event: unknown }) => void persisted.push(input.event) },
    async (input) => {
      charges.push(input);
      return charge(input);
    },
    (message) => warnings.push(message),
  );
  return { log, persisted, charges, warnings };
};

describe("withTurnCharging", () => {
  it("reports a completed run once, after the event is persisted", async () => {
    const { log, persisted, charges } = harness();
    await log.append({ tenantId: "ws-1", event: { type: "run.started", runId: "run-1" } });
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-1" } });
    await flush();
    expect(persisted).toHaveLength(2);
    expect(charges).toEqual([{ workspaceId: "ws-1", runId: "run-1" }]);
  });

  it("does not charge a failed or cancelled run", async () => {
    const { log, charges } = harness();
    await log.append({ tenantId: "ws-1", event: { type: "run.failed", runId: "run-2" } });
    await log.append({ tenantId: "ws-1", event: { type: "run.cancelled", runId: "run-3" } });
    await flush();
    expect(charges).toEqual([]);
  });

  it("says whether the workspace's own model served the turn, when the engine recorded it", async () => {
    const { log, charges } = harness();
    noteTurnModel("run-byo", () => true);
    noteTurnModel("run-platform", () => false);
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-byo" } });
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-platform" } });
    await flush();
    expect(charges).toEqual([
      { workspaceId: "ws-1", runId: "run-byo", workspaceModel: true },
      { workspaceId: "ws-1", runId: "run-platform", workspaceModel: false },
    ]);
  });

  it("forgets a run's model on its terminal event, so the map cannot grow forever", async () => {
    const { log, charges } = harness();
    noteTurnModel("run-4", () => true);
    await log.append({ tenantId: "ws-1", event: { type: "run.failed", runId: "run-4" } });
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-4" } });
    await flush();
    expect(charges).toEqual([{ workspaceId: "ws-1", runId: "run-4" }]);
  });

  it("logs a failed report instead of failing the run", async () => {
    const { log, persisted, warnings } = harness(async () => {
      throw new Error("app down");
    });
    await expect(log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-5" } })).resolves.toBeUndefined();
    await flush();
    expect(persisted).toHaveLength(1);
    expect(warnings.join("\n")).toContain("chat credit not recorded — app down");
  });

  it("persists even when the event is not one it bills", async () => {
    const { log, persisted, charges } = harness();
    await log.append({ tenantId: "ws-1", event: { type: "part.added", runId: "run-6" } });
    expect(persisted).toHaveLength(1);
    expect(charges).toEqual([]);
  });
});

describe("the internal hop's charge_turn", () => {
  it("says which chat the turn was in, so the chat's credits add up (#646)", async () => {
    const { log, charges } = harness();
    noteTurnModel("run-chat", () => false, "conv-9");
    noteTurnModel("run-nochat", () => false);
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-chat" } });
    await log.append({ tenantId: "ws-1", event: { type: "run.completed", runId: "run-nochat" } });
    await flush();
    expect(charges).toEqual([
      { workspaceId: "ws-1", runId: "run-chat", workspaceModel: false, conversationId: "conv-9" },
      { workspaceId: "ws-1", runId: "run-nochat", workspaceModel: false },
    ]);
  });

  it("the engine records the run's chat with its model", () => {
    const engine = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "engine.ts"), "utf8");
    expect(engine).toContain("noteTurnModel(context.runId, turn.ranOnWorkspaceModel, context.conversationId);");
  });

  it("sends the run and the model hint, and no user", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createInternalWebApp({
      baseUrl: "http://web:3000",
      secret: "s",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, async json() { return { charged: 1 }; } } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(client.chargeTurn({ workspaceId: "ws-1", runId: "run-1", workspaceModel: false, conversationId: "conv-1" })).resolves.toEqual({ charged: 1 });
    expect(calls).toEqual([
      { url: "http://web:3000/api/internal/credits", body: { action: "charge_turn", workspaceId: "ws-1", runId: "run-1", workspaceModel: false, conversationId: "conv-1" } },
    ]);
  });
});

describe("withCredit", () => {
  const context = { tenantId: "ws-1", principalId: "user-1" } as never;
  const recorder = () => {
    const charged: { credits: number; tool: string }[] = [];
    const credits = {
      async reserve() {
        return { byo: false, metered: true };
      },
      async charge(_context: unknown, input: { credits: number; tool: string }) {
        charged.push(input);
        return { charged: input.credits };
      },
    };
    return { charged, credits };
  };

  it("reports one unit under the tool's name after the call succeeds", async () => {
    const { charged, credits } = recorder();
    const run = withCredit(() => credits, "generate_content", async (input: { brief: string }) => ({ ok: input.brief }));
    await expect(run({ brief: "x" }, context)).resolves.toEqual({ ok: "x" });
    expect(charged).toEqual([{ credits: 1, tool: "generate_content" }]);
  });

  it("charges nothing when the call fails", async () => {
    const { charged, credits } = recorder();
    const run = withCredit(() => credits, "generate_content", async () => {
      throw new Error("nope");
    });
    await expect(run({}, context)).rejects.toThrow("nope");
    expect(charged).toEqual([]);
  });

  it("names the tool from its input, so a free mode is priced as free by the app", async () => {
    const { charged, credits } = recorder();
    const run = withCredit(
      () => credits,
      (input: { mode: string }) => (input.mode === "alt_text" ? "describe_image_alt_text" : "describe_image"),
      async () => "text",
    );
    await run({ mode: "alt_text" }, context);
    await run({ mode: "caption" }, context);
    expect(charged.map((c) => c.tool)).toEqual(["describe_image_alt_text", "describe_image"]);
  });

  it("never throws when recording fails — the result is already the user's", async () => {
    const credits = {
      async reserve() {
        return { byo: false, metered: true };
      },
      async charge(): Promise<{ charged: number }> {
        throw new Error("ledger down");
      },
    };
    const run = withCredit(() => credits, "repurpose_source", async () => "pieces");
    await expect(run({}, context)).resolves.toBe("pieces");
  });
});

describe("which tools report a credit (#597)", () => {
  const source = (file: string) =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", file), "utf8");

  it.each([
    ["generate.ts", "propose_post_angles"],
    ["generate.ts", "generate_content"],
    ["generate.ts", "generate_campaign"],
    ["generate.ts", "repurpose_source"],
    ["generate.ts", "repurpose_to_formats"],
    ["engagement.ts", "draft_comment_reply"],
    ["engagement.ts", "draft_auto_reply"],
  ])("%s: %s is wrapped in withCredit under its own name", (file, tool) => {
    expect(source(file)).toContain(`withCredit(() => services.credits, "${tool}",`);
  });

  it("describe_image reports its free alt-text mode under its own name", () => {
    expect(source("media.ts")).toMatch(/withCredit\(\(\) => services\.credits, \(input[^)]*\) => \(input\.mode === "alt_text" \? "describe_image_alt_text" : "describe_image"\)/);
  });

  it("the three #499 tools still charge per unit written", () => {
    expect(source("compose.ts")).toContain('chargeWritten(services.credits, context, ok.length, "draft_post_for_channels")');
    expect(source("compose.ts")).toContain('chargeWritten(services.credits, context, revised.size, "revise_post_channels")');
    expect(source("generate.ts")).toContain('"generate_alternatives")');
  });
});
