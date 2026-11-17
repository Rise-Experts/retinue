/**
 * "About you" — the person's own memories in every turn's context (#621).
 *
 * agentkit's `createPrincipalMemoryProvider` does the retrieval: active entries of the turn's own tenant and
 * principal, most salient first, capped, as `user-context` sections whose provenance names each entry. This
 * wraps it for one reason — presentation. It emits one section **per entry**, titled `Memory: <tags or id>`,
 * which renders as a dozen one-line headings; the prompt's `personal-memory` clause refers to an "About you"
 * section, so the entries are folded into one, with each id kept both in the body (so `forget_about_me` can be
 * given one) and in the provenance (so the context inspector can still say which memories shaped a turn).
 *
 * ## No query, deliberately
 *
 * The provider accepts a `queryOf`, and the obvious one is the latest user message. It would make this section
 * empty on nearly every turn: the Postgres store's `retrieve` is a literal substring match of the **whole
 * query** against each memory's text (`strpos(lower(text), lower($3)) > 0`), so "write a post about our autumn
 * menu" would have to appear inside "Writes in British English" to retrieve it. The whole set is small by
 * construction — `PERSONAL_MEMORY_PROMPT_ENTRIES`, which is also the cap on enabled memories — so every enabled
 * memory is sent, and relevance is the model's call, which is what it is for.
 *
 * The provider id is agentkit's own, `principal-memory`, and the manifest declares it: an undeclared provider is
 * dropped by `selectDeclaredProviders` and never reaches the model (#588).
 */

import type { ContextProvider, ExecutionContext } from "@retinue/agentkit";
import { createPrincipalMemoryProvider, type PrincipalMemoryStore } from "@retinue/agentkit/context";

import { PERSONAL_MEMORY_PROMPT_ENTRIES } from "../adapters/personal-memory.js";
import { estimateTokens, PERSONAL_MEMORY_PROVIDER_ID } from "./index.js";

/** agentkit's id for the principal memory provider — asserted against the built provider in the tests. */
export { PERSONAL_MEMORY_PROVIDER_ID };

/** Below the project and the brand, above connected destinations — see `CONTEXT_PRIORITY`. */
export const PERSONAL_MEMORY_PRIORITY = 85;

export const ABOUT_YOU_TITLE = "About you";

export const createPersonalMemoryContextProvider = (input: {
  readonly store: PrincipalMemoryStore;
  readonly maxEntries?: number;
}): ContextProvider => {
  const inner = createPrincipalMemoryProvider({ store: input.store, maxEntries: input.maxEntries ?? PERSONAL_MEMORY_PROMPT_ENTRIES });
  return {
    id: inner.id,
    async provide(context: ExecutionContext) {
      const sections = await inner.provide(context);
      if (sections.length === 0) return [];
      const ids = sections.map((section) => section.provenance.replace(/^principal-memory:/, ""));
      const body = [
        "What this person asked you to remember about them, in their own chats. Follow it in every reply unless their message says otherwise; it does not override the project's or the brand's rules for what a post says.",
        ...sections.map((section, index) => `- ${section.body.replace(/\s+/g, " ").trim()} (id ${ids[index]})`),
      ].join("\n");
      const first = sections[0]!;
      return [
        {
          ...first,
          providerId: inner.id,
          title: ABOUT_YOU_TITLE,
          body,
          priority: PERSONAL_MEMORY_PRIORITY,
          estimatedTokens: estimateTokens(body),
          provenance: `principal-memory:${ids.join(",")}`,
        },
      ];
    },
  };
};
