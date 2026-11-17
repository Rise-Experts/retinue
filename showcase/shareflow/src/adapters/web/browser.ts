/**
 * The one Chromium in this package, and the policy around it.
 *
 * ## Why this file exists at all
 *
 * The old runtime's `core/browser.py` was written after an outage, and its header is the reason this one
 * looks the same: *"a headless Chromium is by far the largest thing this service runs. It OOM-killed the
 * FastAPI process in production — the kernel log read `chrome-headless invoked oom-killer / Killed
 * process (python)` — which severed the assistant's SSE stream mid-run, so the user saw no response at
 * all and nothing was logged anywhere."* Two callers each launched a browser and neither knew about the
 * other.
 *
 * So there is one slot, held for the whole browser lifetime rather than just the launch, because the
 * memory is occupied until it closes. Waiting a few seconds is strictly better than being OOM-killed,
 * which takes the whole process down rather than one request.
 *
 * ## What the old one let through, and what each defence here actually covers
 *
 * `capture.py` validated the URL it was given and handed it to `page.goto`. Two holes followed, and the
 * fix for each is different — which was only established by *measuring what Playwright intercepts*
 * rather than assuming:
 *
 * 1. **Subresources were unchecked.** A page could fetch a LAN address and the render would include it.
 *    `guardRequests` closes this: measured against a real Chromium, a page requesting two off-host
 *    subresources had both aborted by the route handler.
 * 2. **Navigation redirects were followed.** `page.route` does **not** see them — measured: a local page
 *    302ing to another host was followed, the navigation succeeded, and the guard saw only the first
 *    request. So a route handler alone does not close this, and a comment claiming it did would have
 *    been wrong in a file whose whole subject is refusal.
 *
 * The redirect hole takes two other defences. `assertNoRedirect` pre-flights the URL with
 * `redirect: "manual"` and refuses when it points elsewhere — which stops the request to the forbidden
 * address ever being made. And after navigation the **landed** URL is re-checked (`page.url()` reports
 * it, also measured), which catches a redirect the pre-flight could not see: a meta refresh, or
 * `location.href` from a script.
 *
 * **The residual limit, stated:** for a client-side redirect the request to the final address *has been
 * made* by the time the landed URL is checked. Nothing is returned or screenshotted, so a private page's
 * contents do not leak — but a bare GET has happened. Preventing that would mean not running a browser.
 */

import { AgentPlatformError } from "@retinue/agentkit";

/**
 * Launch flags, and each one earns its place.
 *
 * Transcribed from `CHROMIUM_ARGS` with its annotations, because the reasons are not guessable:
 * `--no-sandbox` because the container is already the isolation boundary; `--disable-dev-shm-usage`
 * because Docker's 64 MB `/dev/shm` is too small for Chromium and it crashes rather than degrading; the
 * rest trims what a one-shot render never needs.
 */
export const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--renderer-process-limit=1",
  "--disable-extensions",
  "--disable-background-networking",
  "--mute-audio",
  "--no-first-run",
] as const;

/** How long one render may take, including navigation. */
export const RENDER_TIMEOUT_MS = 30_000;
/** The viewport a capture is taken at. 1280×800 is the old runtime's, and it is what a page expects. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/**
 * How long to let late layout settle after `load`.
 *
 * The old capture slept a flat second, *"to let late layout settle without hanging on long-poll
 * connections"* — which is the trade-off: `networkidle` waits forever on a page holding a socket open.
 */
export const SETTLE_MS = 1_000;

/**
 * At most one browser at a time, process-wide.
 *
 * A promise chain rather than a counting semaphore, because the count is one and the queue has to be
 * fair: a `while (locked) await sleep()` loop lets whichever caller happens to wake first win, which
 * under load starves one of them indefinitely.
 */
let slot: Promise<unknown> = Promise.resolve();

export const withBrowserSlot = async <T>(run: () => Promise<T>): Promise<T> => {
  const mine = slot.then(run, run);
  // The chain must not reject, or every later caller inherits the rejection and no render succeeds again.
  slot = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
};

export type BrowserDeps = {
  /**
   * Playwright's `chromium`, injected.
   *
   * Injected rather than imported at module scope for two reasons that both matter: the tests drive this
   * with a fake, and a deployment whose image has no Chromium gets a **named refusal** instead of a
   * module that fails to load and takes the whole app with it.
   */
  readonly chromium?: {
    launch(options: { args: readonly string[] }): Promise<BrowserLike>;
  };
};

/** The slice of Playwright's API this package uses. Narrow on purpose: everything here is exercised. */
export type BrowserLike = {
  newPage(options?: {
    viewport?: { width: number; height: number };
    /** 2 for retina-sharp text in an exported image — the old renderer's own choice. */
    deviceScaleFactor?: number;
    /** #620: record the page as a WebM in `dir`, at `size` — the slide video. Saved when the page closes. */
    recordVideo?: { dir: string; size: { width: number; height: number } };
  }): Promise<PageLike>;
  close(): Promise<void>;
};

