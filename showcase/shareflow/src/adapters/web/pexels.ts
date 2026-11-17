/**
 * Pexels, the stock photo and video library — #615.
 *
 * Pure request builders and response mappers, tested against fixtures, plus one small client that sends
 * them. Downloads do not go through this client: the file URLs it picks are fetched by the guarded
 * reader (`fetchGuardedBytes`), which carries the egress policy, the redirect re-validation and the byte
 * cap — a second fetcher for files would be a second egress policy.
 *
 * ## The key
 *
 * `PEXELS_API_KEY`, read by the deployment from the environment and handed in. It is sent only in the
 * `Authorization` header (Pexels takes the bare key, no `Bearer`), and it is never part of a URL, an
 * error message or a result — a URL is logged, a message reaches the model, and a result is persisted
 * in the run event log.
 *
 * ## The licence's two asks, honoured by shape
 *
 * 1. **Attribution.** Every item carries the photographer, their page and the Pexels page; the import
 *    keeps them, and the tools tell the model to credit ("Photo by … on Pexels").
 * 2. **Rate limits** (200 requests/hour, 20,000/month by default). A search is one request with a small
 *    page; there is no fan-out. A 429 is reported as `rate_limited`, retryable, in words a person can act
 *    on, and a successful response's `X-Ratelimit-Remaining` is passed through.
 */
import { AgentPlatformError } from "@retinue/agentkit";

import type {
  StockMediaItem,
  StockMediaKind,
  StockMediaOrientation,
  StockMediaSearch,
  StockMediaSize,
} from "../../services/index.js";

export const PEXELS_API_ORIGIN = "https://api.pexels.com";
/** A search page is small on purpose: the model picks one or two, and each request counts against the hourly limit. */
export const PEXELS_DEFAULT_COUNT = 8;
export const PEXELS_MAX_COUNT = 15;
export const PEXELS_TIMEOUT_MS = 10_000;
/** Photos: the storage route's ceiling is 50 MB; an `original` beyond this is refused rather than stored. */
export const PEXELS_MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/**
 * Videos travel to the app as base64 in a JSON body (a third larger), so the ceiling sits well under the
 * bucket's 50 MB.
 */
export const PEXELS_MAX_VIDEO_BYTES = 30 * 1024 * 1024;
export const PEXELS_VIDEO_WIDTH = { hd: 1920, sd: 960 } as const;

/** The refusal when the deployment has no key. Names the variable and nothing else. */
export const stockMediaNotEnabled = (): AgentPlatformError =>
  new AgentPlatformError({
    code: "capability_unavailable",
    message: "Stock media is not enabled on this deployment — set PEXELS_API_KEY.",
    retryable: false,
  });

export type PexelsRequest = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

const headersFor = (apiKey: string): Record<string, string> => ({ authorization: apiKey, accept: "application/json" });

/** `GET /v1/search` for photos, `GET /videos/search` for videos. */
export const buildPexelsSearchRequest = (
  input: { readonly query: string; readonly kind: StockMediaKind; readonly orientation?: StockMediaOrientation; readonly count?: number },
  apiKey: string,
): PexelsRequest => {
  const query = input.query.trim();
  if (query === "") {
    throw new AgentPlatformError({ code: "invalid_input", message: "There is nothing to search for.", retryable: false });
  }
  const perPage = Math.min(Math.max(Math.trunc(input.count ?? PEXELS_DEFAULT_COUNT), 1), PEXELS_MAX_COUNT);
  const url = new URL(input.kind === "video" ? "/videos/search" : "/v1/search", PEXELS_API_ORIGIN);
  url.searchParams.set("query", query.slice(0, 200));
  url.searchParams.set("per_page", String(perPage));
  if (input.orientation !== undefined) url.searchParams.set("orientation", input.orientation);
  return { url: url.toString(), headers: headersFor(apiKey) };
};

/** `GET /v1/photos/:id` or `GET /videos/videos/:id` — the import re-reads the item rather than trusting a URL from the model. */
export const buildPexelsGetRequest = (input: { readonly id: string; readonly kind: StockMediaKind }, apiKey: string): PexelsRequest => {
  const id = String(input.id).trim();
  if (!/^\d{1,15}$/.test(id)) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "pexelsId must be the numeric id a search_stock_media result returned.",
      retryable: false,
    });
  }
  const path = input.kind === "video" ? `/videos/videos/${id}` : `/v1/photos/${id}`;
  return { url: new URL(path, PEXELS_API_ORIGIN).toString(), headers: headersFor(apiKey) };
};

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Only the library's own https hosts. A mapped URL is shown to a person and a picked one is downloaded, so
 * anything else in a response — however it got there — is dropped rather than passed on.
 */
