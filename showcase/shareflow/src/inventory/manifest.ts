/**
 * The old runtime, as extracted from its source — REQ-041 AC-1 (#190).
 *
 * The inventory is a set of claims about another repository, and until this module existed they were claims
 * nothing could check. That was not a theoretical hole. The first scan of the real `social_integgration` found
 * that the committed inventory named, among others, `post_writer`, `publish_guard`, `campaigns.create`,
 * `engagement.inbox`, `analytics.attribution`, cron `publish_due_posts` and `POST /webhooks/:platform/comments`
 * — **none of which exist**. It also omitted most of what does: artifacts, diagrams, PDFs, `delete_post`,
 * `repost_post`, branding writes and the four agent-skill tools.
 *
 * An inventory that validates cleanly while describing a runtime that is not there is the worst possible
 * artefact for this REQ, because its whole purpose is to stop a missing capability reading as parity. So the
 * hand-typed `oldRuntimePath` string is gone, replaced by a **reference that has to resolve**:
 * `tool:publish_now`, `route:POST /campaign`, `webhook:/api/webhooks/stripe`, `cron:chorus-schedule-sweep`. A
 * typo is a failing test, and the human-readable path comes from the manifest rather than from a typist.
 *
 * The three checks here are the ones that cannot be satisfied by writing prose:
 *
 * - `verifyAgainstManifest` — every entry resolves, and **every capability has an entry**. Omission was the
 *   larger of the two defects and the only check that catches it is the one that walks the old runtime.
 * - `approvalParity` — an old tool that required confirmation must map to a new tool that requires approval.
 *   #194 named this the failure mode that matters most, because a runtime asking for *fewer* approvals looks
 *   like an improvement in every metric anyone plots.
 * - `skillParity` — the old runtime's seven instruction sets, matched against the new runtime's. AC-5 asks
 *   that prompts be *accounted for*, and an unchecked field accounts for nothing.
 */

import { SHAREFLOW_BUILT_IN_SKILLS } from "../skills/index.js";

export type OldRuntimeTool = {
  readonly name: string;
  /**
   * What the decorator says, kept separate from the derived boolean.
   *
   * A bare `@tool()` is not the same fact as `@tool(requires_confirmation=False)`: 9 of the 31 tools never
   * state it, and flattening them into `false` would hide that. The default is not this repository's to
   * assume either — the old runtime's own test reads it as `getattr(fn, "requires_confirmation", False)` in
   * `ai_backend/tests/assistant/test_factory_and_studio.py`, so `absent` means false *by its own reading*, and
   * that citation is what makes `requiresConfirmation` evidence rather than a guess.
   */
  readonly confirmationStated: "true" | "false" | "absent";
  readonly requiresConfirmation: boolean;
  readonly source: string;
};

export type OldRuntimeAgent = {
  readonly id: string;
  readonly kind: "generalist" | "specialist" | "team";
  readonly tools: readonly string[];
  readonly source: string;
};

export type OldRuntimeRoute = { readonly method: string; readonly path: string; readonly source: string };
export type OldRuntimeSkill = { readonly name: string; readonly source: string };
export type OldRuntimeWebhook = {
  readonly path: string;
  readonly methods: readonly string[];
  readonly source: string;
};
export type OldRuntimeJob = {
  readonly job: string;
  readonly schedule: string;
  readonly command: string;
  readonly source: string;
};

export type OldRuntimeManifest = {
  readonly repository: string;
  readonly tools: readonly OldRuntimeTool[];
  readonly agents: readonly OldRuntimeAgent[];
  readonly routes: readonly OldRuntimeRoute[];
  readonly skills: readonly OldRuntimeSkill[];
  readonly webhooks: readonly OldRuntimeWebhook[];
  readonly scheduled: readonly OldRuntimeJob[];
};

/**
 * The kinds an inventory entry can point at, and therefore the kinds the omission check covers.
 *
 * `skill` and `agent` are deliberately **not** here, and the exemption is load-bearing rather than an
 * oversight. A skill is an instruction set, not an invocable capability, and an agent is a composition of the
 * tools already listed — giving each of the nine agents its own entry would count the same 31 tools nine times
 * and make the inventory read as far larger than the surface it covers. They are checked instead by
 * `skillParity` and `compositionParity`, which is why those functions exist and are called by the same test
 * that calls this one.
 */
export const INVENTORIED_KINDS = ["tool", "route", "webhook", "cron"] as const;
export type InventoriedKind = (typeof INVENTORIED_KINDS)[number];

