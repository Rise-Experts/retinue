/**
 * A slide deck as a video — #620. The deck page is built in `play` mode (every slide stacked, with the player
 * script from `slide-design.ts`), Playwright records the page while the player steps through the slides with
 * their transitions and build-ins, and ffmpeg turns Playwright's WebM into the H.264 MP4 that Instagram,
 * TikTok and LinkedIn take. The storage route stores `video/mp4` and not WebM, so the MP4 is not optional.
 *
 * Only the pure parts are here — the timing plan and the ffmpeg arguments — plus the one function that runs
 * ffmpeg. The browser half is `renderSlidesVideo` in `render.ts`, under the same single browser slot as every
 * other render.
 */

import { execFile } from "node:child_process";
import { AgentPlatformError } from "@retinue/agentkit";

/** A video longer than a minute is not a feed video, and its render holds the browser slot for as long. */
export const SLIDE_VIDEO_MAX_SECONDS = 60;
export const SLIDE_VIDEO_MAX_SLIDES = 20;
export const SLIDE_VIDEO_DEFAULT_SECONDS = 3;
export const SLIDE_VIDEO_MIN_SECONDS = 1;
export const SLIDE_VIDEO_MAX_SECONDS_PER_SLIDE = 8;
/** How long ffmpeg may take to encode a minute of 1080p. Generous: it is seconds in practice. */
export const FFMPEG_TIMEOUT_MS = 120_000;

export type SlideVideoStep = { readonly index: number; readonly atMs: number; readonly transition: string };
export type SlideVideoPlan = {
  readonly secondsPerSlide: number;
  readonly totalMs: number;
  readonly steps: readonly SlideVideoStep[];
  /** True when the seconds asked for were shortened to keep the whole video within the limit. */
  readonly shortened: boolean;
};

/**
 * When each slide appears: one after another, each held `secondsPerSlide` (1 to 8, default 3), the whole at most
 * 60 seconds — a deck that would run longer has its hold shortened, to the half second, rather than refused.
 */
export const slideVideoPlan = (input: { readonly transitions: readonly string[]; readonly secondsPerSlide?: number }): SlideVideoPlan => {
  const count = input.transitions.length;
  if (count === 0) throw new AgentPlatformError({ code: "invalid_input", message: "That deck has no slides to record.", retryable: false });
  if (count > SLIDE_VIDEO_MAX_SLIDES) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `A video holds at most ${SLIDE_VIDEO_MAX_SLIDES} slides and this deck has ${count}. Shorten it with update_artifact, or attach it as a PDF or a carousel.`,
      retryable: false,
    });
  }
  const asked = input.secondsPerSlide;
  const wanted = asked === undefined || !Number.isFinite(asked) ? SLIDE_VIDEO_DEFAULT_SECONDS : Math.min(SLIDE_VIDEO_MAX_SECONDS_PER_SLIDE, Math.max(SLIDE_VIDEO_MIN_SECONDS, asked));
  const fits = Math.floor((SLIDE_VIDEO_MAX_SECONDS / count) * 2) / 2;
  const secondsPerSlide = Math.max(SLIDE_VIDEO_MIN_SECONDS, Math.min(wanted, fits));
  const holdMs = Math.round(secondsPerSlide * 1000);
  return {
    secondsPerSlide,
    totalMs: holdMs * count,
    steps: input.transitions.map((transition, index) => ({ index, atMs: index * holdMs, transition })),
    shortened: secondsPerSlide < wanted,
  };
};

/**
 * ffmpeg's arguments: cut the recording to the plan (from when the player started, for as long as it ran) and
 * encode it as an H.264 MP4 every feed plays — yuv420p, even dimensions, the index at the front.
 */
export const mp4Args = (input: { readonly input: string; readonly output: string; readonly startMs: number; readonly durationMs: number }): string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  input.input,
  "-ss",
  (Math.max(0, input.startMs) / 1000).toFixed(3),
  "-t",
  (input.durationMs / 1000).toFixed(3),
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-vf",
  "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "-movflags",
  "+faststart",
  input.output,
];

export type RunFfmpeg = (args: readonly string[]) => Promise<void>;

/**
 * ffmpeg, from `FFMPEG_PATH` or the PATH. A missing binary is a deployment fault and refuses by name — the image
 * installs it (`shareflow/Dockerfile`) — and a failed encode carries ffmpeg's own last line.
 */
export const runFfmpeg: RunFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    execFile(process.env["FFMPEG_PATH"] ?? "ffmpeg", [...args], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) return resolve();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new AgentPlatformError({ code: "provider_unavailable", message: "This deployment cannot make videos: ffmpeg is not installed.", retryable: false }));
      }
      const last = String(stderr).trim().split("\n").pop() ?? error.message;
      reject(new AgentPlatformError({ code: "provider_error", message: `The video could not be encoded: ${last}`, retryable: true }));
    });
  });
