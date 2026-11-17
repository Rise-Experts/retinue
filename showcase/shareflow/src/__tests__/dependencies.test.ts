/**
 * `ai` is pinned to an exact version, and this is the test that keeps it that way.
 *
 * **What happened.** This package moved out of the retinue monorepo, whose lockfile pinned `ai` at
 * 7.0.66. Standing alone, a fresh install resolved `^7.0.66` to 7.0.93 and four tool-executing tests
 * failed: the tool call was emitted and then finalised as *"interrupted before it completed"*, because
 * the SDK never executed the tool.
 *
 * Bisected to a single patch release. `ai@7.0.66` through `7.0.69` call the tool's `execute` and emit
 * `tool-result`; `7.0.70` and every version after it (checked through 7.0.93) emit `tool-call` and
 * then `finish`, with `execute` never called:
 *
 *     7.0.69  start -> start-step -> tool-call -> tool-result -> finish-step -> ... -> finish
 *     7.0.70  start -> start-step -> tool-call -> finish-step -> finish        (execute called: 0)
 *
 * Reproduced against `streamText` directly, with no retinue code involved, so it is the SDK's
 * behaviour rather than this package's. Not the tool-input lifecycle parts, not the `input` encoding
 * (an object gets `toolCall.input.trim is not a function`, so a string is still required), and not the
 * provider `specificationVersion`. Whether a *real* provider is affected is unsettled — that needs a
 * live model call — which is exactly why this is pinned rather than ranged: the deployed image must
 * run the version the platform was tested against, not whatever a rebuild happens to resolve.
 *
 * A caret here would make every tool call depend on the day the image was built.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

/** The last version whose `streamText` executes a scripted tool call. See the header. */
const LAST_GOOD_AI = "7.0.69";

describe("the ai SDK", () => {
  it("is declared, because this package imports it directly", () => {
    // `src/app/module.ts` does `await import("ai")` for `generateObject`. In the monorepo it resolved
    // through the runtime's own dependency and nothing noticed it was undeclared.
    expect(manifest.dependencies?.["ai"]).toBeDefined();
  });

  it("is pinned to an exact version, not a range", () => {
    /**
     * The assertion, and the whole point. `^7.0.66` is what produced a green suite locally and four
     * failures on a fresh install, because the two resolved different versions of the same range.
     */
    const declared = manifest.dependencies?.["ai"] ?? "";
    expect(declared, "an exact version — a range resolves differently on the day the image is built").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it("is not raised past the last version that executes tool calls without checking", () => {
    /**
     * Deliberately not "equals 7.0.69". A newer `ai` may well fix this, and this test must not be the
     * reason nobody upgrades. It fails on a bump so that the bump comes with a run of
     * `src/__tests__/ai-tool-execution.test.ts` — which is the thing that actually catches the regression —
     * and with this comment updated to say what was checked.
     */
    const declared = manifest.dependencies?.["ai"] ?? "";
    const [major, minor, patch] = declared.split(".").map(Number) as [number, number, number];
    const [lastMajor, lastMinor, lastPatch] = LAST_GOOD_AI.split(".").map(Number) as [number, number, number];
    const ordered = major * 1e6 + minor * 1e3 + patch <= lastMajor * 1e6 + lastMinor * 1e3 + lastPatch;
    expect(
      ordered,
      `raising ai past ${LAST_GOOD_AI} needs ai-tool-execution.test.ts run against it — 7.0.70 stopped ` +
        `executing scripted tool calls, and the symptom is a recorded tool call with no result`,
    ).toBe(true);
  });
});
