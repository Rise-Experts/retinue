/**
 * `RenderService` — the three capabilities that need a browser.
 *
 * A twelfth service rather than three methods spread across existing ports, because all three share one
 * dependency and one operational constraint: Chromium, and the single slot it runs in. Splitting them
 * would put that constraint in three places, and the whole reason `browser.ts` exists is that the old
 * runtime had it in two.
 *
 * ## None of them stores anything
 *
 * Each returns bytes. Storing is the caller's, through `MediaService.storeAsset`, for the same reason
 * the reader takes bytes rather than a path: this package holds no storage credential, and the hop is
 * `app/internal.ts`.
 */

import { buildCodeSnippetHtml, codeSnippetProblem } from "./code-snippet.js";
import { AgentPlatformError } from "@retinue/agentkit";

import type { RenderService } from "../../services/index.js";
import {
  DEFAULT_DIAGRAM_WIDTH,
  MAX_DIAGRAM_WIDTH,
  MERMAID_RUN,
  MIN_DIAGRAM_WIDTH,
  buildDiagramHtml,
  repairMermaidLabels,
} from "./diagram.js";
import { FULL_BLEED_MARKER, RENDER_DIAGRAMS_JS, documentHasDiagrams, pageCountOf } from "./document.js";
import { TEMPLATE_MARKER } from "./document-templates.js";
import { A4_LANDSCAPE_WIDTH_PX, A4_PRINTABLE_WIDTH_PX, A4_WIDTH_PX, LAYOUT_FACTS_JS, type LayoutFacts, layoutFactsOf, pageSizeOf } from "./render-facts.js";
import { RENDER_TIMEOUT_MS, SETTLE_MS, VIEWPORT, assertNoRedirect, type BrowserDeps, type PageLike, withPage } from "./browser.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mp4Args, runFfmpeg, slideVideoPlan, type RunFfmpeg } from "./slide-video.js";

/** The most page text `readPageText` returns — the toolkit fetcher's own body ceiling (200 KB), in characters. */
export const MAX_PAGE_TEXT_CHARS = 200_000;

/** Run in the page: the main content's visible text. */
export const PAGE_TEXT_JS =
  "(() => { const root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') || document.body; return root ? root.innerText || '' : ''; })()";

export type RenderDeps = BrowserDeps & {
  /**
   * Where the mermaid bundle is. **Absent means `renderDiagram` refuses**, which is what the old runtime
   * did too: *"Diagram rendering is not available on this deployment."*
   *
   * A path rather than a module, because the file is *injected into the page* and never imported by
   * Node — see `diagram.ts` for why it is a devDependency the image copies one file out of.
   */
  readonly mermaidBundlePath?: string;
  /** Overridable for tests, since a settle delay in a unit test is a second of nothing. */
  readonly settleMs?: number;
  /** Overridable for tests. Used only by the redirect pre-flight; the browser does its own fetching. */
  readonly fetchImpl?: typeof fetch;
  /** #620: ffmpeg, overridable for tests — the slide video's WebM to MP4. */
  readonly runFfmpeg?: RunFfmpeg;
};

