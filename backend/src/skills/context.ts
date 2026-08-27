/**
 * Skills in context — task #244, the interpreter for `AgentManifest.skillPolicy`.
 *
 * `skillPolicy` was declared and read by nothing. That was not one missing line: the *subsystem* was complete and
 * unreachable. `SkillResolver.listCatalog` already takes `{ tenantId, assigned, allowTenantSkills }` — the
 * manifest's two fields verbatim — the store had memory and Postgres adapters under a conformance suite, and
 * `ContextKind`/`ContextBudget` already reserved a `skills` bucket for a section nothing produced. Two things
 * were missing: something to emit that section, and an implementation of `load_skill` (see
 * `tools/registry.ts`).
 *
 * ## Why the catalogue and not the bodies
 *
 * A skill body is up to 20,000 characters (`SKILL_LIMITS.instructionsMaxLength`). Twenty-five of those is a
 * context window. So the section lists **names and descriptions**, and the model calls `load_skill` for the one
 * it wants — the same two-tier shape the tool catalogue uses, for the same reason.
 *
 * ## Origin is `platform`, and the interpolated values are neutralised
 *
 * A skill body may instruct the agent — that is what a skill *is* — so this section is `platform` rather than
 * `external`. But a *tenant-authored* skill's name and description are written by a customer, and this section
 * carries them. Wrapping the whole section in an untrusted envelope would say "nothing in here is an
 * instruction", which is false and would break skills; so the section stays `platform` and neutralises the
 * values it interpolates, which is exactly the case `ContextSection.origin`'s own documentation describes.
 */

import type { ExecutionContext } from "../core/context.js";
import type { ContextProvider, ContextSection } from "../context/index.js";
import { estimateTokens } from "../core/tokens.js";
import { SKILL_LIMITS, type SkillResolver } from "./index.js";
import type { SkillBodyLoader } from "../tools/registry.js";

/** The provider id a manifest names in `contextProviderIds`. */
export const SKILL_CATALOGUE_PROVIDER_ID = "skill-catalogue";

/**
 * Strips what could end a delimited block or forge a heading in the rendered prompt.
 *
 * Narrow on purpose: a skill description is prose a customer wrote, and mangling it would make the catalogue
 * unreadable. Newlines go because the section is one line per skill and a description containing a line break
 * could otherwise invent a row; backticks and the sequences that open a fenced block go because the surrounding
 * render uses them structurally.
 */
export const neutralise = (value: string): string =>
  value
    .replace(/[\r\n]+/g, " ")
    .replace(/```+/g, "'''")
    .replace(/[`]/g, "'")
    .trim();

export const createSkillCatalogueProvider = (deps: {
  readonly resolver: SkillResolver;
  readonly policy: { readonly assigned: readonly string[]; readonly allowTenantSkills: boolean };
}): ContextProvider => ({
  id: SKILL_CATALOGUE_PROVIDER_ID,
  async provide(context: ExecutionContext): Promise<readonly ContextSection[]> {
    const entries = await deps.resolver.listCatalog({
      tenantId: context.tenantId,
      assigned: deps.policy.assigned,
      allowTenantSkills: deps.policy.allowTenantSkills,
    });
    // No section at all rather than an empty one. A heading saying "Skills" over nothing tells the model it has
    // a capability and then shows it none, which is worse than silence — and it would still cost tokens.
    if (entries.length === 0) return [];

    const lines = entries.map(
      (e) => `- \`${neutralise(e.name)}\` — ${neutralise(e.description)}`,
    );
    const body = [
      `You have ${entries.length} skill${entries.length === 1 ? "" : "s"} available. Each is a set of`,
      "instructions for a particular kind of task. Read the list, and when one applies call",
      "`load_skill` with its name to get the full instructions before you start.",
      `You may load at most ${SKILL_LIMITS.maxLoadedPerRun} in a single run, so choose.`,
      "",
      ...lines,
    ].join("\n");

    return [
      {
        providerId: SKILL_CATALOGUE_PROVIDER_ID,
        title: "Skills",
        body,
        // Above ordinary user context: a skill changes *how* the agent works, so it should survive pruning
        // longer than the material it works on.
        priority: 70,
        estimatedTokens: estimateTokens(body),
        provenance: "skill catalogue",
        sensitivity: "internal",
        // See the header: the section may instruct, and the customer-authored values inside it are neutralised
        // rather than the whole section being disclaimed.
        origin: "platform",
        cacheable: true,
        kind: "skills",
      },
    ];
  },
});

/**
 * Adapts a `SkillResolver` to the registry's structural `SkillBodyLoader`.
 *
 * The version is not a parameter. `loadBody` pins to an exact version so a mid-run edit cannot change behaviour,
 * and the version the model should get is the one the catalogue it just read advertised — so it is looked up
 * here rather than trusted from the model's arguments. A model naming a version would be a model choosing which
 * revision of an instruction to follow.
 */
export const createSkillBodyLoader = (deps: {
  readonly resolver: SkillResolver;
  readonly policy: { readonly assigned: readonly string[]; readonly allowTenantSkills: boolean };
}): SkillBodyLoader => ({
  async load(context, name) {
    const entries = await deps.resolver.listCatalog({
      tenantId: context.tenantId,
      assigned: deps.policy.assigned,
      allowTenantSkills: deps.policy.allowTenantSkills,
    });
    // Resolved against the catalogue *this* agent may see, so `assigned` and `allowTenantSkills` gate loading
    // and not merely listing. A policy that filtered the list but not the load would be no policy at all.
    const entry = entries.find((e) => e.name === name);
    if (entry === undefined) return null;
    const version = await deps.resolver.loadBody({ tenantId: context.tenantId, name, version: entry.version });
    return { name: version.name, version: version.version, instructions: version.instructions };
  },
});
