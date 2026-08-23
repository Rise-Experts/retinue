/**
 * Citations and per-claim provenance — REQ-030 (#137).
 *
 * `research-and-citation` already says what should happen. This makes it structural, and the structure carries
 * four decisions worth stating.
 *
 * **A citation is a snapshot, not a pointer.** `excerpt`, `title` and `retrievedAt` live on the part. AC-4
 * requires an answer given months ago to stay auditable *after the source is gone* — a document deleted, a URL
 * dead, a chunk re-indexed under a new id — and a citation that resolved by fetching would stop being evidence
 * exactly when someone needs it. The duplication is the feature.
 *
 * **Groundedness is derived from the citation graph**, not flagged on the text. A text part is grounded exactly
 * when some citation names it in `supports`. A boolean on the text part would be a second place for the same
 * fact, and the two would drift the first time a citation was withheld — leaving a claim that says "grounded"
 * with nothing behind it, which is worse than an honestly ungrounded one.
 *
 * **Permission is re-checked at citation time.** AC-5, and the reason is precise: retrieval and rendering are
 * different moments, and a permission can change between them. A citation emitted on the strength of a
 * retrieval check is a citation that can outlive the access that justified it.
 *
 * **One shape for retrieval and web research.** AC-6. Two part types would mean two renderers, two schemas and
 * eventually two behaviours for "click the citation".
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import { asId } from "../core/ids.js";
import type { MessagePartId } from "../core/ids.js";
import type { CitationOrigin, CitationPart, MessagePart } from "../core/content-parts.js";
import { MAX_CITATION_EXCERPT } from "../core/validation.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import type { RetrievalHit } from "../knowledge/retrieval.js";

/** The current citation payload version. Bumped from 1 by #137, which added origin, excerpt and supports. */
export const CITATION_SCHEMA_VERSION = 2;

/**
 * Trim an excerpt to the cap without cutting a word in half.
 *
 * A citation ending mid-word reads as corrupt, and a reader cannot tell whether the source said something else.
 * The ellipsis is explicit so a truncated excerpt is visibly truncated rather than silently shorter than what
 * was read.
 */
export const boundExcerpt = (text: string, max = MAX_CITATION_EXCERPT): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
};

export type CitationCandidate = {
  readonly origin: CitationOrigin;
  readonly excerpt: string;
  readonly retrievedAt: string;
  readonly supports: readonly MessagePartId[];
  readonly charRange?: { readonly start: number; readonly end: number };
  /**
   * The subject the reader must be entitled to.
   *
   * Required for a retrieval citation and absent for a web one — a public URL has no subject to check. Kept
   * *outside* the part on purpose: it is an input to the emission decision, not something a stored citation
   * should carry, because a stale subject on a durable part is a permission claim nobody re-evaluates.
   */
  readonly authSubject?: string;
};

/** A citation built from a retrieval hit. The passage fields come from the hit, so they cannot disagree. */
export const citationFromRetrieval = (input: {
  readonly hit: RetrievalHit;
  readonly supports: readonly MessagePartId[];
  readonly retrievedAt: string;
  readonly charRange?: { readonly start: number; readonly end: number };
}): CitationCandidate => ({
  origin: {
    kind: "retrieval",
    sourceType: input.hit.reference.sourceType,
    sourceId: input.hit.reference.sourceId,
    chunkId: input.hit.reference.chunkId,
    chunkIndex: input.hit.reference.chunkIndex,
    ...(input.hit.reference.locator === undefined ? {} : { locator: input.hit.reference.locator }),
  },
  // The chunk's own content, bounded. Not a re-read of the source: what was *used* is what must be cited.
  excerpt: boundExcerpt(input.hit.chunk.content),
  retrievedAt: input.retrievedAt,
  supports: input.supports,
  ...(input.charRange === undefined ? {} : { charRange: input.charRange }),
  // The chunk's auth subject, so the emission check asks about the same thing retrieval filtered on.
  authSubject: input.hit.chunk.authSubject,
});

/**
 * A citation built from a web passage.
 *
 * Shaped to accept ShareFlow's `SourcePassage` without adaptation — `url`, `retrievedAt`, `excerpt` — because
 * AC-6 is only true if the two paths really do produce one thing rather than two things that look alike.
 */
export const citationFromWeb = (input: {
  readonly passage: { readonly url: string; readonly retrievedAt: string; readonly excerpt: string };
  readonly title?: string;
  readonly supports: readonly MessagePartId[];
}): CitationCandidate => ({
  origin: {
    kind: "web",
    url: input.passage.url,
    ...(input.title === undefined ? {} : { title: input.title }),
  },
  excerpt: boundExcerpt(input.passage.excerpt),
  retrievedAt: input.passage.retrievedAt,
  supports: input.supports,
});

export type EmittedCitations = {
  readonly parts: readonly CitationPart[];
  /**
   * How many candidates were dropped for lack of access.
   *
   * Reported rather than silent. A withheld citation leaves its claim looking ungrounded, and a caller that
   * cannot tell the difference between "nothing supported this" and "you may not see what supported this" will
   * present the two identically — so the count is here for a caller that wants to drop the claim instead.
   */
  readonly withheld: number;
};

