/**
 * The stock media tools — #615. Stub services only: no request leaves the test, and no key exists here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";

import {
  createShareFlowToolProvider,
  importStockMediaTool,
  searchStockMediaTool,
  STOCK_MEDIA_TOOL_FACTORIES,
  STOCK_MEDIA_TOOL_NAMES,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type StockMediaItem,
} from "../../index.js";

const CONTEXT = { tenantId: asId<TenantId>("t1"), principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;

const ITEM: StockMediaItem = {
  id: "2014422",
  kind: "photo",
  width: 3024,
  height: 3024,
  thumbnailUrl: "https://images.pexels.com/photos/2014422/m.jpeg",
  previewUrl: "https://images.pexels.com/photos/2014422/l.jpeg",
  photographer: "Joey Farina",
  photographerUrl: "https://www.pexels.com/@joey",
  pageUrl: "https://www.pexels.com/photo/2014422/",
  alt: "Coffee on a table",
};

let calls: { method: string; args: unknown }[];
let idempotency: IdempotencyStore;
const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

const services = (enabled = true): ShareFlowServices =>
  ({
    research: enabled
      ? {
          async searchStockMedia(_c: ExecutionContext, args: unknown) {
            calls.push({ method: "searchStockMedia", args });
            return { provider: "Pexels", items: [ITEM], totalResults: 40, rateLimitRemaining: 198 };
          },
          async fetchStockMedia(_c: ExecutionContext, args: unknown) {
            calls.push({ method: "fetchStockMedia", args });
            return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), mime: "image/jpeg", width: 1880, height: 1880, item: ITEM };
          },
        }
      : {},
    media: {
      async storeAsset(_c: ExecutionContext, args: { contentType: string; bytes: Uint8Array }) {
        calls.push({ method: "storeAsset", args: { contentType: args.contentType, bytes: args.bytes.byteLength } });
        return { reference: "chorus-media:t1/generated/abc.jpg", contentType: args.contentType, byteSize: args.bytes.byteLength };
      },
      async attachPathsToDraft(_c: ExecutionContext, args: { draftId: string }) {
        calls.push({ method: "attachPathsToDraft", args });
        if (args.draftId !== "d-1") throw new Error(`No post draft ${args.draftId}.`);
        return { draftId: "d-1", mediaAssetIds: ["m-1"] };
      },
    },
  }) as unknown as ShareFlowServices;

const build = (factory: ShareFlowToolFactory, enabled = true): Tool => factory.build({ services: services(enabled), deps: { authorization: allowAll, idempotency } });
let counter = 0;
const run = (tool: Tool, input: unknown): Promise<ToolResult> => tool.execute({ context: CONTEXT, input, idempotencyKey: `k${(counter += 1)}` });
const dataOf = (result: ToolResult) => (result as { data: Record<string, unknown> }).data;

beforeEach(() => {
  calls = [];
  idempotency = createMemoryIdempotencyStore();
});

describe("search_stock_media", () => {
  it("returns candidates with the photographer, the Pexels page and a credit line, and stores nothing", async () => {
    const result = await run(build(searchStockMediaTool), { query: "latte art", orientation: "landscape" });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ method: "searchStockMedia", args: { query: "latte art", kind: "photo", orientation: "landscape", count: 8 } }]);
    const data = dataOf(result);
    expect(data).toMatchObject({ provider: "Pexels", totalResults: 40, rateLimitRemaining: 198 });
    expect(String(data["attribution"])).toMatch(/provided by Pexels/);
    expect(data["results"]).toEqual([
      {
        pexelsId: "2014422",
        kind: "photo",
        width: 3024,
        height: 3024,
        thumbnailUrl: ITEM.thumbnailUrl,
        previewUrl: ITEM.previewUrl,
        photographer: "Joey Farina",
        photographerUrl: ITEM.photographerUrl,
        pageUrl: ITEM.pageUrl,
        alt: "Coffee on a table",
        credit: "Photo by Joey Farina on Pexels",
      },
    ]);
  });

  it("refuses an unknown argument and a count past the page cap", async () => {
    expect((await run(build(searchStockMediaTool), { query: "x", page: 2 })).ok).toBe(false);
    expect((await run(build(searchStockMediaTool), { query: "x", count: 80 })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("says how to enable it on a deployment without a key", async () => {
    const result = await run(build(searchStockMediaTool, false), { query: "coffee" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("Stock media is not enabled on this deployment — set PEXELS_API_KEY.");
  });
});

describe("import_stock_media", () => {
  it("downloads, stores, and returns a reference with the credit — no bytes, no path", async () => {
    const result = await run(build(importStockMediaTool), { pexelsId: 2014422 });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["fetchStockMedia", "storeAsset"]);
    expect(calls[0]!.args).toEqual({ id: "2014422", kind: "photo" });
    const data = dataOf(result);
    expect(data).toMatchObject({
      reference: "chorus-media:t1/generated/abc.jpg",
      kind: "photo",
      contentType: "image/jpeg",
      width: 1880,
      height: 1880,
      attached: false,
      credit: { text: "Photo by Joey Farina on Pexels", photographer: "Joey Farina", pageUrl: ITEM.pageUrl, source: "Pexels" },
    });
    const serialised = JSON.stringify(data);
    for (const forbidden of ['"path"', '"storagePath"', '"signedUrl"', "base64"]) expect(serialised, forbidden).not.toContain(forbidden);
  });

  it("attaches to a draft when given one", async () => {
    const result = await run(build(importStockMediaTool), { pexelsId: "2014422", kind: "photo", size: "large", postDraftId: "d-1" });
    expect(calls.map((c) => c.method)).toEqual(["fetchStockMedia", "storeAsset", "attachPathsToDraft"]);
    expect(calls[2]!.args).toEqual({ draftId: "d-1", paths: ["t1/generated/abc.jpg"] });
    expect(dataOf(result)).toMatchObject({ attached: true, postDraftId: "d-1" });
  });

  // Production, 2026-09-29: the model passed a slide deck's artifact id as postDraftId; three stored photos all "failed".
  it("keeps the stored photo when the draft id is wrong, and says where to put it", async () => {
    const result = await run(build(importStockMediaTool), { pexelsId: "2014422", kind: "photo", postDraftId: "449f8d28-60be-4ea6-ad50-86a904d4f51a" });
    expect(result.ok).toBe(true);
    expect(dataOf(result)).toMatchObject({ reference: "chorus-media:t1/generated/abc.jpg", attached: false });
    expect(String(dataOf(result)["note"])).toContain("put this reference in it instead");
  });

  it("refuses an id that is not numeric, before anything is fetched", async () => {
    for (const pexelsId of ["../v1/search", "abc", -3]) {
      expect((await run(build(importStockMediaTool), { pexelsId })).ok, String(pexelsId)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("says how to enable it on a deployment without a key", async () => {
    const result = await run(build(importStockMediaTool, false), { pexelsId: 1 });
    expect(JSON.stringify(result)).toContain("set PEXELS_API_KEY");
  });
});

describe("the family", () => {
  it("is a read and a workspace write, neither needing approval", async () => {
    const provider = createShareFlowToolProvider({ services: services(), deps: { authorization: allowAll, idempotency }, factories: STOCK_MEDIA_TOOL_FACTORIES });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...STOCK_MEDIA_TOOL_NAMES]);
    expect(descriptors.map((d) => [d.name, d.effect, d.approvalPolicy, d.category])).toEqual([
      ["search_stock_media", "read", "never", "media"],
      ["import_stock_media", "internal-write", "never", "media"],
    ]);
  });
});
