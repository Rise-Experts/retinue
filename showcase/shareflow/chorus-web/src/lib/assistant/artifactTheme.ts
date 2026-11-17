/**
 * The project theme as the artifact panel's CSS variables — #607.
 *
 * The PDF of a document is printed by the agent service in the project's theme (`shareflow/src/design/theme.ts`
 * → `themeCss`, then `themedPrintCss` in `adapters/web/document.ts`). For the panel's preview to look like that
 * PDF it needs the same `--t-*` values, so this reads a stored `projects.design` exactly as `projectTheme`
 * and `resolveTheme` do there, and returns the same variables `themeCss` writes.
 *
 * A mirror, and only of the part the panel paints with: the palette, the two fonts and the radius.
 * `__tests__/artifactTheme.test.ts` imports the agent service's own module and compares the two over a matrix
 * of designs, so a drift fails a test rather than a preview. (A fuller web mirror of the theme is being built
 * in `lib/projects/theme.ts`; when it lands, this can read from it.)
 */
import {
  CURATED_FONT_NAMES,
  PALETTE_ROLES,
  RADIUS_MAX,
  THEME_IDS,
  resolveTheme,
  type CuratedFont,
  type LogoPlacement,
  type PaletteRole,
  type ThemeId,
  type ThemeInput,
} from '@/lib/projects/theme';

type Preset = { palette: Record<PaletteRole, string>; heading: CuratedFont; body: CuratedFont; radius: number };

/** Transcribed from `THEME_PRESETS`; the parity test holds them equal. */
const PRESETS: Record<ThemeId, Preset> = {
  minimal: { palette: { background: '#ffffff', surface: '#f5f5f4', primary: '#111827', accent: '#2563eb', text: '#111827', muted: '#6b7280' }, heading: 'Inter', body: 'Inter', radius: 8 },
  bold: { palette: { background: '#ffffff', surface: '#fef3c7', primary: '#dc2626', accent: '#facc15', text: '#0a0a0a', muted: '#525252' }, heading: 'League Spartan', body: 'Inter', radius: 4 },
  corporate: { palette: { background: '#ffffff', surface: '#f1f5f9', primary: '#1e3a8a', accent: '#0ea5e9', text: '#0f172a', muted: '#64748b' }, heading: 'Roboto', body: 'Open Sans', radius: 6 },
  editorial: { palette: { background: '#fbf8f3', surface: '#f1ebe1', primary: '#1c1917', accent: '#b45309', text: '#1c1917', muted: '#78716c' }, heading: 'EB Garamond', body: 'Lato', radius: 2 },
  playful: { palette: { background: '#fff7fb', surface: '#ffe4f1', primary: '#7c3aed', accent: '#f97316', text: '#1f1235', muted: '#6b5b7b' }, heading: 'Quicksand', body: 'Manrope', radius: 20 },
  'dark-tech': { palette: { background: '#0b1020', surface: '#131a2e', primary: '#22d3ee', accent: '#a855f7', text: '#e5e7eb', muted: '#94a3b8' }, heading: 'Manrope', body: 'Inter', radius: 12 },
};

/** Generic fallbacks, as `CURATED_FONTS` gives them. */
const GENERIC: Partial<Record<CuratedFont, string>> = {
  'Comic Neue': 'cursive',
  'Roboto Slab': 'serif',
  Vollkorn: 'serif',
  'EB Garamond': 'serif',
  'DejaVu Serif': 'serif',
  'JetBrains Mono': 'monospace',
};

const NEAR_BLACK = '#111111';
const NEAR_WHITE = '#f8f8f8';

const normaliseHex = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return undefined;
};

