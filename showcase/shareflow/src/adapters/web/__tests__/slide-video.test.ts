/**
 * The slide video — #620. The timing plan, the ffmpeg arguments and the recorder's contract are pure or
 * drivable with a fake browser; the real recording is exercised by hand against a local Chromium (the report
 * on #620 has the sample), since CI has no ffmpeg to encode with.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import type { PageLike } from "../browser.js";
import { createBrowserRenderService } from "../render.js";
import { SLIDE_DESIGN_CSS, SLIDE_PLAYER_JS, SLIDE_TRANSITION_KEYFRAMES } from "../slide-design.js";
import { SLIDE_VIDEO_MAX_SLIDES, mp4Args, slideVideoPlan } from "../slide-video.js";
import { countUpText } from "../slides.js";

const thrown = (value: unknown): { code: string; message: string } => {
  if (!(value instanceof Error)) throw new Error(`expected a rejection, got ${JSON.stringify(value)?.slice(0, 60)}`);
  return value as unknown as { code: string; message: string };
};

describe("the timing plan", () => {
  it("holds each slide three seconds by default, one after another, with its own transition", () => {
    const plan = slideVideoPlan({ transitions: ["fade", "slide", "zoom"] });
    expect(plan).toEqual({
      secondsPerSlide: 3,
      totalMs: 9000,
      shortened: false,
      steps: [
        { index: 0, atMs: 0, transition: "fade" },
        { index: 1, atMs: 3000, transition: "slide" },
        { index: 2, atMs: 6000, transition: "zoom" },
      ],
    });
  });

  it("keeps the seconds asked for between one and eight", () => {
    expect(slideVideoPlan({ transitions: ["fade"], secondsPerSlide: 12 }).secondsPerSlide).toBe(8);
    expect(slideVideoPlan({ transitions: ["fade"], secondsPerSlide: 0.2 }).secondsPerSlide).toBe(1);
    expect(slideVideoPlan({ transitions: ["fade"], secondsPerSlide: 4.5 }).totalMs).toBe(4500);
    expect(slideVideoPlan({ transitions: ["fade"], secondsPerSlide: Number.NaN }).secondsPerSlide).toBe(3);
  });

  it("shortens the hold, to the half second, so the whole video stays within a minute", () => {
    const twelve = slideVideoPlan({ transitions: Array(12).fill("fade"), secondsPerSlide: 8 });
    expect(twelve).toMatchObject({ secondsPerSlide: 5, totalMs: 60_000, shortened: true });
    const sixteen = slideVideoPlan({ transitions: Array(16).fill("fade") });
    expect(sixteen).toMatchObject({ secondsPerSlide: 3, shortened: false });
    const twenty = slideVideoPlan({ transitions: Array(20).fill("fade"), secondsPerSlide: 5 });
    expect(twenty).toMatchObject({ secondsPerSlide: 3, totalMs: 60_000, shortened: true });
  });

  it("refuses an empty deck and one past twenty slides, by count", () => {
    expect(thrown((() => { try { return slideVideoPlan({ transitions: [] }); } catch (e) { return e; } })()).code).toBe("invalid_input");
    const long = (() => { try { return slideVideoPlan({ transitions: Array(SLIDE_VIDEO_MAX_SLIDES + 1).fill("fade") }); } catch (e) { return e; } })();
    expect(thrown(long).message).toMatch(/at most 20 slides and this deck has 21/);
  });
});

describe("the MP4 encode", () => {
  it("cuts the recording to the plan and encodes H.264 every feed plays", () => {
    const args = mp4Args({ input: "/t/rec.webm", output: "/t/deck.mp4", startMs: 412, durationMs: 27_000 });
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/t/rec.webm"]);
    // Seeking after the input: exact to the frame on a WebM with no cues.
    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
    expect(args).toEqual(expect.arrayContaining(["-ss", "0.412", "-t", "27.000", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"]));
    expect(args[args.length - 1]).toBe("/t/deck.mp4");
    expect(mp4Args({ input: "a", output: "b", startMs: -5, durationMs: 1000 })).toContain("0.000");
  });
});

describe("recording a deck", () => {
  const recorder = () => {
    const log: string[] = [];
    const ffmpeg: string[][] = [];
    let recordDir = "";
    let newPageOptions: Record<string, unknown> = {};
    const page = {
      url: () => "",
      async route() {},
      async setContent() {
        log.push("setContent");
      },
      async evaluate(expression: string) {
        log.push(expression.startsWith("window.__slides.play") ? "play" : expression);
        if (expression.includes("__slides.count")) return 3;
        if (expression.startsWith("window.__slides.play")) {
          const plan = JSON.parse(expression.slice("window.__slides.play(".length, -1)) as { totalMs: number };
          log.push(`plan ${plan.totalMs}`);
        }
        return true;
      },
      video: () => ({ path: async () => `${recordDir}/rec.webm` }),
      async close() {
        log.push("close page");
      },
    } as unknown as PageLike;
    const chromium = {
      async launch() {
        return {
          async newPage(options: Record<string, unknown>) {
            newPageOptions = options;
            recordDir = (options["recordVideo"] as { dir: string }).dir;
            return page;
          },
          async close() {
            log.push("close browser");
          },
        };
      },
    };
    const runFfmpeg = async (args: readonly string[]) => {
      ffmpeg.push([...args]);
      // The encode writes the MP4 where it was told to.
      if (args.includes("-i")) await writeFile(args[args.length - 1]!, new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    };
    return { log, ffmpeg, runFfmpeg, chromium, options: () => newPageOptions, dir: () => recordDir };
  };

  it("records the page at the slide's size while the player runs the plan, then encodes and cleans up", async () => {
    const r = recorder();
    const service = createBrowserRenderService({ chromium: r.chromium, runFfmpeg: r.runFfmpeg });
    const video = await service.renderSlidesVideo!({} as never, { html: "<html></html>", width: 1080, height: 1350, transitions: ["fade", "slide", "zoom"], secondsPerSlide: 2 });
    expect(video).toMatchObject({ mime: "video/mp4", width: 1080, height: 1350, durationMs: 6000, secondsPerSlide: 2, shortened: false });
    expect(video.bytes.byteLength).toBe(8);
    expect(r.options()).toMatchObject({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1, recordVideo: { size: { width: 1080, height: 1350 } } });
    // The page is closed before the file is read (Playwright writes it on close), and the browser after.
    expect(r.log).toEqual(["setContent", "document.fonts.ready.then(() => true)", "window.__slides ? window.__slides.count : 0", "play", "plan 6000", "close page", "close browser"]);
    // ffmpeg is checked before the browser starts, then encodes the recording.
    expect(r.ffmpeg[0]).toContain("-version");
    expect(r.ffmpeg[1]).toEqual(expect.arrayContaining(["-i", `${r.dir()}/rec.webm`, "-t", "6.000"]));
    // The recording's directory is gone.
    expect(existsSync(dirname(r.ffmpeg[1]![r.ffmpeg[1]!.length - 1]!))).toBe(false);
  });

  it("refuses a deck whose slides the page does not hold, and still cleans up", async () => {
    const r = recorder();
    const service = createBrowserRenderService({ chromium: r.chromium, runFfmpeg: r.runFfmpeg });
    const error = await service.renderSlidesVideo!({} as never, { html: "<html></html>", width: 1080, height: 1350, transitions: ["fade"] }).catch((e: unknown) => e);
    expect(thrown(error)).toMatchObject({ code: "invalid_input" });
    expect(existsSync(r.dir())).toBe(false);
  });

  it("refuses by name when there is no ffmpeg, before a browser starts", async () => {
    const r = recorder();
    const missing = async () => {
      throw Object.assign(new Error("This deployment cannot make videos: ffmpeg is not installed."), { code: "provider_unavailable" });
    };
    const service = createBrowserRenderService({ chromium: r.chromium, runFfmpeg: missing });
    const error = await service.renderSlidesVideo!({} as never, { html: "", width: 1080, height: 1350, transitions: ["fade"] }).catch((e: unknown) => e);
    expect(thrown(error).message).toMatch(/ffmpeg is not installed/);
    expect(r.log).toEqual([]);
  });
});

describe("the player", () => {
  const player = () => {
    const window: Record<string, unknown> = {};
    const document = { querySelectorAll: () => [] };
    runInNewContext(SLIDE_PLAYER_JS, { window, document, performance: { now: () => 0 }, requestAnimationFrame: () => 0, setTimeout });
    return window["__slides"] as { count: number; countUp: (figure: string, progress: number) => string };
  };

  it.each(["87%", "$1.2m", "10,000+", "3.5x", "€2,5", "1.234.567", "12.500", "~50%", "", "no figure", "0%", "100%"])(
    "counts %j up exactly as the panel does",
    (figure) => {
      const { countUp } = player();
      for (const progress of [0, 0.1, 0.33, 0.5, 0.8, 0.999, 1]) expect(countUp(figure, progress)).toBe(countUpText(figure, progress));
    },
  );

  it("carries the transitions the panel uses", () => {
    expect(SLIDE_PLAYER_JS).toContain(JSON.stringify(SLIDE_TRANSITION_KEYFRAMES));
    expect(player().count).toBe(0);
  });
});

describe("the design", () => {
  it("colours with the theme's variables — no colour literal but black and white", () => {
    const css = SLIDE_DESIGN_CSS.replace(/url\("data:[^"]*"\)/g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(|\bhsla?\(/i);
    expect(css).toMatch(/var\(--t-primary\)/);
  });

  it("measures in the slide's unit, so the preview and the export are one design at two sizes", () => {
    const px = [...SLIDE_DESIGN_CSS.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => m[0]);
    // Only hairlines are drawn in px: 1px borders and a 1px/3px text shadow.
    expect(new Set(px)).toEqual(new Set(["1px", "3px"]));
  });

  it("moves nothing on a slide that is not playing, and nothing at all for reduced motion", () => {
    const rules = SLIDE_DESIGN_CSS.split("}").filter((rule) => /\banimation(?:-name)?\s*:/.test(rule) && !rule.includes("@media"));
    for (const rule of rules) expect(rule.trim().split("{")[0], rule).toMatch(/\.s-play/);
    expect(SLIDE_DESIGN_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.slide\.s-play, \.slide\.s-play \*/);
  });
});
