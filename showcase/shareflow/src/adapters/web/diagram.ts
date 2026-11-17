/**
 * Mermaid, rendered in the page rather than pre-rendered here.
 *
 * The old runtime's reason, and it is the right one: *"mermaid is a browser library — the same one the
 * chat uses, so a diagram looks identical whether it is read in the conversation or attached to a
 * post."* Anything else means two renderers and eventually two-looking diagrams.
 *
 * ## The bundle is a file, not a CDN
 *
 * *"No CDN, because a network fetch here would either hang or silently fail and produce a blank
 * image."* And a page this package builds must not reach the network at all — `guardRequests` would
 * refuse it anyway.
 *
 * So `mermaid` is a **devDependency** whose one bundled file the image copies: only
 * `dist/mermaid.min.js` is ever read, never imported by Node, and the installed package is 83 MB
 * against a 3.4 MB bundle. Declared in `package.json` so the version is tracked and updatable rather
 * than vendored into the repository as an opaque blob.
 */

import { AgentPlatformError } from "@retinue/agentkit";

import { fontStack, isDark, readableOn, resolveTheme, type Theme } from "../../design/theme.js";

/** Widths a diagram may be rendered at. The floor keeps text legible; the ceiling keeps the PNG storable. */
export const MIN_DIAGRAM_WIDTH = 320;
export const MAX_DIAGRAM_WIDTH = 2_400;
export const DEFAULT_DIAGRAM_WIDTH = 1_200;
/** Source longer than this is a mistake rather than a request — the old runtime's `MAX_SOURCE_CHARS`. */
export const MAX_DIAGRAM_SOURCE_CHARS = 100_000;

/**
 * Repairs the one mermaid mistake models make constantly: unquoted parentheses inside a node label.
 *
 *     A[Mobile App (Client)]      -> parse error
 *     A["Mobile App (Client)"]    -> fine
 *
 * **The third copy of this function**, and the duplication is deliberate rather than sloppy. It exists
 * in `web/src/lib/assistant/mermaid.ts` (the chat renderer) and in `ai_backend/app/core/makepdf.py`,
 * and the Python one records why the second copy was needed: *"the frontend repairs a diagram before
 * rendering it in the chat, but this renderer receives the agent's raw source over an HTTP tool call and
 * never saw that fix. So a diagram that displayed fine in the conversation failed to export as an image
 * — which is exactly what happened in production."* This package cannot import from `web/`, the same
 * boundary that made `postCountFor` a replica.
 *
 * Mermaid's grammar treats `(` and `)` as shape delimiters, so they cannot appear bare inside `[...]` or
 * `{...}`. Quoting the label makes it literal text. The rules are the other copies' rules exactly:
 *
 * - only labels that **contain** a parenthesis are touched; everything else is left byte-identical;
 * - an already-quoted label is skipped, so this never double-quotes;
 * - a label containing a double quote is skipped, because quoting it would need escaping rules mermaid
 *   does not have — *"better to leave it and let the fallback show the source than to produce
 *   differently broken output"*;
 * - round `id(...)` nodes are excluded, because the parenthesis **is** their delimiter and the naive
 *   rule would corrupt every one of them.
 */
export const repairMermaidLabels = (source: string): string =>
  source.replace(
    /(^|[^\w"'`])([A-Za-z_][\w-]*)(\[|\{)([^\]\}\n]*)(\]|\})/g,
    (match, before: string, id: string, open: string, label: string, close: string) => {
      const pairs: Record<string, string> = { "[": "]", "{": "}" };
      if (pairs[open] !== close) return match;
      if (!label.includes("(") && !label.includes(")")) return match;
      if (label.includes('"')) return match;
      return `${before}${id}${open}"${label.trim()}"${close}`;
    },
  );

/**
 * A background colour that cannot escape the CSS declaration it is interpolated into.
 *
 * The value reaches a stylesheet, so `red; } body { background: url(...)` would be a CSS injection into
 * a page this package built. An allow-list of shapes rather than an escape: a colour is a small,
 * closed vocabulary, and anything outside it is a mistake rather than an exotic colour.
 */
export const safeBackground = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "transparent") return "transparent";
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^[a-z]{3,20}$/.test(trimmed)) return trimmed;
  return "#ffffff";
};