export type CitationEmitterDeps = {
  /**
   * AC-5, enforced rather than asserted.
   *
   * **Required.** An emitter that would run without a policy is one someone constructs without one, at which
   * point every citation is emitted regardless of access — and a citation carries an excerpt, so that leaks the
   * text and not merely the existence of the source.
   */
  readonly authorization: AuthorizationPolicy;
  readonly clock?: () => string;
  readonly partId?: () => string;
};

export const createCitationEmitter = (deps: CitationEmitterDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const newId = deps.partId ?? (() => `cite_${crypto.randomUUID()}`);

  return {
    /**
     * Turn candidates into parts, dropping any the reader may not open.
     *
     * Checked here and not only at retrieval, because the two are different moments. A permission revoked in
     * between is exactly the case the test steps name, and a citation emitted on a retrieval-time check would
     * survive it.
     */
    async emit(
      context: ExecutionContext,
      candidates: readonly CitationCandidate[],
    ): Promise<EmittedCitations> {
      const parts: CitationPart[] = [];
      let withheld = 0;
      for (const candidate of candidates) {
        if (!(await this.mayCite(context, candidate))) {
          withheld += 1;
          continue;
        }
        parts.push({
          id: asId<MessagePartId>(newId()),
          type: "citation",
          schemaVersion: CITATION_SCHEMA_VERSION,
          createdAt: clock(),
          origin: candidate.origin,
          excerpt: candidate.excerpt,
          retrievedAt: candidate.retrievedAt,
          supports: candidate.supports,
          ...(candidate.charRange === undefined ? {} : { charRange: candidate.charRange }),
        });
      }
      return { parts, withheld };
    },

    /**
     * Whether this reader may be shown this citation.
     *
     * A web citation needs no check: its URL is public by construction, and asking a policy about it would be
     * asking about a resource the policy has never heard of — which most policies answer by denying, silently
     * suppressing every web citation.
     */
    async mayCite(context: ExecutionContext, candidate: CitationCandidate): Promise<boolean> {
      if (candidate.origin.kind === "web") return true;
      if (candidate.authSubject === undefined)
        // A retrieval citation with no subject cannot be checked, so it is not emitted. Failing closed here is
        // the only safe direction: the alternative emits an excerpt nobody authorised.
        return false;
      const decision = await deps.authorization.can(context, "read", {
        type: "conversation",
        id: candidate.authSubject,
      });
      return decision.allow;
    },
  };
};

export type CitationEmitter = ReturnType<typeof createCitationEmitter>;

/**
 * The parts a message's citations ground — AC-3.
 *
 * Derived from the citation graph, so there is one source of truth. A caller renders a text part differently
 * when its id is in this set; nothing has to inspect the prose.
 */
export const groundedPartIds = (parts: readonly MessagePart[]): ReadonlySet<string> => {
  const grounded = new Set<string>();
  for (const part of parts) {
    if (part.type !== "citation") continue;
    for (const supported of part.supports) grounded.add(supported);
  }
  return grounded;
};

/** Citations that ground a given part, in the order they appear. For rendering markers next to a claim. */
export const citationsFor = (
  parts: readonly MessagePart[],
  partId: string,
): readonly CitationPart[] =>
  parts.filter((p): p is CitationPart => p.type === "citation" && p.supports.includes(partId as MessagePartId));

/**
 * A citation that grounds nothing.
 *
 * Worth finding, because it is the shape a bug takes: a producer that emitted citations without wiring them to
 * the claims they support leaves an answer that *looks* cited — markers in a list at the bottom — while no
 * individual statement is traceable, which is the failure REQ-030 exists to prevent.
 */
export const danglingCitations = (parts: readonly MessagePart[]): readonly CitationPart[] => {
  const ids = new Set(parts.map((p) => p.id as string));
  return parts.filter(
    (p): p is CitationPart =>
      p.type === "citation" && (p.supports.length === 0 || !p.supports.some((s) => ids.has(s as string))),
  );
};

/**
 * What a citation resolves to — AC-2.
 *
 * Returned from the *stored part alone*, with no lookup, which is what makes AC-4 hold: an audit months later
 * gets the same answer whether or not the source still exists. `live` says whether following it further is
 * possible, so a reader is told "this is what was read, and the source is gone" rather than being handed a
 * broken link.
 */
export type ResolvedCitation = {
  readonly excerpt: string;
  readonly retrievedAt: string;
  /** Human-readable: a heading path, or a title, or the URL. What a reader sees next to the claim. */
  readonly label: string;
  /** Where to go, if anywhere. A chunk id for retrieval, the URL for web. */
  readonly target: string;
  readonly kind: CitationOrigin["kind"];
};

export const resolveCitation = (part: CitationPart): ResolvedCitation => ({
  excerpt: part.excerpt,
  retrievedAt: part.retrievedAt,
  label:
    part.origin.kind === "retrieval"
      ? // The heading path when the chunker found one; otherwise the passage's position, which is still more
        // specific than the document. A bare document name would be AC-2 unmet.
        (part.origin.locator ?? `${part.origin.sourceId} — passage ${part.origin.chunkIndex + 1}`)
      : (part.origin.title ?? part.origin.url),
  target: part.origin.kind === "retrieval" ? part.origin.chunkId : part.origin.url,
  kind: part.origin.kind,
});

/** Thrown when a producer tries to cite without an excerpt. A citation with no text is not evidence. */
export const assertCitable = (candidate: CitationCandidate): void => {
  if (candidate.excerpt.trim() === "")
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "a citation must carry the excerpt it is evidence for",
      retryable: false,
    });
};
