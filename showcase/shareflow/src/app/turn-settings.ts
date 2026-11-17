/**
 * What the person chose for this turn — #543 (agent mode #550, model and effort #551) — and what they
 * pointed at (references #548, attachments #549).
 *
 * ## Where it travels
 *
 * The web sends `{ message, conversationId, settings }`. `settings` is written onto the run's `input`
 * next to the message (`turns.ts`), because the worker rebuilds its context from the run row and never
 * sees the request: a header or a body field that stopped at the HTTP handler would be a setting the
 * turn never obeyed. Everything that needs it — the tool gate, the model middleware, the prompt — reads
 * it back by `context.runId`, once per run.
 *
 * References and attachments are **not** settings. They are blocks inside the message text itself,
 * added by the web after it has checked every id and path against the caller's workspace, so they are
 * in the conversation's history for later turns as well as this one. The two parsers below are the only
 * readers; the web's `turnBlocks.ts` is the only writer, and the formats are asserted to agree.
 */
import type { ExecutionContext } from "@retinue/agentkit";

export const AGENT_MODES = ["auto", "ask_first", "plan", "chat_only"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * The chat box's image/video settings — #575, like Google Flow's: what to make, its shape, and which
 * generator. Each field optional; absent means the tool's own default, as before.
 */
export type MediaSettings = {
  readonly kind?: "image" | "video";
  readonly aspectRatio?: string;
  readonly model?: string;
};

export type TurnSettings = {
  readonly mode: AgentMode;
  /** A model id from the deployment's catalogue (`model-catalogue.ts`); absent = the workspace default. */
  readonly model?: string;
  readonly effort: Effort;
  readonly media?: MediaSettings;
};

const ASPECT = /^(auto|\d{1,2}:\d{1,2})$/;
const MEDIA_MODEL = /^[a-z0-9_.-]{1,80}$/i;

/** Lenient like the rest: an unknown field is dropped, never a refusal. */
export const parseMediaSettings = (raw: unknown): MediaSettings | undefined => {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const kind: MediaSettings["kind"] = o["kind"] === "image" || o["kind"] === "video" ? o["kind"] : undefined;
  const aspectRatio = typeof o["aspectRatio"] === "string" && ASPECT.test(o["aspectRatio"]) ? o["aspectRatio"] : undefined;
  const model = typeof o["model"] === "string" && MEDIA_MODEL.test(o["model"]) ? o["model"] : undefined;
  const media = {
    ...(kind === undefined ? {} : { kind }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(media).length === 0 ? undefined : media;
};

export const DEFAULT_TURN_SETTINGS: TurnSettings = { mode: "auto", effort: "medium" };

const MODEL_ID = /^[a-z0-9][a-z0-9_.:/-]{0,79}$/i;

/**
 * Anything that is not exactly a known value falls back to the default, field by field.
 *
 * Lenient on purpose: a setting is a preference, and a malformed one must never refuse the turn. The
 * default for mode is `auto`, which is today's behaviour — so a client that sends nothing, or garbage,
 * gets the assistant it always had rather than a stricter or looser one.
 */
export const parseTurnSettings = (raw: unknown): TurnSettings => {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode = (AGENT_MODES as readonly string[]).includes(String(o["mode"])) ? (o["mode"] as AgentMode) : DEFAULT_TURN_SETTINGS.mode;
  const effort = (EFFORTS as readonly string[]).includes(String(o["effort"])) ? (o["effort"] as Effort) : DEFAULT_TURN_SETTINGS.effort;
  const model = typeof o["model"] === "string" && MODEL_ID.test(o["model"]) ? o["model"] : undefined;
  const media = parseMediaSettings(o["media"]);
  return { mode, effort, ...(model === undefined ? {} : { model }), ...(media === undefined ? {} : { media }) };
};

type RunReader = {
  findById(input: { tenantId: never; id: never }): Promise<{ readonly input?: unknown } | null>;
};

export type TurnInput = { readonly settings: TurnSettings; readonly message: string };

/**
 * The run's settings and message, read once per run.
 *
 * Cached by run id because four readers ask on every model call and tool call of a turn, and the row
 * does not change after admission. Bounded, so a long-lived worker does not keep every run it ever
 * served. A context with no run (a direct tool call, a test) gets the defaults — the same assistant.
 */
export const createTurnInputReader = (runs: RunReader, capacity = 500) => {
  const cache = new Map<string, Promise<TurnInput>>();
  return (context: ExecutionContext): Promise<TurnInput> => {
    const runId = context.runId === undefined ? undefined : String(context.runId);
    if (runId === undefined) return Promise.resolve({ settings: DEFAULT_TURN_SETTINGS, message: "" });
    const hit = cache.get(runId);
    if (hit !== undefined) return hit;
    const read = runs
      .findById({ tenantId: context.tenantId as never, id: runId as never })
      .then((run) => {
        const input = (run?.input ?? {}) as { settings?: unknown; message?: unknown };
        return { settings: parseTurnSettings(input.settings), message: typeof input.message === "string" ? input.message : "" };
      })
      // A read that fails is not cached: the next caller tries again rather than inheriting the failure.
      .catch((error: unknown) => {
        cache.delete(runId);
        console.warn(`[shareflow] run ${runId}'s settings could not be read (${error instanceof Error ? error.message : String(error)}); using the defaults.`);
        return { settings: DEFAULT_TURN_SETTINGS, message: "" };
      });
    cache.set(runId, read);
    if (cache.size > capacity) cache.delete(cache.keys().next().value as string);
    return read;
  };
};

export type TurnInputReader = ReturnType<typeof createTurnInputReader>;

/* ---- blocks inside the message ---- */

const block = (name: string) => new RegExp(`\\[${name}\\]\\n([\\s\\S]*?)\\n\\[/${name}\\]`, "g");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TurnReference = { readonly kind: "post" | "project_asset"; readonly id: string; readonly label: string };

/**
 * `[referenced]` — one line per item: `chorus:post/<uuid> <label>` or `chorus:project-asset/<uuid> <label>`.
 * Lines that do not match are ignored, never guessed at.
 */
export const referencesIn = (message: string): TurnReference[] => {
  const out: TurnReference[] = [];
  for (const match of message.matchAll(block("referenced"))) {
    for (const line of (match[1] ?? "").split("\n")) {
      const m = /^chorus:(post|project-asset)\/(\S+)\s*(.*)$/.exec(line.trim());
      if (m === null || !UUID.test(m[2]!)) continue;
      out.push({ kind: m[1] === "post" ? "post" : "project_asset", id: m[2]!.toLowerCase(), label: (m[3] ?? "").trim().slice(0, 120) });
    }
  }
  return out;
};

/** `[attached-media]` — one media-bucket path per line, already checked against the workspace by the web. */
export const attachmentsIn = (message: string): string[] => {
  const out: string[] = [];
  for (const match of message.matchAll(block("attached-media"))) {
    for (const line of (match[1] ?? "").split("\n")) {
      const path = line.trim();
      if (path !== "" && !path.includes("..") && /^[0-9a-f-]{36}\/[\w./-]+$/i.test(path)) out.push(path);
    }
  }
  return out;
};
