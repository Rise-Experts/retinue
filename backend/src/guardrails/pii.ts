/**
 * Personal data, detected and redacted — REQ-046 (#205), task #212.
 *
 * Deterministic and **offline**. No network call, no model call: a guardrail that costs a round trip per turn is
 * one a deployment switches off under load, and the moment it is off is the moment it was needed. Everything
 * here is a pattern plus, where one exists, a checksum.
 *
 * ## Why a checksum matters more than a pattern
 *
 * A sixteen-digit order number matches every "card number" regex ever written. Flagging it teaches people that
 * this guardrail cries wolf, and a guardrail people have learned to ignore is worse than none — they route
 * around it. So card numbers are Luhn-checked and IBANs mod-97-checked, and a candidate that fails its checksum
 * is *not* personal data, it is a number.
 *
 * ## Referential consistency, without state
 *
 * A placeholder is derived from a hash of the value, so the same value always yields the same placeholder —
 * `[email:7a3f19]`. That is not a cosmetic choice. A model asked to compare two records, handed two *different*
 * placeholders for one email, concludes the records differ and reasons wrongly about data it was never allowed
 * to see. Deriving from the value keeps equality and nothing else.
 *
 * The alternative — a counter per turn — would need state keyed by run and would break the moment a run
 * resumed in a different process, which is the normal case for a durable runtime.
 *
 * A hash placeholder does permit equality testing, and that is the intended trade: equality is exactly the
 * property being preserved. It leaks no plaintext and is not reversible.
 */

import { createHash } from "node:crypto";
import type { ExecutionContext } from "../core/context.js";
import type { Guardrail, GuardrailInput, GuardrailOutput, GuardrailVerdict } from "./index.js";

/** What to look for. Named so a record can say `email` without saying which email. */
export const PII_ENTITIES = ["email", "phone", "card_number", "iban", "ssn", "ip_address"] as const;
export type PiiEntity = (typeof PII_ENTITIES)[number];

/**
 * What to do when something is found.
 *
 * `redact` by default, and the reasoning is worth stating because the other choice is defensible: refusing is
 * safer and ruder. A support agent pasting a customer's email into a chat has done something ordinary, and a
 * runtime that refuses the turn teaches them to paste it somewhere with no guardrail at all. Redaction keeps the
 * conversation working while the value never reaches the model.
 *
 * `refuse` is right where the data must not have been sent at all — a card number, under most policies — so the
 * default is per-entity rather than global.
 */
export type PiiAction = "redact" | "refuse";

export type PiiOptions = {
  /** Which entities to look for. Defaults to all of them. */
  readonly entities?: readonly PiiEntity[];
  /** Per-entity action. Anything unlisted uses `defaultAction`. */
  readonly actions?: Partial<Record<PiiEntity, PiiAction>>;
  /** Defaults to `redact` — see `PiiAction`. */
  readonly defaultAction?: PiiAction;
};

const LUHN_OK = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (Number.isNaN(d)) return false;
    if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
};

/** ISO 7064 mod-97: move the first four characters to the end, letters to digits, remainder must be 1. */
const IBAN_OK = (value: string): boolean => {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const expanded = [...rearranged].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
  let remainder = 0;
  for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
};

/**
 * A phone number, as distinct from any other run of digits.
 *
 * The corpus caught this: the first pattern matched an order number, an epoch timestamp and an invoice
 * reference, giving 78.6% precision. A guardrail that fires on invoice numbers is one somebody switches off, and
 * for this kind of check **precision matters more than recall** — a false positive is visible on every turn,
 * a false negative is invisible until it matters, and only one of the two gets the guardrail disabled.
 *
 * Two conditions, both needed:
 *
 * - **9 to 15 digits.** Below nine and it is a date, an error code or a quantity; above fifteen and it is longer
 *   than E.164 permits, which usually means a card the Luhn check already rejected.
 * - **A leading `+`, or at least two separators.** Humans group phone numbers — `020 7946 0958` — and machines
 *   do not group serial numbers. Two separators rather than one, because one is `INV-2026-0043`.
 *
 * A date like `2026-08-27` has two separators and is excluded by the digit count; a bare `1756300000` has the
 * digits and is excluded by the grouping.
 */
const PHONE_OK = (candidate: string): boolean => {
  const digits = (candidate.match(/\d/g) ?? []).length;
  if (digits < 9 || digits > 15) return false;
  const separators = (candidate.match(/[\s\-()]/g) ?? []).length;
  return candidate.trimStart().startsWith("+") || separators >= 2;
};

/**
 * Detectors, each a pattern and an optional validator.
 *
 * Order matters: `card_number` runs before `phone`, because a long digit run matches both and a card number is
 * the more consequential reading. Getting that backwards would redact a card as a phone number and apply the
 * phone policy to it.
 */
