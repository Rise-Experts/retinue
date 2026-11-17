/**
 * #607: a slide deck names its images by `chorus-media:` reference — what the renderers return — so the
 * image reader takes one as well as an asset id. The tenant boundary is the workspace folder: a reference
 * outside it is refused before anything is signed, and a traversal is refused before the resolver is reached.
 */
import { describe, expect, it } from "vitest";

import { mediaBytesFrom } from "../deployment.js";
import { createWebResearchService } from "../../adapters/web/research.js";

const context = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "p" } as never;

describe("reading an image by chorus-media reference", () => {
  it("passes a reference to the resolver, and refuses a traversal before it", async () => {
    const seen: string[] = [];
    const research = createWebResearchService({
      search: (async () => ({ searched: false, reason: "not-configured" })) as never,
      fetchPage: (async () => ({ ok: false, url: "", reason: "not used" })) as never,
      readAssetBytes: async ({ assetId }) => {
        seen.push(assetId);
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mime: "image/png" };
      },
    });
    const ok = await research.readImage(context, { source: { kind: "asset", assetId: "chorus-media:11111111-1111-4111-8111-111111111111/a.png" as never } });
    expect(ok.mime).toBe("image/png");
    expect(seen).toEqual(["chorus-media:11111111-1111-4111-8111-111111111111/a.png"]);
    for (const bad of ["chorus-media:ws/../other/a.png", "chorus-media:", "other-workspace/secret.png"]) {
      await expect(research.readImage(context, { source: { kind: "asset", assetId: bad as never } }), bad).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(seen).toHaveLength(1);
  });

  it("signs a reference only inside the calling workspace's folder", async () => {
    const signed: string[] = [];
    const read = mediaBytesFrom({
      sql: {
        query: async () => {
          throw new Error("a reference is not looked up by id");
        },
      } as never,
      internal: {
        signMediaUrl: async ({ path }: { path: string }) => {
          signed.push(path);
          throw new Error("stop before the fetch");
        },
      } as never,
    });
    await expect(read({ context, assetId: "chorus-media:22222222-2222-4222-8222-222222222222/a.png" })).rejects.toMatchObject({ code: "not_found" });
    // An encoded or backslashed `..` inside the workspace's own prefix is refused before signing too.
    for (const sneaky of ["%2e%2e/2222/a.png", "..%2F2222/a.png", "x\\..\\2222/a.png"]) {
      await expect(read({ context, assetId: `chorus-media:11111111-1111-4111-8111-111111111111/${sneaky}` }), sneaky).rejects.toMatchObject({ code: "not_found" });
    }
    expect(signed).toEqual([]);
    await expect(read({ context, assetId: "chorus-media:11111111-1111-4111-8111-111111111111/a.png" })).rejects.toThrow("stop before the fetch");
    expect(signed).toEqual(["11111111-1111-4111-8111-111111111111/a.png"]);
  });
});
