/**
 * The inventory, and the hole it closes — #194.
 *
 * The hole is worth restating because every test here is aimed at it: #128's gate compares **write sets**, and a
 * capability the new runtime does not implement writes **nothing**. Comparing nothing against nothing gives an
 * identical-write rate of 100%. So the strongest form of this defect is not a failing gate — it is a *passing*
 * one, on a workflow nobody built.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEHAVIOURAL_CONTRACT,
  CAPABILITY_INVENTORY,
  coverageOf,
  gateStatus,
  inventoryTally,
  manifestCapabilities,
  validateInventory,
  OLD_RUNTIME_MANIFEST,
  type CapabilityEntry,
  type OldRuntimeManifest,
} from "../index.js";
import { SHAREFLOW_BUILT_IN_SKILLS } from "../../skills/index.js";

const entry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  capability: "draft a post",
  // A real reference, because `validateInventory` now looks entries up in the committed manifest to check the
  // replacement names a tool that exists and that `retained` is not claimed inside `ai_backend/`. A fixture
  // pointing at nothing would exercise neither.
  oldRuntimeRef: "tool:create_draft",
  replacement: "create_post_draft",
  status: "implemented",
  invocation: "interactive",
  contractTest: "posts.test.ts",
  // AC-5: an entry with a replacement has to say which instruction set it runs under, and `none` is a value
  // somebody has to type rather than one they can reach by omission.
  instructions: "skills/post-composition",
  // AC-1: what it changes outside this process, with "none — a read" a value someone has to write.
  sideEffects: "inserts a post row",
  // AC-2: the docs/07 gates this capability's runs reach. Without it the workflow verdict cannot see it.
  workflows: ["create-post"],
  ...over,
});

/**
 * A manifest containing exactly the fixture's capabilities.
 *
 * `gateStatus` compares *sets*: it fails an inventory that omits a capability the old runtime has, which is
 * the half of AC-1 that was missing and the reason the shipped inventory grew from 27 entries to 51. A
 * one-entry fixture judged against the real manifest is therefore incomplete by construction and would say
 * nothing about the rule under test. So each test states its own premise about what the old runtime is,
 * rather than being handed a weaker check.
 */
const manifestFor = (entries: readonly CapabilityEntry[]): OldRuntimeManifest => ({
  repository: "fixture",
  tools: entries
    .filter((e) => e.oldRuntimeRef.startsWith("tool:"))
    .map((e) => ({
      name: e.oldRuntimeRef.slice("tool:".length),
      confirmationStated: "false" as const,
      requiresConfirmation: false,
      source: "ai_backend/app/assistant/tools.py:1",
    })),
  agents: [],
  routes: [],
  skills: [],
  webhooks: [],
  scheduled: [],
});

/** A recorded run, reduced to the tools it called — all `coverageOf` reads. */
const agreeing = (tools: readonly string[]): { readonly toolsCalled: readonly string[] } => ({ toolsCalled: tools });

