/**
 * The browser driver port — REQ-055 (#237), task #239.
 *
 * This package does **not** bundle a browser. Chromium is ~150MB, its version has to match the driver's, and a
 * toolkit that downloads a binary on install is a toolkit that fails in every locked-down environment it will
 * actually be deployed into. So the browser is a runtime prerequisite the operator provides — a binary or an
 * image — and the integration page states it plainly rather than leaving it to be discovered.
 *
 * The port is the same arrangement `tools-search` and `tools-scrape` use: a hosted service (Browserbase,
 * Steel, Hyperbrowser) and a local Playwright or CDP process are two *values*, not two sets of tools.
 *
 * Everything security-relevant sits **above** this interface — the URL checks, the reference discipline, the
 * password refusal, the untrusted fence, the lifetime and memory caps. A driver is asked to do a narrow,
 * already-validated thing. That matters because a third-party driver is code the operator trusts but this
 * package does not audit, and a design where the driver enforced the rules would be a design where swapping
 * drivers silently swaps the guarantees.
 */

import type { ElementHandle, Snapshot } from "./refs.js";

/** What a driver is told to click or type into, including what it should still be. */
export type TargetedAction = {
  readonly sessionId: string;
  readonly ref: string;
  /**
   * What the element was when the model saw it.
   *
   * A driver re-checks before acting. The reference registry already refuses stale references; this catches
   * the narrower case where the reference is still current and the element behind it has been replaced.
   */
  readonly expect: { readonly tag: string; readonly name: string };
  readonly timeoutMs: number;
};

export interface BrowserDriver {
  readonly name: string;
  /** Opens a URL. The URL has already been validated — see `tools.ts`. */
  open(input: { sessionId: string; url: string; timeoutMs: number }): Promise<Snapshot>;
  read(input: { sessionId: string; timeoutMs: number }): Promise<Snapshot>;
  click(input: TargetedAction): Promise<void>;
  type(input: TargetedAction & { text: string }): Promise<void>;
  screenshot(input: { sessionId: string; maxBytes: number; timeoutMs: number }): Promise<{
    readonly base64: string;
    readonly bytes: number;
    readonly truncated: boolean;
  }>;
  close(input: { sessionId: string }): Promise<void>;
}

/** A driver that mismatched the expected element. Distinct so the tools can explain it properly. */
export class ElementChangedError extends Error {}

let counter = 0;
/** Snapshot ids, unique within a process. Not security-relevant — references are scoped to a session. */
export const nextSnapshotId = (): string => {
  counter += 1;
  return `s${counter}`;
};

export const snapshotOf = (input: {
  url: string;
  title: string;
  text: string;
  elements: readonly ElementHandle[];
}): Snapshot => ({ id: nextSnapshotId(), ...input });
