/**
 * Pexels — #615. Request builders and mappers over fixtures shaped like the API's documented responses, the
 * client over a fake fetch, and the research service's download path. No real request is made, and the key
 * is a fake one: the real key lives only in the deployment's environment.
 */
import { describe, expect, it } from "vitest";
import { AgentPlatformError, asId, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";

import {
  buildPexelsGetRequest,
  buildPexelsSearchRequest,
  createPexelsClient,
  isPexelsUrl,
  looksLikeMp4,
  mapPexelsPhoto,
  mapPexelsSearch,
  mapPexelsVideo,
  pexelsCredit,
  pexelsErrorFor,
  pickPexelsPhotoFile,
  pickPexelsVideoFile,
  PEXELS_MAX_VIDEO_BYTES,
} from "../pexels.js";
import { createWebResearchService } from "../research.js";

const KEY = "test-key";
const CONTEXT = { tenantId: asId<TenantId>("t1"), principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;

const PHOTO = {
  id: 2014422,
  width: 3024,
  height: 3024,
  url: "https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/",
  photographer: "Joey Farina",
  photographer_url: "https://www.pexels.com/@joey",
  photographer_id: 680589,
  avg_color: "#978E82",
  src: {
    original: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg",
    large2x: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
    large: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
    medium: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350",
    small: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=130",
    tiny: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280",
  },
  liked: false,
  alt: "Brown Rocks During Golden Hour",
};

const VIDEO = {
  id: 2499611,
  width: 1080,
  height: 1920,
  url: "https://www.pexels.com/video/2499611/",
  image: "https://images.pexels.com/videos/2499611/free-video-2499611.jpg?fit=crop&w=1200&h=630&auto=compress&cs=tinysrgb",
  duration: 22,
  user: { id: 680589, name: "Joey Farina", url: "https://www.pexels.com/@joey" },
  video_files: [
    { id: 1, quality: "hd", file_type: "video/mp4", width: 1080, height: 1920, fps: 29.97, link: "https://videos.pexels.com/video-files/2499611/fullhd.mp4" },
    { id: 2, quality: "sd", file_type: "video/mp4", width: 540, height: 960, fps: 29.97, link: "https://videos.pexels.com/video-files/2499611/sd.mp4" },
    { id: 3, quality: "hd", file_type: "video/mp4", width: 720, height: 1280, fps: 29.97, link: "https://videos.pexels.com/video-files/2499611/hd.mp4" },
    { id: 4, quality: "uhd", file_type: "video/mp4", width: 2160, height: 3840, fps: 29.97, link: "https://videos.pexels.com/video-files/2499611/4k.mp4" },
    { id: 5, quality: null, file_type: "video/webm", width: 1080, height: 1920, link: "https://videos.pexels.com/video-files/2499611/x.webm" },
  ],
  video_pictures: [{ id: 1, picture: "https://images.pexels.com/videos/2499611/pictures/preview-0.jpg", nr: 0 }],
};

describe("request builders", () => {
  it("builds a photo search with a small page and the key only in the header", () => {
    const request = buildPexelsSearchRequest({ query: "  latte art ", kind: "photo", orientation: "landscape" }, KEY);
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.pexels.com/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "latte art", per_page: "8", orientation: "landscape" });
    expect(request.headers).toEqual({ authorization: KEY, accept: "application/json" });
    // Never in the URL, which is what gets logged.
    expect(request.url).not.toContain(KEY);
  });

  it("builds a video search and clamps the count", () => {
    const request = buildPexelsSearchRequest({ query: "coffee", kind: "video", count: 99 }, KEY);
    expect(request.url).toBe("https://api.pexels.com/videos/search?query=coffee&per_page=15");
    expect(buildPexelsSearchRequest({ query: "coffee", kind: "photo", count: 0 }, KEY).url).toContain("per_page=1");
  });

  it("refuses an empty query", () => {
    expect(() => buildPexelsSearchRequest({ query: "   ", kind: "photo" }, KEY)).toThrow(/nothing to search/);
  });

  it("gets one item by its numeric id and refuses anything else", () => {
    expect(buildPexelsGetRequest({ id: "2014422", kind: "photo" }, KEY).url).toBe("https://api.pexels.com/v1/photos/2014422");
    expect(buildPexelsGetRequest({ id: "2499611", kind: "video" }, KEY).url).toBe("https://api.pexels.com/videos/videos/2499611");
    for (const id of ["../v1/search", "1/../../x", "abc", "", "12345678901234567"]) {
      expect(() => buildPexelsGetRequest({ id, kind: "photo" }, KEY), id).toThrow(/numeric id/);
    }
  });
});

