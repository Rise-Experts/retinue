/**
 * Capability gating for the conformance suite — `docs/02` → capability declarations.
 *
 * A harness block may be skipped **only** when the adapter declares the capability absent via
 * `AdapterCapability`. An unconditional `it.skip` is not permitted: a silent skip is how a suite
 * comes to look green while verifying nothing, which is exactly the failure #91 exists to close.
 *
 * `gatedIt` therefore always registers a test. When the capability is missing it registers a
 * *passing* test whose name carries the declared reason, so the skip is visible in the report
 * rather than absent from it.
 */

import { it } from "vitest";
import type { AdapterCapability } from "../../persistence/index.js";

/** What an adapter tells the suite about itself. Absent ⇒ treated as "declares nothing". */
export type AdapterDeclaration = {
  readonly capabilities?: readonly AdapterCapability[];
};

export const declares = (
  declaration: AdapterDeclaration | undefined,
  capability: AdapterCapability,
): boolean => (declaration?.capabilities ?? []).includes(capability);

/**
 * Register a test that runs only when the adapter declares `capability`. When it does not, the
 * test still appears in the report, named with the reason — a visible, attributable skip.
 */
export const gatedIt = (
  declaration: AdapterDeclaration | undefined,
  capability: AdapterCapability,
  name: string,
  fn: () => Promise<void> | void,
): void => {
  if (declares(declaration, capability)) {
    it(name, fn);
    return;
  }
  it(`${name} [skipped: adapter does not declare "${capability}"]`, () => {
    // Intentionally empty: the assertion is the printed reason. See the module docstring.
  });
};
