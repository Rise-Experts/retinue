/**
 * The inventory against the real old runtime — REQ-041 AC-1, AC-4, AC-5 (#190).
 *
 * `inventory.test.ts` tests what an entry must *say*. These test whether the entries describe anything, which
 * is a different question and the one that was going unasked. The old inventory passed every structural check
 * while naming `post_writer`, `publish_guard`, `campaigns.create` and cron `publish_due_posts` — none of which
 * exist in `social_integgration` — and omitting artifacts, diagrams, PDFs, `delete_post`, `repost_post`,
 * branding writes, four agent-skill tools, fourteen HTTP endpoints and five webhooks.
 *
 * So the assertions here are all of the form "compare against the scan":
 *
 * - every reference resolves, and **every capability has an entry** (the omission was the larger defect)
 * - every old tool that required confirmation maps to a new tool that requires approval, or to nothing
 * - every skill the old runtime loads exists in the new one
 */
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_INVENTORY,
  CAPABILITY_STATUSES,
  OLD_RUNTIME_MANIFEST,
  approvalParity,
  approvalParityProblems,
  compositionFinding,
  inventoryProblems,
  manifestCapabilities,
  skillParity,
  validateInventory,
  verifyAgainstManifest,
  type CapabilityEntry,
  type OldRuntimeManifest,
} from "../index.js";
import { SHAREFLOW_TOOL_FACTORIES, SHAREFLOW_TOOL_NAMES } from "../../tools/index.js";
import { PARITY_GATES, evaluateParity, gateFor } from "../../parity/index.js";
import { SOCIAL_ASSISTANT_ID } from "../../manifests/index.js";
import type { ShareFlowServices } from "../../services/index.js";

const manifest = OLD_RUNTIME_MANIFEST;

/**
 * The new runtime's descriptors, built the way `layout.test.ts` builds them.
 *
 * `approvalPolicy` is read off the **built descriptor**, never from a second list written beside it: it is
 * derived by `defineTool` from `effect`, and a hand-maintained copy of "which tools need approval" is exactly
 * the artefact that would keep saying yes after someone relabelled an effect.
 */
const descriptors = (() => {
  const deps = { authorization: { async can() { return { allow: true }; } } } as never;
  const explode = new Proxy(
    {},
    { get(_target, property) { throw new Error(`read services.${String(property)} while building`); } },
  ) as ShareFlowServices;
  return SHAREFLOW_TOOL_FACTORIES.map((factory) => factory.build({ services: explode, deps }).descriptor).map(
    (descriptor) => ({ name: descriptor.name, approvalPolicy: descriptor.approvalPolicy }),
  );
})();

const entryFor = (ref: string): CapabilityEntry => {
  const found = CAPABILITY_INVENTORY.find((entry) => entry.oldRuntimeRef === ref);
  if (found === undefined) throw new Error(`no inventory entry for ${ref}`);
  return found;
};

