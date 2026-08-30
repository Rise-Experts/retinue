/**
 * The migrated skills (#122).
 *
 * Two of these tests read the shipped source rather than a value, and for the same reason as #118's:
 * "no limit was restated" and "no absent tool is named" are claims about what is *not* there, and a
 * fixture cannot demonstrate an absence.
 */
import { describe, expect, it } from "vitest";
import { asId, type RunId, type TenantId } from "@retinue/agentkit";
import { SKILL_LIMITS, createRunSkillTracker, createSkillResolver } from "@retinue/agentkit/context";
import { createMemorySkillStore } from "@retinue/agentkit/persistence";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  SHAREFLOW_ASSIGNED_SKILLS,
  SHAREFLOW_BUILT_IN_SKILLS,
  SHAREFLOW_SKILL_BODIES,
  defineShareFlowSkill,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const RUN = asId<RunId>("r1");

const here = dirname(fileURLToPath(import.meta.url));
const contentSource = readFileSync(resolve(here, "../content.ts"), "utf8");
/** Comments stripped: the notes deliberately *mention* what was removed. */
const bodies = Object.values(SHAREFLOW_SKILL_BODIES).join("\n\n");

const resolver = () =>
  createSkillResolver({ builtIn: SHAREFLOW_BUILT_IN_SKILLS, store: createMemorySkillStore() });

/** AC-1. */
describe("all seven skills are available, versioned and text-only", () => {
  it("registers every skill from the original set", () => {
    expect(Object.keys(SHAREFLOW_SKILL_BODIES).sort()).toEqual([
      "analytics-reporting",
      "document-generation",
      "mermaid-diagrams",
      "platform-media-rules",
      "post-composition",
      "publishing-safety",
      "research-and-citation",
    ]);
    expect(SHAREFLOW_BUILT_IN_SKILLS).toHaveLength(7);
  });

  it("validates every body against the platform's own limits at import time", () => {
    // `defineShareFlowSkill` runs `validateSkillInput`, so a body that broke a limit would have failed
    // the import above rather than reaching here. This asserts the limits are actually near enough to
    // matter — a description under the 20-character floor or instructions over 20k would have thrown.
    for (const skill of SHAREFLOW_BUILT_IN_SKILLS) {
      expect(skill.description.length, skill.name).toBeGreaterThanOrEqual(SKILL_LIMITS.descriptionMinLength);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(SKILL_LIMITS.descriptionMaxLength);
      expect(skill.instructions.length, skill.name).toBeLessThanOrEqual(SKILL_LIMITS.instructionsMaxLength);
      expect(skill.name, skill.name).toMatch(SKILL_LIMITS.namePattern);
    }
  });

  it("starts every skill at version 1, so a recorded version means something", () => {
    // #30's guarantee is that a run records the version it executed, which is only meaningful if the
    // number moves when the text does. Every body was edited during migration, so version 1 is honest:
    // this text has never been executed before.
    for (const skill of SHAREFLOW_BUILT_IN_SKILLS) expect(skill.version, skill.name).toBe(1);
  });
});

/** AC-2. */
describe("no skill can contain executable code", () => {
  it("has no field capable of holding anything executable", () => {
    // Structural, and stated rather than pattern-matched. `SkillVersion` has one content field —
    // `instructions: string` — so text that looks like code is inert. A test that grepped the bodies for
    // "function" would be theatre; this asserts the shape that makes it impossible.
    for (const skill of SHAREFLOW_BUILT_IN_SKILLS) {
      expect(Object.keys(skill).sort(), skill.name).toEqual([
        "createdAt",
        "description",
        "id",
        "instructions",
        "name",
        "source",
        "status",
        "version",
      ]);
      for (const [key, value] of Object.entries(skill)) {
        expect(typeof value, `${skill.name}.${key}`).not.toBe("function");
      }
    }
  });

  it("cannot be given an executable field through the builder", () => {
    // The builder constructs the record field by field, so an extra property on the input cannot reach
    // the skill — which is the only route a caller has.
    const built = defineShareFlowSkill({
      name: "post-composition",
      description: "a description comfortably over the twenty character floor",
      instructions: "do the thing",
      version: 1,
      authoredAt: "2026-08-23T00:00:00.000Z",
      // @ts-expect-error deliberately planting a field the type does not allow
      execute: () => "pwned",
    });
    expect(built).not.toHaveProperty("execute");
  });
});