export const createBrowserRenderService = (deps: RenderDeps): RenderService => {
  const settleMs = deps.settleMs ?? SETTLE_MS;

  /**
   * Open a URL in the browser under every guard `captureWebsite` has — the egress check before launch, the
   * redirect pre-flight, the per-request guard inside `withPage`, and the landed-URL re-check — then hand the
   * page to `capture`. Shared since #621, so `readPageText` cannot grow a weaker copy of the guards.
   */
  const openGuarded = async <T>(url: string, capture: (page: PageLike, landed: string) => Promise<T>): Promise<T> => {
    /**
     * The URL is validated **before** the browser starts, as well as per-request inside it.
     *
     * Not redundant: refusing here costs nothing and gives a precise message, while the per-request
     * guard can only abort a load and produce "the page could not be loaded". A user who pasted a
     * localhost URL should be told that, not told the page is broken.
     */
    const { validateHttpEgress } = await import("@retinue/agentkit/mcp");
    const { DEFAULT_EGRESS_POLICY } = await import("@retinue/agentkit/tools");
    try {
      validateHttpEgress(DEFAULT_EGRESS_POLICY, url);
    } catch (error) {
      throw new AgentPlatformError({
        code: "forbidden",
        message: `That URL cannot be captured: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      });
    }

    /**
     * Pre-flight, so a server-side redirect never becomes a request to the forbidden address.
     *
     * Playwright's route handler does not see navigation redirects — measured — so this is what
     * closes that hole, and the landed-URL check below is what catches the client-side kind.
     */
    await assertNoRedirect(url, deps.fetchImpl ?? fetch);

    return withPage(
      deps,
      async (page) => {
        try {
          await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
        } catch (error) {
          /**
           * A navigation failure is not distinguishable from a blocked redirect here, and the message
           * says so rather than guessing. The per-request guard aborts with `blockedbyclient`, which
           * Playwright reports as a navigation error like any other.
           */
          throw new AgentPlatformError({
            code: "provider_unavailable",
            message:
              `That page could not be loaded: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. ` +
              `A page that redirects into a private network is refused rather than captured.`,
            retryable: true,
          });
        }

        /**
         * Where the page **actually is**, re-checked before anything is captured.
         *
         * A meta refresh or a `location.href` from a script moves the page after `load`, and neither
         * the pre-flight nor the route guard sees it. `page.url()` reports the landed URL — measured
         * against a real redirect — so a page that walked into a private range is refused here rather
         * than screenshotted.
         */
        const landed = page.url();
        if (landed !== "" && landed !== url) {
          try {
            validateHttpEgress(DEFAULT_EGRESS_POLICY, landed);
          } catch {
            throw new AgentPlatformError({
              code: "forbidden",
              message:
                `That page moved to ${landed}, which cannot be captured. Nothing was captured — ask for ` +
                `a URL that stays where it points.`,
              retryable: false,
            });
          }
        }

        // Late layout, without waiting on a page that holds a socket open — see SETTLE_MS.
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

        return capture(page, landed === "" ? url : landed);
      },
      { viewport: { ...VIEWPORT } },
    );
  };


  return {
    async renderDocument(_context, input) {
      const wantsDiagrams = documentHasDiagrams(input.html);
      if (wantsDiagrams && deps.mermaidBundlePath === undefined) {
        /**
         * **Refused rather than degraded**, and the old renderer's reason is exact: *"printing the
         * diagram's raw source into the document is the exact bug this path exists to fix, and a
         * silently ugly PDF is worse than a clear error — the bundle is baked into the image, so its
         * absence is a deployment fault, not a user one."*
         */
        throw new AgentPlatformError({
          code: "provider_unavailable",
          message: "Diagram rendering is not available on this deployment.",
          retryable: false,
        });
      }
      const bundlePath = deps.mermaidBundlePath;

      return withPage(deps, async (page) => {
        /**
         * `setContent`, not a navigation.
         *
         * *"Keeps this entirely offline: no navigation, so no SSRF surface from the HTML itself."* The
         * old pipeline's one exception was remote `<img>` srcs; here even those are inlined as `data:`
         * URLs by the caller, so the page makes no request at all — and `guardRequests` would refuse
         * one anyway.
         */
        await page.setContent(input.html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });

        if (wantsDiagrams && bundlePath !== undefined) {
          await page.addScriptTag({ path: bundlePath });
          const outcome = await page.evaluate<{ ok: boolean; index?: number; count?: number; message?: string }>(
            `(${RENDER_DIAGRAMS_JS})()`,
          );
          if (!outcome.ok) {
            /**
             * *Which* diagram, because a report can hold several: *"'the second diagram' is the
             * difference between a fixable error and a guess."*
             */
            const where =
              outcome.index !== undefined && outcome.index > 0
                ? `Diagram ${outcome.index} in that document`
                : "A diagram in that document";
            throw new AgentPlatformError({
              code: "invalid_input",
              message: `${where} has a syntax error and could not be drawn: ${outcome.message ?? "unknown mermaid error"}`,
              retryable: false,
            });
          }
          const expected = outcome.count ?? 0;
          if (expected > 0) {
            /**
             * The SVGs only exist once `run()` has resolved, and this waits for **all** of them.
             *
             * *"Without this the print can catch the raw `<pre>` source instead of the diagram."*
             * Counted rather than waiting for one, because a document with three diagrams can print
             * with the third still unrendered.
             */
            await page.waitForFunction(
              `document.querySelectorAll('pre.mermaid svg').length >= ${expected}`,
              { timeout: RENDER_TIMEOUT_MS },
            );
          }
        }

        /*
         * #660: measured in this page before it prints — content past the printable width, slides whose content leaves
         * the slide, fonts asked for and not installed. The viewport is set to the printable width first so the layout
         * is the one the PDF gets. Best-effort: a failed measurement loses the facts, never the PDF.
         */
        const fullBleed = input.html.includes(FULL_BLEED_MARKER);
        const printableWidth =
          input.page !== undefined
            ? input.page.width
            : input.layoutWidth !== undefined
              ? input.layoutWidth
              : input.html.includes(TEMPLATE_MARKER) && /size:\s*A4\s+landscape/i.test(input.html)
                ? A4_LANDSCAPE_WIDTH_PX
                : fullBleed
                  ? A4_WIDTH_PX
                  : A4_PRINTABLE_WIDTH_PX;
        let layout: LayoutFacts | undefined;
        try {
          await page.setViewportSize({ width: Math.round(printableWidth), height: input.page !== undefined ? Math.round(input.page.height) : VIEWPORT.height });
          layout = layoutFactsOf(await page.evaluate(LAYOUT_FACTS_JS(printableWidth)));
        } catch {
          layout = undefined;
        }

        // #607: a slide deck prints one slide per page at the slide's own size, edge to edge. A themed page has no
        // printed margin and pads its body instead, so its background reaches the paper's edge (#595); every other
        // document keeps the fixed margins its CSS was measured against.
        const noMargin = { top: "0", bottom: "0", left: "0", right: "0" };
        const bytes = await page.pdf(
          input.page !== undefined
            ? { width: `${Math.round(input.page.width)}px`, height: `${Math.round(input.page.height)}px`, printBackground: true, margin: noMargin }
            : {
                format: "A4",
                printBackground: true,
                margin: fullBleed ? noMargin : { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
                /*
                 * #661: the document's `@page` decides the paper — every document, not only a template (#595, whose
                 * campaign plan is landscape). Production, 2026-09-30: an html 16:9 deck printed portrait A4 and
                 * cropped, because without this flag Chromium ignores a CSS `@page` size. Measured on this Chromium:
                 * with it, a CSS `@page` size and margin both win over `format` and `margin` above, which stay as the
                 * fallback for a page that sets neither (`PRINT_CSS` always does). The navy sheet's white frame was
                 * the default margin, which `generate_pdf`'s `margin` now sets (`pageSetupCss`).
                 */
                preferCSSPageSize: true,
              },
        );
        if (bytes.byteLength === 0) {
          throw new AgentPlatformError({ code: "provider_error", message: "The PDF came back empty.", retryable: true });
        }
        const pageSize = pageSizeOf(bytes);
        return {
          bytes,
          mime: "application/pdf" as const,
          pages: pageCountOf(bytes),
          facts: { ...(layout ?? {}), ...(pageSize === undefined ? {} : { page: pageSize }) },
        };
      });
    },

    async renderDiagram(_context, input) {
      if (deps.mermaidBundlePath === undefined) {
        throw new AgentPlatformError({
          code: "provider_unavailable",
          message: "Diagram rendering is not available on this deployment.",
          retryable: false,
        });
      }
      const bundlePath = deps.mermaidBundlePath;

      /**
       * Repaired **once**, here.
       *
       * The old renderer's note, and it is a real trap: *"repaired once here, so the source embedded in
       * the page and the source handed to `mermaid.parse()` below are the same string. Validating the raw
       * text while rendering the repaired one would report errors that no longer exist."* This version
       * reads the source back out of the page for exactly that reason — one string, one place.
       */
      const source = repairMermaidLabels(input.source.trim());
      const width = Math.max(MIN_DIAGRAM_WIDTH, Math.min(Math.trunc(input.width ?? DEFAULT_DIAGRAM_WIDTH), MAX_DIAGRAM_WIDTH));
      // #595: a themed diagram sits on the theme's background, not white.
      const background = input.transparent === true ? "transparent" : (input.theme?.palette.background ?? "#ffffff");
      const html = buildDiagramHtml(source, {
        width,
        background,
        ...(input.theme === undefined ? {} : { theme: input.theme }),
        ...(input.preset === undefined ? {} : { preset: input.preset }),
      });

      return withPage(
        deps,
        async (page) => {
          await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
          await page.addScriptTag({ path: bundlePath });

          const outcome = await page.evaluate<{ ok: boolean; message?: string }>(`(${MERMAID_RUN})()`);
          if (!outcome.ok) {
            /**
             * Mermaid's own message, passed through.
             *
             * "Parse error on line 2: …" is something a model can act on; a generic failure is what
             * makes it re-send the same broken syntax.
             */
            throw new AgentPlatformError({
              code: "invalid_input",
              message: `That diagram has a syntax error and could not be drawn: ${outcome.message ?? "unknown mermaid error"}`,
              retryable: false,
            });
          }

          /**
           * The SVG only exists after `run()` resolves.
           *
           * *"Without this wait the screenshot catches the raw `<pre>` source instead of the diagram"* —
           * which is a picture of the code, and it looks enough like a result to ship.
           */
          await page.waitForSelector("#wrap svg", { timeout: RENDER_TIMEOUT_MS });

          const element = page.locator("#wrap");
          if ((await element.count()) === 0) {
            throw new AgentPlatformError({ code: "provider_error", message: "The diagram could not be rendered.", retryable: true });
          }
          const box = await element.boundingBox();
          // Clipped to the diagram, not the viewport — no dead whitespace under a short diagram.
          const bytes = await element.screenshot({ type: "png", omitBackground: background === "transparent" });
          if (bytes.byteLength === 0) {
            throw new AgentPlatformError({ code: "provider_error", message: "The rendered diagram was empty.", retryable: true });
          }
          return {
            bytes,
            mime: "image/png" as const,
            width: Math.round(box?.width ?? width),
            height: Math.round(box?.height ?? 0),
          };
        },
        // Retina-sharp text in an exported image, which is the old renderer's own choice.
        { viewport: { width, height: 800 }, deviceScaleFactor: 2 },
      );
    },

    async renderHtmlImage(_context, input) {
      const width = Math.max(480, Math.min(Math.trunc(input.width ?? 1080), 1600));
      return withPage(
        deps,
        async (page) => {
          // Print margins do not apply to a screenshot: without these the text sat on the image's left edge.
          // #595: on the theme's background, or the themed document's own would be painted over in white.
          const style = `<style>html,body{background:${input.theme?.palette.background ?? "#fff"}}body{margin:0;padding:64px 72px}</style>`;
          const html = /<\/head>/i.test(input.html) ? input.html.replace(/<\/head>/i, `${style}</head>`) : style + input.html;
          await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
          // The whole document, not the first screen: an artifact is read top to bottom.
          const bytes = await page.screenshot({ type: "png", fullPage: true });
          if (bytes.byteLength === 0) {
            throw new AgentPlatformError({ code: "provider_error", message: "The document image came out empty.", retryable: true });
          }
          const height = await page.evaluate<number>("document.documentElement.scrollHeight");
          return { bytes, mime: "image/png" as const, width, height: Math.round(height) };
        },
        // A short viewport, so a full-page capture is exactly the content's height — no blank tail.
        { viewport: { width, height: 200 }, deviceScaleFactor: 2 },
      );
    },

    async renderSlideImages(_context, input) {
      const width = Math.max(320, Math.min(Math.trunc(input.width), 2400));
      const height = Math.max(320, Math.min(Math.trunc(input.height), 2400));
      return withPage(
        deps,
        async (page) => {
          await page.setContent(input.html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
          const slides = page.locator("section.slide");
          const count = await slides.count();
          if (count === 0) {
            throw new AgentPlatformError({ code: "invalid_input", message: "That deck has no slides to draw.", retryable: false });
          }
          const images = [];
          // One at a time and in order: the order is the carousel's order.
          for (let i = 0; i < count; i++) {
            const slide = slides.nth?.(i);
            if (slide === undefined) throw new AgentPlatformError({ code: "provider_unavailable", message: "Slides cannot be drawn as images here.", retryable: false });
            const bytes = await slide.screenshot({ type: "png" });
            if (bytes.byteLength === 0) {
              throw new AgentPlatformError({ code: "provider_error", message: `Slide ${i + 1} came out empty.`, retryable: true });
            }
            images.push({ bytes, mime: "image/png" as const, width, height });
          }
          return images;
        },
        // Scale 1: a 1080×1350 slide is a 1080×1350 image, which is the size the feed wants.
        { viewport: { width, height }, deviceScaleFactor: 1 },
      );
    },

    async renderSlidesVideo(_context, input) {
      const width = Math.max(320, Math.min(Math.trunc(input.width), 2400));
      const height = Math.max(320, Math.min(Math.trunc(input.height), 2400));
      // Refused before the browser starts: a deck too long, or a deployment with no ffmpeg to encode it.
      const plan = slideVideoPlan({ transitions: input.transitions, ...(input.secondsPerSlide === undefined ? {} : { secondsPerSlide: input.secondsPerSlide }) });
      const ffmpeg = deps.runFfmpeg ?? runFfmpeg;
      await ffmpeg(["-hide_banner", "-loglevel", "error", "-version"]);
      // The recording and the encode live in a directory of their own, removed whatever happens.
      const dir = await mkdtemp(join(tmpdir(), "slides-video-"));
      try {
        const recorded = await withPage(
          deps,
          async (page) => {
            // The recording starts with the page; the player starts later. The difference is cut off the front.
            const opened = Date.now();
            await page.setContent(input.html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
            await page.evaluate<boolean>("document.fonts.ready.then(() => true)");
            const count = await page.evaluate<number>("window.__slides ? window.__slides.count : 0");
            if (count !== input.transitions.length) {
              throw new AgentPlatformError({ code: "invalid_input", message: "That deck could not be played for the video.", retryable: false });
            }
            const startMs = Date.now() - opened;
            await page.evaluate<boolean>(`window.__slides.play(${JSON.stringify(plan)})`);
            const video = page.video?.() ?? null;
            if (video === null || page.close === undefined) {
              throw new AgentPlatformError({ code: "provider_unavailable", message: "Slides cannot be recorded as a video here.", retryable: false });
            }
            // Playwright finishes writing the file when the page closes.
            await page.close();
            return { path: await video.path(), startMs };
          },
          { viewport: { width, height }, deviceScaleFactor: 1, recordVideo: { dir, size: { width, height } } },
        );
        const output = join(dir, "deck.mp4");
        await ffmpeg(mp4Args({ input: recorded.path, output, startMs: recorded.startMs, durationMs: plan.totalMs }));
        const bytes = new Uint8Array(await readFile(output));
        if (bytes.byteLength === 0) throw new AgentPlatformError({ code: "provider_error", message: "The video came out empty.", retryable: true });
        return { bytes, mime: "video/mp4" as const, width, height, durationMs: plan.totalMs, secondsPerSlide: plan.secondsPerSlide, shortened: plan.shortened };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async renderCodeSnippet(_context, input) {
      const problem = codeSnippetProblem(input.code);
      if (problem !== null) throw new AgentPlatformError({ code: "invalid_input", message: problem, retryable: false });
      const html = buildCodeSnippetHtml(input);
      return withPage(
        deps,
        async (page) => {
          await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
          const element = page.locator("#frame");
          const box = await element.boundingBox();
          // Clipped to the window and its backdrop — the page around it is not part of the picture.
          const bytes = await element.screenshot({ type: "png" });
          if (bytes.byteLength === 0) {
            throw new AgentPlatformError({ code: "provider_error", message: "The code image came out empty.", retryable: true });
          }
          return { bytes, mime: "image/png" as const, width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
        },
        // Wide enough for the longest window, retina-sharp like a diagram.
        { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 },
      );
    },

    async captureWebsite(_context, input) {
      return openGuarded(input.url, async (page) => {
        const bytes = await page.screenshot({ fullPage: false, type: "png" });
        const title = await page.title().catch(() => "");
        return { bytes, mime: "image/png" as const, title, url: input.url };
      });
    },

    /**
     * The page's readable text, for `read_source`'s fallback — #621.
     *
     * `innerText` of the main content (an `article` or `main` when there is one), so what a person sees rather
     * than markup; each line becomes its own paragraph so `toPassages` can tell prose from menu items.
     */
    async readPageText(_context, input) {
      return openGuarded(input.url, async (page, landed) => {
        const raw = await page.evaluate<string>(PAGE_TEXT_JS);
        const title = await page.title().catch(() => "");
        const lines = String(raw ?? "").split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
        const joined = lines.join("\n\n");
        const truncated = joined.length > MAX_PAGE_TEXT_CHARS;
        return { url: landed, title, text: truncated ? joined.slice(0, MAX_PAGE_TEXT_CHARS) : joined, truncated };
      });
    },
  };
};
