/**
 * A project's theme — #595. The style kit used to be loose descriptions (a free-text font, an unordered
 * list of swatches, an image-style sentence) that most renderers ignored. A theme is the same kit read as
 * roles: a palette by role, two fonts the render container actually has, a corner radius, a picture look
 * and a logo corner — so a code image, a diagram, a PDF and a generated picture can all follow it.
 *
 * Pure, and the only reader: `resolveTheme` turns whatever `projects.design` holds — new keys, legacy keys,
 * or garbage — into a complete Theme. No row is ever rewritten; an old kit is read into the new shape here.
 */

export const THEME_IDS = ["minimal", "bold", "corporate", "editorial", "playful", "dark-tech"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const PALETTE_ROLES = ["background", "surface", "primary", "accent", "text", "muted"] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export type Palette = Readonly<Record<PaletteRole, string>>;

/**
 * The fonts a theme may name, and **exactly** the ones `shareflow/Dockerfile` installs — the renderers
 * refuse every off-host request (`browser.ts`), so a webfont would never arrive and a name outside this
 * list would silently print in the fallback. Family names are fontconfig's, read with `fc-list` from the
 * installed Debian bookworm packages. Each carries a generic fallback for a checkout without them.
 */
export const CURATED_FONTS = {
  Inter: { generic: "sans-serif", pkg: "fonts-inter" },
  Roboto: { generic: "sans-serif", pkg: "fonts-roboto" },
  "Open Sans": { generic: "sans-serif", pkg: "fonts-open-sans" },
  Lato: { generic: "sans-serif", pkg: "fonts-lato" },
  Manrope: { generic: "sans-serif", pkg: "fonts-manrope" },
  "League Spartan": { generic: "sans-serif", pkg: "fonts-league-spartan" },
  Quicksand: { generic: "sans-serif", pkg: "fonts-quicksand" },
  "Bebas Neue": { generic: "sans-serif", pkg: "fonts-bebas-neue" },
  "Comic Neue": { generic: "cursive", pkg: "fonts-comic-neue" },
  "DejaVu Sans": { generic: "sans-serif", pkg: "fonts-dejavu-core" },
  "Roboto Slab": { generic: "serif", pkg: "fonts-roboto-slab" },
  Vollkorn: { generic: "serif", pkg: "fonts-vollkorn" },
  "EB Garamond": { generic: "serif", pkg: "fonts-ebgaramond" },
  "DejaVu Serif": { generic: "serif", pkg: "fonts-dejavu-core" },
  "JetBrains Mono": { generic: "monospace", pkg: "fonts-jetbrains-mono" },
} as const;
export type CuratedFont = keyof typeof CURATED_FONTS;
export const CURATED_FONT_NAMES = Object.keys(CURATED_FONTS) as readonly CuratedFont[];

/** The picture looks `generate_media` can be told, each as the phrase it receives. */
export const PICTURE_STYLES = {
  photo: "natural photograph, realistic lighting and detail",
  "editorial-photo": "editorial magazine photography, considered composition, shallow depth of field",
  "flat-illustration": "flat vector illustration, clean shapes, no gradients or photographic texture",
  "3d-render": "polished 3D render, soft studio lighting, smooth materials",
  "line-art": "minimal line art, single-weight strokes on a plain background",
  "hand-drawn": "hand-drawn sketch look, visible pencil or ink strokes, paper texture",
  "minimal-graphic": "minimal graphic composition, lots of negative space, simple geometric forms",
} as const;
export type PictureStyle = keyof typeof PICTURE_STYLES;
export const PICTURE_STYLE_IDS = Object.keys(PICTURE_STYLES) as readonly PictureStyle[];

export const LOGO_PLACEMENTS = ["none", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];

export const RADIUS_MAX = 48;
export const MOOD_MAX = 80;

export type ThemePreset = {
  readonly id: ThemeId;
  readonly name: string;
  readonly palette: Palette;
  readonly fonts: { readonly heading: CuratedFont; readonly body: CuratedFont };
  readonly radius: number;
  readonly picture: { readonly style: PictureStyle; readonly mood: string };
  readonly logoPlacement: LogoPlacement;
};

export type Theme = ThemePreset & {
  readonly picture: { readonly style: PictureStyle; readonly mood: string; readonly notes?: string };
  /** Near-black or near-white, whichever reads on `primary` — for text on a filled primary shape. */
  readonly onPrimary: string;
  /**
   * What the person actually chose, as opposed to what the base preset filled in. A legacy kit of two
   * colours and an image-style sentence must not suddenly get the base preset's picture look pushed into
   * every generated image — only the parts they set are *instructions*; the rest only dresses a render.
   */
  readonly chosen: { readonly preset: boolean; readonly palette: boolean; readonly roles: readonly PaletteRole[]; readonly fonts: boolean; readonly picture: boolean };
};

export const THEME_PRESETS: Readonly<Record<ThemeId, ThemePreset>> = {
  minimal: {
    id: "minimal",
    name: "Minimal",
    palette: { background: "#ffffff", surface: "#f5f5f4", primary: "#111827", accent: "#2563eb", text: "#111827", muted: "#6b7280" },
    fonts: { heading: "Inter", body: "Inter" },
    radius: 8,
    picture: { style: "minimal-graphic", mood: "calm, airy, uncluttered" },
    logoPlacement: "bottom-right",
  },
  bold: {
    id: "bold",
    name: "Bold",
    palette: { background: "#ffffff", surface: "#fef3c7", primary: "#dc2626", accent: "#facc15", text: "#0a0a0a", muted: "#525252" },
    fonts: { heading: "League Spartan", body: "Inter" },
    radius: 4,
    picture: { style: "photo", mood: "high contrast, energetic, saturated" },
    logoPlacement: "top-left",
  },
  corporate: {
    id: "corporate",
    name: "Corporate",
    palette: { background: "#ffffff", surface: "#f1f5f9", primary: "#1e3a8a", accent: "#0ea5e9", text: "#0f172a", muted: "#64748b" },
    fonts: { heading: "Roboto", body: "Open Sans" },
    radius: 6,
    picture: { style: "photo", mood: "professional, bright natural light" },
    logoPlacement: "top-right",
  },
  editorial: {
    id: "editorial",
    name: "Editorial",
    palette: { background: "#fbf8f3", surface: "#f1ebe1", primary: "#1c1917", accent: "#b45309", text: "#1c1917", muted: "#78716c" },
    fonts: { heading: "EB Garamond", body: "Lato" },
    radius: 2,
    picture: { style: "editorial-photo", mood: "warm, understated, film grain" },
    logoPlacement: "bottom-left",
  },
  playful: {
    id: "playful",
    name: "Playful",
    palette: { background: "#fff7fb", surface: "#ffe4f1", primary: "#7c3aed", accent: "#f97316", text: "#1f1235", muted: "#6b5b7b" },
    fonts: { heading: "Quicksand", body: "Manrope" },
    radius: 20,
    picture: { style: "flat-illustration", mood: "bright, cheerful, friendly" },
    logoPlacement: "bottom-right",
  },
  "dark-tech": {
    id: "dark-tech",
    name: "Dark tech",
    palette: { background: "#0b1020", surface: "#131a2e", primary: "#22d3ee", accent: "#a855f7", text: "#e5e7eb", muted: "#94a3b8" },
    fonts: { heading: "Manrope", body: "Inter" },
    radius: 12,
    picture: { style: "3d-render", mood: "moody, neon glow, dark background" },
    logoPlacement: "top-right",
  },
};

/** The base when a kit names no preset: a legacy kit is dressed in Minimal, the least opinionated. */
export const DEFAULT_THEME_ID: ThemeId = "minimal";

/** What `projects.design` may hold — new keys and legacy keys, all unvalidated. */
export type ThemeInput = {
  readonly themeId?: unknown;
  readonly palette?: unknown;
  readonly headingFont?: unknown;
  readonly bodyFont?: unknown;
  readonly radius?: unknown;
  readonly picture?: unknown;
  readonly logoPlacement?: unknown;
  /** Legacy: an unordered list of swatches — [0] reads as primary, [1] as accent. */
  readonly colors?: unknown;
  /** Legacy: free text; any curated family it names is taken, in the order it names them. */
  readonly fonts?: unknown;
  /** Legacy: free-text notes, kept as the picture's notes. */
  readonly imageStyle?: unknown;
};

/** `#abc` or `#aabbcc`, normalised to lowercase six digits; anything else is not a colour. */
export const normaliseHex = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return undefined;
};