const DETECTORS: readonly { readonly entity: PiiEntity; readonly pattern: RegExp; readonly valid?: (m: string) => boolean }[] = [
  { entity: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { entity: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,34}\b/g, valid: IBAN_OK },
  { entity: "card_number", pattern: /\b(?:\d[ -]?){13,19}\b/g, valid: (m) => LUHN_OK(m.replace(/[ -]/g, "")) },
  { entity: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { entity: "ip_address", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  // Last: the loosest pattern, so a card or an IBAN has already claimed its digits. And validated, because
  // "a run of digits" is not a phone number — see PHONE_OK.
  { entity: "phone", pattern: /\+?\d[\d\s\-()]{7,20}\d/g, valid: PHONE_OK },
];

/** Six hex characters of a salted-by-entity hash: enough to distinguish values, short enough to read. */
export const placeholderFor = (entity: PiiEntity, value: string): string =>
  `[${entity}:${createHash("sha256").update(`${entity}:${value}`).digest("hex").slice(0, 6)}]`;

export type PiiFinding = { readonly entity: PiiEntity; readonly value: string };

/**
 * Every entity in a string, longest match first so a redaction cannot corrupt an overlapping one.
 *
 * Exported because it is the whole detector and it deserves to be tested directly rather than through a
 * guardrail's verdict.
 */
export const findPii = (text: string, entities: readonly PiiEntity[]): readonly PiiFinding[] => {
  const found: PiiFinding[] = [];
  const claimed: { start: number; end: number }[] = [];
  for (const detector of DETECTORS) {
    if (!entities.includes(detector.entity)) continue;
    for (const match of text.matchAll(detector.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      // A span already claimed by an earlier (more specific) detector is not re-read as something looser.
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      const value = match[0].trim();
      if (detector.valid && !detector.valid(value)) continue;
      claimed.push({ start, end });
      found.push({ entity: detector.entity, value });
    }
  }
  return found;
};

/** Replace every finding with its derived placeholder. Same value ⇒ same placeholder, always. */
export const redactText = (text: string, findings: readonly PiiFinding[]): string => {
  let out = text;
  // Longest first: replacing a short value that is a substring of a longer one would leave a fragment behind.
  for (const finding of [...findings].sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(finding.value).join(placeholderFor(finding.entity, finding.value));
  }
  return out;
};

/** Walk any JSON-ish value, redacting strings. Tool arguments and results are objects, not prose. */
const redactDeep = (value: unknown, entities: readonly PiiEntity[], found: PiiFinding[]): unknown => {
  if (typeof value === "string") {
    const hits = findPii(value, entities);
    found.push(...hits);
    return hits.length === 0 ? value : redactText(value, hits);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, entities, found));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, entities, found)]));
  }
  return value;
};

/**
 * A guardrail that finds personal data in the turn, in tool arguments and in tool results.
 *
 * All three, because each is a real path: the person types it, the model puts it in an argument, or a tool reads
 * a document that contains it. A guardrail covering one of the three is a guardrail whose coverage nobody can
 * state.
 */
export const createPiiGuardrail = (options: PiiOptions = {}): Guardrail => {
  const entities = options.entities ?? [...PII_ENTITIES];
  const defaultAction = options.defaultAction ?? "redact";
  const actionFor = (entity: PiiEntity): PiiAction => options.actions?.[entity] ?? defaultAction;

  const decide = <T>(findings: readonly PiiFinding[], redacted: () => T): GuardrailVerdict<T> => {
    if (findings.length === 0) return { kind: "pass" };
    const refusing = [...new Set(findings.filter((f) => actionFor(f.entity) === "refuse").map((f) => f.entity))];
    if (refusing.length > 0) {
      return {
        kind: "refused",
        code: "pii_present",
        // Names the entity type, never the value — the message is shown to a person and stored in an event.
        message: `That content contains ${refusing.join(", ")}. Please remove it and try again.`,
      };
    }
    return { kind: "redacted", value: redacted(), what: [...new Set(findings.map((f) => f.entity))] };
  };

  return {
    name: "pii",
    inspectInput(input: GuardrailInput): GuardrailVerdict<GuardrailInput> {
      const findings = findPii(input.text, entities);
      return decide(findings, () => ({ ...input, text: redactText(input.text, findings) }));
    },
    inspectOutput(output: GuardrailOutput, _context: ExecutionContext): GuardrailVerdict<GuardrailOutput> {
      if (output.kind === "message") {
        const findings = findPii(output.text, entities);
        return decide(findings, () => ({ ...output, text: redactText(output.text, findings) }));
      }
      const found: PiiFinding[] = [];
      const payload = redactDeep(output.kind === "tool-call" ? output.input : output.output, entities, found);
      return decide(found, () =>
        output.kind === "tool-call" ? { ...output, input: payload } : { ...output, output: payload },
      );
    },
  };
};
