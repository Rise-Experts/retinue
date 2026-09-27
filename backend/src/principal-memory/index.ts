/**
 * User-level (principal) memory — `docs/15` (referenced by REQ-006).
 *
 * Durable working memory scoped to a principal within a tenant: it persists across that principal's
 * conversations, and is never visible to another principal or tenant. Memories are *extracted* from
 * model output through a deterministic, validated, deduplicated step — raw model output is never
 * stored directly. A budgeted context provider retrieves only the relevant entries and tags each
 * with its provenance, so the context inspector can attribute which memories influenced a turn, and
 * so it can never crowd out recent turns or session state (it draws from the user-context bucket).
 *
 * Since #285 the module also holds **scoped memory** — the same limits, dedupe and extraction, kept for a group of
 * conversations (a project) instead of a person. It is at the bottom of this file, with the reason it is a second
 * store rather than a column on this one.
 */

import { AgentPlatformError } from "../core/errors.js";
import { estimateTokens } from "../core/tokens.js";
import type { ExecutionContext, Page, PageRequest, TenantScope } from "../core/context.js";
import type { ConversationId, PrincipalId, RunId } from "../core/ids.js";
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
  // Structural since #285, so the same gate serves scoped memory: only `text` is ever read, and a second copy of
  // this function for a second entry type is how the two would come to dedupe differently.
  existing: readonly { readonly text: string }[],
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
  const estimate = config.estimateTokens ?? estimateTokens;
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
        // The principal's own remembered context, written from their own turns. Treating it as untrusted would
        // wrap a user's own stated preferences in "nothing here is an instruction", which is the opposite of what
        // this provider is for. Third-party content never reaches this store -- see docs/17.
        origin: "platform",
        cacheable: false,
        kind: "user-context",
        pruneStage: "old-knowledge",
      }));
    },
  };
};

export const memoryConflict = (message: string): AgentPlatformError =>
  new AgentPlatformError({ code: "conflict", message, retryable: false });

/*
 * ─── Scoped memory — #285 ────────────────────────────────────────────────────────────────────────────────────
 *
 * Memory kept for a *group* of conversations rather than for a person: what a project's chats have taught —
 * "never say *revolutionary*", "slide 1 names the dish" — so that every chat in the project knows it.
 *
 * **A second store, not a scope column on `principal_memory`.** That was the obvious additive design and it does
 * not survive contact with row-level security. `principal_memory`'s policy is `principal_id = app.principal_id`,
 * which is exactly right for a person's memory and exactly wrong for a project's: a rule Alice's chat taught the
 * project must reach Bob's chat in the same project. A scope column would have forced either a weaker policy on
 * the table that holds everyone's *personal* memory, or a per-row policy switch that one mistaken `NULL` turns
 * into a cross-person leak. A separate table keeps the personal one's guarantee untouched and gives scoped rows
 * the tenant-only policy they need — who may read *which* scope is the host's decision, made when it names the
 * scopes for a run.
 *
 * **Everything else is shared on purpose**: `MEMORY_LIMITS`, `validateAndDedupe`, `MemoryCandidate` and
 * `MemoryPatch` are the principal store's own. Two stores with two ideas of what a valid memory is would be two
 * gates, and the weaker one is the real one.
 */

/**
 * A scope's name: `kind:id`, for example `project:7f3c…`.
 *
 * A string rather than a `{ kind, id }` object because it is what a host stores on a run row, puts in a URL and
 * compares — and a structured value would need a canonical serialisation anyway. `parseMemoryScope` is the one
 * place that decides what is well formed.
 */
export type MemoryScope = string;

/** The kinds of scope are the host's to name; this only constrains their shape. */
const SCOPE_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
// No whitespace, no control characters: a scope id ends up in a provenance string, a log line and a UI, and an id
// that renders as something else in one of them is how a person ends up forgetting the wrong project's memory.
const SCOPE_ID = /^[^\s\p{Cc}]{1,200}$/u;