/** WCAG relative luminance of a normalised hex colour. */
export const luminance = (hex: string): number => {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** WCAG contrast ratio, 1 to 21. */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

export const NEAR_BLACK = "#111111";
export const NEAR_WHITE = "#f8f8f8";
/** WCAG AA for body text. */
const MIN_TEXT_CONTRAST = 4.5;

/** Near-black or near-white, whichever reads better on `background`. */
export const readableOn = (background: string): string =>
  contrastRatio(NEAR_BLACK, background) >= contrastRatio(NEAR_WHITE, background) ? NEAR_BLACK : NEAR_WHITE;

/** Whether a background is dark enough that light text and a dark code window belong on it. */
export const isDark = (background: string): boolean => readableOn(background) === NEAR_WHITE;

const curatedFont = (value: unknown): CuratedFont | undefined => {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return CURATED_FONT_NAMES.find((name) => name.toLowerCase() === v);
};

/**
 * Curated families named in a legacy free-text fonts field, in the order they appear. Longest names are
 * matched first so "Roboto Slab" is not also read as "Roboto".
 */
export const fontsNamedIn = (text: string): CuratedFont[] => {
  const lower = text.toLowerCase();
  const byLength = [...CURATED_FONT_NAMES].sort((a, b) => b.length - a.length);
  const taken: { name: CuratedFont; at: number }[] = [];
  const masked = [...lower];
  for (const name of byLength) {
    const at = masked.join("").indexOf(name.toLowerCase());
    if (at === -1) continue;
    taken.push({ name, at });
    for (let i = at; i < at + name.length; i++) masked[i] = "\u0000";
  }
  return taken.sort((a, b) => a.at - b.at).map((t) => t.name);
};

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value.trim()) ? (value.trim() as T) : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const shortText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\s+/g, " ").trim();
  return v === "" ? undefined : v.slice(0, max);
};

