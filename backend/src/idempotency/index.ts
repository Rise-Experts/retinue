/**
 * Idempotency contract — `docs/04-durable-runtime-and-hitl.md`. **Frozen v1.**
 *
 * Every external/destructive tool call carries a key derived from tenant + run + tool-call
 * identity. A resumed or retried call returns the original result instead of repeating the side
 * effect — the pairing that makes Claude-style retries safe.
 */

import type { RunId, TenantId, ToolCallId } from "../core/ids.js";

const brand = Symbol("IdempotencyKey");
export type IdempotencyKey = string & { readonly [brand]: "IdempotencyKey" };

/**
 * Pure and deterministic: the same (tenant, run, tool-call) always yields the same key, so a
 * retry of the same logical call collides with its first attempt.
 */
export const deriveIdempotencyKey = (input: {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly toolCallId: ToolCallId;
}): IdempotencyKey =>
  `${input.tenantId}:${input.runId}:${input.toolCallId}` as IdempotencyKey;

/**
 * A stable string for a value.
 *
 * Object keys are sorted, because `{a, b}` and `{b, a}` are the same arguments and must not produce
 * two keys — the whole point of a key is that an identical call collides with itself.
 */
export const canonicalizeArgs = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalizeArgs).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeArgs(v)}`).join(",")}}`;
};

/** FNV-1a over the canonical form. Bounds the key's length without needing a crypto dependency. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * The key for a call the runtime identifies by its **arguments** rather than by a provider tool-call
 * id (`docs/04` → Approvals, Idempotency).
 *
 * A resumed approval has no tool-call id to derive from: the call it executes came off a stored
 * interaction, not out of a model stream. Two properties matter, and they pull in opposite directions.
 * It is **run-scoped**, so "publish this" today and the same call next week do not collide — a key
 * shared across runs would return the first result and never publish the second. And it is
 * **argument-derived**, so within one run the same logical call collides with itself: the model
 * re-asking for a publish it already asked for finds the same approval and the same stored result,
 * rather than a second approval and a second publish.
 *
 * Derive it from *normalised* arguments. A schema that lowercases a channel would otherwise give one
 * logical call two keys, and the second would not see the first's result.
 */
export const deriveCallIdempotencyKey = (input: {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly toolName: string;
  readonly args: unknown;
}): IdempotencyKey =>
  deriveIdempotencyKey({
    tenantId: input.tenantId,
    runId: input.runId,
    toolCallId: `${input.toolName}:${fnv1a(canonicalizeArgs(input.args))}` as ToolCallId,
  });

/** Wraps a stored result so a repeated call can return it without re-executing. */
export type IdempotentResult<T> = {
  readonly key: IdempotencyKey;
  /** True on the first execution; false when the stored result is returned. */
  readonly firstSeen: boolean;
  readonly result: T;
};

/** Persists and returns prior results by key. Adapter lands with persistence (#17+). */
export interface IdempotencyStore {
  get<T>(input: { tenantId: TenantId; key: IdempotencyKey }): Promise<IdempotentResult<T> | null>;
  put<T>(input: { tenantId: TenantId; key: IdempotencyKey; result: T }): Promise<void>;
}
