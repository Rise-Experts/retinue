/**
 * `PersonalMemoryService` over agentkit's `PrincipalMemoryStore` — #621.
 *
 * What the assistant remembers about **a person** ("writes in British English", "prefers captions without
 * emoji", "is called Sam"), across every chat they have in the workspace. The project's own rules are a
 * different thing and a different table (`project_memories`, `remember_project_rule`): a project's rule is
 * shared by everyone in the project, a person's preference is theirs alone.
 *
 * ## Whose memory, and why no argument names it
 *
 * The store is keyed `(tenant_id, principal_id, id)` — agentkit's `principal_memory`, migration
 * `0011_principal_memory_blobs`. Every method here reads the tenant and the principal from the
 * `ExecutionContext` and from nowhere else: the turn's context in a conversation, the authenticated caller's in
 * the settings route. There is no input field a model or a browser could fill with somebody else's id, which is
 * the same structural guarantee the store makes one layer down.
 *
 * ## The cap is the prompt's size
 *
 * `retrieve` orders by salience, then oldest first, and the provider takes `PERSONAL_MEMORY_PROMPT_ENTRIES`.
 * With more enabled memories than that, the newest would be stored, listed in settings, and silently never
 * reach a prompt — the "remembered but ignored" failure. So the number a person may keep switched on **is** the
 * number a prompt carries, and past it `remember` refuses and says to forget one.
 */

import { AgentPlatformError, type ExecutionContext, type PrincipalId } from "@retinue/agentkit";
import { MEMORY_LIMITS, commitExtractedMemories, type PrincipalMemoryEntry, type PrincipalMemoryStore } from "@retinue/agentkit/context";

import type { PersonalMemory, PersonalMemoryService } from "../services/index.js";

/** How many memories a prompt carries — and so how many a person may keep switched on. */
export const PERSONAL_MEMORY_PROMPT_ENTRIES = 12;
/** agentkit's own bound (1,000), which its table's CHECK constraint enforces as well. */
export const PERSONAL_MEMORY_MAX_CHARS = MEMORY_LIMITS.textMaxLength;
export const PERSONAL_MEMORY_MIN_CHARS = 3;
/** More than any person has; `commitExtractedMemories` reads the same page size for its dedupe. */
const LIST_LIMIT = 1_000;