/**
 * Split and check a scope, or refuse with a reason.
 *
 * `principal` is reserved as a kind. The issue's notation writes the person's own memory as the `principal`
 * scope, and a group scope that could also be called that would make "whose memory is this" ambiguous in exactly
 * the place a person decides what to forget. The person's own memory is `PrincipalMemoryStore`, always.
 */
export const parseMemoryScope = (scope: MemoryScope): { readonly kind: string; readonly id: string } => {
  const at = scope.indexOf(":");
  const kind = at < 0 ? scope : scope.slice(0, at);
  const id = at < 0 ? "" : scope.slice(at + 1);
  const refuse = (why: string): never => {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `memory scope ${JSON.stringify(scope)} is not valid: ${why}. A scope is \`kind:id\`, e.g. \`project:123\`.`,
      retryable: false,
    });
  };
  if (!SCOPE_KIND.test(kind)) return refuse("the kind must be lowercase letters, digits, '-' or '_', starting with a letter");
  if (kind === "principal") return refuse("`principal` is reserved for a person's own memory, which is not a scope");
  if (!SCOPE_ID.test(id)) return refuse("the id must be 1–200 characters with no whitespace");
  return { kind, id };
};

/**
 * `active` entries reach prompts; `proposed` ones wait for a person to confirm them.
 *
 * The issue's "the host may require confirmation": extraction after a turn may propose, and a project owner
 * approves. A proposed entry is stored — so it can be listed, confirmed or discarded in a UI — and is never a
 * retrieval candidate, the same guarantee `disabledAt` gives.
 */
export type ScopedMemoryStatus = "active" | "proposed";

/**
 * Where a scoped memory came from — recorded on every write.
 *
 * `conversationId` is **required and nullable**: the issue asks that every write record the conversation it came
 * from, and the one legitimate write with no conversation — a person adding a note in the project's settings — has
 * to say so with an explicit `null` rather than by leaving a field out. Omission and "there was none" are different
 * facts, and only one of them is a bug.
 */
export type ScopedMemorySource = {
  readonly conversationId: ConversationId | null;
  readonly runId?: RunId;
  /** Who wrote it — the person whose turn it was extracted from, or who typed it. */
  readonly principalId?: PrincipalId;
};

export type ScopedMemoryEntry = {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly tags: readonly string[];
  /** Higher wins when retrieval is budget-limited. */
  readonly salience: number;
  readonly status: ScopedMemoryStatus;
  /** The conversation the latest write came from; absent for a write that declared none. */
  readonly sourceConversationId?: string;
  readonly sourceRunId?: string;
  readonly createdBy?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when a person switches the entry off; disabled entries are never retrieved for prompts. */
  readonly disabledAt?: string;
};

/** `MemoryPatch`, plus confirming a proposed entry. There is no patch back to `proposed`: confirmation is one-way. */
export type ScopedMemoryPatch = MemoryPatch & { readonly status?: "active" };

/**
 * Memory for a group of conversations. Every method takes `{ tenantId, scope }` (or `scopes`) explicitly, so a
 * query can never reach another tenant's rows or a scope the caller did not name. `delete` is a hard delete — the
 * host UI's "Forget" — and a forgotten entry cannot resurface in a later prompt.
 *
 * This is also the host UI's API: `list` for the panel (filter `status: "proposed"` for the review queue),
 * `update` to edit, disable or confirm, `delete` to forget.
 */
