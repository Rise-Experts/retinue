/**
 * `transcribe` and `speech_generate` — REQ-062 (#257), task #258, AC-9.
 *
 * The two clauses worth the most:
 *
 * - **The tool takes a file id, never bytes and never a URL.** Bytes would put a base64 recording in the
 *   model's context and arrive having bypassed the upload bounds; a URL would make this a fetch tool with an
 *   SSRF surface. Asserted on the schema, because it is the kind of parameter somebody widens helpfully.
 * - **`transcribe` re-checks the bounds against what was stored**, not against what a client declared.
 */
import { describe, expect, it, vi } from "vitest";

import { asId } from "../../../core/ids.js";
import type { ExecutionContext } from "../../../core/context.js";
import { createSpeechGenerateTool, createTranscribeTool, type AudioToolDeps } from "../audio.js";
import { MAX_AUDIO_BYTES, MAX_SPEECH_CHARS } from "../../../audio/index.js";
import type { SpeechProvider, TranscriptionProvider } from "../../../audio/index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("r1"),
};

/** The delegating envelope's deps, minimal: no authorization filtering or approval in these cases. */
const deps = {
  authorization: {
    async can() {
      return { allow: true as const };
    },
    async filterTools(_c: ExecutionContext, tools: readonly unknown[]) {
      return tools as never;
    },
    async scope(c: ExecutionContext) {
      return { tenantId: String(c.tenantId), roleIds: [] };
    },
  },
} as never;

const transcriber = (over: Partial<Awaited<ReturnType<TranscriptionProvider["transcribe"]>>> = {}): TranscriptionProvider => ({
  id: "fake",
  async transcribe() {
    return { text: "the quick brown fox", truncated: false, durationSeconds: 2.66, language: "english", ...over };
  },
});

