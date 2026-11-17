/**
 * #649 follow-up — a call's prompt as hashes, so the part that breaks the prompt cache can be found.
 */
import { describe, expect, it } from "vitest";

import { promptFingerprint } from "../prompt-fingerprint.js";

const params = (over: { system?: string; messages?: string[]; tools?: unknown[] } = {}) => ({
  prompt: [
    { role: "system", content: over.system ?? "You are helpful." },
    ...(over.messages ?? ["hi", "hello"]).map((text, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] })),
  ],
  tools: over.tools ?? [{ type: "function", name: "a" }, { type: "function", name: "b" }],
});

describe("promptFingerprint", () => {
  it("is identical for identical prompts, and holds no prompt text", () => {
    const a = promptFingerprint(params());
    expect(promptFingerprint(params())).toEqual(a);
    expect(JSON.stringify(a)).not.toContain("helpful");
    expect(a.toolCount).toBe(2);
    expect(a.messages).toHaveLength(2);
  });

  it("shows which part changed: tools, system, or one message", () => {
    const base = promptFingerprint(params());
    const tools = promptFingerprint(params({ tools: [{ type: "function", name: "b" }, { type: "function", name: "a" }] }));
    const system = promptFingerprint(params({ system: "You are helpful!" }));
    const message = promptFingerprint(params({ messages: ["hi", "hello!"] }));
    expect(tools.tools).not.toBe(base.tools);
    expect(tools.system).toBe(base.system);
    expect(system.system).not.toBe(base.system);
    expect(system.tools).toBe(base.tools);
    expect(message.messages[0]).toBe(base.messages[0]);
    expect(message.messages[1]).not.toBe(base.messages[1]);
  });

  it("copes with params it does not recognise", () => {
    expect(promptFingerprint(undefined)).toMatchObject({ toolCount: 0, messages: [] });
  });
});
