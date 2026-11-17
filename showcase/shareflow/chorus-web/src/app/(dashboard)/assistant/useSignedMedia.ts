/**
 * Resolves a `chorus-media:` workspace path to a signed URL for rendering.
 *
 * Thin on purpose: the cache, the in-flight de-duplication and the staleness rule
 * all live in `@/lib/assistant/mediaCache`, where they can be unit-tested — this
 * repo has no jsdom, so logic inside a hook is unreachable by the suite. What is
 * left here is the fetch and the React state.
 *
 * `path` may be null (an incomplete reference mid-stream, or a non-reference), in
 * which case nothing is requested at all.
 */

"use client";

import { useEffect, useState } from "react";
import { resolveSignedMedia, peekSignedMedia, type SignedMedia } from "@/lib/assistant/mediaCache";

async function fetchSigned(path: string): Promise<SignedMedia> {
  const res = await fetch(`/api/media/sign?path=${encodeURIComponent(path)}`, {
    // The response carries a credential-bearing URL scoped to this session.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);

  const json = (await res.json()) as { url?: string; expiresAt?: string; kind?: SignedMedia["kind"] };
  if (!json.url) throw new Error("sign returned no url");

  return {
    url: json.url,
    expiresAt: json.expiresAt ? Date.parse(json.expiresAt) : Date.now() + 3_600_000,
    kind: json.kind ?? "image",
  };
}

export interface UseSignedMediaResult {
  media: SignedMedia | null;
  /** True once signing has failed — callers fall back to plain text (AC-5). */
  failed: boolean;
}

/**
 * The outcome of a completed fetch, tagged with the path it belongs to.
 *
 * Tagged because `path` can change while a request is in flight (a message
 * re-renders as it streams). Untagged state would briefly show one file's URL
 * under another's reference.
 */
type Outcome = { path: string; media: SignedMedia | null };

export function useSignedMedia(path: string | null): UseSignedMediaResult {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Read the cache DURING RENDER rather than syncing it into state in an effect.
  // A cache hit is the common case while a reply streams, and writing state for
  // it would mean a second render per token — and eslint's
  // no-sync-setstate-in-effect rule is pointing at exactly that cost.
  const cached = path ? (peekSignedMedia(path) ?? null) : null;

  useEffect(() => {
    // Nothing to do for an incomplete reference, or when the cache already has it.
    if (!path || peekSignedMedia(path)) return;

    let active = true;
    resolveSignedMedia(path, fetchSigned).then((entry) => {
      if (active) setOutcome({ path, media: entry });
    });

    return () => {
      active = false;
    };
  }, [path]);

  const settled = outcome && outcome.path === path ? outcome : null;

  return {
    media: cached ?? settled?.media ?? null,
    // A cache hit always wins: a stale failure must not hide a URL we now have.
    failed: !cached && settled !== null && settled.media === null,
  };
}

/**
 * Resolves a LIST of workspace paths, preserving order.
 *
 * Separate from `useSignedMedia` because a card has N attachments and hooks
 * cannot be called in a loop. One effect covers the whole array, so the hook
 * order stays fixed regardless of how many files a post carries.
 *
 * Order is preserved deliberately: media order is the order a platform renders a
 * carousel in, so results are written by index rather than appended as they
 * arrive. Entries that fail to sign are simply absent — the card still shows its
 * text.
 */
export function useSignedMediaList(paths: readonly (string | null)[]): (SignedMedia | null)[] {
  // Keyed by the joined path list so a different card cannot inherit the
  // previous one's URLs while its own are still resolving.
  const key = paths.join("|");
  const [entries, setEntries] = useState<(SignedMedia | null)[]>(() => paths.map(() => null));

  useEffect(() => {
    let active = true;
    const next: (SignedMedia | null)[] = paths.map(() => null);

    Promise.all(
      paths.map(async (path, i) => {
        if (!path) return;
        const entry = peekSignedMedia(path) ?? (await resolveSignedMedia(path, fetchSigned));
        next[i] = entry;
      }),
    ).then(() => {
      if (active) setEntries(next);
    });

    return () => {
      active = false;
    };
    // `key` stands in for the array: a new array literal each render would
    // re-run this effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return entries;
}
