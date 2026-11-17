/**
 * Code as a macOS-window picture — #574. The HTML half, pure so it is testable without a browser;
 * `render.ts` puts it in a page and screenshots the window.
 *
 * The highlighter is built in rather than a dependency: a post image needs keywords, strings, comments,
 * numbers and calls told apart, not a grammar per language, and every dependency here ships in the
 * image the worker runs. One pass, longest-match-first, so a keyword inside a string stays a string.
 */

import { fontStack, isDark, type Theme } from "../../design/theme.js";

export type CodeTheme = "dark" | "light" | "brand";

/**
 * The window around the code — #595 part 2. `mac` is the window it always drew; `minimal` drops the title
 * bar for a soft border; `terminal` is a dark bar with a prompt glyph; `none` is the code alone on a plain
 * backdrop. Every frame takes the same palette, so each is themed the same way.
 */
export const CODE_FRAMES = ["mac", "minimal", "terminal", "none"] as const;
export type CodeFrame = (typeof CODE_FRAMES)[number];
export const DEFAULT_CODE_FRAME: CodeFrame = "mac";

export const CODE_LIMITS = { chars: 6_000, lines: 80, lineLength: 160 } as const;

const KEYWORDS = new Set(
  (
    // JS/TS
    "const let var function return if else for while do switch case break continue new class extends " +
    "import export from default async await try catch finally throw typeof instanceof in of this super " +
    "interface type enum implements public private protected readonly static void null undefined true false " +
    // Python
    "def lambda pass yield with as elif not and or is None True False self raise except global nonlocal print " +
    // Go / Rust / Java / C#
    "func package go defer chan map struct range fn mut impl trait pub use mod match loop where crate " +
    "int string bool float double char long short byte final abstract namespace using " +
    // SQL / shell
    "select insert update delete where join left right inner outer on group by order having limit into values " +
    "create table alter drop and or not echo fi then done esac export"
  ).split(" "),
);

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Longest-first alternatives: block comment, line comment, strings, numbers, words, anything else. */
const TOKEN =
  /(\/\*[\s\S]*?\*\/)|((?:\/\/|#(?!\w*\()|--\s).*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;

/** Highlighted HTML for one snippet: spans with a class per token kind, everything escaped. */
export const highlight = (code: string): string => {
  let out = "";
  const source = code;
  for (const m of source.matchAll(TOKEN)) {
    const [text, block, line, str, num, word] = m;
    const index = m.index ?? 0;
    if (block !== undefined || line !== undefined) out += `<span class="c">${escape(text)}</span>`;
    else if (str !== undefined) out += `<span class="s">${escape(text)}</span>`;
    else if (num !== undefined) out += `<span class="n">${escape(text)}</span>`;
    else if (word !== undefined) {
      const next = source.slice(index + text.length).match(/^\s*\(/);
      if (KEYWORDS.has(word) || KEYWORDS.has(word.toLowerCase())) out += `<span class="k">${escape(text)}</span>`;
      else if (next !== null) out += `<span class="f">${escape(text)}</span>`;
      else if (/^[A-Z]/.test(word)) out += `<span class="t">${escape(text)}</span>`;
      else out += escape(text);
    } else out += escape(text);
  }
  return out;
};

const PALETTE: Record<"dark" | "light", Record<string, string>> = {
  dark: { bg: "#1e1e2e", bar: "#181825", text: "#cdd6f4", dim: "#7f849c", k: "#cba6f7", s: "#a6e3a1", c: "#6c7086", n: "#fab387", f: "#89b4fa", t: "#f9e2af", backdrop: "linear-gradient(135deg,#1FC8DB 0%,#7c3aed 55%,#F5A623 100%)" },
  light: { bg: "#ffffff", bar: "#f3f4f6", text: "#1f2937", dim: "#6b7280", k: "#7c3aed", s: "#15803d", c: "#9ca3af", n: "#c2410c", f: "#1d4ed8", t: "#b45309", backdrop: "linear-gradient(135deg,#a5f3fc 0%,#ddd6fe 55%,#fde68a 100%)" },
};

/** Refused before a browser is started: too long to read in a feed, or nothing to draw. */
export const codeSnippetProblem = (code: string): string | null => {
  const trimmed = code.replace(/\s+$/, "");
  if (trimmed.trim() === "") return "There is no code to draw.";
  if (trimmed.length > CODE_LIMITS.chars) return `That snippet is ${trimmed.length} characters; an image can hold ${CODE_LIMITS.chars}. Pick the lines that matter.`;
  const lines = trimmed.split("\n").length;
  if (lines > CODE_LIMITS.lines) return `That snippet is ${lines} lines; an image stays readable up to ${CODE_LIMITS.lines}. Pick the lines that matter.`;
  return null;
};

/**
 * #595: the window in the project's theme. The code colours stay a tuned dark or light set — brand colours
 * as syntax colours are unreadable as often as not — chosen by how dark the theme's background is; the
 * backdrop is the brand's primary into its accent, and the title and corners follow the theme.
 */
const brandPalette = (theme: Theme): Record<string, string> => ({
  ...PALETTE[isDark(theme.palette.background) ? "dark" : "light"],
  backdrop: `linear-gradient(135deg,${theme.palette.primary} 0%,${theme.palette.accent} 100%)`,
});

/** The bar above the code, per frame. `minimal` and `none` have none; the title then sits over the code. */
const frameBar = (frame: CodeFrame, title: string): string => {
  if (frame === "mac") {
    return `<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>${title === "" ? "" : `<span class="title">${title}</span>`}</div>`;
  }
  // A shell prompt, then the title as the command's argument — "❯ app.ts" — or a bare prompt.
  if (frame === "terminal") return `<div class="bar term"><span class="prompt">&#10095;</span>${title === "" ? "" : `<span class="cmd">${title}</span>`}</div>`;
  return title === "" ? "" : `<div class="caption">${title}</div>`;
};

/** The frame's own rules, after the shared ones. Every colour is from the palette, so a theme reaches all four. */
const frameCss = (frame: CodeFrame, p: Record<string, string>, titleFont: string): string => {
  switch (frame) {
    case "mac":
      return "";
    case "minimal":
      return `#window{box-shadow:0 12px 32px rgba(0,0,0,.14),0 0 0 1px ${p.dim}33}
.caption{padding:16px 22px 0;font:600 12px/1.4 ${titleFont};letter-spacing:.06em;text-transform:uppercase;color:${p.dim}}`;
    case "terminal":
      // The bar is always dark — a terminal's title bar — whatever the window below it is.
      return `.term{gap:10px;background:#0d1117;border-bottom:1px solid rgba(255,255,255,.06)}
.prompt{font:700 15px/40px "JetBrains Mono",monospace;color:${p.s}}
.cmd{font:500 13px/40px "JetBrains Mono",monospace;color:#c9d1d9}`;
    case "none":
      // No window: the code sits straight on the backdrop, which is the window's own colour so the syntax set reads.
      return `#frame{background:${p.bg}}
#window{box-shadow:none;border-radius:0;min-width:0}
pre{padding:0}
.caption{padding:0 0 14px;font:600 13px/1.4 ${titleFont};color:${p.dim}}`;
  }
};

export const buildCodeSnippetHtml = (input: {
  readonly code: string;
  readonly title?: string;
  readonly theme?: CodeTheme;
  /** The project's theme; "brand" without one draws the default dark window. */
  readonly brand?: Theme;
  readonly lineNumbers?: boolean;
  /** #595: the window style; `mac` when absent. */
  readonly frame?: CodeFrame;
}): string => {
  const frame: CodeFrame = input.frame !== undefined && (CODE_FRAMES as readonly string[]).includes(input.frame) ? input.frame : DEFAULT_CODE_FRAME;
  const brand = input.theme === "brand" ? input.brand : undefined;
  const p = brand !== undefined ? brandPalette(brand) : PALETTE[input.theme === "light" ? "light" : "dark"];
  const radius = brand === undefined ? 14 : Math.max(4, Math.min(brand.radius, 24));
  const titleFont = brand === undefined ? `-apple-system,"Segoe UI",sans-serif` : fontStack(brand.fonts.body);
  const lines = input.code.replace(/\s+$/, "").replace(/\t/g, "  ").split("\n");
  const body = lines
    .map((line, i) => {
      const number = input.lineNumbers === false ? "" : `<span class="ln">${i + 1}</span>`;
      return `<div class="row">${number}<span class="code">${highlight(line) || " "}</span></div>`;
    })
    .join("");
  const title = escape((input.title ?? "").slice(0, 80));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:transparent;font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace}
#frame{display:inline-block;padding:56px;background:${p.backdrop}}
#window{min-width:520px;max-width:1080px;border-radius:${radius}px;overflow:hidden;background:${p.bg};box-shadow:0 30px 70px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08)}
.bar{position:relative;display:flex;align-items:center;gap:8px;height:40px;padding:0 16px;background:${p.bar}}
.dot{width:12px;height:12px;border-radius:50%}
.title{position:absolute;left:0;right:0;text-align:center;font:500 13px/40px ${titleFont};color:${p.dim};pointer-events:none}
pre{padding:18px 22px 22px;font-size:15px;line-height:1.6;color:${p.text};white-space:pre-wrap;word-break:break-word}
.row{display:flex}
.ln{flex:0 0 auto;width:2.6em;padding-right:1em;text-align:right;color:${p.dim};user-select:none}
.code{flex:1;min-width:0}
.k{color:${p.k}}.s{color:${p.s}}.c{color:${p.c};font-style:italic}.n{color:${p.n}}.f{color:${p.f}}.t{color:${p.t}}
${frameCss(frame, p, titleFont)}
</style></head><body><div id="frame" data-frame="${frame}"><div id="window">
${frameBar(frame, title)}
<pre>${body}</pre></div></div></body></html>`;
};