/** A complete Theme from whatever the stored design holds. Never throws; an invalid value is the preset's. */
export const resolveTheme = (design: ThemeInput | null | undefined): Theme => {
  const d: ThemeInput = design ?? {};
  const presetId = oneOf(THEME_IDS, d.themeId);
  const preset = THEME_PRESETS[presetId ?? DEFAULT_THEME_ID];

  // Palette: the preset, then the legacy swatches, then the role palette — the newer the key, the later it wins.
  const palette: Record<PaletteRole, string> = { ...preset.palette };
  const chosenRoles = new Set<PaletteRole>();
  const legacy = Array.isArray(d.colors) ? d.colors.map(normaliseHex) : [];
  const roles = record(d.palette) ?? {};
  const given: [PaletteRole, string | undefined][] = [
    ["primary", legacy[0]],
    ["accent", legacy[1]],
    ...PALETTE_ROLES.map((role): [PaletteRole, string | undefined] => [role, normaliseHex(roles[role])]),
  ];
  for (const [role, hex] of given) {
    if (hex === undefined) continue;
    palette[role] = hex;
    chosenRoles.add(role);
  }
  // Text that does not read on the background is a mistake whoever made it; the renders must stay legible.
  if (contrastRatio(palette.text, palette.background) < MIN_TEXT_CONTRAST) palette.text = readableOn(palette.background);

  const named = typeof d.fonts === "string" ? fontsNamedIn(d.fonts) : [];
  const heading = curatedFont(d.headingFont) ?? named[0] ?? preset.fonts.heading;
  const body = curatedFont(d.bodyFont) ?? named[1] ?? named[0] ?? preset.fonts.body;
  const fontsChosen = curatedFont(d.headingFont) !== undefined || curatedFont(d.bodyFont) !== undefined || named.length > 0;

  const radius =
    typeof d.radius === "number" && Number.isFinite(d.radius) && d.radius >= 0 && d.radius <= RADIUS_MAX ? Math.round(d.radius) : preset.radius;

  const pic = record(d.picture) ?? {};
  const style = oneOf(PICTURE_STYLE_IDS, pic["style"]);
  const mood = shortText(pic["mood"], MOOD_MAX);
  const notes = shortText(d.imageStyle, 2_000);

  return {
    id: preset.id,
    name: preset.name,
    palette,
    fonts: { heading, body },
    radius,
    picture: { style: style ?? preset.picture.style, mood: mood ?? preset.picture.mood, ...(notes === undefined ? {} : { notes }) },
    logoPlacement: oneOf(LOGO_PLACEMENTS, d.logoPlacement) ?? preset.logoPlacement,
    onPrimary: readableOn(palette.primary),
    chosen: { preset: presetId !== undefined, palette: chosenRoles.size > 0, roles: PALETTE_ROLES.filter((r) => chosenRoles.has(r)), fonts: fontsChosen, picture: style !== undefined || mood !== undefined || presetId !== undefined },
  };
};

