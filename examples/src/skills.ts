/**
 * Skills — #171.
 *
 * A skill is a named, versioned block of instructions the model can pull into its own context on demand. The
 * platform has the whole machinery for them — `SkillResolver`, `createRunSkillTracker`, per-run load limits,
 * catalog shadowing, an audit record per load, and a `SkillStore` with adapters on all three backends — and
 * **nothing used any of it.** The seventh built-and-unreachable capability, and the one the new reachability
 * guard was pointed at next.
 *
 * ## Why a skill rather than a longer system prompt
 *
 * Because the prompt is a budget. Everything in it is paid for on every turn, whether or not this turn needs it.
 * Three skills of 500 tokens each cost 1,500 tokens on a turn that needed none of them — and the one that matters
 * is diluted by the two that do not.
 *
 * A skill inverts that: the *catalogue* is in the prompt (a name and a one-line description, tens of tokens), and
 * the body arrives only when the model asks for it. So a conversation about writing a summary pays for the
 * summary skill and nothing else.
 *
 * ## Why versioned, and pinned per run
 *
 * `loadBody` takes an exact version. A skill edited mid-run would change the instructions a run is already
 * following, which makes a run unreproducible and a bug report unanswerable — "it did X" against instructions
 * that no longer exist. Pinning also means an archived version keeps working for runs already using it while
 * disappearing from discovery, which is what lets a skill be retired without breaking anything in flight.
 */

import { SKILL_LIMITS, validateSkillInput } from "@retinue/agentkit/context";
import type { SkillVersion } from "@retinue/agentkit";

/**
 * The built-in skills.
 *
 * Three, each earning its place by being a *procedure* rather than a fact. A fact belongs in memory or a note; a
 * skill is worth loading when it changes how the model does something, and when saying it properly takes more
 * words than a prompt can afford to carry permanently.
 *
 * Run through `validateSkillInput` at module load rather than trusted: it enforces the same name pattern, length
 * bounds and description minimum that a tenant skill must satisfy. A built-in exempt from the rules it enforces
 * on others is how the rules stop meaning anything — and #122 was exactly that, `status` being load-bearing for
 * a tenant skill and inert for a built-in.
 */
export const EXAMPLE_SKILLS: readonly SkillVersion[] = [
  {
    id: "skill-meeting-notes" as SkillVersion["id"],
    name: "meeting-notes",
    description: "Turn a rough set of notes into a structured record with decisions and owners.",
    source: "built-in",
    version: 1,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    instructions: [
      "# Writing up meeting notes",
      "",
      "Produce four sections, in this order, and omit a section entirely rather than writing 'none':",
      "",
      "1. **Decisions** — what was settled. One line each, in the past tense, naming who decided if it is known.",
      "2. **Open questions** — what was raised and not settled, and who needs to answer it.",
      "3. **Actions** — owner, action, and a date if one was given. Never invent an owner or a date; write",
      "   'unassigned' rather than guessing, because a wrong owner is worse than a missing one.",
      "4. **Context** — anything a reader who missed the meeting needs to make sense of the above.",
      "",
      "Quote a number or a name exactly as it was given. If notes conflict, say so in Open questions rather than",
      "picking one — resolving a contradiction silently is how a record becomes wrong and confident.",
    ].join("\n"),
  },
  {
    id: "skill-decision-brief" as SkillVersion["id"],
    name: "decision-brief",
    description: "Compare options against stated criteria and make a recommendation with its reasoning.",
    source: "built-in",
    version: 1,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    instructions: [
      "# Writing a decision brief",
      "",
      "**Recommend, do not survey.** A list of options with their pros and cons hands the work back to the",
      "reader. Lead with the recommendation, then the reasoning, then what would change it.",
      "",
      "Structure:",
      "",
      "- **Recommendation** — one sentence, and the option named.",
      "- **Why** — the two or three things that actually decide it. Not every difference; the ones that matter.",
      "- **What it costs** — what the recommendation gives up. Every real choice gives something up, and a brief",
      "  that names none reads as advocacy.",
      "- **What would change this** — the fact that would flip the recommendation. If nothing would, the decision",
      "  was not close and saying so is useful.",
      "",
      "Where the available information does not settle it, say which fact is missing and what you would do with",
      "each answer. Do not manufacture confidence by leaving out the uncertainty.",
    ].join("\n"),
  },
  {
    id: "skill-changelog" as SkillVersion["id"],
    name: "changelog",
    description: "Describe a change as its effect on someone using the thing, not as a list of edits.",
    source: "built-in",
    version: 1,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    instructions: [
      "# Writing a changelog entry",
      "",
      "Write what is now different **for the person using the thing**. 'Refactored the run store' tells a reader",
      "nothing; 'a resumed run no longer loses its place' tells them whether to care.",
      "",
      "One entry per user-visible change, grouped under Added / Changed / Fixed / Removed. A change with no",
      "user-visible effect does not get an entry — internal work is real work and a changelog is not where it is",
      "recorded.",
      "",
      "For a fix, name the symptom rather than the cause: someone searching the changelog is searching for what",
      "they saw. Mention the cause only when it tells them whether they were affected.",
      "",
      "No version numbers or dates unless given them. Never write 'various improvements'.",
    ].join("\n"),
  },
].map((skill) => validateSkillInput(skill as SkillVersion));

/**
 * Which skills this agent may reach.
 *
 * Assignment is separate from existence on purpose — `listCatalog` takes an `assigned` list, so a tenant can hold
 * skills that a particular agent is not offered. Here the agent is offered all of them, and the interesting part
 * is that this list is what bounds the *catalogue*, while `SKILL_LIMITS.maxLoadedPerRun` bounds how many bodies
 * one run can pull in.
 */
export const ASSIGNED_SKILLS: readonly string[] = EXAMPLE_SKILLS.map((s) => s.name);

/** A one-line-per-skill catalogue for the prompt. Tens of tokens, against hundreds for the bodies. */
export const renderSkillCatalogue = (
  entries: readonly { readonly name: string; readonly description: string; readonly version: number }[],
): string =>
  entries.length === 0
    ? ""
    : [
        "## Skills you can load",
        "",
        "Each of these is a set of instructions for doing one kind of task well. Call `load_skill` with the name",
        `when the task calls for it — you may load up to ${SKILL_LIMITS.maxLoadedPerRun} in a turn. Do not guess`,
        "at what a skill says; load it and follow it.",
        "",
        ...entries.map((e) => `- **${e.name}** (v${e.version}) — ${e.description}`),
      ].join("\n");