export type PageLike = {
  /** The URL the page actually landed on, which is not the one it was sent to if something redirected. */
  url(): string;
  route(pattern: string, handler: (route: RouteLike) => Promise<void> | void): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  /** Injects a local script file. The mermaid bundle, and nothing from the network. */
  addScriptTag(options: { path: string }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  /** Waits for an expression to become truthy in the page. Used to wait for *every* diagram's SVG. */
  waitForFunction(expression: string, options?: { timeout?: number }): Promise<unknown>;
  /**
   * `locator`, and the name was **measured**.
   *
   * This interface first declared `querySelector`, which Playwright does not have — its API is `$` or
   * `locator`. Nothing caught it: `PageLike` is a hand-written slice and the real `chromium` arrives
   * through a cast, so the compiler checks the fake and not the library. The first real render failed
   * with `page.querySelector is not a function`.
   *
   * The lesson is the file's own: a narrow interface over someone else's library is only as true as the
   * last time it was run against it.
   */
  locator(selector: string): ElementLike;
  screenshot(options?: { fullPage?: boolean; type?: string; omitBackground?: boolean }): Promise<Uint8Array>;
  pdf(options?: Record<string, unknown>): Promise<Uint8Array>;
  title(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  /**
   * #620: the page's recording, when it was opened with `recordVideo` — Playwright's `page.video()`, whose file
   * is complete once the page has closed. Optional so the hand-written fakes need not grow it.
   */
  video?(): { path(): Promise<string> } | null;
  close?(): Promise<void>;
};

/** One element, for a screenshot clipped to the drawing rather than the viewport. */
export type ElementLike = {
  count(): Promise<number>;
  screenshot(options?: { type?: string; omitBackground?: boolean }): Promise<Uint8Array>;
  boundingBox(): Promise<{ width: number; height: number } | null>;
  /** #607: the i-th match, for one screenshot per slide. Optional so the hand-written fakes need not grow it. */
  nth?(index: number): ElementLike;
};

export type RouteLike = {
  request(): { url(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
};

/** Playwright's own `chromium`, loaded lazily so a missing image dependency refuses by name. */
export const loadChromium = async (): Promise<NonNullable<BrowserDeps["chromium"]>> => {
  try {
    const { chromium } = await import("playwright");
    return chromium as unknown as NonNullable<BrowserDeps["chromium"]>;
  } catch (error) {
    throw new AgentPlatformError({
      code: "provider_unavailable",
      message:
        "This deployment has no browser, so pages and diagrams cannot be rendered: " +
        (error instanceof Error ? error.message : String(error)),
      retryable: false,
    });
  }
};

/**
 * Refuse every request the page makes to somewhere the egress policy forbids.
 *
 * This covers **subresources** — images, scripts, fetches — which is measured, not assumed. It does
 * **not** cover a navigation redirect: Playwright's route handler is not called for one. See the header
 * for what does.
 *
 * `about:`, `data:` and `blob:` pass untouched: they never leave the process, and a `setContent` page is
 * built from them. `file:` is refused, because it reads the container's disk.
 */
export const guardRequests = async (page: PageLike): Promise<void> => {
  const { validateHttpEgress } = await import("@retinue/agentkit/mcp");
  const { DEFAULT_EGRESS_POLICY } = await import("@retinue/agentkit/tools");
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^(about|data|blob|file):/i.test(url)) {
      // `file:` is refused rather than allowed — it reads the container's disk.
      if (/^file:/i.test(url)) return route.abort("blockedbyclient");
      return route.continue();
    }
    try {
      validateHttpEgress(DEFAULT_EGRESS_POLICY, url);
    } catch {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
};

/**
 * Refuse a URL that redirects, before a browser is started.
 *
 * The same decision the platform's HTTP client makes and for the same reason — *"following one lets a
 * permitted host bounce the request to a forbidden one: the policy checked the URL the model asked for,
 * and the request lands somewhere it never saw"* — applied here because Chromium follows navigation
 * redirects and cannot be told not to.
 *
 * A GET rather than a HEAD: plenty of servers answer HEAD differently or not at all, and a redirect is
 * visible in the status line before any body is read. The body is cancelled immediately.
 */
export const assertNoRedirect = async (
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal });
    // Nothing here reads the body; cancelling stops a large page downloading twice.
    await (response.body as ReadableStream<Uint8Array> | null)?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location") ?? "somewhere else";
      throw new AgentPlatformError({
        code: "forbidden",
        message:
          `That URL redirects to ${target}, and a redirect is not followed — the policy checked the URL ` +
          `you asked for. Ask for the target directly and it will be checked on its own merits.`,
        retryable: false,
      });
    }
  } catch (error) {
    if (error instanceof AgentPlatformError) throw error;
    /**
     * A pre-flight that could not run is **not** a refusal.
     *
     * Some servers reject an unadorned GET from a non-browser client, and failing the capture for that
     * would break a page a browser can load perfectly well. The landed-URL check after navigation is
     * what still holds in that case.
     */
    return;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Open a browser, run something with a page, close it — under the slot.
 *
 * `finally` closes the browser even when the body throws, because a leaked Chromium is the memory that
 * caused the outage this file exists for.
 */
export const withPage = async <T>(
  deps: BrowserDeps,
  run: (page: PageLike) => Promise<T>,
  options: {
    readonly viewport?: { width: number; height: number };
    readonly deviceScaleFactor?: number;
    /** #620: record the page — see `BrowserLike.newPage`. */
    readonly recordVideo?: { dir: string; size: { width: number; height: number } };
  } = {},
): Promise<T> => {
  const chromium = deps.chromium ?? (await loadChromium());
  return withBrowserSlot(async () => {
    const browser = await chromium.launch({ args: [...CHROMIUM_ARGS] });
    try {
      const page = await browser.newPage({
        viewport: options.viewport ?? { ...VIEWPORT },
        ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
        ...(options.recordVideo === undefined ? {} : { recordVideo: options.recordVideo }),
      });
      await guardRequests(page);
      return await run(page);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });
};
