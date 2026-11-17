import { describe, expect, it } from "vitest";
import type { ContextProvider, ExecutionContext } from "@retinue/agentkit";
import { createContextForTurn, type ContextSummary } from "../context-for-turn.js";
import { contextSectionsRecorder } from "../turn-steps.js";

/** #552 — what each turn's prompt was made of, for the chat box's meter. */
const context = { tenantId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", runId: "r1", conversationId: "c1" } as unknown as ExecutionContext;
const provider = (id: string, body: string): ContextProvider => ({
  id,
  async provide() {
    return [{ providerId: id, title: id, body, priority: 50, estimatedTokens: Math.ceil(body.length / 4), provenance: id, sensitivity: "internal", origin: "platform", cacheable: false }] as never;
  },
});

describe("the context summary", () => {
  it("reports each provider's share of what was actually sent", async () => {
    const seen: ContextSummary[] = [];
    const prompt = createContextForTurn({ providers: [provider("shareflow.project", "x".repeat(400)), provider("shareflow.brand", "y".repeat(80))], onAssembled: (_c, s) => seen.push(s) });
    await prompt({ id: "a", instructions: "i".repeat(40), contextProviderIds: ["shareflow.project", "shareflow.brand"] } as never, context);
    expect(seen[0]).toEqual({ instructionsTokens: 10, sections: [{ providerId: "shareflow.project", tokens: 100 }, { providerId: "shareflow.brand", tokens: 20 }] });
  });

  it("never breaks the turn when measuring throws", async () => {
    const prompt = createContextForTurn({ providers: [provider("shareflow.brand", "y")], onAssembled: () => { throw new Error("meter down"); } });
    await expect(prompt({ id: "a", instructions: "x", contextProviderIds: ["shareflow.brand"] } as never, context)).resolves.toContain("# Context");
  });

  it("is stored beside the turn's steps, starting a row the first model call then counts into", async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    await contextSectionsRecorder({ async query(text: string, params: unknown[]) { queries.push({ text, params }); return []; } } as never)(context, { instructionsTokens: 1, sections: [] });
    expect(queries[0]!.text).toContain("on conflict (run_id) do update set context_sections = excluded.context_sections");
    expect(queries[0]!.params).toEqual(["r1", "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "c1", '{"instructionsTokens":1,"sections":[]}']);
  });
});
