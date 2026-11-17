import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../index.js";

/**
 * The `lead-capture` skill must not contradict the adapter it describes — #451.
 *
 * ## The bug
 *
 * The skill told the model:
 *
 * > "This deployment does not suppress duplicates. Recording the same person twice creates two
 * > leads. Nothing dedupes them, by email or otherwise."
 *
 * None of that was true. `leads_dedupe_email_idx` is a **unique** index on
 * `(workspace_id, lower(email))`, `createLead` inserts `on conflict do nothing` and returns
 * `outcome: "existing"`, and `services.test.ts` counts the rows after a duplicate and gets 1.
 *
 * Two mechanisms were conflated: the opt-out list (`isSuppressed`, then unsupplied) and the dedupe
 * indexes (present since #120). A skill is instructions the model follows as faithfully as real
 * ones, so the effect was an assistant telling users their lead list was not deduplicated when it
 * was, and spending extra calls looking for a person the database would have matched anyway.
 *
 * ## Why this test is shaped like this
 *
 * The failure was a *static string asserting a per-deployment fact*. So the guard is not "does the
 * prose say the right thing today" — it is that the prose makes no such claim at all. The skill
 * must point at the tool's own discriminated answer, which is true on every deployment.
 */
const skill = () => {
  const found = SHAREFLOW_BUILT_IN_SKILLS.find((s) => s.name === "lead-capture");
  if (found === undefined) throw new Error("the lead-capture skill is gone");
  return found.instructions;
};

const LEADS_ADAPTER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "postgres", "leads.ts"),
  "utf8",
);

describe("the lead-capture skill and the lead adapter agree", () => {
  it("finds the skill and a non-trivial body, so nothing below passes vacuously", () => {
    expect(skill().length).toBeGreaterThan(200);
  });

  it("does not claim leads are undeduplicated, because they are", () => {
    /**
     * The adapter's insert is the authority. If it still says `on conflict do nothing` and still
     * returns an `existing` arm, then duplicates ARE collapsed and prose saying otherwise is false.
     */
    expect(LEADS_ADAPTER, "the dedupe this guards is gone — re-read the skill before changing this").toMatch(
      /on conflict do nothing/,
    );
    expect(LEADS_ADAPTER).toMatch(/outcome: "existing"/);

    const body = skill().toLowerCase();
    expect(body, "the skill tells the model nothing dedupes leads, which is false").not.toMatch(
      /nothing dedupes/,
    );
    expect(body).not.toMatch(/does not suppress duplicates/);
    expect(body, "the skill still claims recording twice makes two leads").not.toMatch(
      /creates two leads/,
    );
  });

  it("does not assert whether this deployment suppresses, in either direction", () => {
    /**
     * The original defect, generalised. Suppression is supplied by the host app and can be present
     * or absent; a static string cannot track that, so it must not try. Saying "this deployment
     * suppresses" would be the same bug with the sign flipped — and would be wrong on any
     * deployment that does not wire `isSuppressed`.
     */
    const body = skill().toLowerCase();
    expect(body).not.toMatch(/this deployment (does not|cannot|will not)/);
    expect(body).not.toMatch(/never tell a user their list is deduplicated/);
  });

  it("tells the model to report the outcome it was actually given", () => {
    // The durable instruction: the answer is a discriminated union, so read it rather than assume.
    const body = skill().toLowerCase();
    for (const outcome of ["created", "existing", "suppressed"]) {
      expect(body, `the skill never mentions the ${outcome} outcome`).toContain(outcome);
    }
  });
});
