/**
 * Where ShareFlow's built-in skills live (AC-5).
 *
 * #122 migrates the existing skill content onto the skills port. The value #114 adds is that the
 * content is checked **at build time**: `defineShareFlowSkill` runs the platform's own
 * `validateSkillInput` at module load, so a skill whose slug is wrong or whose description is too
 * short fails the process that imports it rather than the first `load_skill` call in production.
 *
 * `validateSkillInput` is reused, not reimplemented. It already enforces exactly the limits
 * `workspace_agent_skills` enforces, and a second copy here would be a second copy to keep in step —
 * the duplicate-definition mistake #113 had to undo.
 *
 * A skill is instructions and data, never code. There is nothing to execute in this directory, and the
 * body of a skill cannot grant a tool or lower an effect classification.
 */
import { asId, type SkillId, type SkillVersion } from "@retinue/agentkit";
import { SKILL_LIMITS, validateSkillInput } from "@retinue/agentkit/context";
import { AgentPlatformError } from "@retinue/agentkit";
import { SHAREFLOW_SKILL_BODIES } from "./content.js";
import { SHAREFLOW_WORKFLOW_SKILL_BODIES } from "./workflows.js";

export * from "./content.js";

export type ShareFlowSkillInput = {
  /**
   * Defaults to `active`. `draft` keeps a migrated body out of discovery while leaving it resolvable —
   * which is what a skill whose tools do not exist yet needs.
   */
  readonly status?: SkillVersion["status"];
  /** Slug, kebab-case. Becomes both the name and the id — built-in skills are referenced by name. */
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  /** Bumped whenever `instructions` changes, so a run records which text it executed. */
  readonly version: number;
  /** When this content was authored. Required rather than stamped, so it is a fact and not a build time. */
  readonly authoredAt: string;
};

/** Build a validated built-in skill. Throws `invalid_input` at import time on any breach. */
export const defineShareFlowSkill = (input: ShareFlowSkillInput): SkillVersion =>
  validateSkillInput({
    id: asId<SkillId>(`shareflow.${input.name}`),
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    source: "built-in",
    status: input.status ?? "active",
    version: input.version,
    createdAt: input.authoredAt,
  });

/**
 * Assemble the built-in set.
 *
 * Two checks the resolver cannot make for itself: duplicate names (its `Map` would silently keep the
 * last one, so a copy-paste would quietly shadow the skill it was copied from), and a set larger than
 * `SKILL_LIMITS.maxSkills` — the per-tenant ceiling the catalog was sized against, which built-ins
 * share context with.
 */
