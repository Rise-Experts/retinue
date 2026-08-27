/**
 * The skill catalogue gets the tool catalogue's treatment — REQ-045 (#204), task #210, AC-5.
 */
import { describe, expect, it } from "vitest";
import { budgetSkillCatalogue, skillEntryTokens, truncationNotice } from "../catalogue.js";
import type { SkillCatalogEntry } from "../index.js";

const entry = (name: string, description: string): SkillCatalogEntry => ({
  name,
  description,
  source: "built-in",
  version: 1,
});

const CATALOGUE = [
  entry("triage-issues", "How this team triages an incoming issue: labels, priorities, who to ask."),
  entry("write-release-notes", "Turn a list of merged changes into release notes somebody will read."),
  entry("answer-support", "How to answer a support question without promising a fix date."),
];

describe("the skill catalogue budget", () => {
  it("leaves a catalogue that fits alone, and says nothing", () => {
    const outcome = budgetSkillCatalogue(CATALOGUE, { maxTokens: 1000 });
    expect(outcome.resident).toHaveLength(3);
    expect(outcome.dropped).toEqual([]);
    expect(truncationNotice(outcome)).toBe("");
  });

  it("keeps what fits and names what did not", () => {
    const first = skillEntryTokens(CATALOGUE[0] as SkillCatalogEntry);
    const outcome = budgetSkillCatalogue(CATALOGUE, { maxTokens: first });
    expect(outcome.resident.map((e) => e.name)).toEqual(["triage-issues"]);
    expect(outcome.dropped).toEqual(["write-release-notes", "answer-support"]);
  });

  it("tells the model the catalogue was shortened, and names the skills", () => {
    /**
     * The loud half, and the reason this is not just arithmetic. A context provider has no run event stream, so
     * the model is told in the prompt — and being told during the turn is what lets it say "there may be a skill
     * for this" instead of confidently reporting that none exists.
     */
    const outcome = budgetSkillCatalogue(CATALOGUE, { maxTokens: skillEntryTokens(CATALOGUE[0] as SkillCatalogEntry) });
    const notice = truncationNotice(outcome);
    expect(notice).toContain("write-release-notes");
    expect(notice).toContain("answer-support");
    expect(notice).toContain("2 more");
  });

  it("charges a longer description more, so the budget tracks the real cost", () => {
    const short = entry("a", "short");
    const long = entry("b", "a description that goes on at considerably greater length than the other one does");
    expect(skillEntryTokens(long)).toBeGreaterThan(skillEntryTokens(short));
  });
});