const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/** Luhn, so an order number or a phone number is not mistaken for a card. */
const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  // "my password is …", "Passwort: …", "the PIN is 1234", "API key = …"
  {
    pattern:
      /\b(pass ?(word|wort|code|phrase)|kennwort|pin(-?code)?|api[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|client[-_ ]?secret|token|private[-_ ]?key|zugangsdaten)(?:\s+(?:for|für|of|von|zu)\s+\S+)?\s*(?:\bis\b|\bist\b|\blautet\b|:|=)\s*\S/i,
    what: "a password, PIN, key or token",
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
  { pattern: /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/, what: "an API key" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: "an access key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: "an access token" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: "an access token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/, what: "an API key" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, what: "a token" },
  // An IBAN: two letters, two check digits, then 11–30 alphanumerics (spaces allowed in groups of four).
  { pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/, what: "a bank account number" },
];

/**
 * Why this text must not be remembered, or `null` when it may be.
 *
 * A deliberately simple guard — the prompt already says never to save secrets, and this is what holds when the
 * model does it anyway. It refuses what would be harmful to keep in a table that reaches every future prompt: a
 * password or PIN stated as such, a string shaped like an API key or token, a card number (Luhn-checked), an
 * IBAN, and any long opaque string mixing letters and digits.
 */
export const sensitiveReason = (text: string): string | null => {
  for (const { pattern, what } of SECRET_PATTERNS) if (pattern.test(text)) return what;
  for (const match of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return "a card number";
  }
  for (const token of text.split(/\s+/)) {
    const bare = token.replace(/^[("'`]+|[)"'`.,;:!?]+$/g, "");
    if (bare.length >= 32 && /^[A-Za-z0-9_\-+/=]+$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare)) return "a key or token";
  }
  return null;
};

const toMemory = (entry: PrincipalMemoryEntry): PersonalMemory => ({
  id: entry.id,
  text: entry.text,
  enabled: entry.disabledAt === undefined,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

/** The tenant and principal of the context, refused when either is missing — never defaulted. */
const scopeOf = (context: ExecutionContext): { readonly tenantId: ExecutionContext["tenantId"]; readonly principalId: PrincipalId } => {
  const tenantId = String(context.tenantId ?? "");
  const principalId = String(context.principalId ?? "");
  if (tenantId === "" || principalId === "") {
    throw new AgentPlatformError({ code: "forbidden", message: "Personal memory needs a signed-in person in a workspace.", retryable: false });
  }
  return { tenantId: context.tenantId, principalId: context.principalId };
};

const notFound = () =>
  new AgentPlatformError({ code: "not_found", message: "You have no memory with that id. List them with the About you section, or in Settings → Memory.", retryable: false });

export const createPersonalMemoryService = (deps: { readonly store: PrincipalMemoryStore }): PersonalMemoryService => {
  const { store } = deps;
  const all = async (context: ExecutionContext): Promise<readonly PrincipalMemoryEntry[]> =>
    (await store.list({ ...scopeOf(context), limit: LIST_LIMIT })).items;

  const update = async (context: ExecutionContext, id: string, disabled: boolean): Promise<PrincipalMemoryEntry> => {
    // One retry on a stale version: a person clicking twice in settings is the only concurrent writer.
    for (let attempt = 0; ; attempt += 1) {
      const current = await store.get({ ...scopeOf(context), id });
      if (current === null) throw notFound();
      try {
        return await store.update({ ...scopeOf(context), id, expectedVersion: current.version, patch: { disabled } });
      } catch (error) {
        if (attempt === 0 && error instanceof AgentPlatformError && error.code === "conflict") continue;
        throw error;
      }
    }
  };

  const enabledCount = (entries: readonly PrincipalMemoryEntry[]): number => entries.filter((e) => e.disabledAt === undefined).length;

  const fullRefusal = () =>
    new AgentPlatformError({
      code: "conflict",
      message:
        `You already have ${PERSONAL_MEMORY_PROMPT_ENTRIES} memories switched on, which is all a chat can carry. ` +
        "Ask the person which one to forget (Settings → Memory lists them) before remembering another.",
      retryable: false,
    });

  return {
    async list(context) {
      return (await all(context)).map(toMemory);
    },

    async remember(context, input) {
      const text = input.text.replace(/\s+/g, " ").trim();
      if (text.length < PERSONAL_MEMORY_MIN_CHARS || text.length > PERSONAL_MEMORY_MAX_CHARS) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `A memory is ${PERSONAL_MEMORY_MIN_CHARS} to ${PERSONAL_MEMORY_MAX_CHARS} characters — one short sentence.`,
          retryable: false,
        });
      }
      const sensitive = sensitiveReason(text);
      if (sensitive !== null) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `Not remembered: that looks like ${sensitive}. Secrets, passwords, keys and payment details are never kept in memory — tell the person so.`,
          retryable: false,
        });
      }
      const existing = await all(context);
      const same = existing.find((entry) => normalize(entry.text) === normalize(text));
      if (same !== undefined) return { memory: toMemory(same), duplicate: true };
      if (enabledCount(existing) >= PERSONAL_MEMORY_PROMPT_ENTRIES) throw fullRefusal();

      // The platform's gate: validated, bounded, deduplicated against what is stored — never raw model output.
      const [stored] = await commitExtractedMemories(store, { ...scopeOf(context), candidates: [{ text }] });
      if (stored === undefined) {
        // Only reachable if a concurrent write stored the same text between the list and the commit.
        const again = (await all(context)).find((entry) => normalize(entry.text) === normalize(text));
        if (again === undefined) throw new AgentPlatformError({ code: "conflict", message: "That memory could not be stored. Try again.", retryable: true });
        return { memory: toMemory(again), duplicate: true };
      }
      return { memory: toMemory(stored), duplicate: false };
    },

    async forget(context, input) {
      const hasId = input.id !== undefined && input.id.trim() !== "";
      const hasText = input.text !== undefined && input.text.trim() !== "";
      if (hasId === hasText) {
        throw new AgentPlatformError({ code: "invalid_input", message: "Pass either the memory's id or some of its text, not both.", retryable: false });
      }
      if (hasId) {
        const entry = await store.get({ ...scopeOf(context), id: input.id!.trim() });
        if (entry === null) throw notFound();
        await store.delete({ ...scopeOf(context), id: entry.id });
        return { forgotten: [toMemory(entry)] };
      }
      const wanted = normalize(input.text!);
      const entries = await all(context);
      const exact = entries.filter((entry) => normalize(entry.text) === wanted);
      const matches = exact.length > 0 ? exact : entries.filter((entry) => normalize(entry.text).includes(wanted));
      if (matches.length === 0) {
        throw new AgentPlatformError({ code: "not_found", message: "Nothing you have asked me to remember matches that.", retryable: false });
      }
      // Several matches forget nothing: which one the person meant is theirs to say.
      if (matches.length > 1) return { forgotten: [], matches: matches.map(toMemory) };
      await store.delete({ ...scopeOf(context), id: matches[0]!.id });
      return { forgotten: [toMemory(matches[0]!)] };
    },

    async setEnabled(context, input) {
      if (input.enabled) {
        const entries = await all(context);
        const target = entries.find((entry) => entry.id === input.id);
        if (target === undefined) throw notFound();
        if (target.disabledAt === undefined) return toMemory(target);
        if (enabledCount(entries) >= PERSONAL_MEMORY_PROMPT_ENTRIES) throw fullRefusal();
      }
      return toMemory(await update(context, input.id, !input.enabled));
    },

    async remove(context, input) {
      const entry = await store.get({ ...scopeOf(context), id: input.id });
      if (entry === null) return { deleted: false };
      await store.delete({ ...scopeOf(context), id: entry.id });
      return { deleted: true };
    },
  };
};
