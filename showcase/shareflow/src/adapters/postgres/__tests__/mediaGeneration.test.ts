import { describe, expect, it } from "vitest";
import { mediaGenerationFrom } from "../media.js";

/**
 * The web app's job status, read into the port — #496.
 *
 * The one place a path or signed URL could enter a tool result is here, so it is dropped here even if
 * the route sends one: `check_media_job` returns this as-is, and a URL in a tool result sits in the run
 * log long after the permission check that produced it.
 */
describe("mediaGenerationFrom", () => {
  it("keeps each asset's id and mime type and nothing else", () => {
    const generation = mediaGenerationFrom({
      jobId: "j1",
      kind: "image",
      status: "succeeded",
      provider: "higgsfield",
      assets: [{ id: "a1", mime: "image/png", path: "ws/generated/j1/a1.png", url: "https://x.test/a1.png?token=t" }],
    });
    expect(generation).toEqual({
      jobId: "j1",
      kind: "image",
      state: "succeeded",
      provider: "higgsfield",
      assets: [{ id: "a1", mimeType: "image/png" }],
    });
  });

  it("reports a failure in words, and only on a failed job", () => {
    expect(mediaGenerationFrom({ jobId: "j1", kind: "video", status: "failed", error: "Out of credits" })).toMatchObject({
      state: "failed",
      failure: "Out of credits",
      assets: [],
    });
    expect(mediaGenerationFrom({ jobId: "j1", kind: "video", status: "running", error: "stale" })).not.toHaveProperty("failure");
  });

  it("reads an unknown status as still running, so the agent asks again rather than giving up", () => {
    expect(mediaGenerationFrom({ jobId: "j1", kind: "image", status: "processing" }).state).toBe("running");
  });

  it("skips an asset with no id, which could not be attached anyway", () => {
    expect(mediaGenerationFrom({ jobId: "j1", kind: "image", status: "succeeded", assets: [{ mime: "image/png" }] }).assets).toEqual([]);
  });
});