export type ManifestCapability = {
  readonly ref: string;
  readonly kind: InventoriedKind;
  /** Where it is in the old runtime — `path:line`, from the scan rather than from a typist. */
  readonly source: string;
  readonly requiresConfirmation?: boolean;
};

/**
 * Every capability an inventory entry must account for, keyed by the reference an entry writes.
 *
 * Built from the manifest rather than listed, so a capability added to the old runtime arrives here the moment
 * the scan is re-run — and then fails the omission check until somebody writes its entry.
 */
export const manifestCapabilities = (
  manifest: OldRuntimeManifest,
): ReadonlyMap<string, ManifestCapability> => {
  const out = new Map<string, ManifestCapability>();
  for (const tool of manifest.tools) {
    out.set(`tool:${tool.name}`, {
      ref: `tool:${tool.name}`,
      kind: "tool",
      source: tool.source,
      requiresConfirmation: tool.requiresConfirmation,
    });
  }
  for (const route of manifest.routes) {
    // `/health` is a liveness probe, not a capability: it has no behaviour to replace and an entry for it
    // would be an entry nobody can act on. Excluded here rather than marked `dropped`, because a drop needs a
    // named person and nobody should have to sign for a health check.
    if (route.path === "/health") continue;
    out.set(`route:${route.method} ${route.path}`, {
      ref: `route:${route.method} ${route.path}`,
      kind: "route",
      source: route.source,
    });
  }
  for (const hook of manifest.webhooks) {
    out.set(`webhook:${hook.path}`, { ref: `webhook:${hook.path}`, kind: "webhook", source: hook.source });
  }
  for (const job of manifest.scheduled) {
    out.set(`cron:${job.job}`, { ref: `cron:${job.job}`, kind: "cron", source: job.source });
  }
  return out;
};

export type ManifestProblem = { readonly ref: string; readonly problem: string };

/**
 * Do the inventory and the old runtime describe the same thing? — AC-1.
 *
 * Both directions, and the second is the one that was failing: an unresolvable reference is a typo, but a
 * capability with no entry is a **feature nobody wrote down**, which is precisely what this REQ exists to make
 * impossible. The old inventory would have passed the first check trivially, because a prose string cannot be
 * wrong about anything.
 */
export const verifyAgainstManifest = (input: {
  readonly entries: readonly { readonly capability: string; readonly oldRuntimeRef: string }[];
  readonly manifest: OldRuntimeManifest;
}): readonly ManifestProblem[] => {
  const capabilities = manifestCapabilities(input.manifest);
  const problems: ManifestProblem[] = [];
  const claimed = new Map<string, number>();

  for (const entry of input.entries) {
    claimed.set(entry.oldRuntimeRef, (claimed.get(entry.oldRuntimeRef) ?? 0) + 1);
    if (!capabilities.has(entry.oldRuntimeRef)) {
      problems.push({
        ref: entry.oldRuntimeRef,
        problem: `"${entry.capability}" points at something that is not in the old runtime. Re-run scripts/scan-old-runtime-capabilities.mjs and use a reference it lists`,
      });
    }
  }

  for (const [ref, count] of claimed) {
    if (count > 1) problems.push({ ref, problem: `${count} entries claim to replace it; one capability, one entry` });
  }

  for (const [ref, capability] of capabilities) {
    if (!claimed.has(ref)) {
      problems.push({
        ref,
        problem: `is in the old runtime (${capability.source}) and has no inventory entry — an unlisted capability is the one a parity gate cannot fail on`,
      });
    }
  }

  return problems;
};

export type ApprovalParity = {
  readonly ref: string;
  readonly oldTool: string;
  readonly newTool: string | null;
  readonly oldRequiredConfirmation: boolean;
  readonly newRequiresApproval: boolean | null;
  readonly verdict: "held" | "lost" | "no-replacement" | "not-gated";
};

/**
 * Did the approval requirement survive the migration? — AC-4.
 *
 * The single most extractable piece of the old runtime's observable contract, and the one whose loss is
 * invisible: `@tool(requires_confirmation=True)` on nine tools, against the new runtime's `approvalPolicy`,
 * which `defineTool` derives from `effect`. Nine confirmation-gated tools is a fact about a live product; a
 * replacement that skips the prompt is a change to what a customer's audience sees without them.
 *
 * **Deliberately one-directional.** A new tool that requires approval where the old one did not is not a
 * regression — it is a stricter product, and failing it would be pressure to relax the gate. So `not-gated`
 * carries no verdict of its own and is reported rather than judged.
 */