/** HTML-escape, for the diagram source that goes inside a `<pre>`. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Layout presets — #595 part 2. Each is a tweak over the theme rather than a second renderer: a default
 * direction for a flowchart that names none, an edge curve and spacing, and a few `classDef`s in the theme's
 * colours that the source opts into with `:::name` (the `mermaid-diagrams` skill says which). `flow` is the
 * diagram exactly as it was drawn before presets existed.
 */
export const DIAGRAM_PRESETS = ["flow", "timeline", "org", "comparison"] as const;
export type DiagramPreset = (typeof DIAGRAM_PRESETS)[number];
export const DEFAULT_DIAGRAM_PRESET: DiagramPreset = "flow";

type PresetSpec = {
  /** Given to a `flowchart`/`graph` header that names no direction; a direction the source chose is kept. */
  readonly direction?: "LR" | "TB";
  readonly flowchart?: { readonly curve: string; readonly nodeSpacing: number; readonly rankSpacing: number; readonly padding: number };
};

export const DIAGRAM_PRESET_SPECS: Readonly<Record<DiagramPreset, PresetSpec>> = {
  flow: {},
  // A left-to-right line of milestones, straight connectors.
  timeline: { direction: "LR", flowchart: { curve: "linear", nodeSpacing: 36, rankSpacing: 56, padding: 14 } },
  // A top-down hierarchy with right-angled reporting lines.
  org: { direction: "TB", flowchart: { curve: "step", nodeSpacing: 32, rankSpacing: 64, padding: 14 } },
  // Options side by side, each with its points. Top-down, because mermaid lays unlinked subgraphs out across
  // the rank direction — measured: under LR the options stacked one above the other.
  comparison: { direction: "TB", flowchart: { curve: "linear", nodeSpacing: 28, rankSpacing: 48, padding: 16 } },
};

const isPreset = (value: unknown): value is DiagramPreset => typeof value === "string" && (DIAGRAM_PRESETS as readonly string[]).includes(value);

/**
 * The classes a preset offers, as mermaid `classDef` bodies. Every value is a normalised hex from the theme,
 * so none can break out of the line it is written into. `default` restyles every plain node.
 */
export const presetClassDefs = (preset: DiagramPreset, theme: Theme): Readonly<Record<string, string>> => {
  const p = theme.palette;
  const plain = `fill:${p.surface},stroke:${p.primary},stroke-width:2px,color:${p.text}`;
  switch (preset) {
    case "flow":
      return {};
    case "timeline":
      return {
        default: plain,
        milestone: `fill:${p.accent},stroke:${p.accent},stroke-width:2px,color:${readableOn(p.accent)}`,
        done: `fill:${p.primary},stroke:${p.primary},stroke-width:2px,color:${theme.onPrimary}`,
      };
    case "org":
      return {
        default: plain,
        lead: `fill:${p.primary},stroke:${p.primary},stroke-width:2px,color:${theme.onPrimary}`,
        team: `fill:${p.background},stroke:${p.accent},stroke-width:2px,color:${p.text}`,
      };
    case "comparison":
      return {
        default: plain,
        option: `fill:${p.primary},stroke:${p.primary},stroke-width:2px,color:${theme.onPrimary}`,
        pro: `fill:${p.surface},stroke:${p.accent},stroke-width:2px,color:${p.text}`,
        con: `fill:${p.background},stroke:${p.muted},stroke-width:1px,stroke-dasharray:5 4,color:${p.muted}`,
      };
  }
};

const FLOWCHART_HEADER = /^(\s*)(flowchart|graph)\b[ \t]*(TB|TD|BT|RL|LR)?[ \t]*;?[ \t]*$/i;

/**
 * The source with a preset applied: a direction for a flowchart header that names none, and the preset's
 * classes appended — each only when the source does not define that class itself. Anything but a flowchart
 * is returned as it came; the config (`mermaidThemeConfig`) still themes it.
 */
