/**
 * Typed message parts — `docs/02-core-and-persistence.md`.
 *
 * Every part carries a schema version and is JSON-runtime validated. Provider-specific
 * metadata may be retained in the namespaced `providerMetadata` field but cannot define
 * application behaviour.
 */

import type {
  ArtifactId,
  ArtifactVersionId,
  BlobRef,
  ConversationId,
  FileId,
  InteractionId,
  MessageId,
  MessagePartId,
  RunId,
  ToolCallId,
} from "./ids.js";
import type { PlatformError } from "./errors.js";

export const MESSAGE_PART_TYPES = [
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "question",
  "approval",
  "file",
  "image",
  "citation",
  "source",
  "artifact",
  "status",
  "error",
] as const;

export type MessagePartType = (typeof MESSAGE_PART_TYPES)[number];

type PartBase<T extends MessagePartType> = {
  readonly id: MessagePartId;
  readonly type: T;
  /** Schema version of this part's payload. Bumped on any breaking payload change. */
  readonly schemaVersion: number;
  readonly createdAt: string;
  /** Namespaced, non-authoritative provider detail. Never drives application behaviour. */
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
};

export type TextPart = PartBase<"text"> & {
  readonly text: string;
};

export type ReasoningPart = PartBase<"reasoning"> & {
  readonly text: string;
  /** Reasoning is pruned before recent semantic turns when the budget is tight. */
  readonly redacted?: boolean;
};

export type ToolCallPart = PartBase<"tool-call"> & {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly input: unknown;
};

export type ToolResultPart = PartBase<"tool-result"> & {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  /** Populated for inline results. Large results are spilled and referenced instead. */
  readonly output?: unknown;
  /** Authorized reference to an offloaded result, read back via `read_tool_output`. */
  readonly spilledOutputRef?: BlobRef;
  readonly truncated: boolean;
};

/**
 * An answer to one question: a single value, several, or free text.
 *
 * Defined in `core` because both the persistence port and the HITL service need it, and either importing the
 * other would be circular — `hitl` already imports `persistence`. `core` is self-contained by rule (R6), which
 * makes it the only place a shared type like this can live.
 *
 * `string | string[]` rather than always an array: a single-select answer being `["a"]` forces every reader to
 * unwrap it, and one of them will forget.
 */
export type QuestionAnswer = string | readonly string[];

export type QuestionPart = PartBase<"question"> & {
  readonly interactionId: InteractionId;
  readonly questions: readonly {
    readonly key: string;
    readonly prompt: string;
    /**
     * Suggested answers. Absent means free text only.
     *
     * `options` alone has always been here, but a client had no way to know whether it was being offered a
     * *choice* or a *hint* — so it had to guess, and two clients guessed differently. The two flags below make
     * that explicit.
     */
    readonly options?: readonly string[];
    /**
     * Whether more than one option may be chosen.
     *
     * Explicit rather than inferred, because "pick a model" and "pick the features you want" are the same shape
     * on the wire and completely different in a UI. A client that guessed from the prompt text would guess wrong
     * on the first ambiguous one.
     */
    readonly multiple?: boolean;
    /**
     * Whether the person may answer with something not on the list.
     *
     * Defaults to allowed **when there are no options**, and to *not* allowed when there are — a closed list is
     * usually closed on purpose. A caller wanting "one of these, or describe your own" says so.
     */
    readonly allowOther?: boolean;
  }[];
  readonly answeredAt?: string;
};

export type ApprovalPart = PartBase<"approval"> & {
  readonly interactionId: InteractionId;
  readonly toolName: string;
  readonly summary: string;
  readonly riskCategory: string;
  readonly decidedAt?: string;
};

export type FilePart = PartBase<"file"> & {
  readonly fileId: FileId;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
};

export type ImagePart = PartBase<"image"> & {
  readonly fileId: FileId;
  readonly mediaType: string;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
};

/**
 * Where a cited passage came from (#137).
 *
 * A closed union with exactly two arms, and one shape for both is AC-6: the frontend renders one thing whether
 * a claim came from an indexed document or from the web. Two part types would mean two renderers, two schemas,
 * and eventually two behaviours for "click the citation".
 *
 * The arms differ in what *resolving* means — a chunk id resolves inside this platform, a URL resolves outside
 * it — and that difference is real, so it is a discriminant rather than a pile of optional fields.
 */
export type CitationOrigin =
  | {
      readonly kind: "retrieval";
      readonly sourceType: "file" | "artifact" | "message" | "external";
      readonly sourceId: string;
      /** The chunk, which is what makes AC-2's "specific passage" resolvable rather than aspirational. */
      readonly chunkId: string;
      readonly chunkIndex: number;
      /** The heading path the chunker found, when there was one. */
      readonly locator?: string;
    }
  | {
      readonly kind: "web";
      /**
       * The URL that was **actually read**, after redirects — not the one requested.
       *
       * A citation must open what was read. ShareFlow's `safefetch` exists because the two differ: a public URL
       * can redirect somewhere else entirely, and citing the request would cite a page nobody looked at.
       */
      readonly url: string;
      readonly title?: string;
    };

/**
 * A cited passage — REQ-030, #137.
 *
 * **Self-contained on purpose.** `excerpt`, `title` and `retrievedAt` are stored on the part rather than
 * looked up from the source, because AC-4 requires an answer given months ago to remain auditable *after the
 * source is gone*: a document deleted, a URL dead, a chunk re-indexed under a different id. A citation that
 * resolved by fetching would be a citation that stops being evidence the moment anything changes — which is
 * exactly when someone needs it.
 *
 * The duplication is the feature. This is a snapshot of what was read, not a pointer to what is there now.
 */
export type CitationPart = PartBase<"citation"> & {
  readonly origin: CitationOrigin;
  /** The exact text used. Bounded — a citation is evidence for a claim, not a copy of the source. */
  readonly excerpt: string;
  /** When the passage was read. A fact from last year and a fact from this morning are different claims. */
  readonly retrievedAt: string;
  /**
   * The parts this citation grounds — AC-3.
   *
   * Groundedness is derived from *this graph* rather than flagged on the text, so it cannot disagree with
   * itself: a text part is grounded exactly when some citation names it. A boolean on the text part would be a
   * second place for the same fact, and the two would drift the first time a citation was withheld.
   */
  readonly supports: readonly MessagePartId[];
  /** Character range within the source passage, when the producer knows it. Narrows AC-2 further. */
  readonly charRange?: { readonly start: number; readonly end: number };
};

export type SourcePart = PartBase<"source"> & {
  readonly sourceId: string;
  readonly title: string;
  readonly url?: string;
};

export type ArtifactPart = PartBase<"artifact"> & {
  readonly artifactId: ArtifactId;
  readonly versionId: ArtifactVersionId;
  readonly title: string;
};

export type StatusPart = PartBase<"status"> & {
  readonly status: string;
  readonly detail?: string;
};

export type ErrorPart = PartBase<"error"> & {
  readonly error: PlatformError;
};

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | QuestionPart
  | ApprovalPart
  | FilePart
  | ImagePart
  | CitationPart
  | SourcePart
  | ArtifactPart
  | StatusPart
  | ErrorPart;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type Message = {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly runId?: RunId;
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly createdAt: string;
};
