import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SHAREFLOW_TOOL_NAMES } from "../../index.js";

/**
 * Every tool is in the exercise plan — #424's third acceptance, made checkable.
 *
 * `npm run exercise:tools` runs all of them against a real database and reports what each actually
 * does. Its own header says why that matters: it is *"the only way to find a tool that is registered,
 * described to the model, named by the prompt, and has nothing behind it"*.
 *
 * A tool missing from the plan is therefore invisible to the one check built to find invisible tools.
 * Nothing asserted that until now — the script's coverage was whoever remembered to add an entry.
 *
 * This reads the script rather than running it, deliberately: the run needs a database *and* a model
 * API key, so it cannot be part of the suite, and the property worth guarding — "is this tool
 * exercised at all" — is visible in the source.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "exercise-tools.mjs");

describe("the exercise plan", () => {
  const script = readFileSync(SCRIPT, "utf8");
  /** Only real entries: `name: "x"` inside the plan, not a mention in a comment. */
  const planned = new Set([...script.matchAll(/^\s*\{\s*name:\s*"([a-z_]+)"/gm)].map((m) => m[1]!));

  it("finds entries at all — an empty parse would pass vacuously", () => {
    expect(planned.size).toBeGreaterThan(40);
  });

  it("has an entry for every registered tool", () => {
    const missing = SHAREFLOW_TOOL_NAMES.filter((name) => !planned.has(name));
    expect(
      missing,
      "these tools are registered and the exercise script never calls them — so the one check that " +
        "finds a tool with nothing behind it cannot see them",
    ).toEqual([]);
  });

  /*
   * A skipped entry satisfies "has an entry" while never running — #426.
   *
   * That is the gap this file was written to close, reopened one level down: `start_campaign_from_
   * template` sat in the plan carrying `skip: "creates a real campaign"`, so the coverage check
   * above passed, and the tool whose entire job is the template path was never exercised. The
   * reason did not even hold — `create_campaign` creates one too and has always run.
   *
   * So the skips are pinned. Four remain, each genuinely side-effecting beyond the sweep's own row;
   * a fifth has to be argued for here, in public, rather than added in passing.
   *
   * `generate_media` (#496) spends real credits — Higgsfield's or Chorus's — on every run, and
   * `check_media_job` has nothing to read without a job the first one started.
   */
  it("skips only the four entries that are meant to be skipped", () => {
    const skipped = [...script.matchAll(/\{\s*name:\s*"([a-z_]+)"[^}]*?\bskip:/g)].map((m) => m[1]!);
    expect(skipped.sort()).toEqual([
      "cancel_recurring_schedule",
      "check_media_job",
      "create_recurring_schedule",
      "generate_media",
    ]);
  });

  it("finds the skip marker at all, so the pin above cannot pass on a broken pattern", () => {
    // If the regex stopped matching, the assertion above would read [] and pass forever.
    expect(script).toContain("skip:");
    expect(script.match(/\bskip:/g)!.length).toBe(4);
  });

  it("plans nothing that is not a tool", () => {
    const registered = new Set<string>(SHAREFLOW_TOOL_NAMES);
    // A renamed tool leaves its old entry behind, and the script would report it as a failure
    // forever — or worse, someone deletes the assertion instead of the entry.
    expect([...planned].filter((name) => !registered.has(name))).toEqual([]);
  });
});