describe("what an entry has to say", () => {
  it("accepts a complete implemented entry", () => {
    expect(validateInventory([entry()])).toEqual([]);
  });

  it("refuses a dropped capability with no signature", () => {
    // A capability removed silently is a customer's workflow removed silently.
    const problems = validateInventory([entry({ status: "dropped", replacement: null })]);
    expect(problems[0]?.problem).toContain("no signature");
  });

  it("refuses a signature missing its date", () => {
    // A decision without a date cannot be reviewed later, which is exactly when someone asks who agreed.
    const problems = validateInventory([
      entry({ status: "dropped", replacement: null, droppedBy: { by: "someone", at: "", reason: "not needed" } }),
    ]);
    expect(problems.some((p) => p.problem.includes("no usable date"))).toBe(true);
  });

  it("accepts a properly signed drop", () => {
    expect(
      validateInventory([
        entry({
          status: "dropped",
          replacement: null,
          droppedBy: { by: "a.person", at: "2026-08-26", reason: "no customer has used it in 18 months" },
        }),
      ]),
    ).toEqual([]);
  });

  it("refuses a dropped capability that also names a replacement", () => {
    const problems = validateInventory([
      entry({ status: "dropped", droppedBy: { by: "x", at: "2026-01-01", reason: "y" } }),
    ]);
    expect(problems.some((p) => p.problem.includes("one or the other"))).toBe(true);
  });

  it("refuses an implemented capability with no behavioural test", () => {
    // "The tool exists" is not "the tool matches" — AC-5.
    const problems = validateInventory([entry({ contractTest: "" })]);
    expect(problems.some((p) => p.problem.includes("no behavioural test"))).toBe(true);
  });

  it("refuses a scheduled or webhook capability with no coverage evidence", () => {
    // Nobody shadows 03:00. Requiring shadow runs of these would require something impossible; requiring
    // *evidence* is the thing that can actually be produced.
    for (const invocation of ["scheduled", "triggered", "webhook"] as const) {
      const problems = validateInventory([entry({ invocation })]);
      expect(problems.some((p) => p.problem.includes("its own coverage evidence")), invocation).toBe(true);
    }
  });

  it("refuses the same capability twice", () => {
    const problems = validateInventory([entry(), entry()]);
    expect(problems.some((p) => p.problem.includes("appears twice"))).toBe(true);
  });
});

