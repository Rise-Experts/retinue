/**
 * A tool call that failed is never reported as done — #689.
 *
 * Production, 2026-10-04: `generate_media` was refused (the model sent `as1pectRatio`) and the reply said "I'm
 * generating an AI image… it will be attached". The refusal was in the model's context; nothing made it matter.
 *
 * Two halves, both in the turn's model middleware, both decided from the tool results in this turn's prompt rather
 * than from what the model says:
 *
 * - **Before** each model call after a failure, a note naming the failed calls is added to the prompt, so the
 *   model retries or says what failed. Per call, never stored.
 * - **After**, if the final answer still does not acknowledge a failure, a line saying what did not happen is
 *   appended to it. The person always learns that the work was not done, whatever the model wrote.
 *
 * A call that failed and then succeeded on a retry in the same turn is not a failure.
 */

export const FAILED_TOOLS_HEADER = "[Tool check, not from the person";

/**
 * `streak` is how many times in a row the tool has failed in this turn — #746.
 *
 * Production, 2026-10-11: `read_source` failed on the same call twenty-odd times in one run, each followed by
 * this guard's "fix the call and try again", until the step limit ended the run with nothing to show. A note
 * that only ever says "try again" is half of a loop.
 */
export type FailedCall = { readonly toolName: string; readonly reason: string; readonly streak: number };

/** From this many failures in a row the note stops inviting a retry and says to stop. */
export const REPEAT_LIMIT = 3;
/** From this many the model is offered no tools at all, so its next step is an answer to the person. */
export const STOP_LIMIT = 5;

type Part = { readonly type?: string; readonly toolName?: string; readonly output?: unknown; readonly text?: string };
type Message = { readonly role?: string; readonly content?: unknown };

const partsOf = (message: Message): readonly Part[] => (Array.isArray(message.content) ? (message.content as Part[]) : []);

const isNote = (message: Message): boolean =>
  message.role === "user" && partsOf(message).some((part) => part.type === "text" && part.text?.startsWith(FAILED_TOOLS_HEADER) === true);

const shorten = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

/**
 * What the schema actually objected to — #746.
 *
 * The SDK's message is `Value: <the whole input>.\nError message: <the issues as JSON>`: the echo of the input
 * comes first, and with a long argument (a base64 result id) it is most of the text. The issues are what the
 * model can act on, so they are read out and named by field.
 */
