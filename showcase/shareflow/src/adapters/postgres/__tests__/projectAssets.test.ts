import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import { createPostgresProjectService } from "../projects.js";

/** A project's files and links, for the assistant — #523. */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ASSET = "9b2d1a4e-1111-4222-8333-944455556666";
const context = { tenantId: WS, principalId: "u1", conversationId: "conv-1" } as unknown as ExecutionContext;

const sqlWith = (assets: Record<string, unknown>[], attachRow?: Record<string, unknown>) => ({
  async query<Row>(text: string): Promise<Row[]> {
    if (text.includes("from public.project_conversations")) return [{ id: "p1", name: "AI", instructions: "", defaults: {} }] as Row[];
    if (text.includes("select id, kind, label, url from public.project_assets")) return assets as Row[];
    if (text.includes("left join public.generated_assets")) return (attachRow === undefined ? [] : [attachRow]) as Row[];
    throw new Error(`unexpected query: ${text.slice(0, 50)}`);
  },
});

describe("list_project_assets' answer", () => {
  it("names files by id and label only, and links by their page", async () => {
    const service = createPostgresProjectService({
      sql: sqlWith([
        { id: "a1", kind: "image", label: "Logo", url: null },
        { id: "a2", kind: "link", label: "Brief", url: "https://example.com/brief" },
      ]) as never,
    });
    const assets = await service.listAssets(context);
    expect(assets).toEqual([
      { id: "a1", kind: "image", label: "Logo" },
      { id: "a2", kind: "link", label: "Brief", url: "https://example.com/brief" },
    ]);
    // No storage path or signed URL in anything the model sees.
    expect(JSON.stringify(assets)).not.toMatch(/storage|path|token=/i);
  });
});

describe("attach_project_asset", () => {
  it("attaches the project file's stored path through the media service's checks", async () => {
    const calls: unknown[] = [];
    const service = createPostgresProjectService({
      sql: sqlWith([], { kind: "image", storage_path: `${WS}/projects/logo.png`, asset_path: null }) as never,
      attachPaths: async (_c, input) => {
        calls.push(input);
        return { draftId: "d1" as never, mediaAssetIds: ["x"] as never };
      },
    });
    await expect(service.attachAsset(context, { postDraftId: "d1", projectAssetId: ASSET })).resolves.toEqual({ postDraftId: "d1", attached: 1 });
    expect(calls).toEqual([{ draftId: "d1", paths: [`${WS}/projects/logo.png`] }]);
  });

  it("uses a generated file's own path when the asset points at one", async () => {
    const calls: { paths: readonly string[] }[] = [];
    const service = createPostgresProjectService({
      sql: sqlWith([], { kind: "image", storage_path: null, asset_path: `${WS}/generated/j/1.png` }) as never,
      attachPaths: async (_c, input) => {
        calls.push(input);
        return { draftId: "d1" as never, mediaAssetIds: [] as never };
      },
    });
    await service.attachAsset(context, { postDraftId: "d1", projectAssetId: ASSET });
    expect(calls[0]!.paths).toEqual([`${WS}/generated/j/1.png`]);
  });

  it("refuses a link, a file from another project, and a conversation outside any project", async () => {
    const attachPaths = async () => ({ draftId: "d1" as never, mediaAssetIds: [] as never });
    const link = createPostgresProjectService({ sql: sqlWith([], { kind: "link", storage_path: null, asset_path: null }) as never, attachPaths });
    await expect(link.attachAsset(context, { postDraftId: "d1", projectAssetId: ASSET })).rejects.toThrow(/cannot be attached/);
    const other = createPostgresProjectService({ sql: sqlWith([]) as never, attachPaths });
    await expect(other.attachAsset(context, { postDraftId: "d1", projectAssetId: ASSET })).rejects.toThrow(/not in this conversation's project/);
    const outside = createPostgresProjectService({ sql: { async query() { return []; } } as never, attachPaths });
    await expect(outside.attachAsset(context, { postDraftId: "d1", projectAssetId: ASSET })).rejects.toThrow(/not in a project/);
  });
});