export const applyDiagramPreset = (source: string, preset: DiagramPreset, theme: Theme): string => {
  if (preset === "flow") return source;
  const lines = source.split("\n");
  let at = 0;
  // Past blank lines, %% comments and a --- front-matter block, to the diagram's own first line.
  while (at < lines.length) {
    const line = (lines[at] ?? "").trim();
    if (line === "---") {
      at += 1;
      while (at < lines.length && (lines[at] ?? "").trim() !== "---") at += 1;
      at += 1;
      continue;
    }
    if (line === "" || line.startsWith("%%")) {
      at += 1;
      continue;
    }
    break;
  }
  const header = FLOWCHART_HEADER.exec(lines[at] ?? "");
  if (header === null) return source;
  const direction = DIAGRAM_PRESET_SPECS[preset].direction;
  if (header[3] === undefined && direction !== undefined) lines[at] = `${header[1] ?? ""}${header[2]} ${direction}`;
  const defs = Object.entries(presetClassDefs(preset, theme))
    .filter(([name]) => !new RegExp(`^\\s*classDef\\s+${name}\\b`, "m").test(source))
    .map(([name, body]) => `  classDef ${name} ${body}`);
  return [...lines, ...defs].join("\n");
};

/**
 * The theme as mermaid config — #595. `theme: "base"` is the only mermaid theme whose `themeVariables`
 * are honoured in full; the rest derive from `primaryColor`. Every value is a normalised hex or a
 * curated font stack, from `resolveTheme`. A preset adds its flowchart spacing and, for mermaid's own
 * `timeline` diagram, section colours from the palette.
 */
export const mermaidThemeConfig = (theme: Theme, preset: DiagramPreset = DEFAULT_DIAGRAM_PRESET) => {
  const p = theme.palette;
  const spec = DIAGRAM_PRESET_SPECS[preset];
  // A native `timeline` colours its sections from cScale0..; the palette, in turn, keeps them on brand.
  const scale = preset === "timeline" ? [p.primary, p.accent, p.surface, p.muted] : [];
  const cScale = Object.fromEntries(
    Array.from({ length: scale.length === 0 ? 0 : 12 }, (_, i) => {
      const colour = scale[i % scale.length] ?? p.primary;
      return [
        [`cScale${i}`, colour],
        [`cScaleLabel${i}`, readableOn(colour)],
      ];
    }).flat(),
  );
  return {
    theme: "base",
    fontFamily: fontStack(theme.fonts.body),
    ...(spec.flowchart === undefined ? {} : { flowchart: { ...spec.flowchart } }),
    themeVariables: {
      darkMode: isDark(p.background),
      background: p.background,
      fontFamily: fontStack(theme.fonts.body),
      primaryColor: p.primary,
      primaryTextColor: theme.onPrimary,
      primaryBorderColor: p.primary,
      secondaryColor: p.accent,
      secondaryTextColor: readableOn(p.accent),
      secondaryBorderColor: p.accent,
      tertiaryColor: p.surface,
      tertiaryTextColor: p.text,
      tertiaryBorderColor: p.muted,
      lineColor: p.muted,
      textColor: p.text,
      clusterBkg: p.surface,
      clusterBorder: p.muted,
      edgeLabelBackground: p.background,
      noteBkgColor: p.surface,
      noteTextColor: p.text,
      noteBorderColor: p.muted,
      ...cScale,
    },
  };
};

/** The id of the element a page carries its mermaid theme in. Read by `MERMAID_RUN` and `RENDER_DIAGRAMS_JS`. */
export const MERMAID_THEME_ID = "t-mermaid";

/**
 * The theme config as an inert JSON block in the page — #595. Carried in the page rather than in the
 * run script so a printed document, which reaches the renderer as HTML alone, themes its diagrams too.
 * `<` is escaped so the block cannot close its own script element.
 */
export const mermaidThemeScript = (theme: Theme | undefined, preset: DiagramPreset = DEFAULT_DIAGRAM_PRESET): string =>
  theme === undefined
    ? ""
    : `<script type="application/json" id="${MERMAID_THEME_ID}">${JSON.stringify(mermaidThemeConfig(theme, preset)).replace(/</g, "\\u003c")}</script>`;

/**
 * Reads the page's theme block for `mermaid.initialize`. Only the three theming keys are taken, and the
 * security settings are applied after them — a model-written HTML body can carry an element with this id,
 * and it must not be able to loosen `securityLevel`.
 */
