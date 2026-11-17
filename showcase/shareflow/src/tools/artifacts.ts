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
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentPlatformError, asId, type ExecutionContext, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  type Artifact,
  type ArtifactId,
  type MediaAssetId,
  type ProjectService,
  type ResearchService,
} from "../services/index.js";
import {
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_IMAGES,
  MAX_PAGE_MARGIN_MM,
  PAGE_ORIENTATIONS,
  PAGE_SIZE_IDS,
  PDF_KINDS,
  buildDocumentHtml,
  layoutWidthOf,
  type PageSetup,
  type PageSizeId,
  markdownImageSources,
  slideMarkdownToHtml,
} from "../adapters/web/document.js";
import {
  CAROUSEL_MAX_SLIDES,
  SLIDE_FORMAT_IDS,
  buildSlidesHtml,
  parseSlides,
  slideImageSources,
  type BuiltSlides,
  type SlideFormat,
} from "../adapters/web/slides.js";
import { DOCUMENT_TEMPLATES, documentTemplateDirective, type DocumentTemplate } from "../adapters/web/document-templates.js";
import { SLIDE_VIDEO_MAX_SECONDS, SLIDE_VIDEO_MAX_SECONDS_PER_SLIDE, SLIDE_VIDEO_MAX_SLIDES, SLIDE_VIDEO_MIN_SECONDS } from "../adapters/web/slide-video.js";
import { CURATED_FONT_NAMES, type Theme } from "../design/theme.js";
import { deckParts, deckStyleProblems, joinDeck, unknownDirectives } from "../adapters/web/slides.js";
import { renderFactsView } from "../adapters/web/render-facts.js";
import { SvgError, sanitizeSvg } from "../design/svg.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, optionalIdString, shareFlowTool } from "./factory.js";
import { logoForChat, themeForChat } from "./project-theme.js";

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

/**
 * Patch edits — #607. A small change used to mean the model rewriting the whole document, which costs the
 * tokens of the whole document and is how a section silently goes missing. An edit names text that must
 * appear **exactly once** and what replaces it; edits apply in order, each to the result of the one before.
 *
 * Exactly once, because a `find` that matches twice is ambiguous and one that matches nowhere means the
 * model's picture of the document is wrong — either way the right move is to read it, not to guess. The
 * error names the edit by number, and quotes the start of its `find`, so the retry fixes that one.
 */
export type ArtifactEdit = { readonly find: string; readonly replace: string };

export const MAX_ARTIFACT_EDITS = 50;
/** #644: a full rewrite may stand in for failed edits only if it is at least this share of the document's length. */
export const CONTENT_FALLBACK_SHARE = 0.7;

const occurrences = (haystack: string, needle: string): number => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
};

/**
 * One change to one slide of a deck — #644. `slide` counts from 1, the way the "Documents in this chat" outline
 * numbers them; edits apply in order, each to the deck the ones before it left.
 */
export type SlideEdit = { readonly slide: number; readonly action: "replace" | "insert_before" | "insert_after" | "delete"; readonly content?: string };

/**
 * What a set of slide edits did — #665: the result names the slides that changed, so the reply can say "slide 4"
 * from the call's own record instead of from memory. `changed` is numbered in the deck as saved (a replaced or an
 * inserted slide); `removed` in the deck as it was, since a deleted slide has no number afterwards.
 */
export type SlideEditOutcome = { readonly content: string; readonly changed: readonly number[]; readonly removed: readonly number[] };

export const applySlideEdits = (source: string, edits: readonly SlideEdit[]): string => applySlideEditsTracked(source, edits).content;

export const applySlideEditsTracked = (source: string, edits: readonly SlideEdit[]): SlideEditOutcome => {
  const { preamble, slides } = deckParts(source);
  // Beside each slide: its number before the edits (undefined for an inserted one) and whether an edit touched it.
  const marks: { readonly from: number | undefined; changed: boolean }[] = slides.map((_, index) => ({ from: index + 1, changed: false }));
  const removed: number[] = [];
  edits.forEach((edit, index) => {
    const label = `Slide edit ${index + 1} of ${edits.length}`;
    const at = edit.slide - 1;
    const inserting = edit.action === "insert_before" || edit.action === "insert_after";
    const max = inserting ? slides.length : slides.length - 1;
    if (!Number.isInteger(edit.slide) || at < 0 || at > max || (inserting && slides.length === 0 && at !== 0)) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `${label}: there is no slide ${edit.slide} — the deck has ${slides.length}${index > 0 ? " after the edits before it" : ""}. Nothing was changed.`,
        retryable: false,
      });
    }
    const body = (edit.content ?? "").trim();
    if (edit.action !== "delete" && body === "") {
      throw new AgentPlatformError({ code: "invalid_input", message: `${label}: \`content\` is empty — give the slide's markdown. Nothing was changed.`, retryable: false });
    }
    if (edit.action !== "delete" && deckParts(body).slides.length > 1) {
      throw new AgentPlatformError({ code: "invalid_input", message: `${label}: \`content\` holds more than one slide — one slide per edit, without \`---\`. Nothing was changed.`, retryable: false });
    }
    if (edit.action === "replace") {
      slides[at] = body;
      const mark = marks[at];
      if (mark !== undefined) mark.changed = true;
    } else if (edit.action === "delete") {
      slides.splice(at, 1);
      const [gone] = marks.splice(at, 1);
      if (gone?.from !== undefined) removed.push(gone.from);
    } else {
      const to = edit.action === "insert_before" ? at : at + 1;
      slides.splice(to, 0, body);
      marks.splice(to, 0, { from: undefined, changed: true });
    }
  });
  if (slides.length === 0) {
    throw new AgentPlatformError({ code: "invalid_input", message: "Those edits would leave the deck with no slides. Nothing was changed.", retryable: false });
  }
  const changed = marks.flatMap((mark, index) => (mark.changed ? [index + 1] : []));
  return { content: joinDeck(preamble, slides), changed, removed: removed.sort((a, b) => a - b) };
};

export const applyArtifactEdits = (content: string, edits: readonly ArtifactEdit[]): string => {
  let next = content;
  edits.forEach((edit, index) => {
    const label = `Edit ${index + 1} of ${edits.length}`;
    const quoted = JSON.stringify(edit.find.length > 60 ? `${edit.find.slice(0, 60)}…` : edit.find);
    if (edit.find === "") {
      throw new AgentPlatformError({ code: "invalid_input", message: `${label}: \`find\` is empty — name the text to replace.`, retryable: false });
    }
    const count = occurrences(next, edit.find);
    if (count !== 1) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message:
          count === 0
            ? `${label}: \`find\` ${quoted} is not in the document${index > 0 ? " (after the edits before it)" : ""}. Nothing was changed — read it with get_artifact and copy the text exactly.`
            : `${label}: \`find\` ${quoted} appears ${count} times. Nothing was changed — include more of the surrounding text so it matches once.`,
        retryable: false,
      });
    }
    const at = next.indexOf(edit.find);
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  });
  if (next.trim() === "") {
    throw new AgentPlatformError({ code: "invalid_input", message: "Those edits would leave the document empty. Nothing was changed.", retryable: false });
  }
  if (next.length > ARTIFACT_MAX_CHARS) {
    throw new AgentPlatformError({ code: "invalid_input", message: `After those edits the document is over ${ARTIFACT_MAX_CHARS} characters. Nothing was changed.`, retryable: false });
  }
  return next;
};