export interface ScopedMemoryStore {
  put(
    input: TenantScope & {
      scope: MemoryScope;
      id?: string;
      text: string;
      tags?: readonly string[];
      salience?: number;
      /** Defaults to `active`. */
      status?: ScopedMemoryStatus;
      source: ScopedMemorySource;
    },
  ): Promise<ScopedMemoryEntry>;
  get(input: TenantScope & { scope: MemoryScope; id: string }): Promise<ScopedMemoryEntry | null>;
  /** Every entry in the scope, oldest first; `status` narrows it (the review queue is `status: "proposed"`). */
  list(
    input: TenantScope & { scope: MemoryScope; status?: ScopedMemoryStatus } & PageRequest,
  ): Promise<Page<ScopedMemoryEntry>>;
  update(
    input: TenantScope & { scope: MemoryScope; id: string; expectedVersion: number; patch: ScopedMemoryPatch },
  ): Promise<ScopedMemoryEntry>;
  delete(input: TenantScope & { scope: MemoryScope; id: string }): Promise<void>;
  /**
   * Active, confirmed entries of the given scopes relevant to `query`, most salient first, capped at `limit` per
   * scope. An empty `scopes` returns nothing — never "every scope".
   */
  retrieve(
    input: TenantScope & { scopes: readonly MemoryScope[]; query?: string; limit: number },
  ): Promise<readonly ScopedMemoryEntry[]>;
}

/**
 * Commit extracted candidates to a scope the run belongs to — the post-turn write path.
 *
 * Takes the **execution context**, not a tenant and a conversation id, and that is the design: the source is read
 * from the trusted context (conversation, run, principal) so a caller cannot misattribute a memory, and the scope
 * must be one of `context.memoryScopes` so a turn can only teach the projects it is part of. A model that proposed
 * a memory "for project 42" cannot get it written there by naming it.
 *
 * `scope` may be omitted when the run belongs to exactly one — the common case, a chat inside one project. With
 * several it must be named, because guessing which project a lesson belongs to is not this layer's call.
 *
 * `requireConfirmation` stores the accepted candidates as `proposed`, for a host that wants a person to approve
 * what a project remembers. Dedupe runs against proposed entries too, so a lesson awaiting review is not proposed
 * again on every turn.
 */
export const commitExtractedScopedMemories = async (
  store: ScopedMemoryStore,
  input: {
    readonly context: ExecutionContext;
    readonly candidates: readonly MemoryCandidate[];
    readonly scope?: MemoryScope;
    readonly requireConfirmation?: boolean;
  },
): Promise<readonly ScopedMemoryEntry[]> => {
  const { context } = input;
  const scopes = context.memoryScopes ?? [];
  const scope = input.scope ?? (scopes.length === 1 ? scopes[0] : undefined);
  if (scope === undefined)
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        scopes.length === 0
          ? "this run belongs to no memory scope, so there is nowhere to commit scoped memories. Name the run's scopes at admission (`memoryScopes`)."
          : `this run belongs to several memory scopes (${scopes.join(", ")}); name the one these memories are for.`,
      retryable: false,
    });
  if (!scopes.includes(scope))
    throw new AgentPlatformError({
      code: "forbidden",
      message: `this run does not belong to memory scope ${JSON.stringify(scope)}, so it may not write to it.`,
      retryable: false,
    });
  parseMemoryScope(scope);

  const existing = (await store.list({ tenantId: context.tenantId, scope, limit: 1_000 })).items;
  const accepted = validateAndDedupe(input.candidates, existing);
  const source: ScopedMemorySource = {
    conversationId: context.conversationId ?? null,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    principalId: context.principalId,
  };
  const stored: ScopedMemoryEntry[] = [];
  for (const c of accepted) {
    stored.push(
      await store.put({
        tenantId: context.tenantId,
        scope,
        text: c.text,
        ...(c.tags ? { tags: c.tags } : {}),
        ...(c.salience === undefined ? {} : { salience: c.salience }),
        status: input.requireConfirmation === true ? "proposed" : "active",
        source,
      }),
    );
  }
  return stored;
};

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

