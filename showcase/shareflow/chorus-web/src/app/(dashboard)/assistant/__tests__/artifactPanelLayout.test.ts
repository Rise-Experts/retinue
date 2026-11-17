import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The artifact panel's Attach menu and the message copy button — production, 2026-09-28.
 *
 * A source scan, as in `postCardGate.test.ts`: this repo has no jsdom, and each property is "what the
 * code offers or where the rule places it", not pixels.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("Attach to post", () => {
  const panel = read("ArtifactPanel.tsx");

  it("offers a PDF only when every channel of the post takes a document", () => {
    // Offered on an Instagram post, then on Instagram + Facebook + LinkedIn: the tool refused both, since
    // one channel without a document post type refuses the whole draft.
    expect(panel).toContain("post.platforms.every((p) => DOCUMENT_PLATFORMS.has(p))");
    expect(panel).toContain("new Set(documentPlatforms())");
    expect(panel).toContain("{pdf && (");
  });

  it("does not put the whole caption in a tooltip", () => {
    expect(panel).not.toContain("title={post.caption}");
  });

  it("anchors the menu to the toolbar, inside the panel", () => {
    const css = read("messages.module.css");
    expect(rule(css, ".artifactToolbar")).toContain("position: relative");
    expect(rule(css, ".attachRoot")).toContain("position: static");
    expect(rule(css, ".attachMenu")).toContain("calc(100% - 28px)");
  });
});

describe("the copy button", () => {
  it("sits under the message instead of over its first line", () => {
    const copy = rule(read("messages.module.css"), ".copyBtn");
    expect(copy).not.toContain("position: absolute");
  });
});

describe("the media viewer", () => {
  it("draws a PDF in a reader and a video in a player, not as a broken image", async () => {
    const { mediaViewKind } = await import("../MediaModal");
    expect(mediaViewKind("https://x.supabase.co/storage/v1/object/sign/media/ws/generated/a.pdf?token=abc")).toBe("pdf");
    expect(mediaViewKind("https://x/y/clip.MP4?t=1")).toBe("video");
    expect(mediaViewKind("https://x/y/pic.png?token=pdf")).toBe("image");
  });
});