describe("mappers", () => {
  it("maps a photo to a candidate with everything attribution needs", () => {
    expect(mapPexelsPhoto(PHOTO)).toEqual({
      id: "2014422",
      kind: "photo",
      width: 3024,
      height: 3024,
      thumbnailUrl: PHOTO.src.medium,
      previewUrl: PHOTO.src.large,
      photographer: "Joey Farina",
      photographerUrl: "https://www.pexels.com/@joey",
      pageUrl: PHOTO.url,
      avgColor: "#978E82",
      alt: "Brown Rocks During Golden Hour",
    });
    expect(pexelsCredit({ kind: "photo", photographer: "Joey Farina" })).toBe("Photo by Joey Farina on Pexels");
  });

  it("maps a video, with its duration and an sd preview", () => {
    expect(mapPexelsVideo(VIDEO)).toMatchObject({
      id: "2499611",
      kind: "video",
      width: 1080,
      height: 1920,
      thumbnailUrl: VIDEO.image,
      previewUrl: "https://videos.pexels.com/video-files/2499611/sd.mp4",
      photographer: "Joey Farina",
      duration: 22,
    });
    expect(pexelsCredit({ kind: "video", photographer: "Joey Farina" })).toBe("Video by Joey Farina on Pexels");
  });

  it("drops a URL that is not a pexels.com https host rather than showing or downloading it", () => {
    expect(isPexelsUrl("https://images.pexels.com/x.jpg")).toBe(true);
    expect(isPexelsUrl("http://images.pexels.com/x.jpg")).toBe(false);
    expect(isPexelsUrl("https://pexels.com.evil.test/x.jpg")).toBe(false);
    expect(isPexelsUrl("https://evil.test/?pexels.com")).toBe(false);
    const planted = { ...PHOTO, photographer_url: "javascript:alert(1)", src: { ...PHOTO.src, medium: "https://evil.test/m.jpg", small: undefined, tiny: undefined } };
    expect(mapPexelsPhoto(planted)).toBeUndefined();
    expect(mapPexelsPhoto({ ...PHOTO, photographer_url: "https://evil.test/@joey" })?.photographerUrl).toBe("");
  });

  it("maps a search page, skipping unusable items and passing the remaining quota through", () => {
    const search = mapPexelsSearch("photo", { total_results: 1200, page: 1, per_page: 8, photos: [PHOTO, { id: 3 }, "junk"] }, 187);
    expect(search).toMatchObject({ provider: "Pexels", totalResults: 1200, rateLimitRemaining: 187 });
    expect(search.items.map((item) => item.id)).toEqual(["2014422"]);
    expect(mapPexelsSearch("video", { videos: [VIDEO] }).items[0]?.kind).toBe("video");
    expect(mapPexelsSearch("photo", null)).toEqual({ provider: "Pexels", items: [], totalResults: 0 });
  });
});

describe("choosing the file to download", () => {
  it("takes large2x for a photo by default, and original or large when asked", () => {
    expect(pickPexelsPhotoFile(PHOTO)).toEqual({ url: PHOTO.src.large2x, width: 1880, height: 1880 });
    expect(pickPexelsPhotoFile(PHOTO, "large")).toEqual({ url: PHOTO.src.large, width: 940, height: 940 });
    expect(pickPexelsPhotoFile(PHOTO, "original")).toEqual({ url: PHOTO.src.original, width: 3024, height: 3024 });
  });

  it("takes the largest mp4 whose longer side fits 1920 for hd, 960 for sd — never the 4k or the webm", () => {
    expect(pickPexelsVideoFile(VIDEO)?.url).toBe("https://videos.pexels.com/video-files/2499611/fullhd.mp4");
    expect(pickPexelsVideoFile(VIDEO, "sd")?.url).toBe("https://videos.pexels.com/video-files/2499611/sd.mp4");
  });

  it("skips a file the response says is over the byte cap, and falls back to the smallest when none fits", () => {
    const heavy = { ...VIDEO, video_files: VIDEO.video_files.map((file) => (file.id === 1 ? { ...file, size: PEXELS_MAX_VIDEO_BYTES + 1 } : file)) };
    expect(pickPexelsVideoFile(heavy)?.url).toBe("https://videos.pexels.com/video-files/2499611/hd.mp4");
    const onlyBig = { ...VIDEO, video_files: [VIDEO.video_files[3]] };
    expect(pickPexelsVideoFile(onlyBig)?.url).toBe("https://videos.pexels.com/video-files/2499611/4k.mp4");
    expect(pickPexelsVideoFile({ video_files: [] })).toBeUndefined();
  });
});