export const isPexelsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "pexels.com" || host.endsWith(".pexels.com"));
  } catch {
    return false;
  }
};

const pexelsUrl = (value: unknown): string => {
  const text = str(value);
  return isPexelsUrl(text) ? text : "";
};

/** One photo from `/v1/search` or `/v1/photos/:id`. `undefined` when the response is not a usable photo. */
export const mapPexelsPhoto = (raw: unknown): StockMediaItem | undefined => {
  const photo = obj(raw);
  const src = obj(photo["src"]);
  const id = photo["id"];
  const thumbnailUrl = pexelsUrl(src["medium"]) || pexelsUrl(src["small"]) || pexelsUrl(src["tiny"]);
  const previewUrl = pexelsUrl(src["large"]) || thumbnailUrl;
  if ((typeof id !== "number" && typeof id !== "string") || thumbnailUrl === "") return undefined;
  const avgColor = str(photo["avg_color"]);
  const alt = str(photo["alt"]).trim();
  return {
    id: String(id),
    kind: "photo",
    width: num(photo["width"]),
    height: num(photo["height"]),
    thumbnailUrl,
    previewUrl,
    photographer: str(photo["photographer"]).trim() || "Unknown photographer",
    photographerUrl: pexelsUrl(photo["photographer_url"]),
    pageUrl: pexelsUrl(photo["url"]),
    ...(/^#[0-9a-f]{6}$/i.test(avgColor) ? { avgColor } : {}),
    ...(alt === "" ? {} : { alt: alt.slice(0, 200) }),
  };
};

/** One video from `/videos/search` or `/videos/videos/:id`. */
export const mapPexelsVideo = (raw: unknown): StockMediaItem | undefined => {
  const video = obj(raw);
  const user = obj(video["user"]);
  const id = video["id"];
  const pictures = Array.isArray(video["video_pictures"]) ? (video["video_pictures"] as unknown[]) : [];
  const thumbnailUrl = pexelsUrl(video["image"]) || pexelsUrl(obj(pictures[0])["picture"]);
  if ((typeof id !== "number" && typeof id !== "string") || thumbnailUrl === "") return undefined;
  const preview = pickPexelsVideoFile(raw, "sd");
  return {
    id: String(id),
    kind: "video",
    width: num(video["width"]),
    height: num(video["height"]),
    thumbnailUrl,
    previewUrl: preview?.url ?? thumbnailUrl,
    photographer: str(user["name"]).trim() || "Unknown creator",
    photographerUrl: pexelsUrl(user["url"]),
    pageUrl: pexelsUrl(video["url"]),
    duration: num(video["duration"]),
  };
};

export const mapPexelsSearch = (kind: StockMediaKind, raw: unknown, rateLimitRemaining?: number): StockMediaSearch => {
  const body = obj(raw);
  const list = Array.isArray(body[kind === "video" ? "videos" : "photos"]) ? (body[kind === "video" ? "videos" : "photos"] as unknown[]) : [];
  const map = kind === "video" ? mapPexelsVideo : mapPexelsPhoto;
  const items = list.map(map).filter((item): item is StockMediaItem => item !== undefined);
  return {
    provider: "Pexels",
    items,
    totalResults: num(body["total_results"]) || items.length,
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
  };
};

/**
 * Which photo file to download. `large2x` by default (about 1880 px wide — sharp on a slide, light for a
 * post); `original` when asked, and the byte cap still applies at download.
 */
export const pickPexelsPhotoFile = (
  raw: unknown,
  size: StockMediaSize = "large2x",
): { readonly url: string; readonly width: number; readonly height: number } | undefined => {
  const photo = obj(raw);
  const src = obj(photo["src"]);
  const width = num(photo["width"]);
  const height = num(photo["height"]);
  const order = size === "original" ? ["original", "large2x", "large"] : size === "large" ? ["large", "large2x"] : ["large2x", "large", "original"];
  for (const key of order) {
    const url = pexelsUrl(src[key]);
    if (url === "") continue;
    // The resized variants are 940 px (large) and 1880 px (large2x) wide at most; the original is the photo.
    const cap = key === "large" ? 940 : key === "large2x" ? 1880 : width;
    const w = width > 0 ? Math.min(width, cap) : cap;
    const h = width > 0 && height > 0 ? Math.round((height * w) / width) : 0;
    return { url, width: w, height: h };
  }
  return undefined;
};

/**
 * Which video file to download: the largest mp4 whose longer side fits the size (`hd` 1920, `sd` 960),
 * skipping any the response says is over the byte cap. Falls back to the smallest mp4 when none fits.
 */
export const pickPexelsVideoFile = (
  raw: unknown,
  size: StockMediaSize = "hd",
  maxBytes: number = PEXELS_MAX_VIDEO_BYTES,
): { readonly url: string; readonly width: number; readonly height: number } | undefined => {
  const video = obj(raw);
  const limit = size === "sd" ? PEXELS_VIDEO_WIDTH.sd : PEXELS_VIDEO_WIDTH.hd;
  const files = (Array.isArray(video["video_files"]) ? (video["video_files"] as unknown[]) : [])
    .map(obj)
    .filter((file) => str(file["file_type"]).toLowerCase() === "video/mp4" && pexelsUrl(file["link"]) !== "")
    .filter((file) => num(file["size"]) === 0 || num(file["size"]) <= maxBytes)
    .map((file) => ({ url: pexelsUrl(file["link"]), width: num(file["width"]), height: num(file["height"]) }))
    .filter((file) => file.width > 0 && file.height > 0);
  if (files.length === 0) return undefined;
  const longer = (file: { width: number; height: number }) => Math.max(file.width, file.height);
  const fitting = files.filter((file) => longer(file) <= limit).sort((a, b) => longer(b) - longer(a));
  return fitting[0] ?? [...files].sort((a, b) => longer(a) - longer(b))[0];
};

/** The error for a non-2xx answer. Never includes the request (the key is in its header, not its URL, but a message is no place for either). */
export const pexelsErrorFor = (status: number): AgentPlatformError => {
  if (status === 429) {
    return new AgentPlatformError({
      code: "rate_limited",
      message: "Pexels rate limit reached — try again later (the free tier allows 200 requests an hour).",
      retryable: true,
    });
  }
  if (status === 401 || status === 403) {
    return new AgentPlatformError({
      code: "provider_unavailable",
      message: "Pexels refused this deployment's key — PEXELS_API_KEY is invalid or revoked.",
      retryable: false,
    });
  }
  if (status === 404) {
    return new AgentPlatformError({ code: "not_found", message: "Pexels has no item with that id.", retryable: false });
  }
  return new AgentPlatformError({ code: "provider_error", message: `Pexels answered ${status}.`, retryable: status >= 500 });
};

export const rateLimitRemainingFrom = (headers: { get(name: string): string | null }): number | undefined => {
  const value = headers.get("x-ratelimit-remaining");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
};

export type PexelsClient = {
  search(input: {
    readonly query: string;
    readonly kind: StockMediaKind;
    readonly orientation?: StockMediaOrientation;
    readonly count?: number;
  }): Promise<StockMediaSearch>;
  /** The raw item, so the caller can both map it and pick its file. */
  get(input: { readonly id: string; readonly kind: StockMediaKind }): Promise<unknown>;
};

export const createPexelsClient = (config: {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): PexelsClient => {
  const send = async (request: PexelsRequest): Promise<{ body: unknown; remaining?: number }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? PEXELS_TIMEOUT_MS);
    let response: Response;
    try {
      /*
       * The URL is built here from a fixed https origin — never from model input — so this is not the SSRF
       * surface the guarded reader exists for. Redirects are refused all the same: the API does not use
       * them, and following one would carry the Authorization header somewhere else.
       */
      response = await (config.fetchImpl ?? fetch)(request.url, {
        headers: request.headers,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new AgentPlatformError({
        code: aborted ? "timeout" : "provider_unavailable",
        message: aborted ? "Pexels did not answer in time." : "Pexels could not be reached.",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw pexelsErrorFor(response.status);
    const body: unknown = await response.json().catch(() => {
      throw new AgentPlatformError({ code: "provider_error", message: "Pexels sent a response that is not JSON.", retryable: true });
    });
    const remaining = rateLimitRemainingFrom(response.headers);
    return { body, ...(remaining === undefined ? {} : { remaining }) };
  };

  return {
    async search(input) {
      const { body, remaining } = await send(buildPexelsSearchRequest(input, config.apiKey));
      return mapPexelsSearch(input.kind, body, remaining);
    },
    async get(input) {
      return (await send(buildPexelsGetRequest(input, config.apiKey))).body;
    },
  };
};

/** The credit line the licence asks for, in the words Pexels suggests. */
export const pexelsCredit = (item: Pick<StockMediaItem, "kind" | "photographer">): string =>
  `${item.kind === "video" ? "Video" : "Photo"} by ${item.photographer} on Pexels`;

/** An MP4's `ftyp` box, checked so a non-video answer is never stored under `video/mp4`. */
export const looksLikeMp4 = (bytes: Uint8Array): boolean =>
  bytes.length > 11 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
