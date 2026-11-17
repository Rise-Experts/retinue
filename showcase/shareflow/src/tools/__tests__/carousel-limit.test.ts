/**
 * #611: a carousel refused for its size says how to fit the smallest channel limit.
 */
import { AgentPlatformError } from "@retinue/agentkit";
import { describe, expect, it } from "vitest";

import { carouselRefusal } from "../artifacts.js";

describe("carouselRefusal", () => {
  it("adds the smallest limit among the channels and what to do about it", () => {
    const error = new AgentPlatformError({
      code: "conflict",
      message: "X allows at most 4 images; this post would have 7 LinkedIn allows at most 9 images; this post would have 7",
      retryable: false,
    });
    const refused = carouselRefusal(error, 5) as AgentPlatformError;
    expect(refused).toBeInstanceOf(AgentPlatformError);
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("X allows at most 4 images; this post would have 7");
    expect(refused.message).toContain("the smallest limit is 4 images");
    expect(refused.message).toContain("Trim the deck with update_artifact, split it across two posts");
  });

  it("passes any other refusal through untouched", () => {
    const other = new AgentPlatformError({ code: "conflict", message: "TikTok does not accept images", retryable: false });
    expect(carouselRefusal(other, 5)).toBe(other);
    const plain = new Error("boom");
    expect(carouselRefusal(plain, 5)).toBe(plain);
  });
});
