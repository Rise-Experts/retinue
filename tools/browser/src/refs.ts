/**
 * Element references, and why a click never takes coordinates — REQ-055 (#237), task #239, AC-4.
 *
 * ## Coordinates are unverifiable and unreproducible
 *
 * `click(x: 412, y: 890)` cannot be checked against anything. It means a different element at a different
 * window size, after a font loads, once an ad renders, or when a cookie banner appears — and the failure is
 * silent, because clicking the wrong thing succeeds. A reference obtained from a read is checkable: it names
 * an element the model actually saw.
 *
 * ## The realistic failure is the *stale* reference, not the fabricated one
 *
 * A fabricated reference is easy to refuse and rare in practice. The one that happens constantly is: read the
 * page, click something, the DOM changes, then click a second reference from the **first** read. That ref may
 * now point at a different element, or at nothing, and clicking it does something nobody asked for.
 *
 * So an interaction **invalidates the snapshot it came from**. After a click, the model must read again before
 * clicking anything else. That is stricter than strictly necessary — some clicks change nothing — and the
 * strictness is the point: this package cannot know which clicks are the harmless ones, and guessing wrong is
 * an unrequested action on somebody else's site.
 *
 * A fingerprint travels with the reference as well, so a driver can confirm the element it is about to click is
 * still the one that was described. Belt and braces, and cheap.
 */

export type ElementHandle = {
  readonly ref: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  /** `password`, `email`, `submit`… for inputs. The password case is refused — see AC-6 in `tools.ts`. */
  readonly type?: string;
  readonly disabled?: boolean;
};

export type Snapshot = {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly ElementHandle[];
};

export class ReferenceError_ extends Error {}
/** A reference this session never issued. */
export class UnknownReferenceError extends ReferenceError_ {}
/** A reference from a snapshot that is no longer current. */
export class StaleReferenceError extends ReferenceError_ {}

export type ResolvedReference = {
  readonly handle: ElementHandle;
  readonly snapshotId: string;
};

/**
 * Per-session reference bookkeeping.
 *
 * Deliberately not global: a reference from one session must not resolve in another, or two concurrent runs
 * can address each other's pages.
 */
export type ReferenceRegistry = {
  /** Records a snapshot as current, returning it. Any earlier snapshot's refs become stale. */
  readonly record: (snapshot: Snapshot) => Snapshot;
  /** Resolves a reference against the *current* snapshot, throwing if unknown or stale. */
  readonly resolve: (ref: string) => ResolvedReference;
  /** Marks the current snapshot as no longer trustworthy — called after every interaction. */
  readonly invalidate: () => void;
  readonly current: () => Snapshot | undefined;
};

export const createReferenceRegistry = (): ReferenceRegistry => {
  let current: Snapshot | undefined;
  let valid = false;
  // Every ref ever issued in this session, so "never issued" and "issued but stale" give different messages.
  const everIssued = new Set<string>();

  return {
    record(snapshot) {
      current = snapshot;
      valid = true;
      for (const element of snapshot.elements) everIssued.add(element.ref);
      return snapshot;
    },
    invalidate() {
      valid = false;
    },
    current: () => current,
    resolve(ref) {
      if (current === undefined) {
        throw new UnknownReferenceError(
          `There is no page open in this session yet. Call browser_navigate first, then use a reference from what it returned.`,
        );
      }
      if (!valid) {
        throw new StaleReferenceError(
          `"${ref}" came from a page state that has since changed — the last interaction may have altered the ` +
            "page. Call browser_read to see the page as it is now, and use a reference from that.",
        );
      }
      const handle = current.elements.find((element) => element.ref === ref);
      if (handle === undefined) {
        throw everIssued.has(ref)
          ? new StaleReferenceError(
              `"${ref}" was on an earlier version of this page and is not on the current one. Call ` +
                "browser_read and use a reference from the result.",
            )
          : new UnknownReferenceError(
              `"${ref}" is not an element reference this session issued. References come from browser_navigate ` +
                `and browser_read; the current page has ${current.elements.length}.`,
            );
      }
      return { handle, snapshotId: current.id };
    },
  };
};