export const approvalParity = (input: {
  readonly entries: readonly {
    readonly oldRuntimeRef: string;
    readonly replacement: string | null;
    readonly status: string;
  }[];
  readonly manifest: OldRuntimeManifest;
  /** The new runtime's built tools. `approvalPolicy` comes from the descriptor, never from a second list. */
  readonly descriptors: readonly { readonly name: string; readonly approvalPolicy: string }[];
}): readonly ApprovalParity[] => {
  const byName = new Map(input.descriptors.map((d) => [d.name, d]));
  const results: ApprovalParity[] = [];

  for (const tool of input.manifest.tools) {
    const ref = `tool:${tool.name}`;
    const entry = input.entries.find((e) => e.oldRuntimeRef === ref);
    const replacement = entry?.replacement ?? null;
    const descriptor = replacement === null ? undefined : byName.get(replacement);
    const newRequiresApproval = descriptor === undefined ? null : descriptor.approvalPolicy === "always";

    results.push({
      ref,
      oldTool: tool.name,
      newTool: replacement,
      oldRequiredConfirmation: tool.requiresConfirmation,
      newRequiresApproval,
      verdict: !tool.requiresConfirmation
        ? "not-gated"
        : replacement === null || newRequiresApproval === null
          ? "no-replacement"
          : newRequiresApproval
            ? "held"
            : "lost",
    });
  }

  return results;
};

/** Only `lost` is a defect: a gate that was there and is not. See `approvalParity`. */
export const approvalParityProblems = (results: readonly ApprovalParity[]): readonly ManifestProblem[] =>
  results
    .filter((result) => result.verdict === "lost")
    .map((result) => ({
      ref: result.ref,
      problem: `${result.oldTool} required confirmation in the old runtime and ${String(result.newTool)} does not require approval — the migration would remove a person from a decision they make today`,
    }));

/**
 * The old runtime's instruction sets against the new runtime's — AC-5.
 *
 * Both runtimes carry seven skills with the same seven names, which is the reason this can be a check rather
 * than a paragraph. The direction that matters is old-to-new: a skill the old product loads and the new one
 * does not is a behavioural change that produces *identical write sets* on every run where the missing
 * guidance did not happen to alter a decision.
 */
export const skillParity = (
  manifest: OldRuntimeManifest,
  newSkillNames: readonly string[] = SHAREFLOW_BUILT_IN_SKILLS.map((skill) => skill.name),
): readonly ManifestProblem[] => {
  const present = new Set(newSkillNames);
  return manifest.skills
    .filter((skill) => !present.has(skill.name))
    .map((skill) => ({
      ref: `skill:${skill.name}`,
      problem: `the old runtime loads ${skill.name} (${skill.source}) and the new runtime has no skill by that name — a tool-for-tool match under different instructions is a different product`,
    }));
};

export type CompositionFinding = {
  readonly oldAgents: number;
  readonly oldSpecialists: readonly string[];
  readonly oldTeams: readonly string[];
  readonly newAgents: readonly string[];
  readonly detail: string;
};

/**
 * How the two runtimes are *composed*, which is a difference no write-set comparison can see.
 *
 * The old runtime is a generalist, a studio agent, six role-scoped specialists and a coordinating team — nine
 * components, each with its own instructions and its own subset of the tools. The new runtime is one agent
 * holding all of them. On any single run where the old leader would have routed to the member that owns the
 * work, both runtimes call the same tool and write the same rows, and the gate reads agreement.
 *
 * Reported as a **finding rather than a problem**, because collapsing to one agent may well be the intended
 * product and this module is not the place that decision gets made. What it must not do is go unrecorded: it
 * is the largest behavioural difference between the two runtimes and the one least visible to the gate.
 */
export const compositionFinding = (
  manifest: OldRuntimeManifest,
  newAgentIds: readonly string[],
): CompositionFinding => {
  const specialists = manifest.agents.filter((a) => a.kind === "specialist").map((a) => a.id);
  const teams = manifest.agents.filter((a) => a.kind === "team").map((a) => a.id);
  return {
    oldAgents: manifest.agents.length,
    oldSpecialists: specialists,
    oldTeams: teams,
    newAgents: newAgentIds,
    detail:
      `the old runtime is ${manifest.agents.length} components (${specialists.length} role-scoped specialists behind ` +
      `${teams.length} team, plus a generalist and a studio agent); the new runtime is ${newAgentIds.length} ` +
      `(${newAgentIds.join(", ")}). Routing differences produce identical write sets whenever the leader would ` +
      "have chosen the same tool, so shadow data cannot decide this one",
  };
};