describe("instructions are accounted for — AC-5", () => {
  /**
   * A tool-for-tool match under different instructions is a different product, and the difference produces
   * *identical write sets* on every run where the instructions did not happen to matter — so the parity gate is
   * the one thing that cannot catch it.
   */
  it("refuses an entry with a replacement and no instruction set named", () => {
    const problems = validateInventory([entry({ instructions: undefined })]);
    expect(problems.map((p) => p.problem).join(" ")).toContain("instruction set");
  });

  it("accepts `none` with a reason, because deterministic tools exist", () => {
    // The point of requiring the field rather than defaulting it: "no prose" and "nobody looked" have to be
    // distinguishable, and only one of them can be typed.
    expect(validateInventory([entry({ instructions: "none — a deterministic read" })])).toEqual([]);
  });

  it("does not demand instructions from a capability that is not built", () => {
    // A `missing` entry has no replacement to run under anything. Demanding it would be asking somebody to
    // invent the instructions for a tool that does not exist.
    expect(validateInventory([entry({ status: "missing", replacement: null, instructions: undefined, contractTest: undefined })])).toEqual([]);
  });

  it("every shipped entry with a replacement names one", () => {
    const silent = CAPABILITY_INVENTORY.filter(
      (candidate) => candidate.replacement !== null && (candidate.instructions ?? "").trim() === "",
    );
    expect(silent.map((candidate) => candidate.capability)).toEqual([]);
  });

  it("every named skill exists in the shipped skill set", () => {
    /**
     * The claim that would otherwise rot. `instructions: "skills/post-composition"` is a string; a renamed or
     * deleted skill leaves it pointing at nothing, and the inventory would keep reporting that instructions are
     * accounted for.
     */
    const known = new Set(SHAREFLOW_BUILT_IN_SKILLS.map((skill) => skill.name));
    const unknown: string[] = [];
    for (const candidate of CAPABILITY_INVENTORY) {
      for (const [, name] of (candidate.instructions ?? "").matchAll(/skills\/([a-z0-9-]+)/g)) {
        if (name !== undefined && !known.has(name)) unknown.push(`${candidate.capability} → ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe("coverage is counted, never supplied", () => {
  it("counts a shadow run only when it called the replacement", () => {
    const coverage = coverageOf({
      entries: [entry(), entry({ capability: "publish", replacement: "publish_post_now" })],
      shadowRuns: [agreeing(["create_post_draft"]), agreeing(["create_post_draft"]), agreeing(["list_accounts"])],
    });
    expect(coverage.find((c) => c.capability === "draft a post")?.shadowRuns).toBe(2);
    expect(coverage.find((c) => c.capability === "publish")?.shadowRuns).toBe(0);
  });

  it("gives a missing capability zero, since there is no tool to have been called", () => {
    const coverage = coverageOf({
      entries: [entry({ status: "missing", replacement: null })],
      shadowRuns: [agreeing(["create_post_draft"])],
    });
    expect(coverage[0]?.shadowRuns).toBe(0);
  });

  it("has no way for a caller to state a count — AC-3", () => {
    /**
     * Structural, not behavioural, and that is why it is a test.
     *
     * `coverageOf`'s input has no `shadowRuns` *per entry*: the only shadow input is the run list. An entry's
     * author is the person most likely to believe their capability is covered, so a number they could write is a
     * number that says what they expect rather than what happened.
     */
    const keys = Object.keys(entry());
    expect(keys).not.toContain("shadowRuns");
  });
});

describe("zero shadow runs cannot contribute to a pass — AC-4", () => {
  it("reports an implemented, unexercised capability", () => {
    const gate = gateStatus({ entries: [entry()], shadowRuns: [], manifest: manifestFor([entry()]) });
    expect(gate.status).toBe("incomplete");
    expect(gate.unexercised).toEqual(["draft a post"]);
  });

  it("does not demand shadow runs of a capability shadow traffic cannot reach", () => {
    // A webhook with evidence is covered. Counting its (necessarily zero) shadow runs against it would be
    // demanding the impossible and then calling its absence a defect.
    const webhook = entry({ invocation: "webhook", coverageEvidence: "replayed fixture: webhooks.test.ts" });
    const gate = gateStatus({ entries: [webhook], shadowRuns: [], manifest: manifestFor([webhook]) });
    expect(gate.unexercised).toEqual([]);
    expect(gate.status).toBe("complete");
  });

  it("is complete when everything is built and exercised", () => {
    const gate = gateStatus({
      entries: [entry()],
      shadowRuns: [agreeing(["create_post_draft"])],
      manifest: manifestFor([entry()]),
    });
    expect(gate.status).toBe("complete");
    expect(gate.problems).toEqual([]);
  });
});

describe("the shipped inventory", () => {
  it("is structurally valid — every entry says everything its status requires", () => {
    /**
     * Zero problems, which it did not manage before the rewrite for a reason worth keeping in view: the old
     * file also reported zero, while naming capabilities that do not exist. Structural validity was never the
     * hard part — `verifyAgainstManifest` is, and it has its own tests in `manifest.test.ts`.
     */
    expect(validateInventory(CAPABILITY_INVENTORY)).toEqual([]);
  });

  it("reports incomplete, which is the honest answer today", () => {
    const gate = gateStatus({ entries: CAPABILITY_INVENTORY, shadowRuns: [] });
    expect(gate.status).toBe("incomplete");

    /**
     * The tally, pinned. Named numbers rather than a list of strings, because the list would be edited to match
     * on every change and stop being a claim — but the *shape* of the migration is a claim: this package
     * replaces 25 of the old runtime's capabilities outright, has 8 signed off as dropped, and has not
     * replaced 12.
     *
     * 13 → 16 when the three artifact tools shipped, → 18 with `repost_post` and `delete_post`. All five were
     * listed as needing only a tool over services that already existed, and that turned out to be exactly
     * true — `assistant_artifacts` and its version table for the first three, `scheduled_items` and the
     * connector seam for the other two.
     *
     * 25 → 26 with `generate_campaign`, which is the first of the twelve missing capabilities to land —
     * one `proposeAngles` call then `generate` per angle, with the siblings' hooks named. It needed a port
     * field (`avoidHooks`) because `avoid` renders as a rejection, which is false of a sibling.
     *
     * 26 → 27 with `suggest_campaign_ideas`, the advisory half of the same cluster. It gained something
     * the old route lacked rather than only porting it: the trend search's own outcome is reported
     * (`trendGrounded`), because a fail-soft search made "found nothing" and "never looked" the same
     * value, and ideas from the model's priors then read as grounded in a live search.
     *
     * 27 → 28 with `evaluate_campaign`, which took a port method with it (`campaignBreakdown`) because
     * "which post did best" is unanswerable from an aggregate. Its input is only a campaign id: the old
     * signature took the `stats` string it then told the model not to embellish, which is unenforceable
     * when the model is what supplies them.
     *
     * **36 → 37 with `generate_pdf`, and `missing` reaches zero.** Every capability the old runtime has
     * is either replaced, signed off as dropped, or retained where it already lives. What is left of the
     * cutover is not code: shadow data, the flag flip per workspace, and removing `ai_backend`.
     *
     * 34 → 36 with `capture_website` and `render_diagram`, the first two capabilities that needed
     * **Chromium in the image** — a decision rather than more of the same work, and signed off. Both go
     * through one browser slot, because the old runtime was OOM-killed for not having one. `generate_pdf`
     * is the last, and it is the third caller of that same browser.
     *
     * 33 → 34 with `describe_image`, which needed the model layer to grow: `StructuredGenerate` now takes
     * an optional image, so the model, its credentials and its pricing are still resolved in one place.
     * The three left need a headless browser (`render_diagram`, `POST /capture`) or a PDF writer
     * (`generate_pdf`) — none of them a model call.
     *
     * 32 → 33 with `read_pdf`, the last capability in both `create-post` and `campaign-planning`. It is
     * the first one that needed a **new dependency** (`unpdf`) and a byte-capable guarded fetch, since
     * the platform's HTTP client returns strings and caps at 200 KB — right for a page a model reads as
     * prose, and smaller than almost every real PDF.
     *
     * 30 → 32 with the two media-*prompt* capabilities, `enhance_media_prompt` and `plan_video_scenes`.
     * Both are text: they write the prompt a generation job is queued with and generate no media, which
     * is why they are `media` by category and `ContentGenerator` by port. The five left all need
     * something this runtime does not have — a PDF parser, a headless browser, or a vision call.
     *
     * 29 → 30 with `repurpose_source`, which completes the `repurpose` workflow — its only capability.
     * Worth noting where its caller is: `/repurpose` has no Next.js route, and the live caller is the
     * `repurpose` tool in the web app's MCP server, a `retained` surface that outlives the cutover.
     *
     * 28 → 29 with `route:POST /campaign/agent`, and it is the one entry whose replacement is not shaped
     * like what it replaces: the autonomy belongs to this runtime, which *is* an agent, and a sub-agent
     * inside a tool would run an invisible second tool budget outside the approval gate. What the tool
     * gained is the grounding (`researchFirst`). The screenshots that route could take are still missing
     * under their own entry, and nothing here claims them.
     *
     * 22 → 25 and **partial → 0** when `POST /api/tools/:name` shipped. All three were `partial` for one
     * reason and it was never the tool: `propose_post_angles`, `generate_content` and `draft_comment_reply`
     * were done and tested, and the old runtime also exposed them as routes the Next app calls from a form.
     * The entry point was the missing half, and it is gated to `read` and `internal-write` effects — a
     * conversation is where an approval is asked for, and this endpoint has nobody to ask.
     */
    expect(inventoryTally(CAPABILITY_INVENTORY)).toEqual({
      implemented: 37,
      partial: 0,
      missing: 0,
      dropped: 8,
      retained: 6,
    });
  });

  it("carries a real name, date and reason on every drop — and the drops do not unblock a gate", () => {
    /**
     * Eight drops signed on 2026-09-07: the six workspace-configuration tools and the two platform endpoints.
     *
     * The second assertion is the one worth having. `dropped` does not block a workflow verdict — by design,
     * since the control on a drop is the signature rather than the gate — which means signing one is a way to
     * turn a blocking capability into a passing one. Every capability signed off here names **no** workflow, so
     * no verdict moved. If a later drop covers something a gate measures, this fails and somebody has to look
     * at whether the gate still means anything.
     */
    const dropped = CAPABILITY_INVENTORY.filter((entry) => entry.status === "dropped");
    expect(dropped).toHaveLength(8);
    for (const entry of dropped) {
      expect(entry.droppedBy?.by, entry.capability).toBe("Jane Doe");
      expect(entry.droppedBy?.at, entry.capability).toBe("2026-09-07");
      // A reason long enough to say what was given up. A one-word reason is a reason nobody can review.
      expect((entry.droppedBy?.reason ?? "").length, entry.capability).toBeGreaterThan(80);
      expect(entry.replacement, entry.capability).toBeNull();
      expect(entry.workflows, entry.capability).toEqual([]);
    }
  });

  it("records what each drop costs, rather than implying somewhere else covers it", () => {
    /**
     * Two of the eight remove the only surface a thing has, and the signature says so instead of a comment
     * beside it — because the record is what a reviewer reads in a year, and "it moved to the UI" would be
     * false in both cases.
     *
     * `update_branding` is the only writer of `workspace_ai_profile` in the product: the white-label settings
     * screen writes `workspace_branding`, a different table, and the MCP server only reads the AI profile.
     * `workspace_agent_skills` has no UI at all — the four Agno tools are its only surface.
     */
    const reasonFor = (ref: string) =>
      CAPABILITY_INVENTORY.find((entry) => entry.oldRuntimeRef === ref)?.droppedBy?.reason ?? "";
    expect(reasonFor("tool:update_branding")).toContain("only writer of workspace_ai_profile");
    expect(reasonFor("tool:save_agent_skill")).toContain("no UI for workspace_agent_skills");
    // And the two that genuinely move work rather than deleting it say *that*, not that it is covered.
    expect(reasonFor("route:POST /llm/validate")).toContain("instead of");
  });

  it("asks a dropped entry for no coverage evidence, and still asks for its signature", () => {
    /**
     * Both halves, because the exemption could be the hole. Two signed drops are `triggered` routes, and the
     * coverage text they used to carry — "the cutover runbook has to carry it" — became false the moment
     * somebody signed them off; a stale reassurance is worse than a blank.
     *
     * The control is that removing the signature still fails. Were the exemption written as "dropped entries
     * are fine", a drop with nobody's name on it would pass.
     */
    const route = CAPABILITY_INVENTORY.find((e) => e.oldRuntimeRef === "route:POST /llm/validate");
    if (route === undefined) throw new Error("expected the llm/validate entry");
    expect(route.coverageEvidence).toBeUndefined();
    expect(validateInventory([route])).toEqual([]);

    const unsigned: CapabilityEntry = { ...route, droppedBy: undefined };
    expect(validateInventory([unsigned]).map((p) => p.problem)).toEqual([
      "is dropped with no signature — AC-1 requires a named decision",
    ]);
  });

  it("marks nothing inside ai_backend as retained", () => {
    /**
     * `retained` is the status that could empty this file: "it stays where it is" is available for anything
     * inconvenient. It is only true of the six capabilities in `web/` — five webhooks and the sweep — and
     * `validateInventory` refuses it for a capability whose source is under `ai_backend/`, which is the runtime
     * the cutover deletes.
     */
    const capabilities = manifestCapabilities(OLD_RUNTIME_MANIFEST);
    for (const entry of CAPABILITY_INVENTORY.filter((e) => e.status === "retained")) {
      expect(capabilities.get(entry.oldRuntimeRef)?.source, entry.capability).not.toMatch(/^ai_backend\//);
    }
    expect(CAPABILITY_INVENTORY.filter((e) => e.status === "retained")).toHaveLength(6);
  });

  it("every contract test it names is a file that exists", () => {
    /**
     * The other claim that rots. `contractTest: "…/posts.test.ts"` is a string, and a renamed or deleted test
     * leaves the entry asserting a behavioural comparison that nothing performs — while `validateInventory`
     * keeps reporting the entry as complete, because the field is non-empty.
     *
     * Paths are repository-relative, so this resolves them from the workspace root rather than from here.
     */
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const missing = [...new Set(CAPABILITY_INVENTORY.map((entry) => entry.contractTest).filter(Boolean))].filter(
      (path) => !existsSync(resolve(root, path as string)),
    );
    expect(missing).toEqual([]);
  });

  it("names a behavioural contract with the approval clause in it", () => {
    // The failure mode that matters most, because a runtime asking for fewer approvals looks like an improvement.
    expect(BEHAVIOURAL_CONTRACT.some((c) => c.includes("approval"))).toBe(true);
  });
});
