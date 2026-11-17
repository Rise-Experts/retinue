/**
 * Stock photos and video (Pexels) — #615.
 *
 * Two steps, like `capture_website` then `describe_image`: **search** returns candidates and stores
 * nothing; **import** downloads the one picked into the workspace's media and returns a `chorus-media:`
 * reference — the same kind every renderer returns — so it goes straight into a slide
 * (`![alt](chorus-media:…)` or `<!-- background: chorus-media:… -->`), a document, a post, or a
 * generation's reference image.
 *
 * Search-and-pick is the whole surface on purpose: the licence forbids replicating the library, and each
 * request counts against a 200-an-hour limit, so there is no browse, no paging loop and no bulk import.
 *
 * ## Attribution travels with the file
 *
 * The storage route keeps bytes and no metadata, so the credit is returned by the import — photographer,
 * their page, the Pexels page and a ready credit line — and the descriptions tell the model to print it
 * under the picture. A search result carries the same fields, so candidates shown to a person are
 * credited too.
 */
import { z } from "zod";
import type { Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";

import {
  STOCK_MEDIA_KINDS,
  STOCK_MEDIA_ORIENTATIONS,
  STOCK_MEDIA_SIZES,
} from "../services/index.js";
import { stockMediaNotEnabled, pexelsCredit, PEXELS_DEFAULT_COUNT, PEXELS_MAX_COUNT } from "../adapters/web/pexels.js";
import { optionalIdString, plausibleDraftId, shareFlowTool, unattachedNote, type ShareFlowToolFactory } from "./factory.js";

const searchStockMediaSchema = z
  .object({
    query: z.string().trim().min(1).max(200).describe("What the picture should show, in plain words — e.g. \"barista pouring latte art\"."),
    kind: z.enum(STOCK_MEDIA_KINDS).default("photo"),
    orientation: z.enum(STOCK_MEDIA_ORIENTATIONS).optional().describe("landscape for slides and documents, portrait for stories/reels, square for feed posts."),
    count: z.number().int().min(1).max(PEXELS_MAX_COUNT).optional().describe(`How many candidates, default ${PEXELS_DEFAULT_COUNT}.`),
  })
  .strict();

export const searchStockMediaTool = shareFlowTool(["research"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "search_stock_media",
    label: "Search stock photos and video",
    description:
      "Search Pexels for free stock photos or videos. Returns candidates — id, size, a thumbnail URL, the photographer and the Pexels page — and stores nothing. Pick one and call import_stock_media with its id to put it in the workspace; one search per need, not a loop. When you show candidates, say they are provided by Pexels and name each photographer.",
    category: "media",
    effect: "read",
    inputSchema: searchStockMediaSchema,
    delegatesTo: "ResearchService.searchStockMedia",
    delegate: async (input: z.infer<typeof searchStockMediaSchema>, context) => {
      if (services.research.searchStockMedia === undefined) throw stockMediaNotEnabled();
      const found = await services.research.searchStockMedia(context, {
        query: input.query,
        kind: input.kind,
        ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
        count: input.count ?? PEXELS_DEFAULT_COUNT,
      });
      return {
        provider: found.provider,
        attribution: "Photos and videos provided by Pexels (https://www.pexels.com). Credit the photographer wherever one is used.",
        totalResults: found.totalResults,
        ...(found.rateLimitRemaining === undefined ? {} : { rateLimitRemaining: found.rateLimitRemaining }),
        results: found.items.map(({ id, ...item }) => ({ pexelsId: id, ...item, credit: pexelsCredit(item) })),
      };
    },
  }));

const importStockMediaSchema = z
  .object({
    pexelsId: z
      .union([z.number().int().positive(), z.string().trim().regex(/^\d{1,15}$/, "the numeric id from search_stock_media")])
      .describe("The pexelsId a search_stock_media result returned."),
    kind: z.enum(STOCK_MEDIA_KINDS).default("photo"),
    size: z
      .enum(STOCK_MEDIA_SIZES)
      .optional()
      .describe("Photo: large2x (default, ~1880 px), large (~940 px) or original. Video: hd (default, ≤1920 px) or sd (≤960 px)."),
    /** Attach straight to a draft, as the renderers do — a stored file has no asset id for attach_media_to_post. */
    postDraftId: optionalIdString,
  })
  .strict();

export const importStockMediaTool = shareFlowTool(["research", "media"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "import_stock_media",
    label: "Import a stock photo or video",
    description:
      "Download one Pexels photo or video (by the pexelsId search_stock_media returned) into the workspace's media. Returns a chorus-media: reference: put it in a slide (![alt](chorus-media:…) or <!-- background: chorus-media:… -->), a document or PDF, or generate_media's referencePaths (the reference without its chorus-media: prefix); with postDraftId it is attached to that draft. Also returns the credit — print it small under the picture (\"Photo by … on Pexels\"). To write a post or document from an imported photo, call describe_image with source {kind:'asset', assetId: the reference}. Import only what you will use.",
    category: "media",
    /** Stores a file in the workspace and nothing leaves it — the same line `capture_website` sits on. */
    effect: "internal-write",
    inputSchema: importStockMediaSchema,
    delegatesTo: "ResearchService.fetchStockMedia",
    delegate: async (input: z.infer<typeof importStockMediaSchema>, context) => {
      if (services.research.fetchStockMedia === undefined) throw stockMediaNotEnabled();
      const downloaded = await services.research.fetchStockMedia(context, {
        id: String(input.pexelsId),
        kind: input.kind,
        ...(input.size === undefined ? {} : { size: input.size }),
      });
      const stored = await services.media.storeAsset(context, { contentType: downloaded.mime, bytes: downloaded.bytes });
      const path = stored.reference.replace(/^chorus-media:/, "");
      const attached =
        input.postDraftId === undefined || !plausibleDraftId(input.postDraftId)
          ? null
          : await services.media
              .attachPathsToDraft(context, { draftId: input.postDraftId, paths: [path] })
              /*
               * The file is already stored; a bad draft id must not throw it away. Production, 2026-09-29: building
               * a deck, the model passed the deck's artifact id as postDraftId, and three imports that had saved
               * their photos all reported failure. Unattached, the reference still goes into the deck.
               */
              .catch(() => null);
      const item = downloaded.item;
      return {
        reference: stored.reference,
        kind: item.kind,
        contentType: downloaded.mime,
        width: downloaded.width,
        height: downloaded.height,
        byteSize: stored.byteSize,
        ...(item.duration === undefined ? {} : { durationSeconds: item.duration }),
        ...(item.alt === undefined ? {} : { alt: item.alt }),
        credit: {
          text: pexelsCredit(item),
          photographer: item.photographer,
          photographerUrl: item.photographerUrl,
          pageUrl: item.pageUrl,
          source: "Pexels",
        },
        ...(attached === null
          ? {
              attached: false,
              ...(input.postDraftId === undefined
                ? {}
                : { note: `${unattachedNote(input.postDraftId)} If it is a slide deck or document, put this reference in it instead (update_artifact).` }),
            }
          : { attached: true, postDraftId: attached.draftId, note: "Already attached to the draft — do not attach it again." }),
      };
    },
  }));

export const STOCK_MEDIA_TOOL_NAMES = ["search_stock_media", "import_stock_media"] as const;

export const STOCK_MEDIA_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [searchStockMediaTool, importStockMediaTool];
