/**
 * Searching indexed material — REQ-039 (#188).
 *
 * An envelope over the retriever, and the interesting part is what it does *not* take as input.
 *
 * ## `authSubjects` comes from the host, never from the model
 *
 * `RetrieveInput.authSubjects` is "the subjects this caller may read". If it were a field on this tool's input
 * schema, a model could widen its own read scope by asking — including under the influence of a page it just
 * fetched. So the schema has no field for it, and the host supplies a resolver that derives the list from the
 * execution context. This is the same rule as credentials in `./http.ts`: the model states what it wants, the
 * deployment states what it may have.
 *
 * An empty subject list is not an error here. The retriever answers `no-access`, which is a different sentence
 * from `no-match` — "nothing you can see matches that" rather than "nothing matches that" — and the model needs
 * the difference to avoid telling someone their documents do not mention something they cannot read.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import type { ExecutionContext } from "../../core/context.js";
import type { RetrievalMode, RetrievalOutcome } from "../../knowledge/retrieval.js";

/** The slice of the retriever this tool needs. A type, so the tools layer takes no dependency on its wiring. */
export type KnowledgeRetriever = {
  retrieve(
    context: { readonly tenantId: ExecutionContext["tenantId"] },
    input: {
      readonly query: string;
      readonly authSubjects: readonly string[];
      readonly limit: number;
      readonly mode?: RetrievalMode;
    },
  ): Promise<RetrievalOutcome>;
};

const schema = z
  .object({
    query: z.string().min(1).max(1_000),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const createSearchKnowledgeTool = (
  deps: DelegatingToolDeps,
  config: {
    readonly retriever: KnowledgeRetriever;
    /** What this caller may read, derived from the context by the host. Never from tool input. */
    readonly authSubjects: (context: ExecutionContext) => readonly string[] | Promise<readonly string[]>;
    readonly mode?: RetrievalMode;
  },
): Tool =>
  defineDelegatingTool(deps, {
    name: "search_knowledge",
    label: "Search indexed material",
    description:
      "Search the indexed documents and notes for passages relevant to a question. Returns passages with a " +
      "citation for each, so quote and cite rather than paraphrasing from memory. If `found` is false, read the " +
      "`reason`: 'no-access' and 'nothing-indexed' mean the material was never searched, which is not the same " +
      "as it not existing.",
    category: "knowledge",
    effect: "read",
    inputSchema: schema,
    delegatesTo: "knowledge/retrieval.Retriever.retrieve",
    delegate: async (input: z.infer<typeof schema>, context) => {
      const outcome = await config.retriever.retrieve(context, {
        query: input.query,
        authSubjects: await config.authSubjects(context),
        limit: input.limit,
        ...(config.mode === undefined ? {} : { mode: config.mode }),
      });
      if (!outcome.found) return { found: false, reason: outcome.reason, message: outcome.message, passages: [] };
      return {
        found: true,
        passages: outcome.hits.map((hit) => ({
          text: hit.chunk.content,
          score: hit.score,
          // The citation, not the chunk id: a caller that wants to show provenance needs the reference shape, and
          // one built here is one every consumer does not build differently.
          reference: hit.reference,
        })),
      };
    },
  });
