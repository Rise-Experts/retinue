import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";

import { failedToolCalls, failureOf, FAILED_TOOLS_HEADER, STOP_LIMIT, withFailureNote } from "../failed-tool-guard.js";
import { withWorkspaceModel } from "../workspace-turn-model.js";
import { stripToolRecordEcho } from "../tool-record-echo.js";

/** #689 — a failed tool call is never reported as done. */

// What the SDK puts in the prompt for the 2026-10-04 call, as recorded by `tool-argument-retry.test.ts`.
const refusedByTypo = {
  type: "error-text",
  value:
    'AI_InvalidToolInputError: Invalid input for tool generate_media: AI_TypeValidationError: Type validation failed: Value: {"as1pectRatio":"4:5"}.\nError message: [{"code": "custom", "message": "Unknown argument \\"as1pectRatio\\" (did you mean \\"aspectRatio\\"?). This tool takes: kind, prompt, aspectRatio. Call it again with the right name — nothing was done.", "path": []}]',
};
const ok = { type: "json", value: { jobId: "job-1", status: "queued" } };

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const result = (toolName: string, output: unknown) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: `${toolName}-${Math.random()}`, toolName, output }] });

describe("what counts as a failure", () => {
  it("reads the SDK's refusal, a tool's own error and a guardrail's refusal", () => {
    expect(failureOf(refusedByTypo)).toContain('Unknown argument "as1pectRatio" (did you mean "aspectRatio"?)');
    expect(failureOf({ type: "json", value: { ok: false, error: { code: "not_configured", message: "No image model is configured" } } })).toBe("No image model is configured");
    expect(failureOf({ type: "json", value: { refused: true, message: "blocked by policy" } })).toBe("blocked by policy");
  });

  it("does not read a successful result as one", () => {
    expect(failureOf(ok)).toBeUndefined();
    expect(failureOf({ type: "json", value: { ok: true, data: { error: "a field called error" } } })).toBeUndefined();
  });
});

describe("the failed calls of this turn", () => {
  it("are those after the person's last message", () => {
    const prompt = [user("earlier"), result("create_post_draft", refusedByTypo), user("make an image"), result("generate_media", refusedByTypo)];
    expect(failedToolCalls(prompt).map((call) => call.toolName)).toEqual(["generate_media"]);
  });

  it("leave out a call that a retry in the same turn fixed", () => {
    expect(failedToolCalls([user("make an image"), result("generate_media", refusedByTypo), result("generate_media", ok)])).toEqual([]);
  });

  it("are still counted after the guard's own note", () => {
    const noted = withFailureNote({ prompt: [user("make an image"), result("generate_media", refusedByTypo)] });
    expect(noted.prompt).toHaveLength(3);
    expect(failedToolCalls(noted.prompt).map((call) => call.toolName)).toEqual(["generate_media"]);
  });
});

describe("a call that keeps failing (#746, the 2026-10-11 read_source loop)", () => {
  // The SDK's refusal for an over-long result id: the input echo first, the issue after it.
  const tooLong = {
    type: "error-text",
    value:
      `AI_InvalidToolInputError: Invalid input for tool read_source: AI_TypeValidationError: Type validation failed: Value: {"resultId":"src_${"A".repeat(300)}"}.\nError message: [{"code": "too_big", "maximum": 200, "path": ["resultId"], "message": "String must contain at most 200 character(s)"}]`,
  };
  const failingTimes = (n: number) => [user("read it"), ...Array.from({ length: n }, () => result("read_source", tooLong))];

  it("names the field the schema objected to, not just that the arguments were invalid", () => {
    expect(failureOf(tooLong)).toBe("invalid arguments — resultId: String must contain at most 200 character(s)");
  });

  it("counts failures in a row, and a success resets the count", () => {
    expect(failedToolCalls(failingTimes(3))[0]?.streak).toBe(3);
    expect(failedToolCalls([...failingTimes(3), result("read_source", ok), result("read_source", tooLong)])[0]?.streak).toBe(1);
  });

  it("stops inviting a retry after three", () => {
    const once = JSON.stringify(withFailureNote({ prompt: failingTimes(1) }).prompt.at(-1));
    expect(once).toContain("try again");
    const stuck = JSON.stringify(withFailureNote({ prompt: failingTimes(3) }).prompt.at(-1));
    expect(stuck).toContain("read_source has failed 3 times in a row");
    expect(stuck).toContain("Do not call it again");
    expect(withFailureNote({ prompt: failingTimes(3) })).not.toHaveProperty("toolChoice");
  });

  it("offers no tools after the stop limit, so the next step answers the person", () => {
    expect(withFailureNote({ prompt: failingTimes(STOP_LIMIT) })).toMatchObject({ toolChoice: { type: "none" } });
  });
});