export const shareFlowBuiltInSkills = (
  skills: readonly SkillVersion[],
): readonly SkillVersion[] => {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name))
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `duplicate built-in ShareFlow skill: ${skill.name}`,
        retryable: false,
      });
    seen.add(skill.name);
  }
  if (skills.length > SKILL_LIMITS.maxSkills)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${skills.length} built-in skills exceeds the ${SKILL_LIMITS.maxSkills}-skill catalog ceiling`,
      retryable: false,
    });
  return skills;
};

/**
 * When each body was authored, as a fact rather than a build time.
 *
 * The seven bodies came across from `ai_backend/skills/<name>/SKILL.md` in #122. Every one was edited on the
 * way — see the notes in `content.ts` — so this is the date of that reconciliation, which is the version
 * a run would be recording.
 */
const MIGRATED_AT = "2026-08-23T00:00:00.000Z";

/** When the four workflow skills in `workflows.ts` were written, which is not when anything was migrated. */
const AUTHORED_AT = "2026-09-09T00:00:00.000Z";

/**
 * The seven skills, at version 1.
 *
 * **Version 1 on purpose.** #30's guarantee is that a run records the skill version it executed, and
 * that is only meaningful if the numbers move when the text does. Starting at 1 for a body that was
 * edited during migration is honest: this text has never been executed before.
 *
 * `mermaid-diagrams` **was** `draft` while `render_diagram` did not exist — offering guidance for a tool the
 * model cannot call instructs it into nothing. It is `active` now, and it had to be in the same change that
 * built the tool: the prompt's `diagram-files` clause says *"ALWAYS load the `mermaid-diagrams` skill before
 * turning a diagram into a file"*, and a prompt naming a skill the resolver's status filter hides is an
 * instruction into nothing of a different kind.
 *
 * Its version stays 1, like `document-generation`'s. Only the status changed, and #30's guarantee is that the
 * number moves when the *text* does.
 *
 * `document-generation` **was** draft for the same reason and is now `active` — REQ-041 (#190) built
 * `create_artifact`, `update_artifact` and `get_artifact`, so the precondition is gone. Worth being precise
 * about why it was safe *then*: its body names no tool at all. It is about choosing a document over a reply,
 * writing markdown, keeping a diagram in the document's source, and reporting what was made — none of which
 * depended on `generate_pdf`, which did not exist yet and does now. Leaving it draft would have been the AC-5 defect in its
 * purest form: three replaced tools shipping without the instructions the old runtime ran them under, which
 * produces identical write sets on every run where the guidance did not happen to change a decision.
 *
 * Its version stays 1. Only the status changed; the text is the same text, and #30's guarantee is that the
 * number moves when the *text* does.
 */
export const SHAREFLOW_BUILT_IN_SKILLS: readonly SkillVersion[] = shareFlowBuiltInSkills([
  defineShareFlowSkill({
    name: "post-composition",
    description:
      "Write captions that suit each platform — tone, hooks, hashtag placement and links — and adapt one idea across several platforms without posting the same text everywhere.",
    instructions: SHAREFLOW_SKILL_BODIES["post-composition"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "platform-media-rules",
    description:
      "How to check that an attachment will be accepted by the destinations a post is going to, and how to repair one that will not, before an approval is spent on a post that cannot succeed.",
    instructions: SHAREFLOW_SKILL_BODIES["platform-media-rules"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "publishing-safety",
    description:
      "Get publishing and scheduling right — never guessing a date, what an approval refusal means and how to relay it, and how to report an outcome the result actually confirms.",
    instructions: SHAREFLOW_SKILL_BODIES["publishing-safety"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "research-and-citation",
    description:
      "Decide when a post actually needs research, cite only sources a tool returned, and never invent a URL or state an unsourced claim as measured.",
    instructions: SHAREFLOW_SKILL_BODIES["research-and-citation"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "analytics-reporting",
    description:
      "Report performance and comments honestly — how fresh stored stats are, why missing data is not a zero, and how to summarise numbers without inventing a cause or a benchmark.",
    instructions: SHAREFLOW_SKILL_BODIES["analytics-reporting"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "mermaid-diagrams",
    description:
      "Write mermaid diagrams that render — choosing the output before writing, quoting labels that contain punctuation, and recovering from a parse failure instead of retrying it.",
    instructions: SHAREFLOW_SKILL_BODIES["mermaid-diagrams"],
    version: 1,
    authoredAt: MIGRATED_AT,
  }),
  defineShareFlowSkill({
    name: "document-generation",
    description:
      "Decide whether an answer belongs in a document or in the reply, write a document as markdown and a designed page as HTML with installed fonts, and report what was created rather than handing over a bare link.",
    instructions: SHAREFLOW_SKILL_BODIES["document-generation"],
    version: 1,
    authoredAt: MIGRATED_AT,
    // Active since the artifact tools exist — see the note above. Its body names the two stock media tools
    // (#615) and, since #661, `generate_pdf` for designed HTML pages — all three preloaded.
    status: "active",
  }),

  /**
   * Four workflows that had no skill at all — see `workflows.ts` for the bodies and for the
   * preloading constraint that shapes them.
   *
   * The seven above were migrated from the old runtime and cover what it covered. Nine campaign
   * tools, five engagement tools, three lead tools and three account tools arrived in this package
   * with nothing but their one-line descriptions, which is enough for the model to *find* them and
   * not enough for it to use them well: the order of operations, the argument shapes that are easy
   * to get wrong, and the facts about this deployment that no schema states.
   *
   * `authoredAt` is today's date rather than `MIGRATED_AT`, because these were written here and
   * calling them migrations would misattribute their content to a runtime that never had them.
   */
  defineShareFlowSkill({
    name: "campaign-planning",
    description:
      "Plan and run a dated campaign — settling the cadence and dates with the user, attaching drafts to it, and knowing that a campaign with nothing published is too early to evaluate rather than broken.",
    instructions: SHAREFLOW_WORKFLOW_SKILL_BODIES["campaign-planning"],
    version: 1,
    authoredAt: AUTHORED_AT,
  }),
  defineShareFlowSkill({
    name: "comment-triage",
    description:
      "Reply to comments under the workspace's name — reading the thread first, never inventing a fact about the business, and treating a refused approval as a decision to report rather than an error to retry.",
    instructions: SHAREFLOW_WORKFLOW_SKILL_BODIES["comment-triage"],
    version: 1,
    authoredAt: AUTHORED_AT,
  }),
  defineShareFlowSkill({
    name: "lead-capture",
    description:
      "Record leads with the attribution that makes them worth having, and know that this deployment does not suppress duplicates — so a list is only deduplicated if someone looked first.",
    instructions: SHAREFLOW_WORKFLOW_SKILL_BODIES["lead-capture"],
    version: 1,
    authoredAt: AUTHORED_AT,
  }),
  defineShareFlowSkill({
    name: "account-connection",
    description:
      "Connect a destination and read its health — which of the four states the user can fix themselves, which needs an operator, and the per-platform redirect URL that fails silently when it is wrong.",
    instructions: SHAREFLOW_WORKFLOW_SKILL_BODIES["account-connection"],
    version: 1,
    authoredAt: AUTHORED_AT,
  }),
]);

/**
 * The skills the Social Assistant is assigned.
 *
 * Derived from the built-in set rather than listed again: an assigned name with no skill behind it is the
 * silent gap #121 had to fix in `SHAREFLOW_CONTEXT_PROVIDER_IDS`, and a second hand-maintained list is
 * how it happens.
 */
export const SHAREFLOW_ASSIGNED_SKILLS: readonly string[] = SHAREFLOW_BUILT_IN_SKILLS.filter(
  (skill) => skill.status === "active",
).map((skill) => skill.name);