/** A curated family as a CSS font-family value, quoted, with its generic fallback. */
export const fontStack = (font: CuratedFont): string => `"${font}", ${CURATED_FONTS[font].generic}`;

/**
 * The theme as CSS custom properties on `:root`. Every value is either a normalised hex, an integer or a
 * curated family, so nothing here can escape the declaration it is interpolated into.
 */
export const themeCss = (theme: Theme): string =>
  ":root{" +
  `--t-bg:${theme.palette.background};` +
  `--t-surface:${theme.palette.surface};` +
  `--t-primary:${theme.palette.primary};` +
  `--t-accent:${theme.palette.accent};` +
  `--t-text:${theme.palette.text};` +
  `--t-muted:${theme.palette.muted};` +
  `--t-on-primary:${theme.onPrimary};` +
  `--t-radius:${theme.radius}px;` +
  `--t-font-heading:${fontStack(theme.fonts.heading)};` +
  `--t-font-body:${fontStack(theme.fonts.body)};` +
  "}";

/**
 * #663 (AR-17, F4): a deck's own style directives — `<!-- palette: … -->`, `<!-- heading-font: … -->`,
 * `<!-- body-font: … -->`, `<!-- mode: dark -->` — already validated by the slide parser, laid over the
 * resolved theme. Production, 2026-09-30: asked for a dark deck in another typeface, the model had no way to
 * say so in a deck and rebuilt it as an HTML page instead; these are that way.
 */
export type ThemeOverlay = {
  readonly background?: string;
  readonly text?: string;
  readonly accent?: string;
  readonly headingFont?: CuratedFont;
  readonly bodyFont?: CuratedFont;
  readonly mode?: "dark" | "light";
};

/** Two normalised hex colours mixed in sRGB — `t` of the way from `a` to `b`. */
export const mixHex = (a: string, b: string, t: number): string =>
  "#" +
  [1, 3, 5]
    .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0"))
    .join("");

/** #663: the ground `mode` switches to when the deck sets no background of its own. */
export const MODE_GROUNDS = { dark: "#0f1117", light: "#ffffff" } as const;
/** WCAG's non-text contrast: a filled shape fainter than this against the background does not read as one. */
const MIN_SHAPE_CONTRAST = 3;

/**
 * #663: a palette with a deck's overlay on it. A new background (given, or the ground of a `mode` the theme is
 * not already in) brings a surface to match, and a primary that would vanish on it gives way to the accent (or
 * the text); text that does not read on the background is replaced exactly as `resolveTheme` replaces it, and
 * the muted tone follows the text. The web panel runs the same steps (`withDeckStyleVars` in
 * `web/src/lib/assistant/artifactTheme.ts`), held equal by the slides parity test.
 */
