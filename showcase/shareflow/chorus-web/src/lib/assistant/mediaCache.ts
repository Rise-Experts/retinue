/**
 * Signed-URL cache for rendering `chorus-media:` references (SPEC #322 AC-7).
 *
 * WHY THIS IS NEEDED: assistant replies stream token by token, so a message
 * containing a media reference re-renders dozens of times while it arrives.
 * Signing per render would fire dozens of requests for one file — and a reply
 * that mentions four files, four times that.
 *
 * Two mechanisms, both required:
 *
 *  1. A resolved-URL cache keyed by path. Module scope, not component state, so
 *     it survives the remount that ends a stream and is shared between the
 *     inline reference and the gallery tile for the same file.
 *  2. In-flight de-duplication. The cache alone does not help the first render:
 *     ten nodes mount in the same tick, all miss, and all fetch. Handing every
 *     caller the same pending promise collapses that to one request.
 *
 * Kept out of the component tree so it can be tested at all — this repo has no
 * jsdom, so anything inside a component is unreachable by the suite.
 */

export interface SignedMedia {
  url: string;
  expiresAt: number;
  kind: 'image' | 'video' | 'document';
}

/**
 * Refresh this far before the real expiry. A URL that dies mid-render shows the
 * user a broken tile, so the margin is generous relative to the 1h TTL.
 */
export const REFRESH_MARGIN_MS = 60_000;

type Fetcher = (path: string) => Promise<SignedMedia>;

const resolved = new Map<string, SignedMedia>();
const inFlight = new Map<string, Promise<SignedMedia | null>>();

/** True when `entry` is absent or close enough to expiry to be worth replacing. */
export function isStale(entry: SignedMedia | undefined, now: number): boolean {
  return !entry || entry.expiresAt - now <= REFRESH_MARGIN_MS;
}

/** Cached entry for `path`, or undefined when absent or stale. */
export function peekSignedMedia(path: string, now: number = Date.now()): SignedMedia | undefined {
  const entry = resolved.get(path);
  return isStale(entry, now) ? undefined : entry;
}

/**
 * Resolves `path` to a signed URL, at most once concurrently per path.
 *
 * Returns null on failure rather than throwing: the specified fallback is to show
 * the filename as plain text (AC-5), and a rejected promise in a render path
 * would take the message down with it. Failures are NOT cached — a transient 502
 * should not poison a path for the rest of the session.
 */
export async function resolveSignedMedia(
  path: string,
  fetcher: Fetcher,
  now: number = Date.now(),
): Promise<SignedMedia | null> {
  const cached = peekSignedMedia(path, now);
  if (cached) return cached;

  const pending = inFlight.get(path);
  if (pending) return pending;

  const request = fetcher(path)
    .then((entry) => {
      resolved.set(path, entry);
      return entry;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(path);
    });

  inFlight.set(path, request);
  return request;
}

/** Test seam. Never called by the app — the cache is process-lifetime by design. */
export function __resetMediaCache(): void {
  resolved.clear();
  inFlight.clear();
}