describe("the note", () => {
  it("is added only after a failure, and names it", () => {
    const clean = { prompt: [user("hi"), result("list_post_drafts", ok)] };
    expect(withFailureNote(clean)).toBe(clean);
    const text = JSON.stringify(withFailureNote({ prompt: [user("make an image"), result("generate_media", refusedByTypo)] }).prompt.at(-1));
    expect(text).toContain(FAILED_TOOLS_HEADER);
    expect(text).toContain("generate_media");
    expect(text).toContain("Never say or imply that this work was done");
  });

  it("is cut from a reply that copies it, like the other tool records", () => {
    expect(stripToolRecordEcho(`Sure.\n\n${FAILED_TOOLS_HEADER}] These tool calls failed`).text).toBe("Sure.");
  });
});

describe("a reply after a failure (AC-3, the 2026-10-04 conversation as an eval case)", () => {
  const context = { tenantId: "t1", principalId: "u1", runId: "r1", conversationId: "c1" } as unknown as ExecutionContext;
  const streamOf = (chunks: readonly unknown[]) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const reply = (text: string) => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: "stop" },
  ];

  /** One model call through the turn's real middleware: params transformed, then the stream. */
  const answer = async (prompt: unknown[], chunks: unknown[]) => {
    let middleware: { transformParams: (o: { params: unknown }) => Promise<unknown>; wrapStream: (o: { doStream: () => Promise<unknown>; params: unknown }) => Promise<{ stream: ReadableStream }> } | undefined;
    withWorkspaceModel({
      model: {},
      context,
      resolve: async () => undefined,
      languageModelFor: async () => ({}),
      wrap: ({ middleware: m }) => {
        middleware = m as never;
        return {};
      },
      deployment: { provider: "google", modelId: "gemini-2.5-flash" },
    });
    const params = (await middleware!.transformParams({ params: { prompt } })) as { prompt: unknown[] };
    const { stream } = await middleware!.wrapStream({ doStream: async () => ({ stream: streamOf(chunks) }), params });
    let text = "";
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((value as { type: string }).type === "text-delta") text += (value as { delta: string }).delta;
    }
    return { sentPrompt: params.prompt, text };
  };

  const failedTurn = [{ role: "system", content: "s" }, user("Make an AI image of our cafe for Instagram"), result("generate_media", refusedByTypo)];

  it("never stands as a success claim for the failed call", async () => {
    const { sentPrompt, text } = await answer(failedTurn, reply("I'm generating an AI image of your cafe — it will be attached to the post shortly."));
    expect(JSON.stringify(sentPrompt.at(-1))).toContain("generate_media");
    expect(text).toContain("⚠️ Not done: generate_media did not run");
  });

  it("is left alone when it already says what failed", async () => {
    const said = "I couldn't generate the image: I sent a wrong setting. Want me to try again?";
    expect((await answer(failedTurn, reply(said))).text).toBe(said);
  });

  it("is left alone when nothing failed", async () => {
    const fine = [user("Make an AI image"), result("generate_media", ok)];
    expect((await answer(fine, reply("It's being made — about 20 seconds."))).text).toBe("It's being made — about 20 seconds.");
  });
});