describe("errors", () => {
  it("says a 429 is the rate limit, retryable, in words a person can act on", () => {
    const error = pexelsErrorFor(429);
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(error.message).toMatch(/Pexels rate limit reached — try again later/);
  });

  it("names a refused key without repeating it", () => {
    expect(pexelsErrorFor(401).message).toMatch(/PEXELS_API_KEY is invalid/);
    expect(pexelsErrorFor(404)).toMatchObject({ code: "not_found" });
    expect(pexelsErrorFor(503)).toMatchObject({ code: "provider_error", retryable: true });
  });
});

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

describe("the client", () => {
  it("sends the key in the Authorization header, refuses redirects, and reads the remaining quota", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createPexelsClient({
      apiKey: KEY,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse({ total_results: 1, photos: [PHOTO] }, { headers: { "X-Ratelimit-Remaining": "199", "X-Ratelimit-Limit": "200" } });
      }) as unknown as typeof fetch,
    });
    const found = await client.search({ query: "rocks", kind: "photo" });
    expect(found.rateLimitRemaining).toBe(199);
    expect(found.items).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(KEY);
    expect(seen[0]!.init.redirect).toBe("error");
  });

  it("turns a 429 into the rate-limit error and never puts the key in a message", async () => {
    const client = createPexelsClient({ apiKey: KEY, fetchImpl: (async () => jsonResponse({ error: "slow down" }, { status: 429 })) as unknown as typeof fetch });
    const error = await client.search({ query: "rocks", kind: "photo" }).catch((e: unknown) => e as AgentPlatformError);
    expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("reports an unreachable API without the request in the message", async () => {
    const client = createPexelsClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        throw new Error(`connect ECONNREFUSED with ${KEY}`);
      }) as unknown as typeof fetch,
    });
    const error = (await client.get({ id: "1", kind: "photo" }).catch((e: unknown) => e)) as AgentPlatformError;
    expect(error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(error.message).not.toContain(KEY);
  });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0]);

const research = (downloads: Record<string, Uint8Array>, item: unknown) => {
  const fetched: string[] = [];
  const service = createWebResearchService({
    search: async () => ({ searched: true, query: "", hits: [] }),
    fetchPage: async () => ({ ok: false, reason: "unused" }) as never,
    stockMedia: {
      async search() {
        throw new Error("unused");
      },
      async get() {
        return item;
      },
    },
    fetchImpl: (async (url: string) => {
      fetched.push(url);
      const bytes = downloads[url];
      return bytes === undefined ? new Response("nope", { status: 404 }) : new Response(bytes as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { service, fetched };
};

describe("the research service's stock download", () => {
  it("downloads the picked photo through the guarded reader and sniffs its type", async () => {
    const { service, fetched } = research({ [PHOTO.src.large2x]: JPEG }, PHOTO);
    const got = await service.fetchStockMedia!(CONTEXT, { id: "2014422", kind: "photo" });
    expect(fetched).toEqual([PHOTO.src.large2x]);
    expect(got).toMatchObject({ mime: "image/jpeg", width: 1880, height: 1880, item: { photographer: "Joey Farina" } });
    expect(got.bytes).toEqual(JPEG);
  });

  it("downloads the hd mp4 and refuses bytes that are not an mp4", async () => {
    const hd = "https://videos.pexels.com/video-files/2499611/fullhd.mp4";
    const ok = research({ [hd]: MP4 }, VIDEO);
    expect(await ok.service.fetchStockMedia!(CONTEXT, { id: "2499611", kind: "video" })).toMatchObject({ mime: "video/mp4", width: 1080, height: 1920 });
    const bad = research({ [hd]: JPEG }, VIDEO);
    await expect(bad.service.fetchStockMedia!(CONTEXT, { id: "2499611", kind: "video" })).rejects.toThrow(/not an MP4/);
    expect(looksLikeMp4(MP4)).toBe(true);
  });

  it("refuses by name when the deployment has no key", async () => {
    const service = createWebResearchService({ search: async () => ({ searched: true, query: "", hits: [] }), fetchPage: async () => ({}) as never });
    await expect(service.searchStockMedia!(CONTEXT, { query: "x", kind: "photo", count: 3 })).rejects.toThrow(
      "Stock media is not enabled on this deployment — set PEXELS_API_KEY.",
    );
    await expect(service.fetchStockMedia!(CONTEXT, { id: "1", kind: "photo" })).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});
