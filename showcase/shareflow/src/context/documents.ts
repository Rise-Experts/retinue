/**
 * "Documents in this chat" — #644. The current text of the documents this conversation made or pointed at.
 *
 * Production, chat d756738b (2026-09-29): asked to change one slide of a deck it had made, the agent created a new
 * deck, twice, and then patched a third from memory — it could not see the deck it was editing. The text it wrote
 * is now carried in history (`history.ts`, tool inputs in full), but history holds what was *sent*, not what the
 * document *is*: find/replace patches, a revision from another chat and the person's own edits in the side panel
 * all change it after the fact. So every turn this section reads each document's latest version.
 *
 * - Which documents: every `artifactId` / `chorus-artifact:<id>` in the conversation's messages, newest first.
 * - The newest `FULL_DOCUMENTS` carry their full text (each capped, and a total cap); older ones their title,
 *   kind, id and version only — `get_artifact` reads them.
 * - A slide deck also gets a numbered outline, so "the third slide" and `update_artifact`'s `slideEdits` agree
 *   on what 3 means.
 *
 * `origin: "external"`: a document can hold text copied from a web page, so it is data, never instructions. What
 * to do with it (edit in place with `update_artifact`) is the `documents` prompt clause's job, not this section's.
 * `kind: "knowledge"`, so it has its own budget and cannot crowd the brand or the project out of the prompt.
 */
import type { ContextProvider, ConversationId, ExecutionContext, Message, MessageStore, TenantId } from "@retinue/agentkit";

import { splitSlides } from "../adapters/web/slides.js";
import type { Artifact, ArtifactId, ArtifactService } from "../services/index.js";
import { DOCUMENTS_PROVIDER_ID, shareFlowSection } from "./index.js";

/** How many documents are listed at all, newest first. */
export const LISTED_DOCUMENTS = 8;
/** How many of those carry their full text. */
export const FULL_DOCUMENTS = 3;
/** One document's text, and all of them together (~24k tokens). */
export const DOCUMENT_CHARS = 40_000;
export const DOCUMENTS_TOTAL_CHARS = 96_000;
/** How far back the conversation is read for ids. */
const MESSAGE_PAGE = 200;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = new RegExp(`chorus-artifact:(${UUID})`, "gi");

/** Ids in one message, in the order they appear: tool results' `artifactId`, then references in any text. */
const idsIn = (message: Message): string[] => {
  const out: string[] = [];
  for (const part of message.parts ?? []) {
    const typed = part as { type?: string; output?: unknown; text?: unknown; input?: unknown };
    if (typed.type === "tool-result" && typed.output !== null && typeof typed.output === "object") {
      const id = (typed.output as { artifactId?: unknown }).artifactId;
      if (typeof id === "string") out.push(id);
    }
    const text = typed.type === "text" && typeof typed.text === "string" ? typed.text : typed.type === "tool-result" ? JSON.stringify(typed.output ?? "") : "";
    for (const match of text.matchAll(REFERENCE)) if (match[1] !== undefined) out.push(match[1]);
    // update_artifact / get_artifact name the document they touched.
    if (typed.type === "tool-call" && typed.input !== null && typeof typed.input === "object") {
      const input = typed.input as { artifactId?: unknown; input?: { artifactId?: unknown } };
      const id = typeof input.artifactId === "string" ? input.artifactId : input.input?.artifactId;
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
};

/** The conversation's documents, newest mention first, each once. Pure, for tests. */
export const documentIdsOf = (newestFirst: readonly Message[], limit = LISTED_DOCUMENTS): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of newestFirst) {
    // Within one message, the last mention is the newest.
    for (const id of idsIn(message).reverse()) {
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
      if (out.length === limit) return out;
    }
  }
  return out;
};

/** A slide's title: its first heading, or its first line. */
const slideTitle = (slide: string): string => {
  const lines = slide.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("<!--"));
  const heading = lines.find((line) => /^#{1,6}\s/.test(line));
  const text = (heading ?? lines[0] ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "");
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || "(picture only)";
};

/** "1. Title" per slide, numbered the way `slideEdits` counts. Pure, for tests. */
export const slideOutline = (content: string): string =>
  splitSlides(content)
    .map((slide, index) => `${index + 1}. ${slideTitle(slide)}`)
    .join("\n");

/** The section body for these documents, newest first. Pure, for tests. */
export const documentsText = (documents: readonly Artifact[]): string => {
  let budget = DOCUMENTS_TOTAL_CHARS;
  const blocks = documents.map((doc, index) => {
    const head = `### ${doc.title} — artifactId ${String(doc.id)} · ${doc.kind} · version ${doc.version}`;
    const outline = doc.kind === "slides" ? `\nSlides (${splitSlides(doc.content).length}):\n${slideOutline(doc.content)}` : "";
    if (index >= FULL_DOCUMENTS || budget <= 0) return `${head}${outline}\n(Text not shown here — read it with get_artifact.)`;
    const room = Math.min(DOCUMENT_CHARS, budget);
    const text = doc.content.length <= room ? doc.content : `${doc.content.slice(0, room)}\n… [${doc.content.length - room} more characters — read the rest with get_artifact]`;
    budget -= Math.min(doc.content.length, room);
    return `${head}${outline}\nCurrent text:\n~~~~${doc.kind}\n${text}\n~~~~`;
  });
  return [
    "The documents in this conversation, newest first, as they are now — including any change the person made in the side panel.",
    ...blocks,
  ].join("\n\n");
};

export const createDocumentsContextProvider = (deps: {
  readonly messages: Pick<MessageStore, "listByConversation">;
  readonly artifacts: Pick<ArtifactService, "get">;
}): ContextProvider => ({
  id: DOCUMENTS_PROVIDER_ID,
  async provide(context: ExecutionContext) {
    if (context.conversationId === undefined) return [];
    const page = await deps.messages
      .listByConversation({
        tenantId: context.tenantId as TenantId,
        conversationId: context.conversationId as ConversationId,
        limit: MESSAGE_PAGE,
        newestFirst: true,
      })
      .catch(() => ({ items: [] as Message[] }));
    const ids = documentIdsOf(page.items);
    if (ids.length === 0) return [];
    // A document that cannot be read (deleted, another workspace's id in a pasted link) is left out, never an error.
    const documents = (
      await Promise.all(ids.map((id) => deps.artifacts.get(context, { id: id as ArtifactId }).catch(() => null)))
    ).filter((doc): doc is Artifact => doc !== null);
    if (documents.length === 0) return [];
    return [
      shareFlowSection({
        providerId: DOCUMENTS_PROVIDER_ID,
        origin: "external",
        kind: "knowledge",
        title: "Documents in this chat",
        body: documentsText(documents),
        priority: 88,
        provenance: `shareflow:documents.${documents.map((d) => String(d.id)).join(",")}`,
      }),
    ];
  },
});