/** A slides artifact as its print page — the deck's slides at the format's size, in the chat's theme. */
const buildDeck = async (
  source: string,
  title: string,
  theme: Theme | undefined,
  format: SlideFormat | undefined,
  images: Readonly<Record<string, string>>,
  logo?: string,
  mode?: "print" | "play",
): Promise<BuiltSlides> => {
  try {
    return await buildSlidesHtml({
      source,
      title,
      images,
      renderMarkdown: slideMarkdownToHtml,
      ...(mode === undefined ? {} : { mode }),
      ...(logo === undefined ? {} : { logo }),
      ...(theme === undefined ? {} : { theme }),
      ...(format === undefined ? {} : { format }),
    });
  } catch (error) {
    if (error instanceof AgentPlatformError) throw error;
    throw new AgentPlatformError({ code: "invalid_input", message: error instanceof Error ? error.message : String(error), retryable: false });
  }
};

/**
 * The deck's images, read and inlined — the print page refuses every request. One at a time, as the PDF's
 * images are; one that cannot be read is drawn as its alt text and reported, not a reason to lose the deck.
 */
type ImageRead = (source: { kind: "asset"; assetId: MediaAssetId } | { kind: "url"; url: string }) => Promise<{ bytes: Uint8Array; mime: string }>;

const deckImages = async (read: ImageRead, source: string): Promise<{ images: Record<string, string>; skipped: string[] }> =>
  inlineSources(read, slideImageSources(parseSlides(source)));

/**
 * #615: a markdown document's `![alt](chorus-media:…)` images, read and inlined the same way — so an imported
 * stock photo prints in the PDF instead of a broken picture.
 */
const documentImages = async (read: ImageRead, kind: string, source: string | undefined): Promise<{ images: Record<string, string>; skipped: string[] }> =>
  kind === "markdown" && source !== undefined ? inlineSources(read, markdownImageSources(source)) : { images: {}, skipped: [] };

/** #615: the chat's project logo, inlined, for a deck or a document. */
const chatLogo = (projects: Pick<ProjectService, "logoReference"> | undefined, read: ImageRead, context: ExecutionContext): Promise<string | undefined> =>
  logoForChat(projects, (reference) => read({ kind: "asset", assetId: asId<MediaAssetId>(reference) }), context);

const inlineSources = async (read: ImageRead, sources: readonly string[]): Promise<{ images: Record<string, string>; skipped: string[] }> => {
  const images: Record<string, string> = {};
  const skipped: string[] = [];
  for (const src of sources.slice(0, MAX_DOCUMENT_IMAGES)) {
    try {
      const image = await read(src.startsWith("https://") ? { kind: "url", url: src } : { kind: "asset", assetId: asId<MediaAssetId>(src) });
      images[src] = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
    } catch {
      skipped.push(src);
    }
  }
  return { images, skipped };
};

/**
 * #607 part 3: a React artifact runs only in the panel's sandbox, which loads React and Babel from a CDN. The
 * print and screenshot page refuses every off-host request (`adapters/web/browser.ts`), so it cannot run one —
 * refused by name rather than printed as a page of source code.
 */
const reactNotPrintable = (what: "a PDF" | "an image") =>
  new AgentPlatformError({
    code: "invalid_input",
    message: `An interactive React artifact cannot be turned into ${what}: it only runs in the chat's sandboxed preview. Offer to rebuild it as an html artifact (static markup) and export that, or ask the person to take a screenshot of the preview.`,
    retryable: false,
  });

/** A stored SVG, re-sanitized before it is drawn — a row written before the sanitizer existed is made inert too. */
const cleanSvg = (content: string): string => {
  try {
    return sanitizeSvg(content).svg;
  } catch (error) {
    if (error instanceof SvgError) throw new AgentPlatformError({ code: "invalid_input", message: `This SVG cannot be drawn: ${error.message}`, retryable: false });
    throw error;
  }
};