export const MERMAID_CONFIG_JS = `(() => {
    const node = document.getElementById('${MERMAID_THEME_ID}');
    let themed = {};
    try { themed = node ? JSON.parse(node.textContent) : {}; } catch (e) { themed = {}; }
    const picked = {};
    for (const key of ['theme', 'themeVariables', 'fontFamily']) if (themed && themed[key] !== undefined) picked[key] = themed[key];
    // A preset's spacing: numbers and a curve name only, so a model-written block cannot switch anything else on.
    const flow = themed && typeof themed.flowchart === 'object' && themed.flowchart !== null ? themed.flowchart : null;
    if (flow) {
      const f = {};
      for (const key of ['nodeSpacing', 'rankSpacing', 'padding']) if (typeof flow[key] === 'number') f[key] = flow[key];
      if (typeof flow.curve === 'string' && /^(basis|linear|step|stepBefore|stepAfter|cardinal|monotoneX)$/.test(flow.curve)) f.curve = flow.curve;
      picked.flowchart = f;
    }
    return Object.assign({ fontFamily: 'sans-serif' }, picked, { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
  })()`;

/**
 * The page a diagram renders in.
 *
 * `#wrap` is an inline-block so its bounding box is the diagram's, which is what lets the screenshot be
 * clipped to the drawing instead of the viewport — *"so the image has no dead whitespace below a short
 * diagram."*
 */
export const buildDiagramHtml = (source: string, options: { width: number; background: string; theme?: Theme; preset?: DiagramPreset }): string => {
  if (source.trim() === "") {
    throw new AgentPlatformError({ code: "invalid_input", message: "There is no diagram to render.", retryable: false });
  }
  if (source.length > MAX_DIAGRAM_SOURCE_CHARS) {
    throw new AgentPlatformError({ code: "invalid_input", message: "That diagram source is too long.", retryable: false });
  }
  const background = safeBackground(options.background);
  const width = Math.max(MIN_DIAGRAM_WIDTH, Math.min(Math.trunc(options.width), MAX_DIAGRAM_WIDTH));
  const preset = isPreset(options.preset) ? options.preset : DEFAULT_DIAGRAM_PRESET;
  // A preset outside a project is drawn in the Minimal theme: its classes need colours, and flow alone is today's look.
  const theme = options.theme ?? (preset === "flow" ? undefined : resolveTheme(undefined));
  const drawn = theme === undefined ? source : applyDiagramPreset(source, preset, theme);
  return (
    "<!doctype html><html><head><meta charset='utf-8'><style>" +
    `html,body{margin:0;padding:0;background:${background};}` +
    `#wrap{display:inline-block;padding:24px;width:${width}px;box-sizing:border-box;}` +
    "#wrap svg{width:100%;height:auto;display:block;}" +
    "</style>" +
    mermaidThemeScript(theme, preset) +
    "</head><body>" +
    `<div id='wrap' data-preset='${preset}'><pre class='mermaid'>${escapeHtml(drawn)}</pre></div>` +
    "</body></html>"
  );
};

/**
 * The script that runs mermaid, and every part of it is load-bearing.
 *
 * - `securityLevel: 'strict'` — *"diagram source is model-generated text, and mermaid can otherwise emit
 *   raw HTML and clickable callbacks from a definition."* The same setting the chat renderer uses.
 * - `parse()` **before** `run()`, and the error **returned rather than thrown**. The old runtime's note
 *   is the whole reason: *"Playwright surfaced a bare `Page.evaluate: Object` for a parse failure, which
 *   told the agent nothing — it apologised and re-sent the same broken syntax. Handing back 'Parse error
 *   on line 2: …' lets it actually fix the diagram."*
 * - `suppressErrorRendering` so a failure is a message rather than mermaid's own error graphic drawn
 *   into the image.
 */
export const MERMAID_RUN = `async () => {
  try {
    const source = document.querySelector('#wrap pre.mermaid').textContent;
    window.mermaid.initialize(${MERMAID_CONFIG_JS});
    await window.mermaid.parse(source);
    await window.mermaid.run();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error && error.message ? error.message : error) };
  }
}`;
