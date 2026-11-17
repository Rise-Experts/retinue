/**
 * What a printed document actually looks like, measured — #660.
 *
 * The agent cannot see a PDF it made, and it said so anyway. Production, 2026-09-30, five times: "removed the white
 * border" (still there), "follows all your styling requirements" (portrait and cropped), "the corrected 16:9 PDF" (the
 * identical file), "a dark-tech theme gives a near-black background" (no such theme), "merged into one comparison
 * slide" (garbled). `generate_pdf` returned a page count and a byte size, and nothing that could contradict a guess.
 *
 * So the render reports facts the reply can be held to: the page size and orientation (read from the PDF itself),
 * content that runs past the printable width (measured in the same headless page before printing), and fonts the
 * document asked for that the render container does not have (they silently fall back). Best-effort throughout: a
 * measurement that fails leaves its fact out, never the PDF.
 */
import { CURATED_FONT_NAMES } from "../../design/theme.js";

export type PageSize = { readonly width: number; readonly height: number; readonly orientation: "portrait" | "landscape" | "square" };

export type LayoutFacts = {
  /** Elements wider than the printable area, and a few of them by tag and text, so the fix can be aimed. */
  readonly overflow?: { readonly count: number; readonly examples: readonly string[] };
  /** For a deck: the slides whose content runs past the slide's own edges (1-based). */
  readonly overflowingSlides?: readonly number[];
  /** Font families the document asked for that this renderer does not have. */
  readonly missingFonts?: readonly string[];
  /** The document tried to load fonts from another site; the render blocks every outside request. */
  readonly externalFontLinks?: boolean;
};

export type RenderFacts = LayoutFacts & { readonly page?: PageSize };

/** The first page's size, in PDF points, from its `/MediaBox`. Pure; undefined when it cannot be read. */
export const pageSizeOf = (bytes: Uint8Array): PageSize | undefined => {
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 2_000_000))).toString("latin1");
  const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
  if (box === null) return undefined;
  const width = Math.round(Number(box[3]) - Number(box[1]));
  const height = Math.round(Number(box[4]) - Number(box[2]));
  if (!(width > 0 && height > 0)) return undefined;
  const orientation = Math.abs(width - height) <= 2 ? "square" : width > height ? "landscape" : "portrait";
  return { width, height, orientation };
};

/** A4 at 96 dpi, and its printable width inside the document margins (16 mm each side). */
export const A4_WIDTH_PX = 794;
export const A4_LANDSCAPE_WIDTH_PX = 1123;
export const A4_PRINTABLE_WIDTH_PX = 673;

/** Families a document may name without them being installed fonts: CSS generics and system aliases. */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "emoji", "math", "inherit", "initial"]);

/**
 * Runs in the page. Measures against `width` CSS pixels: elements that end past it (outside a deck), slides whose
 * content leaves the slide, and the first family of every text element's computed font.
 */
export const LAYOUT_FACTS_JS = (width: number): string => `(() => {
  const W = ${Math.round(width)};
  const out = { overflowCount: 0, examples: [], slides: [], families: [], externalFonts: false };
  const label = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "") + ' "' + (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40) + '"');
  const slides = Array.from(document.querySelectorAll("section.slide"));
  if (slides.length > 0) {
    slides.forEach((slide, i) => {
      const box = slide.getBoundingClientRect();
      const over = Array.from(slide.querySelectorAll("*")).some((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.position === "absolute" && style.pointerEvents === "none") return false;
        return r.right > box.right + 2 || r.bottom > box.bottom + 2 || r.left < box.left - 2;
      });
      if (over) out.slides.push(i + 1);
    });
  } else {
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > W + 2 || r.left < -2) {
        // Count only the outermost element that overflows, not each of its children.
        const parent = el.parentElement;
        const pr = parent ? parent.getBoundingClientRect() : null;
        if (pr && parent !== document.body && (pr.right > W + 2 || pr.left < -2)) continue;
        out.overflowCount += 1;
        if (out.examples.length < 3) out.examples.push(label(el));
      }
    }
  }
  const seen = new Set();
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,span,a,blockquote,figcaption,div")).slice(0, 400)) {
    if (!(el.textContent || "").trim()) continue;
    const first = (getComputedStyle(el).fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first && !seen.has(first)) { seen.add(first); out.families.push(first); }
  }
  out.externalFonts = !!document.querySelector('link[href*="fonts.googleapis"],link[href*="fonts.gstatic"],link[href*="use.typekit"]')
    || Array.from(document.querySelectorAll("style")).some((s) => /@import[^;]*(fonts\\.googleapis|typekit)/i.test(s.textContent || ""));
  return out;
})()`;

type RawLayout = { overflowCount: number; examples: string[]; slides: number[]; families: string[]; externalFonts: boolean };

/** The measurement, as facts. Pure, for tests. */
export const layoutFactsOf = (raw: RawLayout): LayoutFacts => {
  const installed = new Set(CURATED_FONT_NAMES.map((name) => name.toLowerCase()));
  const missing = raw.families.filter((family) => !GENERIC.has(family.toLowerCase()) && !installed.has(family.toLowerCase()));
  return {
    ...(raw.overflowCount > 0 ? { overflow: { count: raw.overflowCount, examples: raw.examples } } : {}),
    ...(raw.slides.length > 0 ? { overflowingSlides: raw.slides } : {}),
    ...(missing.length > 0 ? { missingFonts: missing } : {}),
    ...(raw.externalFonts ? { externalFontLinks: true } : {}),
  };
};

/**
 * The facts as the tool result carries them, with a note when something is wrong — the part the reply must not
 * contradict. Pure, for tests.
 */
export const renderFactsView = (facts: RenderFacts | undefined): Record<string, unknown> => {
  if (facts === undefined) return {};
  const problems: string[] = [];
  if (facts.overflow !== undefined) problems.push(`${facts.overflow.count} element(s) run past the page's printable width and are cut off (${facts.overflow.examples.join("; ")})`);
  if (facts.overflowingSlides !== undefined) problems.push(`content runs off slide(s) ${facts.overflowingSlides.join(", ")}`);
  if (facts.missingFonts !== undefined) problems.push(`font(s) ${facts.missingFonts.join(", ")} are not installed here, so a fallback font was used — the installed fonts are ${CURATED_FONT_NAMES.join(", ")}`);
  if (facts.externalFontLinks === true) problems.push("the document links fonts from another site, which the renderer blocks");
  return {
    ...(facts.page === undefined ? {} : { pageSize: { width: facts.page.width, height: facts.page.height, unit: "pt" }, orientation: facts.page.orientation }),
    ...(facts.overflow === undefined ? {} : { overflow: facts.overflow }),
    ...(facts.overflowingSlides === undefined ? {} : { overflowingSlides: facts.overflowingSlides }),
    ...(facts.missingFonts === undefined ? {} : { missingFonts: facts.missingFonts }),
    ...(facts.externalFontLinks === undefined ? {} : { externalFontLinks: true }),
    ...(problems.length === 0
      ? {}
      : { renderNote: `Measured in the render: ${problems.join("; ")}. Say this to the person, and fix the document before calling it done — do not describe the PDF as matching what they asked.` }),
  };
};