/** An SVG on its own page, sized to the width — what `renderHtmlImage` photographs and `generate_pdf` prints. */
const svgPage = (svg: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>svg{display:block;max-width:100%;height:auto;margin:0 auto}</style></head><body>${svg}</body></html>`;

const slideFormat = z.enum(SLIDE_FORMAT_IDS as unknown as [SlideFormat, ...SlideFormat[]]).optional();

/** #595 part 2: a document template for a printed markdown, text or html document. */
const documentTemplate = z.enum(DOCUMENT_TEMPLATES).optional();

/**
 * The project's logo, inlined for a template's header — #595 part 2. Only read when a template is printed, and
 * never a reason to fail one: a missing, unreadable or non-image logo prints the header without it.
 */
export const projectLogo = async (
  projects: Pick<ProjectService, "logoReference"> | undefined,
  readImage: ResearchService["readImage"],
  context: ExecutionContext,
): Promise<string | undefined> => {
  try {
    const reference = await projects?.logoReference?.(context);
    if (reference === undefined) return undefined;
    const image = await readImage(context, { source: { kind: "asset", assetId: asId<MediaAssetId>(reference) } });
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(image.mime)) return undefined;
    return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
};

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
      "Create a document the user opens beside the chat instead of reading it inline — a content plan, a strategy note, a landing page, a long diagram. Use it for anything substantial and reusable, and not for a short answer. Never use it for a social post: a post belongs in `create_post_draft` so it can actually be validated and published. `kind` is markdown, html, mermaid, slides, react or svg. HTML: a complete page (inline <style>/<script>; scripts only from cdnjs.cloudflare.com, unpkg.com or cdn.jsdelivr.net; no network requests) for a landing-page mockup or a small interactive tool. REACT: ONE component file with a default export (import only from 'react'; Tailwind classes work) for a calculator or an interactive tool — it runs in the chat's sandbox and cannot be exported to PDF or image, so use html for anything to print or post. SVG: one <svg> element with a viewBox, no scripts or external links (they are stripped); it can go on a post as an image. SLIDES: markdown with a line of --- between slides, one idea per slide. The layout follows from what a slide holds: only a # heading (plus one line) is the title; a lone ## heading (or '## 02 Results') is a section divider; a short line directly above a heading is its eyebrow (or <!-- eyebrow: Q3 review -->); a heading and 3-5 short bullets is bullets (drawn as numbered cards); a heading like '## Agenda' over a list is an agenda; list items that start with a time ('- **Q1** — Pilot', '- 2024: Launch', '- Step 1 …') are a timeline (3-6 steps); a lone figure (87%, $1.2m, '3x More Engagement') is a big stat — a percentage draws a ring — and 2-4 figures each with a label are a stat grid; two ### sub-headings each with bullets are two columns, and a comparison when they contrast (Before/After, Pros/Cons, or 'vs' in the heading) — a comparison is strictly two-sided; three or four ### sub-headings are that many even columns (pricing tiers: ### Basic / ### Team / ### Premium); a > block with '— Name' is a quote (add one ![Name](chorus-media:...) for a portrait); one ![alt](chorus-media:...) image is a full-bleed image slide (with a heading and bullets it sits beside them); 2-8 images are a team grid (a caption line under each: 'Dana Weiss — CTO') or a logo wall (a heading like 'Trusted by'); a heading with a link, URL or @handle under it (or 'Follow…', 'Try…', 'Book…') is a call to action — its last short line becomes the button and the link shows under it. Force any of them with <!-- layout: title|section|bullets|agenda|timeline|stat|stat-grid|two-column|comparison|columns|quote|image|image-left|image-right|team|logos|cta -->. <!-- format: 16:9 --> in the deck makes it landscape (default 4:5, 1080x1350, for feeds). <!-- transition: fade|slide|zoom|none --> before the first --- sets how every slide arrives in present mode and in a video (default fade); on a slide, only that one. <!-- background: chorus-media:... --> puts a photo behind a slide, graded to the theme's colours, and <!-- credit: Photo by … on Pexels --> credits it; in a project the logo is added to every slide by itself. Style a deck with directives, never by rebuilding it as an html page: <!-- palette: #background #text #accent --> (hex), <!-- heading-font: … --> and <!-- body-font: … --> (installed fonts only: Inter, Roboto, Open Sans, Lato, Manrope, League Spartan, Quicksand, Bebas Neue, Comic Neue, DejaVu Sans, Roboto Slab, Vollkorn, EB Garamond, DejaVu Serif, JetBrains Mono), <!-- mode: dark|light -->, and on one slide <!-- bg-color: #hex -->; a value that was not applied comes back in `styleProblems` — say so rather than claiming it. At most 30 slides, 10 for an Instagram carousel. A markdown document that will be printed can name its layout with <!-- template: one-pager|report|brief|checklist|campaign-plan -->. It is NOT a PDF: when the person asks for a PDF, call generate_pdf (and never call this result a PDF). Put the returned `reference` in your reply as a markdown link and say in a sentence what it is, instead of pasting the whole document — a long document flooding the chat is the thing this avoids. If the result lists `placeholders`, fix them with update_artifact, or tell the person exactly which details are still missing.",
    category: "artifacts",
    effect: "internal-write",
    inputSchema: createArtifactSchema,
    delegatesTo: "ArtifactService.create",
    delegate: async (input: z.infer<typeof createArtifactSchema>, context, { idempotencyKey }) => ({
      ...receiptView(
        await services.artifacts.create(context, {
          idempotencyKey,
          title: input.title,
          kind: input.kind,
          content: input.content,
        }),
      ),
      ...slideWarnings(input.kind, input.content),
      ...placeholderWarnings(input.content),
    }),
  }));

/**
 * A bracketed stand-in for a detail nobody supplied — `[Customer Name]`, `[Company]`, `[date]`. One to five words,
 * letters only, not followed by `(` (a markdown link) and not a task box (`[x]`) or a footnote (`[1]`).
 */
const PLACEHOLDER = /\[(?:[A-Za-z][A-Za-z'’]*)(?:[ _-][A-Za-z][A-Za-z'’]*){0,4}\](?!\()/g;
const FENCED = /^(\s*)(```|~~~)[\s\S]*?^\1\2/gm;

/** The placeholders in a document, outside code, once each. Pure, for tests. */
export const placeholdersIn = (content: string): string[] => {
  const prose = content.replace(FENCED, "").replace(/`[^`\n]*`/g, "");
  const found: string[] = [];
  for (const match of prose.matchAll(PLACEHOLDER)) {
    const text = match[0];
    // "[x]" and "[ ]" are task boxes; a single letter is never a placeholder.
    if (text.length < 5 || /^\[[xX ]\]$/.test(text)) continue;
    // "![alt]" is an image's alt text, not a stand-in.
    if (match.index !== undefined && match.index > 0 && prose[match.index - 1] === "!") continue;
    if (!found.includes(text)) found.push(text);
  }
  return found.slice(0, 10);
};

/**
 * #655: placeholders left in a document. Production, 2026-09-30: "— [Customer Name], [Company]" shipped in both decks
 * and the reply called them finished. Said in the result so the agent fixes them or names them to the person.
 */
export const placeholderWarnings = (content: string): { readonly placeholders?: readonly string[]; readonly placeholderNote?: string } => {
  const found = placeholdersIn(content);
  if (found.length === 0) return {};
  return {
    placeholders: found,
    placeholderNote:
      `This document still has placeholders: ${found.join(", ")}. Ask the person for these details or remove those parts with update_artifact; ` +
      "if one has to stay, name it in your reply. Do not call the document finished while they are in it.",
  };
};

/**
 * #653: directives a deck used that no slide understands. They are removed before rendering (a comment the
 * renderer did not know used to print on the slide), and said here so the agent does not tell the person a
 * `theme` or `font` was applied.
 *
 * #663: and style directives whose value was not applied — a colour that is not hex, a font that is not
 * installed (named with the nearest one that is, AC-2), a mode that is neither dark nor light.
 */
export const slideWarnings = (
  kind: string,
  content: string,
): { readonly unknownDirectives?: readonly string[]; readonly styleProblems?: readonly string[]; readonly directiveNote?: string } => {
  if (kind !== "slides") return {};
  const names = unknownDirectives(content);
  const problems = deckStyleProblems(content);
  if (names.length === 0 && problems.length === 0) return {};
  const notes = [
    ...(names.length === 0
      ? []
      : [
          `Not slide directives, so they were ignored: ${names.map((name) => `<!-- ${name}: … -->`).join(", ")}. ` +
            "For colours, fonts or a dark deck use palette, heading-font, body-font, mode or bg-color.",
        ]),
    ...(problems.length === 0 ? [] : [`Not applied: ${problems.join(" ")}`]),
  ];
  return {
    ...(names.length === 0 ? {} : { unknownDirectives: names }),
    ...(problems.length === 0 ? {} : { styleProblems: problems }),
    directiveNote:
      `${notes.join(" ")} Do not say any of this was applied. If the person asked for something slides cannot do, say so plainly ` +
      "— and never rebuild the deck as an HTML page to get a look.",
  };
};

const updateArtifactSchema = z
  .object({
    artifactId: idString,
    /** The whole new document. With `edits` too, the edits win and this is the fallback. */
    content: content.optional(),
    /** #607: find/replace patches, applied in order; each `find` must match exactly once. */
    edits: z
      .array(z.object({ find: z.string().min(1, "an edit needs the text to find"), replace: z.string() }).strict())
      .min(1)
      .max(MAX_ARTIFACT_EDITS)
      .optional(),
    /** #644: for a slides document — replace, insert or delete slides by number (the outline's numbering). */
    slideEdits: z
      .array(
        z
          .object({
            slide: z.number().int().min(1),
            action: z.enum(["replace", "insert_before", "insert_after", "delete"]),
            content: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ARTIFACT_EDITS)
      .optional(),
    /** Omitted keeps the current title. Renaming and revising are one call because the old tool made them one. */
    title: title.optional(),
  })
  .strict()
  /*
   * At least one — not "exactly one". Production, 2026-09-28: gpt-4.1 sent both, three times; the schema refused
   * each call before the tool ran, the model saw only "Type validation failed", and it gave up. Both is handled.
   */
  .refine((value) => value.content !== undefined || value.edits !== undefined || value.slideEdits !== undefined, {
    message: "pass slideEdits (a deck: replace, insert or delete slides by number), edits (find/replace patches) for a small change, or content (the whole new document)",
  });

export const updateArtifactTool = shareFlowTool(["artifacts"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "update_artifact",
    label: "Revise a document",
    description:
      "Revise a document, keeping the previous version — nothing is overwritten and the id does not change, so a reference you showed earlier still resolves to the current text. ALWAYS use this to change a document that exists — never create_artifact, which makes a second one. The Documents in this chat section of your context has each document's current text and, for a deck, its numbered slide outline. For a deck, change slides with `slideEdits`: [{ slide, action: replace | insert_before | insert_after | delete, content }] — slide numbers are the outline's, content is ONE slide's markdown without `---`, applied in order. A change to particular slides — a quote's attribution, a heading, one slide's bullets, a slide added, merged or removed — is always `slideEdits`, even when it touches several slides; send a deck's full `content` only to restructure it. The result's `slidesChanged` lists the changed slides by number. For a SMALL change elsewhere (a heading, a sentence, a number) pass `edits`: [{ find, replace }] — each `find` is text copied exactly from the current document that appears exactly once, applied in order; nothing else changes. Rewrite with `content` (the FULL new document, never a fragment) only when most of it changes or the person asks for a rewrite — send one or the other, not both. Read it with `get_artifact` first if you do not have the exact current text, because editing from memory of an earlier turn is how a document silently loses a section. You cannot change its kind; create a new one for that. Say a document changed only when this call's result confirms it (its version), and which slides or parts changed. If the person had it printed, print it again with generate_pdf after the edit so their file matches. When they say a result looks wrong, change the document first — printing it unchanged gives the same file.",
    category: "artifacts",
    effect: "internal-write",
    inputSchema: updateArtifactSchema,
    delegatesTo: "ArtifactService.revise",
    delegate: async (input: z.infer<typeof updateArtifactSchema>, context, { idempotencyKey }) => {
      const id = asId<ArtifactId>(input.artifactId);
      // A patch is applied to the current text here and saved as a whole new version, so history and the
      // archive-before-update guarantee are exactly those of a full rewrite.
      /*
       * Both given: the edits are applied, since they name the change exactly and a full `content` from a small
       * model can drop a section; the content is used only when an edit does not match.
       */
      let next: string;
      let note: string | undefined;
      let savedFrom: "slideEdits" | "edits" | "content" = "content";
      let slideChanges: { slidesChanged: readonly number[]; slidesRemoved?: readonly number[] } | undefined;
      if (input.edits === undefined && input.slideEdits === undefined) next = input.content ?? "";
      else {
        const current = await services.artifacts.get(context, { id });
        try {
          let working = current.content;
          if (input.slideEdits !== undefined) {
            if (current.kind !== "slides") {
              throw new AgentPlatformError({ code: "invalid_input", message: `slideEdits are for a slides document; this one is ${current.kind}. Use edits (find/replace) instead.`, retryable: false });
            }
            const outcome = applySlideEditsTracked(working, input.slideEdits);
            working = outcome.content;
            slideChanges = { slidesChanged: outcome.changed, ...(outcome.removed.length === 0 ? {} : { slidesRemoved: outcome.removed }) };
            savedFrom = "slideEdits";
          }
          if (input.edits !== undefined) {
            working = applyArtifactEdits(working, input.edits);
            savedFrom = "edits";
          }
          next = working;
          if (input.content !== undefined) note = "Applied your edits; the full content you also sent was not used.";
        } catch (error) {
          /*
           * #644: the full content is a fallback only when it is plausibly the whole document. Production, chat
           * d756738b: an edit's `find` was guessed, it did not match, and the content — rewritten from memory — was
           * saved as the new version. A rewrite much shorter than the document is how a section disappears.
           */
          const fallbackOk = input.content !== undefined && input.content.length >= current.content.length * CONTENT_FALLBACK_SHARE;
          if (!fallbackOk) throw error;
          next = input.content ?? "";
          // The edits before the one that failed were discarded with it: the result must not report them.
          savedFrom = "content";
          slideChanges = undefined;
          note = `An edit did not match (${error instanceof Error ? error.message : "no match"}), so the full content you sent was saved instead — check it kept everything the person wanted.`;
        }
      }
      const revised = await services.artifacts.revise(context, {
        idempotencyKey,
        id,
        content: next,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      return {
        ...receiptView(revised),
        savedFrom,
        ...(input.edits === undefined ? {} : { edited: input.edits.length }),
        ...(input.slideEdits === undefined ? {} : { slidesEdited: input.slideEdits.length, slides: deckParts(next).slides.length }),
        // #665: which slides, by number — absent when a failed edit fell back to the full content.
        ...(slideChanges ?? {}),
        ...(note === undefined ? {} : { note }),
        ...slideWarnings(revised.kind, next),
        ...placeholderWarnings(next),
      };
    },
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

/**
 * `generate_pdf` — replacing `tool:generate_pdf`.
 *
 * `artifacts` by category, because that is the neighbourhood: an artifact is a document the assistant
 * authored, and a PDF is one a person can keep. The old tool sat with the Documents agent for the same
 * reason.
 *
 * ## Diagrams go inside the document
 *
 * The instruction is transcribed into the description because it is the one the model gets wrong in a
 * way that destroys the answer: *"With kind='markdown', put a ```mermaid fenced block anywhere in
 * `source` and it is drawn as a real diagram at that spot, in the middle of your prose. Do NOT render a
 * diagram to a PNG first and pass it as kind='media' — that puts it on its own page and throws the
 * surrounding text away."*
 *
 * And its companion, which is about `render_diagram` rather than this tool: *"Do NOT use generate_pdf
 * for a diagram unless the user asked for a PDF: no platform renders a PDF in a feed, so a diagram
 * exported that way cannot be attached to a post at all."*
 *
 * ## Images are inlined, not signed
 *
 * `kind: "media"` takes asset ids and the tool reads their **bytes**, inlining them as `data:` URLs.
 * The old pipeline passed signed URLs into the page and let Chromium fetch them; inlining means the
 * page makes no request at all — no expiry, no question about whether the container can reach storage,
 * and nothing for the page's request guard to weigh.
 */
export const generatePdfSchema = z
  .object({
    kind: z.enum(PDF_KINDS),
    source: z.string().max(MAX_DOCUMENT_CHARS).optional(),
    /**
     * Print a document already made with create_artifact — #587. Production, 2026-09-28: after making the
     * artifact, the model passed its id as a media asset in seven straight calls ("No media asset …") and
     * never got a PDF. The id is what it had in hand, so the tool takes it.
     */
    artifactId: optionalIdString,
    title: z.string().trim().min(1).max(200).optional(),
    /** #607: for a slides artifact — 4:5 (1080x1350, the default) or 16:9. Overrides the deck's own directive. */
    format: slideFormat,
    /** #595 part 2: a document template. Overrides a markdown document's own `<!-- template: … -->`. */
    template: documentTemplate,
    /**
     * #661: the paper — A4, Letter, 16:9 (1920x1080) or 4:5 (1080x1350). Production, 2026-09-30: an html deck
     * asked for `format: "16:9"`, which only slides read, and printed portrait A4 with every slide cropped. For a
     * slides artifact 16:9 and 4:5 stand in for `format`.
     */
    page: z.enum(PAGE_SIZE_IDS as unknown as [PageSizeId, ...PageSizeId[]]).optional(),
    orientation: z.enum(PAGE_ORIENTATIONS).optional(),
    /** #661: every side, in millimetres; 0 is full-bleed. The white frame round a navy sheet could not be removed. */
    margin: z.number().min(0).max(MAX_PAGE_MARGIN_MM).optional(),
    /** #661: "page / pages" at the foot of every page — a plain document had none. */
    pageNumbers: z.boolean().optional(),
    /**
     * For `kind: "media"` only — one page per image, in this order.
     *
     * An empty list reads as absent. Production, 2026-09-28: gpt-4.1-mini sent `mediaAssetIds: []` with a
     * markdown PDF six calls running, each refused by the tie below with a validation error it could not
     * read, and never produced the PDF. An empty list carries no pictures to lose, so nothing is dropped.
     */
    mediaAssetIds: z.preprocess(
      (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
      z.array(idString).min(1).max(MAX_DOCUMENT_IMAGES).optional(),
    ),
  })
  .strict()
  .refine((value) => value.kind !== "media" || value.mediaAssetIds !== undefined, {
    /**
     * The two are tied: `media` needs images and no other kind takes them.
     *
     * Refused rather than ignored, because a `kind: "markdown"` call carrying `mediaAssetIds` is a
     * caller expecting its pictures to appear — and silently dropping them produces a document that
     * looks finished and is missing half its content.
     */
    // Other kinds may carry pictures too since #587 — they go after the text rather than being refused.
    message: "kind 'media' needs mediaAssetIds",
  });

/**
 * The last PDF printed from each document version — #654.
 *
 * Production, 2026-09-30: told "that came out as a web page, remake it as proper slides", the agent called
 * generate_pdf again on the unchanged document, got the identical 55,320-byte file, and presented it as "the
 * corrected PDF". A print of the same version with the same options now returns that file with `unchanged: true`
 * and says what to do instead. Per process and bounded: a restart only means one extra render.
 */
const lastPrints = new Map<string, Record<string, unknown>>();
const LAST_PRINTS_LIMIT = 500;

/** The document's content is hashed in too, so a change that did not move the version still prints anew. */
export const printKey = (tenantId: string, artifact: { readonly id: unknown; readonly version: unknown; readonly content: string }, input: Record<string, unknown>): string =>
  JSON.stringify([
    tenantId,
    String(artifact.id),
    artifact.version,
    createHash("sha256").update(artifact.content).digest("hex"),
    input["kind"],
    input["template"] ?? null,
    input["format"] ?? null,
    input["title"] ?? null,
    input["mediaAssetIds"] ?? [],
    // #661: a different page is a different print.
    input["page"] ?? null,
    input["orientation"] ?? null,
    input["margin"] ?? null,
    input["pageNumbers"] ?? null,
  ]);

export const rememberPrint = (key: string, result: Record<string, unknown>): void => {
  lastPrints.delete(key);
  lastPrints.set(key, result);
  if (lastPrints.size > LAST_PRINTS_LIMIT) lastPrints.delete(lastPrints.keys().next().value as string);
};

export const unchangedPrint = (key: string, version: unknown): Record<string, unknown> | undefined => {
  const previous = lastPrints.get(key);
  if (previous === undefined) return undefined;
  return {
    ...previous,
    unchanged: true,
    note:
      `This document has not changed since it was printed (version ${String(version)}), so this is the same PDF as before. ` +
      "If the person said the result is wrong, change the document with update_artifact first, then print it again — do not present this file as a fix.",
  };
};

/** #661: the page options `generate_pdf` was given, or undefined when it was given none. */
export const pageSetupOf = (input: { readonly page?: PageSizeId | undefined; readonly orientation?: PageSetup["orientation"] | undefined; readonly margin?: number | undefined; readonly pageNumbers?: boolean | undefined }): PageSetup | undefined => {
  const setup: PageSetup = {
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
    ...(input.margin === undefined ? {} : { margin: input.margin }),
    ...(input.pageNumbers === undefined ? {} : { pageNumbers: input.pageNumbers }),
  };
  return Object.keys(setup).length === 0 ? undefined : setup;
};

export const generatePdfTool = shareFlowTool(["render", "media", "research", "artifacts", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_pdf",
    label: "Make a PDF",
    description:
      "Turn content into a PDF stored in this workspace — only when the person asked for a PDF or a file. To print a document you made with create_artifact, pass its artifactId (and any kind) — no need to resend the content; a slides artifact prints one slide per page (format 4:5 or 16:9); an svg prints as a page holding the drawing; a react artifact cannot be printed (it only runs in the chat's preview). `kind` is text (verbatim), markdown (headings, lists, tables), html (a document body) or media (stored images, one per page); with the other kinds, mediaAssetIds are added after the text. template lays the document out, in the project's theme with its logo in the header and numbered pages: one-pager (compact, one sheet), report (a cover page, then numbered ## sections), brief (the first paragraph as a summary box, ## sections as labels), checklist (every - item a box to tick; - [x] prints ticked) or campaign-plan (landscape, for tables of dates, channels and owners) — leave it out for a plain document; a markdown document can carry <!-- template: report --> itself. DIAGRAMS GO INSIDE THE DOCUMENT: with kind='markdown', put a ```mermaid fenced block anywhere in `source` and it is drawn as a real diagram at that spot, in the middle of your prose — do NOT render it to a PNG first and pass it as kind='media', which puts it on its own page and throws the surrounding text away. Do not use this for a diagram unless the user asked for a PDF: of the channels only LinkedIn posts a PDF (as a document post), so a diagram meant for a post should be an image. To put an existing document on a post, use attach_artifact_to_post. Returns a reference; put it in your reply so the user can get the file. Describe the PDF only from this result — its pages, pageSize and orientation, and any renderNote, overflow, overflowingSlides or missingFonts; if those show a problem, say so and fix the document, and never claim colours or a layout you cannot check. PAGE: page is A4 (default), Letter, 16:9 (1920x1080 px, landscape) or 4:5 (1080x1350 px); orientation portrait or landscape; margin in mm on every side (default 18/16 on A4 and Letter, 0 on 16:9 and 4:5) — margin 0 is full-bleed, so a coloured background reaches the paper's edge with no white frame; pageNumbers: true prints 'page / pages' at the foot (it keeps a 12 mm bottom margin for them). COLOURS AND LAYOUT NEED kind='html': markdown prints in the standard document style, so a designed page — a coloured price sheet, a cover, a deck — is html with an inline <style>. A slide deck as html: each slide a block of exactly the page's size (1920x1080 px for 16:9) with break-after: page, and pass page='16:9'. In html your own @page rule (size, margin) wins over the default margins; page, orientation and margin passed here win over both. FONTS: only installed fonts print — " +
      CURATED_FONT_NAMES.join(", ") +
      ", plus the generic families (sans-serif, serif, monospace). Links to Google Fonts or any other web font do not load (the renderer makes no outside requests), so name an installed font in font-family instead.",
    category: "artifacts",
    // It stores a file in the workspace and nothing leaves it — as with a capture or a drawing.
    effect: "internal-write",
    inputSchema: generatePdfSchema,
    delegatesTo: "RenderService.renderDocument",
    delegate: async (input: z.infer<typeof generatePdfSchema>, context) => {
      /**
       * The images, inlined.
       *
       * Read one at a time rather than in parallel: each is a signed-URL round trip plus a download,
       * and thirty at once against the app is a burst nobody asked for. The order is the page order.
       */
      // A document made earlier: its content and kind are the source (#587).
      const artifact = input.artifactId === undefined ? null : await services.artifacts.get(context, { id: asId<ArtifactId>(input.artifactId) });
      const key = artifact === null ? undefined : printKey(String(context.tenantId), artifact, input as Record<string, unknown>);
      const again = key === undefined ? undefined : unchangedPrint(key, artifact?.version);
      if (again !== undefined) return again;
      const remembered = <T extends Record<string, unknown>>(result: T): T => {
        if (key !== undefined) rememberPrint(key, result);
        return result;
      };
      // #595: in a project, the PDF prints in its theme — fonts, colours, a themed rule, themed diagrams.
      const theme = await themeForChat(services.projects, context);

      const read: ImageRead = (source) => services.research.readImage(context, { source });
      // #615: the project's logo, on every slide and in a document's header.
      const logo = await chatLogo(services.projects, read, context);

      // #607: a deck prints one slide per page, at the slide's own size.
      if (artifact !== null && artifact.kind === "slides") {
        const { images: inlined, skipped } = await deckImages(read, artifact.content);
        // #661: `page: "16:9"` or `"4:5"` asks a deck for that slide size, as `format` does; `format` wins if both.
        const format = input.format ?? (input.page === "16:9" || input.page === "4:5" ? input.page : undefined);
        const deck = await buildDeck(artifact.content, input.title ?? artifact.title, theme, format, inlined, logo);
        const printed = await services.render.renderDocument(context, { html: deck.html, page: { width: deck.width, height: deck.height } });
        const stored = await services.media.storeAsset(context, { contentType: printed.mime, bytes: printed.bytes });
        return remembered({
          reference: stored.reference,
          pages: printed.pages,
          slides: deck.count,
          format: deck.format,
          byteSize: stored.byteSize,
          ...renderFactsView(printed.facts),
          ...slideWarnings(artifact.kind, artifact.content),
          ...placeholderWarnings(artifact.content),
          ...(skipped.length === 0 ? {} : { skippedImages: skipped, note: "These images could not be read, so their slides show the alt text." }),
        });
      }
      if (artifact !== null && artifact.kind === "react") throw reactNotPrintable("a PDF");
      // #607: an SVG prints as an html body holding the (re-sanitized) drawing; mermaid as a fenced block.
      const kind = artifact === null || artifact.kind === "mermaid" ? input.kind : artifact.kind === "svg" ? "html" : artifact.kind;
      const source =
        artifact === null
          ? input.source
          : artifact.kind === "mermaid"
            ? "```mermaid\n" + artifact.content + "\n```"
            : artifact.kind === "svg"
              ? `<div style="text-align:center">${cleanSvg(artifact.content)}</div>`
              : artifact.content;

      const images: string[] = [];
      const skippedMedia: string[] = [];
      for (const assetId of input.mediaAssetIds ?? []) {
        try {
          const image = await services.research.readImage(context, {
            source: { kind: "asset", assetId: asId<MediaAssetId>(assetId) },
          });
          images.push(`data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`);
        } catch (error) {
          /*
           * For a PDF of images the images ARE the document, so a bad one still fails it. For a text
           * document they are extras: production passed an artifact's id here seven times and got no PDF
           * at all. Skipped, and said, rather than losing the whole document.
           */
          if (kind === "media") throw error;
          skippedMedia.push(assetId);
        }
      }

      // #615: the document's own ![alt](chorus-media:…) pictures, inlined — the print page fetches nothing.
      const printable = kind === "slides" || kind === "react" ? "markdown" : kind;
      const named = await documentImages(read, printable, source);
      skippedMedia.push(...named.skipped);
      // #595 part 2: the template asked for, or the one the markdown names; its header carries the project's logo.
      const template: DocumentTemplate | undefined = input.template ?? (kind === "markdown" && source !== undefined ? documentTemplateDirective(source) : undefined);
      const pageSetup = pageSetupOf(input);
      const html = await buildDocumentHtml({
        // A slides artifact returned above and a react one was refused, so what is left is a printable kind.
        kind: printable,
        ...(theme === undefined ? {} : { theme }),
        ...(template === undefined ? {} : { template }),
        ...(logo === undefined ? {} : { logo }),
        ...(Object.keys(named.images).length === 0 ? {} : { inlineImages: named.images }),
        ...(source === undefined ? {} : { source }),
        ...(input.title === undefined ? (artifact !== null && !/^\s*#\s/.test(artifact.content) ? { title: artifact.title } : {}) : { title: input.title }),
        ...(images.length === 0 ? {} : { images }),
        ...(pageSetup === undefined ? {} : { pageSetup }),
      });

      const layoutWidth = pageSetup === undefined ? undefined : layoutWidthOf(pageSetup);
      const printed = await services.render.renderDocument(context, { html, ...(layoutWidth === undefined ? {} : { layoutWidth }) });
      const stored = await services.media.storeAsset(context, {
        contentType: printed.mime,
        bytes: printed.bytes,
      });
      return remembered({
        reference: stored.reference,
        /**
         * The page count, which is what tells a person whether they got the document they meant.
         *
         * Read out of the PDF's own structure and best-effort — *"a nicety for the reply text, never
         * something to fail a successful render over."*
         */
        pages: printed.pages,
        byteSize: stored.byteSize,
        // #660: what the print measured — the reply must not claim anything these contradict.
        ...renderFactsView(printed.facts),
        ...(artifact === null ? {} : { ...slideWarnings(artifact.kind, artifact.content), ...placeholderWarnings(artifact.content) }),
        ...(template === undefined ? {} : { template, logo: logo !== undefined }),
        ...(skippedMedia.length === 0 ? {} : { skippedMedia, note: "These ids are not images in this workspace, so they were left out; the PDF has the text." }),
      });
    },
  }));

/**
 * An artifact onto a post — #589. Opening one beside the chat worked; putting one on a post had no path
 * at all. What a post can carry decides the shape: a PDF only on LinkedIn (a document post), an image
 * everywhere. So a document becomes a PDF by default or an image on request, and a diagram an image. The
 * attach goes through the same channel check as any file, so a PDF on an Instagram draft is refused with
 * the reason rather than silently dropped.
 */
const attachArtifactSchema = z
  .object({
    artifactId: idString,
    postDraftId: idString,
    /** #607: `carousel` — a slides artifact as one PNG per slide, attached in order. #620: `video` — as an MP4. */
    as: z.enum(["pdf", "image", "carousel", "video"]).optional(),
    format: slideFormat,
    /** #620: with as='video', how long each slide is held — 1 to 8 seconds, default 3. */
    secondsPerSlide: z.number().min(SLIDE_VIDEO_MIN_SECONDS).max(SLIDE_VIDEO_MAX_SECONDS_PER_SLIDE).optional(),
    /** #595 part 2: a document template for a markdown or html document, as generate_pdf takes. */
    template: documentTemplate,
  })
  .strict();

/**
 * A carousel the channels refused for its size — #611. The app's reason names every channel's image
 * limit and the total the post would have; this adds what to do about it, sized to the smallest limit.
 */
export const carouselRefusal = (error: unknown, slides: number): unknown => {
  if (!(error instanceof AgentPlatformError) || error.code !== "conflict") return error;
  if (!/allows at most \d+ images/.test(error.message)) return error;
  const limits = [...error.message.matchAll(/allows at most (\d+) images/g)].map((match) => Number(match[1]));
  const smallest = Math.min(...limits);
  return new AgentPlatformError({
    code: "conflict",
    message:
      `${error.message} The ${slides}-slide carousel does not fit every channel on this post: the smallest limit is ${smallest} images, ` +
      "counting what is already attached. Trim the deck with update_artifact, split it across two posts, remove a channel, or attach it as a PDF for LinkedIn.",
    retryable: false,
  });
};

export const attachArtifactToPostTool = shareFlowTool(["artifacts", "render", "media", "projects", "research"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "attach_artifact_to_post",
    label: "Put a document on a post",
    description:
      "Put an artifact on a post draft. A markdown or html document becomes a PDF by default — only LinkedIn posts a PDF, as a document post — or an image with as='image', which every channel takes. A mermaid or svg artifact always becomes an image (PNG). A react artifact cannot be attached — it only runs in the chat's preview. A slides artifact becomes a PDF, one slide per page (a LinkedIn document post), or with as='carousel' one image per slide attached in order (format 4:5 or 16:9), or with as='video' an MP4 of the deck playing — each slide held secondsPerSlide (1-8, default 3) with its transitions and animations, at most 20 slides and 60 seconds — for Reels, TikTok, Shorts and LinkedIn video. Each channel caps the images one post carries, counting what the draft already has — X 4, LinkedIn 9, Instagram and Facebook 10, Threads 20 — so a carousel must fit the smallest limit among the post's channels. A markdown or html document can take a template (one-pager, report, brief, checklist, campaign-plan), as generate_pdf does. A channel that cannot take the file refuses it with the reason; say which. Already attached when it answers — do not attach it again.",
    category: "artifacts",
    effect: "internal-write",
    inputSchema: attachArtifactSchema,
    delegatesTo: "ArtifactService.get",
    delegate: async (input: z.infer<typeof attachArtifactSchema>, context) => {
      const artifact = await services.artifacts.get(context, { id: asId<ArtifactId>(input.artifactId) });
      // #595: what goes on a post from a project chat follows the project's theme, like everything made there.
      const theme = await themeForChat(services.projects, context);
      const themed = theme === undefined ? {} : { theme };
      const read: ImageRead = (source) => services.research.readImage(context, { source });
      const logo = await chatLogo(services.projects, read, context);

      // #620: a deck as a video — its slides played with their transitions and build-ins, recorded as an MP4.
      if (artifact.kind === "slides" && input.as === "video") {
        const slideCount = parseSlides(artifact.content).slides.length;
        if (slideCount > SLIDE_VIDEO_MAX_SLIDES) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `A video holds at most ${SLIDE_VIDEO_MAX_SLIDES} slides and this deck has ${slideCount}. Shorten it with update_artifact, or attach it as a PDF.`,
            retryable: false,
          });
        }
        if (services.render.renderSlidesVideo === undefined) {
          throw new AgentPlatformError({ code: "provider_unavailable", message: "Slides cannot be turned into a video on this deployment.", retryable: false });
        }
        const { images: inlined, skipped } = await deckImages(read, artifact.content);
        const deck = await buildDeck(artifact.content, artifact.title, theme, input.format, inlined, logo, "play");
        const video = await services.render.renderSlidesVideo(context, {
          html: deck.html,
          width: deck.width,
          height: deck.height,
          transitions: deck.transitions,
          ...(input.secondsPerSlide === undefined ? {} : { secondsPerSlide: input.secondsPerSlide }),
        });
        const stored = await services.media.storeAsset(context, { contentType: video.mime, bytes: video.bytes });
        const attached = await services.media.attachPathsToDraft(context, { draftId: input.postDraftId, paths: [stored.reference.replace(/^chorus-media:/, "")] });
        return {
          attached: true,
          as: "video",
          postDraftId: attached.draftId,
          reference: stored.reference,
          slides: deck.count,
          format: deck.format,
          seconds: Math.round(video.durationMs / 100) / 10,
          secondsPerSlide: video.secondsPerSlide,
          note:
            `Attached as an MP4 video, ${deck.count} slides at ${video.secondsPerSlide}s each with their animations.` +
            (video.shortened ? ` Each slide was shortened to fit the ${SLIDE_VIDEO_MAX_SECONDS}-second limit.` : ""),
          ...(skipped.length === 0 ? {} : { skippedImages: skipped }),
        };
      }
      if (input.as === "video") {
        throw new AgentPlatformError({ code: "invalid_input", message: "Only a slides artifact can become a video. Attach this one as a PDF or an image.", retryable: false });
      }

      // #607: a deck — a PDF of its slides, or its slides as a carousel of images.
      if (artifact.kind === "slides") {
        const as = input.as === "carousel" || input.as === "image" ? "carousel" : "pdf";
        const slideCount = parseSlides(artifact.content).slides.length;
        if (as === "carousel" && slideCount > CAROUSEL_MAX_SLIDES) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: `A carousel holds at most ${CAROUSEL_MAX_SLIDES} slides and this deck has ${slideCount}. Shorten it with update_artifact, or attach it as a PDF.`,
            retryable: false,
          });
        }
        const { images: inlined, skipped } = await deckImages(read, artifact.content);
        const deck = await buildDeck(artifact.content, artifact.title, theme, input.format, inlined, logo);
        let files: { readonly bytes: Uint8Array; readonly mime: string }[];
        if (as === "pdf") {
          files = [await services.render.renderDocument(context, { html: deck.html, page: { width: deck.width, height: deck.height } })];
        } else {
          if (services.render.renderSlideImages === undefined) {
            throw new AgentPlatformError({ code: "provider_unavailable", message: "Slides cannot be turned into images on this deployment.", retryable: false });
          }
          files = [...(await services.render.renderSlideImages(context, { html: deck.html, width: deck.width, height: deck.height }))];
        }
        // Stored one at a time, then attached in ONE call: the channel check sees the whole set, in order.
        const references: string[] = [];
        for (const file of files) references.push((await services.media.storeAsset(context, { contentType: file.mime, bytes: file.bytes })).reference);
        /*
         * #611: the channel check counts the draft's existing media plus these, per channel — X takes 4
         * images, LinkedIn 9, Instagram 10 — and names each channel's limit. A carousel refused that way
         * is told how to fit the smallest of them, not just that it does not fit.
         */
        const attached = await services.media
          .attachPathsToDraft(context, {
            draftId: input.postDraftId,
            paths: references.map((reference) => reference.replace(/^chorus-media:/, "")),
          })
          .catch((error: unknown) => {
            throw as === "carousel" ? carouselRefusal(error, references.length) : error;
          });
        return {
          attached: true,
          as,
          postDraftId: attached.draftId,
          ...(as === "pdf" ? { reference: references[0] } : { references }),
          slides: deck.count,
          format: deck.format,
          note:
            as === "pdf"
              ? "Attached as a PDF, one slide per page — it publishes on LinkedIn only; other channels need the carousel."
              : `Attached as a carousel of ${references.length} images, in slide order.`,
          ...(skipped.length === 0 ? {} : { skippedImages: skipped }),
        };
      }

      if (artifact.kind === "react") throw reactNotPrintable(input.as === "pdf" || input.as === undefined ? "a PDF" : "an image");
      // #607: a drawing — mermaid or SVG — always goes on as an image.
      const drawing = artifact.kind === "mermaid" || artifact.kind === "svg";
      const as = drawing ? "image" : input.as === "carousel" ? "image" : (input.as ?? "pdf");
      let rendered: { readonly bytes: Uint8Array; readonly mime: string };
      if (artifact.kind === "mermaid") {
        rendered = await services.render.renderDiagram(context, { source: artifact.content, ...themed });
      } else if (artifact.kind === "svg") {
        if (services.render.renderHtmlImage === undefined) {
          throw new AgentPlatformError({ code: "provider_unavailable", message: "Drawings cannot be turned into images on this deployment.", retryable: false });
        }
        rendered = await services.render.renderHtmlImage(context, { html: svgPage(cleanSvg(artifact.content)), ...themed });
      } else {
        // The title only when the document does not already open with it — rendered, it read twice.
        const opensWithTitle = /^\s*#\s/.test(artifact.content) || /^\s*<h1[\s>]/i.test(artifact.content);
        const named = await documentImages(read, artifact.kind, artifact.content);
        const template = input.template ?? (artifact.kind === "markdown" ? documentTemplateDirective(artifact.content) : undefined);
        const html = await buildDocumentHtml({
          kind: artifact.kind,
          source: artifact.content,
          ...(opensWithTitle ? {} : { title: artifact.title }),
          ...themed,
          ...(template === undefined ? {} : { template }),
          ...(logo === undefined ? {} : { logo }),
          ...(Object.keys(named.images).length === 0 ? {} : { inlineImages: named.images }),
        });
        if (as === "pdf") {
          rendered = await services.render.renderDocument(context, { html });
        } else {
          if (services.render.renderHtmlImage === undefined) {
            throw new AgentPlatformError({ code: "provider_unavailable", message: "Documents cannot be turned into images on this deployment.", retryable: false });
          }
          rendered = await services.render.renderHtmlImage(context, { html, ...themed });
        }
      }
      const stored = await services.media.storeAsset(context, { contentType: rendered.mime, bytes: rendered.bytes });
      const attached = await services.media.attachPathsToDraft(context, {
        draftId: input.postDraftId,
        paths: [stored.reference.replace(/^chorus-media:/, "")],
      });
      return {
        attached: true,
        as,
        postDraftId: attached.draftId,
        reference: stored.reference,
        note: as === "pdf" ? "Attached as a PDF — it publishes on LinkedIn only; other channels need the image." : "Attached as an image.",
      };
    },
  }));

export const ARTIFACT_TOOL_NAMES = ["create_artifact", "update_artifact", "get_artifact", "generate_pdf", "attach_artifact_to_post"] as const;

/** In the order a conversation uses them: write one, read it back, revise it. */
export const ARTIFACT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  createArtifactTool,
  getArtifactTool,
  updateArtifactTool,
  // Last: a PDF is what a document becomes when somebody wants to keep it.
  generatePdfTool,
  // #589: and a post is where it goes when somebody wants to share it.
  attachArtifactToPostTool,
];