export const validationIssues = (text: string): string | undefined => {
  const at = text.indexOf("Error message:");
  if (at === -1) return undefined;
  try {
    const issues = JSON.parse(text.slice(at + "Error message:".length).trim()) as { message?: unknown; path?: unknown }[];
    if (!Array.isArray(issues) || issues.length === 0) return undefined;
    const named = issues.slice(0, 3).map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${String(issue.message ?? "invalid")}`;
    });
    return shorten(`invalid arguments — ${named.join("; ")}`);
  } catch {
    return undefined;
  }
};

/** Why a tool result is a failure, or undefined when it is not one. Pure, for tests. */
export const failureOf = (output: unknown): string | undefined => {
  if (output === null || typeof output !== "object") return undefined;
  const { type, value } = output as { type?: string; value?: unknown };
  if (type === "error-text" || type === "error-json") {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const unknownArgument = /Unknown arguments? [^\n]*?This tool takes: [^.]*\./.exec(text.replace(/\\"/g, '"'));
    if (unknownArgument !== null) return shorten(unknownArgument[0]);
    if (/Invalid input|InvalidToolInput|validation/i.test(text)) return validationIssues(text) ?? "its arguments were invalid";
    return shorten(text.replace(/^AI_\w+: /, ""));
  }
  if (type !== "json" || value === null || typeof value !== "object") return undefined;
  const result = value as { ok?: unknown; refused?: unknown; error?: { message?: unknown } | string; message?: unknown };
  if (result.ok === false || result.refused === true || (result.ok === undefined && result.error !== undefined)) {
    const message = typeof result.error === "string" ? result.error : result.error?.message ?? result.message;
    return typeof message === "string" && message.trim() !== "" ? shorten(message) : "it returned an error";
  }
  return undefined;
};

/**
 * The calls in this turn that failed and were not later retried successfully. "This turn" is everything after the
 * person's last message; the guard's own note is not a message from the person. Pure, for tests.
 */
export const failedToolCalls = (prompt: readonly Message[] | undefined): readonly FailedCall[] => {
  if (!Array.isArray(prompt)) return [];
  let start = 0;
  prompt.forEach((message, index) => {
    if (message.role === "user" && !isNote(message)) start = index + 1;
  });
  const failed = new Map<string, { reason: string; streak: number }>();
  for (const message of prompt.slice(start)) {
    if (message.role !== "tool") continue;
    for (const part of partsOf(message)) {
      if (part.type !== "tool-result" || part.toolName === undefined) continue;
      const reason = failureOf(part.output);
      if (reason === undefined) failed.delete(part.toolName);
      else failed.set(part.toolName, { reason, streak: (failed.get(part.toolName)?.streak ?? 0) + 1 });
    }
  }
  return [...failed].map(([toolName, { reason, streak }]) => ({ toolName, reason, streak }));
};

const list = (failed: readonly FailedCall[]): string => failed.map((call) => `${call.toolName} — ${call.reason}`).join("; ");

/** The note added to a model call that follows a failure. */
export const failureNoteText = (failed: readonly FailedCall[]): string => {
  const stuck = failed.filter((call) => call.streak >= REPEAT_LIMIT);
  const advice =
    stuck.length === 0
      ? "Fix the call and try again if you can. Otherwise tell the person plainly what did not happen and why. "
      : `${stuck.map((call) => `${call.toolName} has failed ${String(call.streak)} times in a row`).join("; ")} — retrying the same call will fail again. ` +
        "Do not call it again in this reply: change the approach (another source, another argument) or tell the person plainly what did not work and why. ";
  return `${FAILED_TOOLS_HEADER}] These tool calls failed in this reply and did nothing: ${list(failed)}. ${advice}` +
    "Never say or imply that this work was done, is in progress, or will arrive.";
};

/**
 * The prompt with the failure note appended, or unchanged when nothing failed. After `STOP_LIMIT` failures in a
 * row the call is also made with no tool choice, so the step that follows is an answer rather than a sixth try.
 */
export const withFailureNote = <P extends { readonly prompt?: unknown }>(params: P): P => {
  const failed = failedToolCalls(params.prompt as Message[] | undefined);
  if (failed.length === 0) return params;
  const note = { role: "user", content: [{ type: "text", text: failureNoteText(failed) }] };
  const stop = failed.some((call) => call.streak >= STOP_LIMIT);
  return { ...params, prompt: [...(params.prompt as Message[]), note], ...(stop ? { toolChoice: { type: "none" } } : {}) };
};

/** Words that show a reply already tells the person something did not work, in English and German. */
const ACKNOWLEDGES =
  /\b(fail(ed|s|ure)?|couldn['’]?t|could not|can['’]?t|cannot|unable|didn['’]?t work|did not work|wasn['’]?t able|was not able|error|not possible|went wrong)\b|konnte|fehlgeschlagen|nicht möglich|fehler|leider|hat nicht geklappt/i;

export const acknowledgesFailure = (text: string): boolean => ACKNOWLEDGES.test(text);

/** The line appended to a final answer that did not mention a failure. */
export const failureLine = (failed: readonly FailedCall[]): string =>
  `\n\n⚠️ Not done: ${failed.map((call) => `${call.toolName} did not run (${call.reason})`).join("; ")}. Nothing from ${failed.length === 1 ? "it" : "them"} was created or changed.`;

type StreamPart = { readonly type?: string; readonly delta?: string } & Record<string, unknown>;

/**
 * A model stream with the failure line added before `finish` — only on a final answer (no tool calls in it),
 * only when calls failed this turn, and only when the answer does not already say so.
 */
export const withFailureAcknowledged = (stream: unknown, failed: readonly FailedCall[], onAppend: () => void = () => {}): unknown => {
  if (failed.length === 0) return stream;
  if (typeof TransformStream === "undefined" || stream === null || typeof stream !== "object" || typeof (stream as { pipeThrough?: unknown }).pipeThrough !== "function") {
    return stream;
  }
  let text = "";
  let callsTools = false;
  return (stream as ReadableStream<StreamPart>).pipeThrough(
    new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        if (part.type === "tool-call") callsTools = true;
        if (part.type === "text-delta" && typeof part.delta === "string") text += part.delta;
        if (part.type === "finish" && !callsTools && !acknowledgesFailure(text)) {
          onAppend();
          const id = "failed-tools";
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, delta: failureLine(failed) });
          controller.enqueue({ type: "text-end", id });
        }
        controller.enqueue(part);
      },
    }),
  );
};
