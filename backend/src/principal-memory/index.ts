/**
 * User-level (principal) memory — `docs/15` (referenced by REQ-006).
 *
 * Durable working memory scoped to a principal within a tenant: it persists across that principal's
 * conversations, and is never visible to another principal or tenant. Memories are *extracted* from
 * model output through a deterministic, validated, deduplicated step — raw model output is never
 * stored directly. A budgeted context provider retrieves only the relevant entries and tags each
 * with its provenance, so the context inspector can attribute which memories influenced a turn, and
 * so it can never crowd out recent turns or session state (it draws from the user-context bucket).
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext, Page, PageRequest, TenantScope } from "../core/context.js";
import type { PrincipalId } from "../core/ids.js";
import type { ContextProvider, ContextSection } from "../context/index.js";

export type PrincipalMemoryEntry = {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly text: string;
  readonly tags: readonly string[];
  /** Higher wins when retrieval is budget-limited. */
  readonly salience: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the user disables the entry; disabled entries are never retrieved for prompts. */
  readonly disabledAt?: string;
};

export type MemoryPatch = {
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly salience?: number;
  /** true disables, false re-enables. */
  readonly disabled?: boolean;
};

/**
 * Principal-scoped memory. Every method takes `{ tenantId, principalId }` explicitly, so a query can
 * never reach another principal's or tenant's memory. `delete` is a hard delete — a deleted entry
 * cannot resurface in a later prompt.
 */
export interface PrincipalMemoryStore {
  put(
    input: TenantScope & { principalId: PrincipalId; id?: string; text: string; tags?: readonly string[]; salience?: number },
  ): Promise<PrincipalMemoryEntry>;
  get(input: TenantScope & { principalId: PrincipalId; id: string }): Promise<PrincipalMemoryEntry | null>;
  list(input: TenantScope & { principalId: PrincipalId } & PageRequest): Promise<Page<PrincipalMemoryEntry>>;
  update(
    input: TenantScope & { principalId: PrincipalId; id: string; expectedVersion: number; patch: MemoryPatch },
  ): Promise<PrincipalMemoryEntry>;
  delete(input: TenantScope & { principalId: PrincipalId; id: string }): Promise<void>;
  /** Active (not disabled) entries relevant to `query`, most salient first, capped at `limit`. */
  retrieve(
    input: TenantScope & { principalId: PrincipalId; query?: string; limit: number },
  ): Promise<readonly PrincipalMemoryEntry[]>;
}

export const MEMORY_LIMITS = { textMaxLength: 1_000, maxTagsPerEntry: 8 } as const;

export type MemoryCandidate = { readonly text: string; readonly tags?: readonly string[]; readonly salience?: number };

const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The deterministic gate between model output and durable memory: trims, enforces bounds, and dedupes
 * candidates against each other and existing entries by normalized text. Returns the accepted
 * candidates to commit — so raw model output is never stored, only validated, unique memories.
 */
export const validateAndDedupe = (
  candidates: readonly MemoryCandidate[],
  existing: readonly PrincipalMemoryEntry[],
): readonly MemoryCandidate[] => {
  const seen = new Set(existing.map((e) => normalize(e.text)));
  const accepted: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (text.length === 0 || text.length > MEMORY_LIMITS.textMaxLength) continue;
    const key = normalize(text);
    if (seen.has(key)) continue; // duplicate of an existing or already-accepted memory
    seen.add(key);
    const tags = (candidate.tags ?? []).slice(0, MEMORY_LIMITS.maxTagsPerEntry);
    accepted.push({ text, tags, ...(candidate.salience === undefined ? {} : { salience: candidate.salience }) });
  }
  return accepted;
};

/** Commit extracted candidates, skipping duplicates. Returns the entries actually stored. */
export const commitExtractedMemories = async (
  store: PrincipalMemoryStore,
  input: TenantScope & { principalId: PrincipalId; candidates: readonly MemoryCandidate[] },
): Promise<readonly PrincipalMemoryEntry[]> => {
  const existing = (await store.list({ tenantId: input.tenantId, principalId: input.principalId, limit: 1_000 })).items;
  const accepted = validateAndDedupe(input.candidates, existing);
  const stored: PrincipalMemoryEntry[] = [];
  for (const c of accepted) {
    stored.push(
      await store.put({
        tenantId: input.tenantId,
        principalId: input.principalId,
        text: c.text,
        ...(c.tags ? { tags: c.tags } : {}),
        ...(c.salience === undefined ? {} : { salience: c.salience }),
      }),
    );
  }
  return stored;
};

/**
 * A budgeted context provider over principal memory. Retrieves only relevant, active entries under
 * `maxEntries`, and emits them as `user-context` sections — so they never crowd out recent turns
 * (history bucket) or session state. Each section's provenance carries the entry id for attribution.
 */
export const createPrincipalMemoryProvider = (config: {
  readonly store: PrincipalMemoryStore;
  readonly maxEntries?: number;
  readonly estimateTokens?: (text: string) => number;
  /** Optional query derived from the turn (e.g. the latest user message) to focus retrieval. */
  readonly queryOf?: (context: ExecutionContext) => string | undefined;
}): ContextProvider => {
  const maxEntries = config.maxEntries ?? 8;
  const estimate = config.estimateTokens ?? ((t: string) => Math.ceil(t.length / 4));
  return {
    id: "principal-memory",
    async provide(context) {
      const entries = await config.store.retrieve({
        tenantId: context.tenantId,
        principalId: context.principalId,
        ...(config.queryOf?.(context) ? { query: config.queryOf(context)! } : {}),
        limit: maxEntries,
      });
      return entries.map<ContextSection>((e) => ({
        providerId: "principal-memory",
        title: `Memory: ${e.tags.join(", ") || e.id}`,
        body: e.text,
        priority: e.salience,
        estimatedTokens: estimate(e.text),
        provenance: `principal-memory:${e.id}`, // lets the context inspector attribute the turn
        sensitivity: "confidential",
        cacheable: false,
        kind: "user-context",
        pruneStage: "old-knowledge",
      }));
    },
  };
};

export const memoryConflict = (message: string): AgentPlatformError =>
  new AgentPlatformError({ code: "conflict", message, retryable: false });