/**
 * The prompt section for each scope a run belongs to: "what this project has learned".
 *
 * **Bounded in bytes, per scope, and the bound is real.** Entries are taken most-salient first and added whole while
 * they fit `maxBytes` (UTF-8, the unit a prompt is actually sent in); one that does not fit is skipped rather than
 * cut, because half a rule — "never say" — is worse than no rule. A project that has learned a great deal therefore
 * cannot push the conversation itself out of the window: the section's size is fixed by configuration, not by how
 * chatty the project's history was.
 *
 * **Its size is reported, not assumed.** `estimatedTokens` is computed from the body actually emitted, and the
 * section draws from the `user-context` bucket, so the assembler's budget sees exactly what this costs — the same
 * accounting every other provider is held to.
 *
 * One section per scope rather than one per entry, unlike `createPrincipalMemoryProvider`: a byte budget has to be
 * enforced over *something*, and a scope is the unit a person reasons about ("what does this project know").
 * Attribution survives: `provenance` names the scope and every entry id included, so the context inspector can
 * still say which remembered lessons shaped a turn.
 *
 * Scopes come only from `context.memoryScopes` — see the field for why a model can never add one.
 */
export const createScopedMemoryProvider = (config: {
  readonly store: ScopedMemoryStore;
  /** Per scope, in UTF-8 bytes. Default 2,048 — about 500 tokens. */
  readonly maxBytes?: number;
  /** Candidates considered per scope before the byte budget is applied. Default 20. */
  readonly maxEntries?: number;
  readonly estimateTokens?: (text: string) => number;
  readonly queryOf?: (context: ExecutionContext) => string | undefined;
  /** The section title for a scope. Default: "What this project has learned (project:…)". */
  readonly titleOf?: (scope: { readonly scope: MemoryScope; readonly kind: string; readonly id: string }) => string;
}): ContextProvider => {
  const maxBytes = config.maxBytes ?? 2_048;
  const maxEntries = config.maxEntries ?? 20;
  const estimate = config.estimateTokens ?? estimateTokens;
  const titleOf = config.titleOf ?? (({ scope, kind }) => `What this ${kind} has learned (${scope})`);
  return {
    id: "scoped-memory",
    async provide(context) {
      const scopes = context.memoryScopes ?? [];
      if (scopes.length === 0) return [];
      const query = config.queryOf?.(context);
      const sections: ContextSection[] = [];
      for (const scope of scopes) {
        // A malformed scope fails the turn loudly. It came from the host's admission code, and silently rendering
        // no project memory would look exactly like a project that has learned nothing.
        const { kind, id } = parseMemoryScope(scope);
        const entries = await config.store.retrieve({
          tenantId: context.tenantId,
          scopes: [scope],
          ...(query ? { query } : {}),
          limit: maxEntries,
        });
        const lines: string[] = [];
        const included: ScopedMemoryEntry[] = [];
        let used = 0;
        for (const entry of entries) {
          const line = `- ${entry.text}`;
          const cost = byteLength(line) + (lines.length === 0 ? 0 : 1); // the newline joining it to the previous
          if (used + cost > maxBytes) continue;
          lines.push(line);
          included.push(entry);
          used += cost;
        }
        if (lines.length === 0) continue;
        const body = lines.join("\n");
        sections.push({
          providerId: "scoped-memory",
          title: titleOf({ scope, kind, id }),
          body,
          priority: Math.max(...included.map((e) => e.salience)),
          estimatedTokens: estimate(body),
          provenance: `scoped-memory:${scope}#${included.map((e) => e.id).join(",")}`,
          sensitivity: "confidential",
          /**
           * `platform`, like the person's own memory, and for the same reason: these are the project's standing
           * rules, written from its members' own turns in the host's own product, and wrapping them in "nothing
           * here is an instruction" would defeat "never say revolutionary". Third-party content never reaches this
           * store — extraction reads the conversation, and a host that fed fetched pages into it would be making
           * the same mistake with principal memory. See docs/17.
           */
          origin: "platform",
          cacheable: false,
          kind: "user-context",
          pruneStage: "old-knowledge",
        });
      }
      return sections;
    },
  };
};