export const overlayPalette = (palette: Palette, overlay: ThemeOverlay): Palette => {
  const p: Record<PaletteRole, string> = { ...palette };
  const ground =
    overlay.background ?? (overlay.mode !== undefined && isDark(p.background) !== (overlay.mode === "dark") ? MODE_GROUNDS[overlay.mode] : undefined);
  if (ground !== undefined) {
    p.background = ground;
    p.surface = mixHex(ground, readableOn(ground), 0.06);
  }
  if (overlay.text !== undefined) p.text = overlay.text;
  if (overlay.accent !== undefined) p.accent = overlay.accent;
  if (contrastRatio(p.text, p.background) < MIN_TEXT_CONTRAST) p.text = readableOn(p.background);
  if (ground !== undefined || overlay.text !== undefined) p.muted = mixHex(p.text, p.background, 0.35);
  if (ground !== undefined && contrastRatio(p.primary, p.background) < MIN_SHAPE_CONTRAST) {
    p.primary = contrastRatio(p.accent, p.background) >= MIN_SHAPE_CONTRAST ? p.accent : p.text;
  }
  return p;
};

/** #663: the theme a deck is drawn in — the resolved theme with the deck's own directives laid over it. */
export const withDeckStyle = (theme: Theme, overlay: ThemeOverlay | undefined): Theme => {
  if (overlay === undefined) return theme;
  const palette = overlayPalette(theme.palette, overlay);
  return {
    ...theme,
    palette,
    fonts: { heading: overlay.headingFont ?? theme.fonts.heading, body: overlay.bodyFont ?? theme.fonts.body },
    onPrimary: readableOn(palette.primary),
  };
};

/**
 * #663: one slide's `<!-- bg-color: … -->` — the `--t-*` values that slide overrides on its own root, so its
 * text, cards and fills follow its background as a whole deck's follow the theme's.
 */
export const slideGroundVars = (theme: Theme, background: string): Record<`--t-${string}`, string> => {
  const p = overlayPalette(theme.palette, { background });
  return {
    "--t-bg": p.background,
    "--t-surface": p.surface,
    "--t-primary": p.primary,
    "--t-text": p.text,
    "--t-muted": p.muted,
    "--t-on-primary": readableOn(p.primary),
  };
};

/** The picture look as the phrase `generate_media` receives: style, mood, then the person's own notes. */
export const picturePrompt = (theme: Theme): string => {
  const parts = [PICTURE_STYLES[theme.picture.style], `mood: ${theme.picture.mood}`];
  if (theme.picture.notes !== undefined) parts.push(theme.picture.notes);
  return parts.join("; ");
};

/**
 * The palette as a short phrase for an image prompt — the roles that colour a picture, and only those the
 * person set (directly or by picking a preset): a legacy kit's two swatches do not bring the base preset's
 * white background with them. Empty when nothing was chosen.
 */
export const palettePrompt = (theme: Theme): string =>
  (["primary", "accent", "background"] as const)
    .filter((role) => theme.chosen.preset || theme.chosen.roles.includes(role))
    .map((role) => `${role} ${theme.palette[role]}`)
    .join(", ");

/** The keys that make a kit a *theme* for renders. An image-style sentence alone steers pictures only. */
const RENDER_KEYS = ["themeId", "palette", "headingFont", "bodyFont", "radius", "logoPlacement", "colors", "fonts", "picture"] as const;

/**
 * The project's theme for the renderers, or undefined when the kit sets nothing a render could follow —
 * so a project with only preferred shapes still gets today's code image, diagram and PDF (#595).
 */
export const projectTheme = (design: ThemeInput | null | undefined): Theme | undefined => {
  if (design === null || design === undefined) return undefined;
  const set = RENDER_KEYS.some((key) => {
    const value = design[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  });
  return set ? resolveTheme(design) : undefined;
};
