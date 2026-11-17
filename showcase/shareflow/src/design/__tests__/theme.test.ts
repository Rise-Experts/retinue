/** #595 — the theme model: presets, the one reader of `projects.design`, and what it hands the renderers. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CURATED_FONTS,
  CURATED_FONT_NAMES,
  NEAR_BLACK,
  NEAR_WHITE,
  PALETTE_ROLES,
  THEME_IDS,
  THEME_PRESETS,
  contrastRatio,
  fontsNamedIn,
  normaliseHex,
  palettePrompt,
  picturePrompt,
  projectTheme,
  resolveTheme,
  themeCss,
} from "../theme.js";

describe("the presets", () => {
  it("are six, each complete, with readable text and curated fonts", () => {
    expect(THEME_IDS).toEqual(["minimal", "bold", "corporate", "editorial", "playful", "dark-tech"]);
    for (const id of THEME_IDS) {
      const preset = THEME_PRESETS[id];
      expect(preset.id).toBe(id);
      for (const role of PALETTE_ROLES) expect(normaliseHex(preset.palette[role]), `${id}.${role}`).toBe(preset.palette[role]);
      expect(contrastRatio(preset.palette.text, preset.palette.background), id).toBeGreaterThanOrEqual(4.5);
      expect(CURATED_FONT_NAMES).toContain(preset.fonts.heading);
      expect(CURATED_FONT_NAMES).toContain(preset.fonts.body);
    }
  });

  it("resolve to themselves", () => {
    const theme = resolveTheme({ themeId: "editorial" });
    expect(theme).toMatchObject({ ...THEME_PRESETS.editorial, chosen: { preset: true, palette: false, fonts: false, picture: true } });
  });
});

describe("the curated fonts are the fonts the image installs", () => {
  it("every family's package is in the Dockerfile's font install, and nothing else is", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dockerfile = readFileSync(resolve(here, "../../../Dockerfile"), "utf8");
    const install = dockerfile.slice(dockerfile.indexOf("#595"));
    const installed = new Set([...install.matchAll(/\bfonts-[a-z0-9-]+/g)].map((m) => m[0]));
    const wanted = new Set(Object.values(CURATED_FONTS).map((f) => f.pkg));
    expect([...installed].sort()).toEqual([...wanted].sort());
  });
});

describe("resolveTheme — legacy kits", () => {
  it("reads colors[0] as primary and colors[1] as accent, over the default base", () => {
    const theme = resolveTheme({ colors: ["#1A2B3C", "#F2C14E", "#000000"] });
    expect(theme.id).toBe("minimal");
    expect(theme.palette).toMatchObject({ primary: "#1a2b3c", accent: "#f2c14e", background: "#ffffff" });
    expect(theme.chosen).toMatchObject({ preset: false, palette: true, roles: ["primary", "accent"] });
  });

  it("takes curated families from free-text fonts, in the order they are named", () => {
    expect(resolveTheme({ fonts: "Headlines in roboto slab, body in Inter" }).fonts).toEqual({ heading: "Roboto Slab", body: "Inter" });
    // One name is both.
    expect(resolveTheme({ fonts: "Lato everywhere" }).fonts).toEqual({ heading: "Lato", body: "Lato" });
    // An uninstalled font is not taken: the preset's stand.
    expect(resolveTheme({ fonts: "Helvetica Neue" }).fonts).toEqual(THEME_PRESETS.minimal.fonts);
    expect(fontsNamedIn("Roboto Slab and Roboto")).toEqual(["Roboto Slab", "Roboto"]);
  });

  it("keeps imageStyle as the picture's notes", () => {
    const theme = resolveTheme({ imageStyle: "  flat illustration,   soft grain " });
    expect(theme.picture.notes).toBe("flat illustration, soft grain");
    expect(theme.chosen.picture).toBe(false);
  });

  it("lets the new keys win over the legacy ones", () => {
    const theme = resolveTheme({ colors: ["#111111"], palette: { primary: "#abc" }, fonts: "Lato", headingFont: "Vollkorn" });
    expect(theme.palette.primary).toBe("#aabbcc");
    expect(theme.fonts).toEqual({ heading: "Vollkorn", body: "Lato" });
  });
});

describe("resolveTheme — invalid values fall back to the preset", () => {
  it("per key", () => {
    const theme = resolveTheme({
      themeId: "neon",
      palette: { primary: "red; } body { x", accent: "#12345", surface: 3 },
      headingFont: "Comic Sans MS",
      radius: 400,
      picture: { style: "oil-painting", mood: 42 },
      logoPlacement: "middle",
    });
    const base = THEME_PRESETS.minimal;
    expect(theme.palette).toEqual(base.palette);
    expect(theme.fonts).toEqual(base.fonts);
    expect(theme.radius).toBe(base.radius);
    expect(theme.picture).toEqual(base.picture);
    expect(theme.logoPlacement).toBe(base.logoPlacement);
    expect(theme.chosen).toEqual({ preset: false, palette: false, roles: [], fonts: false, picture: false });
  });

  it("from nothing at all", () => {
    expect(resolveTheme(undefined)).toMatchObject(THEME_PRESETS.minimal);
    expect(resolveTheme(null).id).toBe("minimal");
  });

  it("replaces text that does not read on the background", () => {
    expect(resolveTheme({ palette: { background: "#ffffff", text: "#eeeeee" } }).palette.text).toBe(NEAR_BLACK);
    expect(resolveTheme({ themeId: "minimal", palette: { background: "#101010" } }).palette.text).toBe(NEAR_WHITE);
    // Readable text is left alone.
    expect(resolveTheme({ palette: { text: "#333333" } }).palette.text).toBe("#333333");
  });

  it("picks the readable colour for text on primary", () => {
    expect(resolveTheme({ palette: { primary: "#fef08a" } }).onPrimary).toBe(NEAR_BLACK);
    expect(resolveTheme({ palette: { primary: "#1e3a8a" } }).onPrimary).toBe(NEAR_WHITE);
  });
});

describe("projectTheme", () => {
  it("is undefined when the kit sets nothing a render follows", () => {
    expect(projectTheme(undefined)).toBeUndefined();
    expect(projectTheme({})).toBeUndefined();
    expect(projectTheme({ aspectRatios: ["4:5"], imageStyle: "watercolour", colors: [] } as never)).toBeUndefined();
    expect(projectTheme({ colors: ["#123456"] })?.palette.primary).toBe("#123456");
  });
});

describe("what the renderers receive", () => {
  const theme = resolveTheme({ themeId: "dark-tech", radius: 16 });

  it("themeCss sets every custom property", () => {
    const css = themeCss(theme);
    expect(css).toBe(
      ":root{--t-bg:#0b1020;--t-surface:#131a2e;--t-primary:#22d3ee;--t-accent:#a855f7;--t-text:#e5e7eb;--t-muted:#94a3b8;" +
        '--t-on-primary:#111111;--t-radius:16px;--t-font-heading:"Manrope", sans-serif;--t-font-body:"Inter", sans-serif;}',
    );
  });

  it("picturePrompt is the style phrase, the mood and the notes", () => {
    expect(picturePrompt(theme)).toBe("polished 3D render, soft studio lighting, smooth materials; mood: moody, neon glow, dark background");
    expect(picturePrompt(resolveTheme({ picture: { style: "line-art", mood: "quiet" }, imageStyle: "no text" }))).toBe(
      "minimal line art, single-weight strokes on a plain background; mood: quiet; no text",
    );
  });

  it("palettePrompt names only what was chosen", () => {
    expect(palettePrompt(theme)).toBe("primary #22d3ee, accent #a855f7, background #0b1020");
    expect(palettePrompt(resolveTheme({ colors: ["#123456"] }))).toBe("primary #123456");
    expect(palettePrompt(resolveTheme({}))).toBe("");
  });
});
