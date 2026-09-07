/**
 * Artifacts — `create_artifact`, `update_artifact`, `get_artifact` — REQ-041 (#190).
 *
 * The three the old runtime's Documents agent owned, and the three the inventory listed as `missing` while
 * noting they were "a tool away": `assistant_artifacts`, its version table and the `chorus-artifact:` scheme
 * are all in ShareFlow already.
 *
 * ## Same names as the old tools, deliberately
 *
 * Elsewhere the new names differ where the noun does — `create_post_draft` for `create_draft`, because
 * ShareFlow's word is "post draft". "Artifact" is the same word on both sides, so renaming would cost the
 * only free thing about this replacement: a model that has seen the old product's traces, and the inventory's
 * `replacement` column, both read the same identifier.
 *
 * ## What is *not* here
 *
 * No `list_artifacts`, no `delete_artifact`. The old runtime has neither, and a tool the old product did not
 * have is not parity — it is scope with a parity label on it, and the parity gate would have nothing to
 * compare it against. The three that exist are the three that ship.
 *
 * ## Why an artifact is not a post, and why the description says so twice
 *
 * The old `create_artifact` docstring spends a paragraph on it: *"Do NOT use it for a short answer, or for a
 * social post — a post belongs in create_draft so it can actually be published."* That is the mistake the
 * capability invites, and it is expensive in one direction: a post written into an artifact cannot be
 * scheduled, validated or published, so the user gets a document where they asked for a post and finds out at
 * publish time. The reverse — a plan written as a draft — is merely untidy.
 */
import { z } from "zod";
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  type Artifact,
  type ArtifactId,
} from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, shareFlowTool } from "./factory.js";

/**
 * What the model gets back, and what it deliberately does not.
 *
 * `content` is absent from a write's result. `create_artifact` and `update_artifact` are handed the content by
 * the model, so echoing it back doubles a document that can be 200,000 characters inside the context window
 * for no information — the old tool returns `{"id", "title", "kind", "version", "reference"}` for exactly
 * that reason. `get_artifact` returns it, because reading is the point.
 */
const receiptView = (artifact: Artifact) => ({
  artifactId: String(artifact.id),
  title: artifact.title,
  kind: artifact.kind,
  version: artifact.version,
  ...(artifact.reference === undefined ? {} : { reference: artifact.reference }),
  updatedAt: artifact.updatedAt,
});

const artifactView = (artifact: Artifact) => ({
  ...receiptView(artifact),
  content: artifact.content,
  createdAt: artifact.createdAt,
});

/**
 * Bounded in the schema as well as in the adapter, and the duplication is the point.
 *
 * The adapter's limits are the app's, transcribed, and they are what protects the row. These are what protect
 * the *turn*: a model told "at most 200000 characters" after generating 400,000 has already spent them. A
 * schema refusal costs nothing and names the limit.
 */
const title = z.string().trim().min(1, "an artifact needs a title").max(ARTIFACT_MAX_TITLE);
const content = z.string().min(1, "an artifact needs content").max(ARTIFACT_MAX_CHARS);

const createArtifactSchema = z
  .object({
    title,
    /**
     * From the DB's own CHECK constraint, via the port.
     *
     * A closed enum rather than a string: `kind` decides which view the app renders, so "md" instead of
     * "markdown" would be refused by the database at write time — after the model had produced the whole
     * document.
     */
    kind: z.enum(ARTIFACT_KINDS),
    content,
  })
  .strict();

export const createArtifactTool = shareFlowTool(["artifacts"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "create_artifact",
    label: "Create a document",
    description:
      "Create a document the user opens beside the chat instead of reading it inline — a content plan, a strategy note, a landing page, a long diagram. Use it for anything substantial and reusable, and not for a short answer. Never use it for a social post: a post belongs in `create_post_draft` so it can actually be validated and published. `kind` is markdown, html or mermaid. Put the returned `reference` in your reply as a markdown link and say in a sentence what it is, instead of pasting the whole document — a long document flooding the chat is the thing this avoids.",
    category: "artifacts",
    effect: "internal-write",
    inputSchema: createArtifactSchema,
    delegatesTo: "ArtifactService.create",
    delegate: async (input: z.infer<typeof createArtifactSchema>, context, { idempotencyKey }) =>
      receiptView(
        await services.artifacts.create(context, {
          idempotencyKey,
          title: input.title,
          kind: input.kind,
          content: input.content,
        }),
      ),
  }));

const updateArtifactSchema = z
  .object({
    artifactId: idString,
    content,
    /** Omitted keeps the current title. Renaming and revising are one call because the old tool made them one. */
    title: title.optional(),
  })
  .strict();

export const updateArtifactTool = shareFlowTool(["artifacts"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "update_artifact",
    label: "Revise a document",
    description:
      "Revise a document, keeping the previous version — nothing is overwritten and the id does not change, so a reference you showed earlier still resolves to the current text. Pass the FULL new content, not a diff or a fragment: this replaces the body. Read it with `get_artifact` first if you only have part of it, because editing from memory of an earlier turn is how a document silently loses a section. You cannot change its kind; create a new one for that.",
    category: "artifacts",
    effect: "internal-write",
    inputSchema: updateArtifactSchema,
    delegatesTo: "ArtifactService.revise",
    delegate: async (input: z.infer<typeof updateArtifactSchema>, context, { idempotencyKey }) =>
      receiptView(
        await services.artifacts.revise(context, {
          idempotencyKey,
          id: asId<ArtifactId>(input.artifactId),
          content: input.content,
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      ),
  }));

const getArtifactSchema = z.object({ artifactId: idString }).strict();

export const getArtifactTool = shareFlowTool(["artifacts"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "get_artifact",
    label: "Read a document",
    description:
      "Read a document's current content, title, kind and version. Use it before `update_artifact` whenever you do not have the full existing text in front of you — a revision written from memory of an earlier turn is how a section disappears without anyone deciding to remove it.",
    category: "artifacts",
    effect: "read",
    inputSchema: getArtifactSchema,
    delegatesTo: "ArtifactService.get",
    delegate: async (input: z.infer<typeof getArtifactSchema>, context) =>
      artifactView(await services.artifacts.get(context, { id: asId<ArtifactId>(input.artifactId) })),
  }));

/** The complete Artifacts catalog, pinned by a test. */
export const ARTIFACT_TOOL_NAMES = ["create_artifact", "update_artifact", "get_artifact"] as const;

/** In the order a conversation uses them: write one, read it back, revise it. */
export const ARTIFACT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  createArtifactTool,
  getArtifactTool,
  updateArtifactTool,
];
