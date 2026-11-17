/**
 * A tool record the model wrote itself, removed before anyone sees it — #650.
 *
 * History tells the model what its tools did through a bracketed record (`history.ts`, `TOOL_NOTE_HEADERS`).
 * Production, 2026-09-30: with that record inside its own earlier replies, the model started *writing* one —
 * a fake `update_artifact` to version 3 and a `generate_pdf` link to a file that did not exist — instead of
 * calling the tools, and the chat showed the whole block plus an "UNAVAILABLE" card. It happened on a plain
 * "Noted 25." reply too.
 *
 * The record now opens the next user turn instead, which removes the pattern to copy. This is the other half:
 * whatever still comes out is cut at its header, in the stream (so it is neither shown nor saved) and in stored
 * history (so an old leaked reply does not teach it again). Everything from the header to the end of that text
 * block goes: the record always ran to the end of the reply, and a fabricated one is not something to keep half of.
 */

/** The openings of every record format this service has written, current and earlier. */
const HEADERS = [
  "[System note, not from the person",
  "[Your tool calls in this reply",
  "[What your tools returned in this reply",
  "[What your tools did in this reply",
  // #689's note after a failed call (`failed-tool-guard.ts`), should the model copy it.
  "[Tool check, not from the person",
] as const;

const headerAt = (text: string): number => {
  let at = -1;
  for (const header of HEADERS) {
    const index = text.indexOf(header);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  return at;
};

/** The text with any echoed record removed, and whether one was. Pure, for history and tests. */
export const stripToolRecordEcho = (text: string): { readonly text: string; readonly stripped: boolean } => {
  const at = headerAt(text);
  if (at === -1) return { text, stripped: false };
  return { text: text.slice(0, at).trimEnd(), stripped: true };
};

/** How much of `held`'s end could still turn into a header, so it is kept back rather than streamed. */
const pendingTail = (held: string): number => {
  const start = held.lastIndexOf("[");
  if (start === -1) return 0;
  const tail = held.slice(start);
  return HEADERS.some((header) => header.startsWith(tail)) ? tail.length : 0;
};

type StreamPart = { readonly type?: string; readonly id?: string; readonly delta?: string } & Record<string, unknown>;

/**
 * A LanguageModelV3 stream with echoed records cut out of its text.
 *
 * Text is passed through as it arrives, except a trailing `[…` that could still become a header, which is held
 * back until it either becomes one (then that block's text stops) or cannot (then it is released).
 */
export const withoutToolRecordEcho = (stream: unknown, onStrip: () => void = () => {}): unknown => {
  if (typeof TransformStream === "undefined" || stream === null || typeof stream !== "object" || typeof (stream as { pipeThrough?: unknown }).pipeThrough !== "function") {
    return stream;
  }
  const held = new Map<string, string>();
  const cut = new Set<string>();
  return (stream as ReadableStream<StreamPart>).pipeThrough(
    new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        const id = String(part.id ?? "");
        if (part.type === "text-delta" && typeof part.delta === "string") {
          if (cut.has(id)) return;
          const text = (held.get(id) ?? "") + part.delta;
          const at = headerAt(text);
          if (at !== -1) {
            cut.add(id);
            held.delete(id);
            onStrip();
            const before = text.slice(0, at).trimEnd();
            if (before !== "") controller.enqueue({ ...part, delta: before });
            return;
          }
          const keep = pendingTail(text);
          held.set(id, keep === 0 ? "" : text.slice(text.length - keep));
          const release = text.slice(0, text.length - keep);
          if (release !== "") controller.enqueue({ ...part, delta: release });
          return;
        }
        if (part.type === "text-end") {
          const rest = held.get(id) ?? "";
          held.delete(id);
          if (rest !== "" && !cut.has(id)) controller.enqueue({ type: "text-delta", id: part.id, delta: rest } as StreamPart);
        }
        controller.enqueue(part);
      },
    }),
  );
};

/** The same, for a non-streamed result's content parts. */
export const withoutToolRecordEchoInContent = <T>(content: T, onStrip: () => void = () => {}): T => {
  if (!Array.isArray(content)) return content;
  return content.map((part: StreamPart) => {
    if (part?.type !== "text" || typeof part["text"] !== "string") return part;
    const result = stripToolRecordEcho(part["text"] as string);
    if (result.stripped) onStrip();
    return result.stripped ? { ...part, text: result.text } : part;
  }) as T;
};