const luminance = (hex: string): number => {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const readableOn = (background: string): string => (contrast(NEAR_BLACK, background) >= contrast(NEAR_WHITE, background) ? NEAR_BLACK : NEAR_WHITE);

const curated = (value: unknown): CuratedFont | undefined =>
  typeof value === 'string' ? CURATED_FONT_NAMES.find((name) => name.toLowerCase() === value.trim().toLowerCase()) : undefined;

/** Curated families named in a legacy free-text fonts field, in order; longest names first, as there. */
const fontsNamedIn = (text: string): CuratedFont[] => {
  const lower = text.toLowerCase();
  const masked = [...lower];
  const taken: { name: CuratedFont; at: number }[] = [];
  for (const name of [...CURATED_FONT_NAMES].sort((a, b) => b.length - a.length)) {
    const at = masked.join('').indexOf(name.toLowerCase());
    if (at === -1) continue;
    taken.push({ name, at });
    for (let i = at; i < at + name.length; i++) masked[i] = '\u0000';
  }
  return taken.sort((a, b) => a.at - b.at).map((t) => t.name);
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const fontStack = (font: CuratedFont): string => `"${font}", ${GENERIC[font] ?? 'sans-serif'}`;

/** The `--t-*` variables, named as `themeCss` names them. */
export type ThemeVars = Readonly<Record<`--t-${string}`, string>>;

/** `resolveTheme` → `themeCss`, as a style object. Never throws; an invalid value is the preset's. */
export function themeVarsFor(design: unknown): ThemeVars {
  const d = record(design) ?? {};
  const presetId = typeof d.themeId === 'string' && (THEME_IDS as readonly string[]).includes(d.themeId.trim()) ? (d.themeId.trim() as ThemeId) : 'minimal';
  const preset = PRESETS[presetId];
  const palette: Record<PaletteRole, string> = { ...preset.palette };
  const legacy = Array.isArray(d.colors) ? d.colors.map(normaliseHex) : [];
  const roles = record(d.palette) ?? {};
  const given: [PaletteRole, string | undefined][] = [
    ['primary', legacy[0]],
    ['accent', legacy[1]],
    ...PALETTE_ROLES.map((role): [PaletteRole, string | undefined] => [role, normaliseHex(roles[role])]),
  ];
  for (const [role, hex] of given) if (hex !== undefined) palette[role] = hex;
  if (contrast(palette.text, palette.background) < 4.5) palette.text = readableOn(palette.background);

  const named = typeof d.fonts === 'string' ? fontsNamedIn(d.fonts) : [];
  const heading = curated(d.headingFont) ?? named[0] ?? preset.heading;
  const body = curated(d.bodyFont) ?? named[1] ?? named[0] ?? preset.body;
  const radius = typeof d.radius === 'number' && Number.isFinite(d.radius) && d.radius >= 0 && d.radius <= RADIUS_MAX ? Math.round(d.radius) : preset.radius;

  return {
    '--t-bg': palette.background,
    '--t-surface': palette.surface,
    '--t-primary': palette.primary,
    '--t-accent': palette.accent,
    '--t-text': palette.text,
    '--t-muted': palette.muted,
    '--t-on-primary': readableOn(palette.primary),
    '--t-radius': `${radius}px`,
    '--t-font-heading': fontStack(heading),
    '--t-font-body': fontStack(body),
  };
}

/** The keys that make a kit a theme for renders — `projectTheme`'s list. An image-style sentence alone does not. */
const RENDER_KEYS = ['themeId', 'palette', 'headingFont', 'bodyFont', 'radius', 'logoPlacement', 'colors', 'fonts', 'picture'] as const;

/**
 * The project's theme for the panel, or null when its kit sets nothing a render follows — `projectTheme`'s
 * rule, so a document the PDF prints plain is previewed plain.
 */
export function projectThemeVars(design: unknown): ThemeVars | null {
  const d = record(design);
  if (d === undefined) return null;
  const set = RENDER_KEYS.some((key) => {
    const value = d[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
  });
  return set ? themeVarsFor(d) : null;
}

/** What a slide deck wears outside a themed project — the default preset, as `buildSlidesHtml` uses. */
export const DEFAULT_THEME_VARS: ThemeVars = themeVarsFor(undefined);

/**
 * #615: the project's logo for a slide preview — its `chorus-media:` reference (signed by the viewer, as any
 * slide image) and the theme's corner, read with the web's `resolveTheme`, the same reading as the agent's.
 */
export type SlideLogo = { readonly reference: string; readonly placement: LogoPlacement };

export function logoPlacementFor(design: unknown): LogoPlacement {
  return resolveTheme((record(design) ?? {}) as ThemeInput).logoPlacement;
}

/**
 * #663: a deck's own style directives, already validated by the slide parser — `ThemeOverlay` in the agent's
 * `design/theme.ts`, laid over the theme by `withDeckStyleVars` here and `withDeckStyle` there.
 */
export type ThemeOverlay = {
  readonly background?: string;
  readonly text?: string;
  readonly accent?: string;
  readonly headingFont?: CuratedFont;
  readonly bodyFont?: CuratedFont;
  readonly mode?: 'dark' | 'light';
};

/** Two normalised hex colours mixed in sRGB — `mixHex` in the agent's theme. */
const mixHex = (a: string, b: string, t: number): string =>
  '#' +
  [1, 3, 5]
    .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0'))
    .join('');

const MODE_GROUNDS = { dark: '#0f1117', light: '#ffffff' } as const;
const MIN_SHAPE_CONTRAST = 3;
const ROLE_VARS: Readonly<Record<PaletteRole, `--t-${string}`>> = {
  background: '--t-bg',
  surface: '--t-surface',
  primary: '--t-primary',
  accent: '--t-accent',
  text: '--t-text',
  muted: '--t-muted',
};

/** `overlayPalette` in the agent's theme, step for step; the slides parity test holds the two equal. */
const overlayPalette = (palette: Readonly<Record<PaletteRole, string>>, overlay: ThemeOverlay): Record<PaletteRole, string> => {
  const p: Record<PaletteRole, string> = { ...palette };
  const ground =
    overlay.background ?? (overlay.mode !== undefined && isDarkHex(p.background) !== (overlay.mode === 'dark') ? MODE_GROUNDS[overlay.mode] : undefined);
  if (ground !== undefined) {
    p.background = ground;
    p.surface = mixHex(ground, readableOn(ground), 0.06);
  }
  if (overlay.text !== undefined) p.text = overlay.text;
  if (overlay.accent !== undefined) p.accent = overlay.accent;
  if (contrast(p.text, p.background) < 4.5) p.text = readableOn(p.background);
  if (ground !== undefined || overlay.text !== undefined) p.muted = mixHex(p.text, p.background, 0.35);
  if (ground !== undefined && contrast(p.primary, p.background) < MIN_SHAPE_CONTRAST) {
    p.primary = contrast(p.accent, p.background) >= MIN_SHAPE_CONTRAST ? p.accent : p.text;
  }
  return p;
};

const isDarkHex = (hex: string): boolean => readableOn(hex) === NEAR_WHITE;

const paletteOf = (vars: ThemeVars): Record<PaletteRole, string> => {
  const fallback = DEFAULT_THEME_VARS;
  const out = {} as Record<PaletteRole, string>;
  for (const role of PALETTE_ROLES) out[role] = normaliseHex(vars[ROLE_VARS[role]]) ?? normaliseHex(fallback[ROLE_VARS[role]]) ?? NEAR_BLACK;
  return out;
};

/** #663: `withDeckStyle` → `themeCss` in the agent service, on the panel's variables. */
export function withDeckStyleVars(vars: ThemeVars, overlay: ThemeOverlay | undefined): ThemeVars {
  if (overlay === undefined) return vars;
  const p = overlayPalette(paletteOf(vars), overlay);
  return {
    ...vars,
    '--t-bg': p.background,
    '--t-surface': p.surface,
    '--t-primary': p.primary,
    '--t-accent': p.accent,
    '--t-text': p.text,
    '--t-muted': p.muted,
    '--t-on-primary': readableOn(p.primary),
    ...(overlay.headingFont === undefined ? {} : { '--t-font-heading': fontStack(overlay.headingFont) }),
    ...(overlay.bodyFont === undefined ? {} : { '--t-font-body': fontStack(overlay.bodyFont) }),
  };
}

/** #663: one slide's `bg-color` — `slideGroundVars` in the agent service: the values that slide overrides. */
export function slideGroundVars(vars: ThemeVars, background: string): ThemeVars {
  const p = overlayPalette(paletteOf(vars), { background });
  return {
    '--t-bg': p.background,
    '--t-surface': p.surface,
    '--t-primary': p.primary,
    '--t-text': p.text,
    '--t-muted': p.muted,
    '--t-on-primary': readableOn(p.primary),
  };
}

/**
 * #620: whether a deck's background is dark — `isDark(theme.palette.background)` in the agent service, which
 * marks every slide `tone-dark` so the design lifts its cards and deepens its blobs. The parity test holds the
 * two readings equal.
 */
export function isDarkThemeVars(vars: ThemeVars): boolean {
  const bg = normaliseHex(vars['--t-bg']);
  return bg !== undefined && readableOn(bg) === NEAR_WHITE;
}