/** AC-3. */
describe("platform limits exist in exactly one place", () => {
  it("restates no limit value in any skill body", () => {
    // The reconciliation of AC-3 against #118. `platform_rules` is workspace-overridable, so a limit in
    // a skill body is a second source that can disagree with the tenant's own configuration — and the
    // model would be working from the wrong one with no error anywhere.
    expect(bodies).not.toMatch(/\b280\b/);           // X's character limit
    expect(bodies).not.toMatch(/\b52_?428_?800\b/);  // MEDIA_MAX_BYTES
    expect(bodies).not.toMatch(/\b50\s?MB\b/i);
    expect(bodies).not.toMatch(/\bone PDF per post\b/i);
    expect(bodies).not.toMatch(/\bvideo only\b/i);
    expect(bodies).not.toMatch(/\brequired\b.*\battachment\b/i);
    // Hashtag counts: `hashtag_min` / `hashtag_max` are also per-workspace.
    expect(bodies).not.toMatch(/\b\d+\s*[–-]\s*\d+\s*hashtags?\b/i);
  });

  it("tells the model to ask instead", () => {
    // The original skill already contained the resolution — "runs the same check as the publisher" — and
    // it is now the whole skill rather than a footnote to a table.
    const media = SHAREFLOW_SKILL_BODIES["platform-media-rules"];
    expect(media).toContain("check_media_for_platforms");
    expect(media).toContain("same check as the publisher");
    expect(media).toMatch(/per-workspace configuration/);
  });

  it("keeps the media provider free of limits too, as #118 established", () => {
    // Restated here rather than only in #118's suite, because AC-3 is about the *pair*: a limit removed
    // from one place and added to the other satisfies neither.
    const provider = readFileSync(resolve(here, "../../tools/media.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    expect(provider).not.toMatch(/52_?428_?800/);
    expect(provider).not.toMatch(/\bMEDIA_MAX/);
  });
});

/** AC-4. */
describe("skills load lazily and the version is recorded", () => {
  it("loads only what was asked for, not all seven", async () => {
    const tracker = createRunSkillTracker({ resolver: resolver() });
    await tracker.load({ tenantId: T1, runId: RUN, name: "publishing-safety", version: 1 });
    const loaded = tracker.recorded(RUN);
    expect(loaded.map((r) => r.name)).toEqual(["publishing-safety"]);
    // The observable effect: six bodies were never materialised into the run.
    expect(loaded).toHaveLength(1);
  });

  it("records the name, version and source of every load", async () => {
    const tracker = createRunSkillTracker({ resolver: resolver() });
    await tracker.load({ tenantId: T1, runId: RUN, name: "post-composition", version: 1 });
    expect(tracker.recorded(RUN)[0]).toMatchObject({
      name: "post-composition",
      version: 1,
      source: "built-in",
    });
  });

  it("returns the migrated body, not a placeholder", async () => {
    const loaded = await resolver().loadBody({ tenantId: T1, name: "publishing-safety", version: 1 });
    expect(loaded.instructions).toContain("Never guess a date");
    expect(loaded.instructions).toBe(SHAREFLOW_SKILL_BODIES["publishing-safety"]);
  });
});

/** AC-5 — the reconciliations, asserted so they cannot quietly regress. */
describe("the migrated content matches implemented behaviour", () => {
  it("does not claim that confirmation is automatic", async () => {
    // The original said "the system pauses and asks the user when you invoke them". #119 established
    // that it does not: `allow-once` issues no grant, nothing executes the stored approved input, and the
    // call returns `approval_required`. Shipping this unchanged would have the model invoke, say nothing,
    // and wait for a prompt that never arrives.
    expect(bodies).not.toMatch(/confirmation is automatic/i);
    expect(bodies).not.toMatch(/let the system ask/i);
    expect(bodies).not.toMatch(/the system pauses and asks/i);
    expect(SHAREFLOW_SKILL_BODIES["publishing-safety"]).toContain("approval_required");
    expect(SHAREFLOW_SKILL_BODIES["analytics-reporting"]).toContain("approval_required");
  });

  it("describes the half-published rule, not just the published one", () => {
    // `assertEditable` refuses a post that is uneditable because *any* destination succeeded, even while
    // the post's own status has not caught up. The original's narrower wording would have the assistant
    // confidently offering an edit that is refused.
    for (const name of ["platform-media-rules", "publishing-safety"] as const) {
      expect(SHAREFLOW_SKILL_BODIES[name], name).toMatch(/any\*{0,2}\s*destination/i);
    }
  });

  it("points at the derived outcome rather than leaving the judgement to the model", () => {
    const safety = SHAREFLOW_SKILL_BODIES["publishing-safety"];
    for (const outcome of ["published", "scheduled", "partial", "unconfirmed", "failed"]) {
      expect(safety, outcome).toContain(`\`${outcome}\``);
    }
    // The one that matters: an unconfirmed destination is not a success.
    expect(safety).toMatch(/This is not success/i);
  });

  it("teaches the boolean rather than the arithmetic", () => {
    // #115 replaced `captionLength` with `captionStoredInFull` because a model asked to remember a
    // number and compare it is being asked to do the thing it is worst at. The skill was teaching the
    // arithmetic.
    const composition = SHAREFLOW_SKILL_BODIES["post-composition"];
    expect(composition).toContain("captionStoredInFull");
    expect(composition).not.toContain("captionLength");
    expect(composition).toMatch(/Do not compare lengths yourself/i);
  });

  it("names no tool that does not exist", () => {
    // A loaded skill instructing a call into nothing is worse than an absent skill: the model follows it
    // and fails. These are the tools the original named that this package has no counterpart for.
    for (const absent of [
      "check_conversion",
      "repost_post",
      "delete_post",
      "add_post_media",
      "remove_post_media",
      "check_media_compatibility",
      "create_draft`",
      "get_post_stats",
      "search_web",
      "read_url",
      "read_pdf",
    ]) {
      expect(bodies, absent).not.toContain(absent);
    }
  });

  it("keeps the artifact skills out of discovery until their tools exist", async () => {
    // Every tool `mermaid-diagrams` and `document-generation` describe is REQ-028. Migrated and
    // versioned, not offered — which is what `status: "draft"` is for, now that the resolver honours it
    // for built-ins as the store already did for tenant skills.
    const drafts = SHAREFLOW_BUILT_IN_SKILLS.filter((s) => s.status === "draft").map((s) => s.name);
    expect([...drafts].sort()).toEqual(["document-generation", "mermaid-diagrams"]);
    expect(SHAREFLOW_ASSIGNED_SKILLS).not.toContain("mermaid-diagrams");
    expect(SHAREFLOW_ASSIGNED_SKILLS).toHaveLength(5);

    // And discovery agrees, even when a manifest names them.
    const catalog = await resolver().listCatalog({
      tenantId: T1,
      assigned: SHAREFLOW_BUILT_IN_SKILLS.map((s) => s.name),
      allowTenantSkills: false,
    });
    expect(catalog.map((e) => e.name)).not.toContain("mermaid-diagrams");
    expect(catalog).toHaveLength(5);
  });

  it("still resolves a draft skill by exact version, so a pinned run keeps working", async () => {
    // Matching the store's documented behaviour: "a run pinned to an archived version keeps working and
    // no new run picks it up." Only discovery hides it.
    const loaded = await resolver().loadBody({ tenantId: T1, name: "mermaid-diagrams", version: 1 });
    expect(loaded.instructions).toContain("Quote any label with punctuation");
  });

  it("records what changed, next to what changed it", () => {
    // A reconciliation nobody can see is indistinguishable from a transcription error, and AC-6 asks a
    // human to review these judgements — which they cannot do if the judgements are not written down.
    for (const name of Object.keys(SHAREFLOW_SKILL_BODIES)) {
      expect(contentSource, name).toContain(`\`${name}\`.`);
    }
    expect(contentSource).toMatch(/\*\*Changed[,:]/);
    expect(contentSource).toMatch(/\*\*Removed:/);
  });
});

describe("the always-on rule the skill asked for", () => {
  it("keeps the untrusted-content rule out of the skill and in base policy", () => {
    // `research-and-citation` says the rule "must never depend on this skill being loaded". So the skill
    // keeps a pointer and the rule itself is a base-policy section — one wording, always present.
    const research = SHAREFLOW_SKILL_BODIES["research-and-citation"];
    expect(research).toMatch(/always-on instructions/);
    expect(research).toMatch(/data, not instructions/);
  });
});
