/**
 * #661 against a real Chromium: the page setup printed, then read back out of the PDF.
 *
 * The option-passing tests (`browser.test.ts`, `document.test.ts`) prove what we *ask* Chromium for; only a real
 * print proves what it *does* with it — the bug this issue fixes was a page rule Chromium was silently ignoring.
 * Skipped where Playwright's Chromium is not installed (a CI image without it), rather than failing there.
 */
import { describe, expect, it } from "vitest";
import { getDocumentProxy } from "unpdf";

import { buildDocumentHtml, layoutWidthOf, type PageSetup } from "../document.js";
import { createBrowserRenderService } from "../render.js";

const chromium = await (async () => {
  try {
    const { chromium: real } = await import("playwright");
    const browser = await real.launch({ args: [] });
    await browser.close();
    return real;
  } catch {
    return undefined;
  }
})();

type Placed = { readonly str: string; readonly left: number; readonly top: number; readonly right: number };
type Printed = { readonly width: number; readonly height: number; readonly pages: number; readonly text: readonly Placed[] };

/** Prints `source` as `generate_pdf` would, and reads page 1's size and every text item's position (PDF points). */
const print = async (kind: "html" | "markdown", source: string, pageSetup?: PageSetup): Promise<Printed> => {
  const service = createBrowserRenderService({ chromium: chromium as never, settleMs: 0 });
  const html = await buildDocumentHtml({ kind, source, ...(pageSetup === undefined ? {} : { pageSetup }) });
  const layoutWidth = pageSetup === undefined ? undefined : layoutWidthOf(pageSetup);
  const printed = await service.renderDocument({} as never, { html, ...(layoutWidth === undefined ? {} : { layoutWidth }) });
  const doc = await getDocumentProxy(new Uint8Array(printed.bytes));
  const text: Placed[] = [];
  let width = 0;
  let height = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [, , w, h] = page.view as [number, number, number, number];
    if (n === 1) [width, height] = [w, h];
    for (const item of (await page.getTextContent()).items as { str?: string; transform: number[]; width: number }[]) {
      if (n !== 1 || item.str === undefined || item.str.trim() === "") continue;
      const left = item.transform[4] ?? 0;
      text.push({ str: item.str, left, top: h - (item.transform[5] ?? 0), right: left + item.width });
    }
  }
  return { width, height, pages: doc.numPages, text };
};

const at = (printed: Printed, str: string): Placed => {
  const found = printed.text.find((item) => item.str.includes(str));
  if (found === undefined) throw new Error(`"${str}" is not on page 1: ${printed.text.map((item) => item.str).join(" | ")}`);
  return found;
};

describe.skipIf(chromium === undefined)("page setup, printed by Chromium (#661)", () => {
  it("AC-1: a navy price sheet with margin 0 prints edge to edge — no white frame", async () => {
    const sheet =
      "<style>html,body{background:#0b1f4d;color:#fff;margin:0} .corner{position:absolute;left:0;top:0;font:14px sans-serif}</style>" +
      "<div class='corner'>EDGE</div><h1 style='padding:40px'>Price sheet</h1>";
    const framed = await print("html", sheet);
    const bled = await print("html", sheet, { margin: 0 });
    // A4 both times; the default keeps its 16 mm side margin (~45pt), margin 0 puts the corner on the paper's edge.
    expect([Math.round(bled.width), Math.round(bled.height)]).toEqual([595, 842]);
    expect(at(framed, "EDGE").left).toBeGreaterThan(40);
    expect(at(bled, "EDGE").left).toBeLessThan(1);
    expect(at(bled, "EDGE").top).toBeLessThan(20);
  }, 30_000);

  it("AC-1: the page's own @page margin wins over the default margins", async () => {
    const own = await print("html", "<style>@page{margin:0} body{margin:0}</style><div style='position:absolute;left:0;top:0'>EDGE</div>");
    expect(at(own, "EDGE").left).toBeLessThan(1);
  }, 30_000);

  it("AC-2: a 1920x1080 HTML deck with page 16:9 prints landscape, one slide a page, nothing cropped", async () => {
    const slide = (n: number) =>
      `<section style="position:relative;width:1920px;height:1080px;background:#112;color:#fff;break-after:page;overflow:hidden">` +
      `<div style="position:absolute;left:40px;top:40px">LEFT${n}</div><div style="position:absolute;right:40px;bottom:40px">RIGHT${n}</div></section>`;
    const deck = `<style>body{margin:0}</style>${slide(1)}${slide(2)}`;
    const printed = await print("html", deck, { page: "16:9" });
    // 1920x1080 CSS px is 1440x810 pt.
    expect([Math.round(printed.width), Math.round(printed.height)]).toEqual([1440, 810]);
    expect(printed.pages).toBe(2);
    const right = at(printed, "RIGHT1");
    expect(right.right).toBeLessThanOrEqual(printed.width);
    expect(right.left).toBeGreaterThan(printed.width / 2);
    expect(right.top).toBeGreaterThan(printed.height / 2);
  }, 30_000);

  it("prints Letter landscape, and page numbers at the foot", async () => {
    const printed = await print("markdown", "# Report\n\nBody text.", { page: "Letter", orientation: "landscape", pageNumbers: true });
    expect([Math.round(printed.width), Math.round(printed.height)]).toEqual([792, 612]);
    const number = at(printed, "1 / 1");
    expect(number.top).toBeGreaterThan(printed.height - 12 * (72 / 25.4));
  }, 30_000);
});