describe("the committed scan", () => {
  it("describes a live product rather than an empty one", () => {
    /**
     * The snapshot is generated, so the risk is a regeneration from a broken extractor: a regex that stops
     * matching reports **zero**, and zero old capabilities means an inventory that covers all of them. The
     * script refuses below its own minimums; this refuses a committed file that slipped past them.
     */
    expect(manifest.tools.length).toBeGreaterThanOrEqual(25);
    expect(manifest.agents.length).toBeGreaterThanOrEqual(8);
    expect(manifest.routes.length).toBeGreaterThanOrEqual(10);
    expect(manifest.skills.length).toBeGreaterThanOrEqual(5);
    expect(manifest.webhooks.length).toBeGreaterThanOrEqual(3);
    expect(manifest.scheduled.length).toBeGreaterThanOrEqual(1);
  });

  it("records what each decorator states, not just what it means", () => {
    /**
     * `absent` and `false` are different facts. Nine of the 31 tools never state `requires_confirmation`, and
     * flattening them into `false` would hide that the old runtime left it unsaid — so the derived boolean is
     * separate, and its default is the old runtime's own reading rather than this repository's assumption
     * (`getattr(fn, "requires_confirmation", False)`, `ai_backend/tests/assistant/test_factory_and_studio.py`).
     */
    for (const tool of manifest.tools) {
      expect(["true", "false", "absent"]).toContain(tool.confirmationStated);
      expect(tool.requiresConfirmation).toBe(tool.confirmationStated === "true");
    }
    expect(manifest.tools.filter((t) => t.confirmationStated === "absent").length).toBeGreaterThan(0);
  });

  it("carries a source for every capability, so a reviewer never has to trust this file", () => {
    for (const capability of manifestCapabilities(manifest).values()) {
      expect(capability.source, capability.ref).toMatch(/^(ai_backend|web|supabase)\//);
    }
  });
});

describe("the inventory and the old runtime describe the same thing — AC-1", () => {
  it("has an entry for every capability, and no entry for anything else", () => {
    // The assertion the whole rewrite exists for. Both directions: an unresolvable reference is a typo, a
    // capability with no entry is a feature nobody wrote down.
    expect(verifyAgainstManifest({ entries: CAPABILITY_INVENTORY, manifest })).toEqual([]);
  });

  it("reports a reference that resolves to nothing", () => {
    // Exactly the shape of the entries this replaced: `post_writer` typechecked and named nothing.
    const problems = verifyAgainstManifest({
      entries: [{ capability: "draft a post", oldRuntimeRef: "tool:post_writer" }],
      manifest,
    });
    expect(problems.some((p) => p.problem.includes("not in the old runtime"))).toBe(true);
  });

  it("reports a capability nobody wrote an entry for", () => {
    /**
     * The larger of the two defects, and the only one a prose inventory could never catch. An old runtime with
     * a tool and an inventory with none of it: the parity gate then scores every workflow that touches the
     * tool on runs where both sides wrote nothing.
     */
    const problems = verifyAgainstManifest({ entries: [], manifest });
    expect(problems.length).toBe(manifestCapabilities(manifest).size);
    expect(problems.every((p) => p.problem.includes("has no inventory entry"))).toBe(true);
  });

  it("reports two entries claiming the same capability", () => {
    const problems = verifyAgainstManifest({
      entries: [
        { capability: "publish", oldRuntimeRef: "tool:publish_now" },
        { capability: "publish, again", oldRuntimeRef: "tool:publish_now" },
      ],
      manifest,
    });
    expect(problems.some((p) => p.problem.includes("one capability, one entry"))).toBe(true);
  });

  it("excludes the health probe, which has no behaviour to replace", () => {
    // Excluded rather than marked `dropped`: a drop needs a named person, and nobody should have to sign for
    // a liveness endpoint.
    expect(manifest.routes.some((route) => route.path === "/health")).toBe(true);
    expect([...manifestCapabilities(manifest).keys()]).not.toContain("route:GET /health");
  });
});

describe("the approval requirement survives the migration — AC-4", () => {
  it("holds wherever there is a replacement, and is lost nowhere", () => {
    /**
     * The measured result, and the reason this check is mechanical rather than a paragraph: nine of the old
     * runtime's tools are confirmation-gated. Three have replacements — `publish_now`, `schedule_post`,
     * `reply_to_comment` — and all three require approval in the new runtime, derived from `external-write`
     * rather than declared. The other six have no replacement at all, which the inventory records as
     * `missing`; a `repost_post` a customer can use today and cannot after the cutover is a gap, but it is not
     * a *silent* one.
     */
    const results = approvalParity({ entries: CAPABILITY_INVENTORY, manifest, descriptors });
    const byVerdict = (verdict: string) => results.filter((r) => r.verdict === verdict).map((r) => r.oldTool);

    expect(byVerdict("held").sort()).toEqual(["publish_now", "reply_to_comment", "schedule_post"]);
    expect(byVerdict("lost")).toEqual([]);
    expect(byVerdict("no-replacement").sort()).toEqual([
      "delete_agent_skill",
      "delete_post",
      "repost_post",
      "save_agent_skill",
      "set_agent_skill_enabled",
      "update_branding",
    ]);
    expect(approvalParityProblems(results)).toEqual([]);
  });

  it("reports a replacement that dropped the prompt", () => {
    /**
     * The sabotage that matters most in this file. A new runtime asking for **fewer** approvals looks like an
     * improvement in every metric anyone plots: fewer interruptions, faster turns, higher completion. The only
     * thing that catches it is a comparison against the old contract.
     */
    const results = approvalParity({
      entries: CAPABILITY_INVENTORY,
      manifest,
      descriptors: descriptors.map((d) =>
        d.name === "publish_post_now" ? { ...d, approvalPolicy: "never" } : d,
      ),
    });
    const problems = approvalParityProblems(results);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("remove a person from a decision they make today");
    expect(inventoryProblems({ entries: CAPABILITY_INVENTORY, descriptors: descriptors.map((d) =>
      d.name === "publish_post_now" ? { ...d, approvalPolicy: "never" } : d,
    ) })).toHaveLength(1);
  });

  it("does not complain when the new runtime is stricter", () => {
    /**
     * One-directional on purpose. `get_comments` was never confirmation-gated; if `list_comments` grew an
     * approval it would be a stricter product, and failing that would turn this check into pressure to relax
     * the gate — the opposite of what it is for.
     */
    const results = approvalParity({
      entries: CAPABILITY_INVENTORY,
      manifest,
      descriptors: descriptors.map((d) => (d.name === "list_comments" ? { ...d, approvalPolicy: "always" } : d)),
    });
    expect(results.find((r) => r.oldTool === "get_comments")?.verdict).toBe("not-gated");
    expect(approvalParityProblems(results)).toEqual([]);
  });

  it("reads the policy off the built tool, so relabelling an effect moves it", () => {
    /**
     * Not a tautology: `approvalPolicy` is derived by `defineTool` from `effect`, so this asserts the two
     * agree for every tool the descriptors come from. Were `publish_post_now` relabelled `internal-write` to
     * avoid a prompt, the descriptor would say `never` and the check above would fail — which is the point of
     * reading it here rather than keeping a list.
     */
    const gated = descriptors.filter((d) => d.approvalPolicy === "always").map((d) => d.name).sort();
    expect(gated).toEqual([
      "check_media_storage",
      "publish_post_now",
      "reply_to_comment",
      "retry_publish_target",
      "schedule_post",
    ]);
  });
});

describe("prompts and instructions are accounted for — AC-5", () => {
  it("has every skill the old runtime loads", () => {
    // Seven directories in `ai_backend/skills/`, seven skills in this package, same seven names. That is what
    // lets this be a check instead of a paragraph.
    expect(skillParity(manifest)).toEqual([]);
    expect(manifest.skills.map((s) => s.name)).toHaveLength(7);
  });

  it("reports a skill the new runtime dropped", () => {
    // A tool-for-tool match under different instructions produces identical write sets on every run where the
    // missing guidance did not happen to change a decision — so nothing downstream would notice.
    const problems = skillParity(
      manifest,
      manifest.skills.filter((s) => s.name !== "publishing-safety").map((s) => s.name),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("different product");
  });

  it("names an instruction set on every entry that has a replacement", () => {
    for (const entry of CAPABILITY_INVENTORY) {
      if (entry.status !== "implemented" && entry.status !== "partial") continue;
      expect((entry.instructions ?? "").trim(), entry.capability).not.toBe("");
    }
  });

  it("records the composition difference the gate cannot see", () => {
    /**
     * Nine components against one. The old runtime routes through six role-scoped specialists behind a
     * coordinating team, plus a generalist and a studio agent; this package ships one assistant holding all 37
     * tools. On any run where the old leader would have picked the same tool, both runtimes write the same rows
     * and the gate reads agreement — so this is recorded as a finding rather than measured.
     */
    const finding = compositionFinding(manifest, [SOCIAL_ASSISTANT_ID]);
    expect(finding.oldSpecialists).toHaveLength(6);
    expect(finding.oldTeams).toEqual(["chorus-team"]);
    expect(finding.newAgents).toEqual(["social-assistant"]);
    expect(finding.detail).toContain("shadow data cannot decide this one");
  });
});

describe("every capability is attached to a gate, or visibly to none — AC-2", () => {
  it("names only workflows a gate covers", () => {
    // A typo here is the quiet version of the whole defect: `evaluateParity` filters by exact workflow name, so
    // `publish-post` instead of `publish` removes the entry from the gate it was written for and nothing says so.
    for (const entry of CAPABILITY_INVENTORY) {
      for (const workflow of entry.workflows) {
        expect(gateFor(workflow), `${entry.capability} → ${workflow}`).toBeDefined();
      }
    }
  });

  it("leaves no measurable gate without capabilities", () => {
    /**
     * The other direction, and the one that restores the hole silently: a gate no entry names is evaluated
     * against an empty capability list, so it can never report `incomplete` — which is precisely the state the
     * whole report was in before `evaluateParity` took the inventory.
     *
     * Only the measurable gates: `analytics` and `engagement-read` are `unmeasurable-by-shadow`, and they are
     * decided before capabilities are looked at.
     */
    for (const gate of PARITY_GATES) {
      if (gate.metric === "unmeasurable-by-shadow") continue;
      const named = CAPABILITY_INVENTORY.filter((entry) => entry.workflows.includes(gate.workflow));
      expect(named.length, gate.workflow).toBeGreaterThan(0);
    }
  });

  it("produces the incomplete verdict through evaluateParity, not only through evaluateWorkflow", () => {
    /**
     * The reachability assertion. #194 built `incomplete` and tested it through `evaluateWorkflow`, whose
     * `capabilities` argument is optional — and `evaluateParity`, the only function the parity report calls,
     * never passed one. The verdict existed, the report had a symbol for it, and no input could produce it.
     */
    const reports = Array.from({ length: 600 }, () => ({
      identical: true,
      approvalBearingWrites: { old: 0, new: 0 },
    })) as never[];
    const evaluation = evaluateParity({ publish: reports }, CAPABILITY_INVENTORY);
    expect(evaluation.verdicts.find((v) => v.workflow === "publish")?.verdict).toBe("incomplete");

    // The control: the same data with no capabilities passes, which is what the report used to print.
    const blind = evaluateParity({ publish: reports }, []);
    expect(blind.verdicts.find((v) => v.workflow === "publish")?.verdict).toBe("passed");
  });

  it("counts the capabilities no gate covers, rather than letting an empty list read as nothing to do", () => {
    // 22 of 51: artifacts, PDFs, diagrams, branding, the agent-skill tools, five webhooks and the platform
    // endpoints. Not measured by any threshold, so nothing about them can fail — which is worse than failing.
    const ungated = CAPABILITY_INVENTORY.filter((entry) => entry.workflows.length === 0);
    expect(ungated).toHaveLength(22);
    expect(ungated.every((entry) => entry.status === "missing" || entry.status === "retained")).toBe(true);
  });
});

describe("the fields that could still hide a claim", () => {
  const base = (): CapabilityEntry => entryFor("tool:create_draft");

  it("refuses a replacement the new runtime does not serve", () => {
    /**
     * The last free-text field a wrong name could hide in. An entry naming `get_branding` as its replacement
     * would have read as covered forever, because nothing looked the name up — and `get_branding` is precisely
     * one of the tools this package does *not* have.
     */
    const problems = validateInventory([{ ...base(), replacement: "get_branding" }]);
    expect(problems.some((p) => p.problem.includes("serves no tool by that name"))).toBe(true);
    expect(SHAREFLOW_TOOL_NAMES).not.toContain("get_branding");
  });

  it("checks the replacement only for tool entries", () => {
    // A route or a webhook is replaced by a subsystem, not by a tool. Demanding a tool name there would force
    // a false one — the entry for `POST /generate` names `propose_post_angles`, which is a tool, but the one
    // for the sweep names nothing at all and is right to.
    const route = { ...entryFor("route:POST /generate"), replacement: "propose_post_angles" };
    expect(validateInventory([route])).toEqual([]);
  });

  it("refuses an entry that does not say what it changes", () => {
    const problems = validateInventory([{ ...base(), sideEffects: "  " }]);
    expect(problems.some((p) => p.problem.includes("what it changes outside this process"))).toBe(true);
  });

  it("refuses `retained` for a capability inside the runtime being removed", () => {
    /**
     * Without this, `retained` is the escape hatch that empties the inventory: every awkward capability
     * becomes "it stays where it is" and the gate stops blocking. It is only true of the six in `web/`.
     */
    const problems = validateInventory([
      { ...base(), status: "retained", replacement: null, retainedBecause: "we would rather not" },
    ]);
    expect(problems.some((p) => p.problem.includes("inside the runtime the cutover removes"))).toBe(true);
  });

  it("refuses `retained` with no reason", () => {
    const problems = validateInventory([
      { ...entryFor("cron:chorus-schedule-sweep"), retainedBecause: "" },
    ]);
    expect(problems.some((p) => p.problem.includes("does not say why it stays"))).toBe(true);
  });

  it("has a rule for every status — so a new one cannot pass by falling through", () => {
    /**
     * The hazard in `CAPABILITY_STATUSES` growing: `validateInventory` and `gateStatus` branch on the value,
     * and a status matching no branch contributes **no problem** — it passes. The `switch` statements have a
     * `never` default so a sixth status is a compile error, and this asserts the observable half: every status
     * in the list produces either a specific complaint or a considered silence, never the fallback.
     */
    for (const status of CAPABILITY_STATUSES) {
      const problems = validateInventory([
        { ...base(), status, replacement: null, contractTest: undefined, instructions: undefined },
      ]);
      for (const problem of problems) {
        expect(problem.problem, status).not.toContain("which no rule in validateInventory covers");
      }
    }
  });
});

describe("the shipped inventory, checked end to end", () => {
  it("has no problems of any kind", () => {
    // The composite, so no caller can run the cheap half and report a clean inventory.
    expect(inventoryProblems({ entries: CAPABILITY_INVENTORY, descriptors })).toEqual([]);
  });

  it("would report problems against a manifest it does not match", () => {
    /**
     * The control. Without it every assertion above could be passing against checks that return `[]` no matter
     * what — which is what the previous inventory's clean report actually was.
     */
    const shrunk: OldRuntimeManifest = {
      ...manifest,
      tools: [
        ...manifest.tools,
        {
          name: "a_tool_nobody_inventoried",
          confirmationStated: "true",
          requiresConfirmation: true,
          source: "ai_backend/app/assistant/tools.py:1",
        },
      ],
    };
    const problems = inventoryProblems({ entries: CAPABILITY_INVENTORY, manifest: shrunk, descriptors });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.capability).toBe("tool:a_tool_nobody_inventoried");
  });
});