const speaker = (): SpeechProvider => ({
  id: "fake",
  async speak() {
    return { audio: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" };
  },
});

const audioDeps = (over: Partial<AudioToolDeps> = {}): AudioToolDeps => ({
  async readFile() {
    return { bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg", byteSize: 3, filename: "note.mp3" };
  },
  async writeAudio() {
    return { fileId: "file-generated", url: "/files/file-generated" };
  },
  ...over,
});

const run = async (tool: ReturnType<typeof createTranscribeTool>, input: unknown) =>
  tool.execute({ context, input });

describe("transcribe", () => {
  it("is a read, and returns the transcript with its duration", async () => {
    const tool = createTranscribeTool(deps, transcriber(), audioDeps());
    expect(tool.descriptor.effect).toBe("read");
    expect(tool.descriptor.approvalPolicy).toBe("never");

    const outcome = (await run(tool, { fileId: "file-1" })) as { ok: true; data: Record<string, unknown> };
    expect(outcome.ok).toBe(true);
    expect(outcome.data.text).toBe("the quick brown fox");
    // The duration is what usage is charged on, so it has to reach the caller.
    expect(outcome.data.durationSeconds).toBe(2.66);
    expect(outcome.data.language).toBe("english");
    expect(outcome.data.provider).toBe("fake");
  });

  it("takes a file id and refuses anything else", async () => {
    /**
     * Asserted on the schema, because this is the parameter somebody widens helpfully. Bytes here would mean a
     * base64 recording in the model's context that bypassed the upload bounds; a URL would make this a fetch
     * tool with an SSRF surface.
     */
    const tool = createTranscribeTool(deps, transcriber(), audioDeps());
    /**
     * Asserted through the schema's own parser rather than by reading `properties`.
     *
     * The descriptor carries the **Zod schema**, not a JSON-schema object — the registry validates through it.
     * Reading `.properties` returned an empty object and the first version of this test asserted against that,
     * which would have passed for any schema at all.
     */
    const schema = tool.descriptor.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(typeof schema.safeParse).toBe("function");
    expect(schema.safeParse({ fileId: "file-1" }).success).toBe(true);

    // A recording must arrive as an id. Bytes bypass the upload bounds; a URL is an SSRF surface.
    for (const bad of [{}, { fileId: "" }, { url: "https://example.test/a.mp3" }, { audio: "AAAA" }]) {
      const outcome = (await run(tool, bad)) as { ok: boolean };
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("re-checks the bounds against what was stored", async () => {
    /**
     * Not redundant with the upload check: that one validates what a client *declared*. This validates the
     * file that actually exists — one uploaded before the deployment tightened its bounds, for instance.
     */
    const tool = createTranscribeTool(
      deps,
      transcriber(),
      audioDeps({
        async readFile() {
          return { bytes: new Uint8Array([1]), mediaType: "audio/mpeg", byteSize: MAX_AUDIO_BYTES + 1 };
        },
      }),
    );
    const outcome = (await run(tool, { fileId: "file-huge" })) as { ok: false; error: { code: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("invalid_input");
  });

  it("refuses a stored file that is not audio, without calling the provider", async () => {
    const transcribe = vi.fn();
    const tool = createTranscribeTool(
      deps,
      { id: "fake", transcribe: transcribe as never },
      audioDeps({
        async readFile() {
          return { bytes: new Uint8Array([1]), mediaType: "application/pdf", byteSize: 10 };
        },
      }),
    );
    expect(((await run(tool, { fileId: "file-pdf" })) as { ok: boolean }).ok).toBe(false);
    // The provider's refusal would cost the round trip and name the request rather than the format.
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("passes the truncation through so the model can say the transcript is partial", async () => {
    const tool = createTranscribeTool(deps, transcriber({ truncated: true, text: "beginning only" }), audioDeps());
    const outcome = (await run(tool, { fileId: "file-1" })) as { ok: true; data: { truncated: boolean } };
    expect(outcome.data.truncated).toBe(true);
    // And the description tells the model what to do about it.
    expect(tool.descriptor.description).toMatch(/say so rather than summarising it as the whole thing/);
  });
});

describe("speech_generate", () => {
  it("is an internal-write producing a file, not an external write", async () => {
    /**
     * The effect decision, asserted. It creates a file the tenant owns and nothing leaves the deployment —
     * which is what separates `internal-write` from `external-write`. It is not a `read` because it costs
     * money.
     */
    const tool = createSpeechGenerateTool(deps, speaker(), audioDeps());
    expect(tool.descriptor.effect).toBe("internal-write");
    expect(tool.descriptor.approvalPolicy).toBe("policy");
  });

  it("returns a file id the interface can play", async () => {
    const tool = createSpeechGenerateTool(deps, speaker(), audioDeps());
    const outcome = (await run(tool as never, { text: "hello there" })) as { ok: true; data: Record<string, unknown> };
    expect(outcome.data.fileId).toBe("file-generated");
    expect(outcome.data.mediaType).toBe("audio/mpeg");
    expect(outcome.data.characters).toBe(11);
    expect(outcome.data.byteSize).toBe(3);
  });

  it("names the file from the text, bounded", async () => {
    const written: { filename: string }[] = [];
    const tool = createSpeechGenerateTool(
      deps,
      speaker(),
      audioDeps({
        async writeAudio(input) {
          written.push({ filename: input.filename });
          return { fileId: "f" };
        },
      }),
    );
    await run(tool as never, { text: "Quarterly results are in: revenue rose nine percent across every region" });
    // Readable, and not a 4,000-character filename.
    expect(written[0]?.filename).toMatch(/^speech-Quarterly-results/);
    expect(written[0]?.filename.length).toBeLessThan(70);
    expect(written[0]?.filename.endsWith(".mp3")).toBe(true);
  });

  it("survives text with nothing filename-safe in it", async () => {
    const written: { filename: string }[] = [];
    const tool = createSpeechGenerateTool(
      deps,
      speaker(),
      audioDeps({
        async writeAudio(input) {
          written.push({ filename: input.filename });
          return { fileId: "f" };
        },
      }),
    );
    // A filename that reduced to nothing would be `speech-.mp3`, which is a broken download rather than a name.
    await run(tool as never, { text: "。。。！！！" });
    expect(written[0]?.filename).toBe("speech-audio.mp3");
  });

  it("refuses text over the ceiling at the schema, before the provider", async () => {
    const speak = vi.fn();
    const tool = createSpeechGenerateTool(deps, { id: "fake", speak: speak as never }, audioDeps());
    const outcome = (await run(tool as never, { text: "a".repeat(MAX_SPEECH_CHARS + 1) })) as { ok: boolean };
    expect(outcome.ok).toBe(false);
    // Speech is billed per character, so the refusal must not cost a call.
    expect(speak).not.toHaveBeenCalled();
  });
});
