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
