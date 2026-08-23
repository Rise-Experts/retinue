/**
 * Forbidden-claim checking — #121 AC-2: *"a forbidden claim is refusable at the tool layer, not only
 * discouraged in the prompt."*
 *
 * ## Why this exists at all
 *
 * A claim restriction expressed only in the prompt is advisory. The model usually follows it, and
 * "usually" is not a property you can put in a compliance conversation. This makes the restriction
 * **checkable**, which is what turns "discouraged" into "refusable".
 *
 * ## What it is not
 *
 * **A floor, not a guarantee.** It matches literal phrasings; it will not catch a paraphrase. So the
 * prompt-side instruction is not redundant — it is the half that handles rewording, and this is the half
 * that cannot be talked out of. Describing this as *preventing* forbidden claims would invite someone to
 * drop the other half, which is the only way this file could make things worse.
 *
 * And a clean result means "nothing matched", not "nothing forbidden": there is no claims record in
 * ShareFlow yet, so an adapter returning an empty policy produces no findings on any text at all.
 *
 * It also **over-matches in one direction**, and that is the deliberate trade: a forbidden "number one"
 * fires on "number one hundred in the rankings", because the phrase is genuinely present. Refusing
 * something legitimate costs the user a rewording; missing a real claim costs them a compliance problem.
 * A checker cannot tell which one a phrase is, so it errs toward the recoverable mistake — which is also
 * why `repairable` is false and the decision goes back to the person.
 */
import type { ForbiddenClaim, ValidationIssue } from "../services/index.js";

/** The stable code a forbidden claim is reported under. Branchable by a repair step (docs/07 step 8). */
export const FORBIDDEN_CLAIM_CODE = "forbidden-claim" as const;

/** Regex-special characters, escaped so a phrase is matched literally rather than as a pattern. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the matcher for one phrase.
 *
 * Word boundaries at both ends, but only where the phrase itself starts or ends with a word character —
 * `\bC++\b` would never match, because `+` is not a word character and there is no boundary after it.
 * Getting that wrong means a forbidden phrase that silently never fires, which is worse than no check.
 *
 * Case-insensitive, and runs of whitespace in the phrase match runs of any whitespace in the text, so a
 * claim broken across a line in a caption is still caught.
 */
const matcherFor = (phrase: string): RegExp | null => {
  const trimmed = phrase.trim();
  if (trimmed === "") return null;
  const body = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
  const lead = /^\w/.test(trimmed) ? "\\b" : "";
  const tail = /\w$/.test(trimmed) ? "\\b" : "";
  return new RegExp(`${lead}${body}${tail}`, "i");
};

/**
 * Every forbidden claim the text contains, as findings.
 *
 * The same `ValidationIssue` shape `PublishingService.validate` and `MediaService`'s compatibility check
 * return, so a caller handles one contract and a repair step branches on a code rather than parsing a
 * sentence.
 *
 * `repairable: false`. A forbidden claim is not a formatting problem the assistant should quietly rewrite
 * around — the user asked for something the brand may not say, and they should be told that rather than
 * handed a silently altered version. Deciding to rephrase is theirs.
 */
export const findForbiddenClaims = (
  text: string,
  forbidden: readonly ForbiddenClaim[],
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  for (const claim of forbidden) {
    const matcher = matcherFor(claim.phrase);
    if (matcher === null || !matcher.test(text)) continue;
    issues.push({
      code: FORBIDDEN_CLAIM_CODE,
      message:
        claim.reason === undefined
          ? `the phrase "${claim.phrase.trim()}" is not approved for this brand`
          : `the phrase "${claim.phrase.trim()}" is not approved for this brand: ${claim.reason}`,
      repairable: false,
    });
  }
  return issues;
};

/** Convenience: does this text contain any forbidden claim? */
export const containsForbiddenClaim = (text: string, forbidden: readonly ForbiddenClaim[]): boolean =>
  findForbiddenClaims(text, forbidden).length > 0;
