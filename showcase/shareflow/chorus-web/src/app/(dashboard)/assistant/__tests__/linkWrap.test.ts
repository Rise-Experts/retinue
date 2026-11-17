import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Production, 2026-09-29: a long source URL made the whole chat scroll sideways. */
describe("links in a message", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "messages.module.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("can break anywhere", () => {
    expect(rule(".mdLink")).toContain("overflow-wrap: anywhere");
  });

  it("do not inherit the wrapper's nowrap, which made the break impossible", () => {
    expect(rule(".mdLinkWrap")).toContain("white-space: nowrap");
    expect(rule(".mdLinkWrap > .mdLink")).toContain("white-space: normal");
  });
});
