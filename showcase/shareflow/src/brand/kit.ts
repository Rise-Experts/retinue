/**
 * The brand kit — #634 §4. The structured half of the brand profile (industry, tone, emoji and hashtag
 * habits, language, colours, logo, words to avoid), parsed from a row and rendered as prompt lines.
 *
 * One renderer, used by both the chat's brand context section and the generator's brand brief, so the
 * assistant and `generate_content` cannot describe the same brand two different ways.
 *
 * **Tolerant by construction.** The columns arrive in migration `20260929200000_workspace_brand_kit.sql`,
 * which may not be applied when this code deploys. The adapter reads the row as `to_jsonb(row)`, so a
 * missing column is simply a missing key here — never a failed turn — and anything malformed is dropped
 * rather than rendered.
 */

import type { BrandColor, BrandProfile, EmojiUse, HashtagStyle } from "../services/index.js";

const EMOJI_USE: readonly EmojiUse[] = ["none", "light", "lots"];
const HASHTAG_STYLE: readonly HashtagStyle[] = ["none", "few", "many"];
const HEX = /^#[0-9a-f]{6}$/i;
/** The settings page allows four; a hand-edited row with forty should not become forty lines of prompt. */
const MAX_COLORS = 4;
const MAX_TONES = 10;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const tones = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(text).filter((t): t is string => t !== undefined).slice(0, MAX_TONES);
  return out.length === 0 ? undefined : out;
};

const colors = (value: unknown): readonly BrandColor[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: BrandColor[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const hex = text((entry as { hex?: unknown }).hex);
    if (hex === undefined || !HEX.test(hex)) continue;
    const name = text((entry as { name?: unknown }).name);
    out.push(name === undefined ? { hex: hex.toLowerCase() } : { hex: hex.toLowerCase(), name });
    if (out.length === MAX_COLORS) break;
  }
  return out.length === 0 ? undefined : out;
};

type Kit = Pick<
  BrandProfile,
  "logoPath" | "colors" | "industry" | "tone" | "emojiUse" | "hashtagStyle" | "language" | "avoid"
>;

/** The kit fields of a `workspace_ai_profile` row (as jsonb). Absent or malformed → absent, never an empty value. */
export const brandKitFromRow = (row: Readonly<Record<string, unknown>>): Kit => {
  const entries: [keyof Kit, unknown][] = [
    ["logoPath", text(row.logo_path)],
    ["colors", colors(row.brand_colors)],
    ["industry", text(row.industry)],
    ["tone", tones(row.tone)],
    ["emojiUse", oneOf(EMOJI_USE, row.emoji_use)],
    ["hashtagStyle", oneOf(HASHTAG_STYLE, row.hashtag_style)],
    ["language", text(row.language)],
    ["avoid", text(row.avoid)],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as Kit;
};

const EMOJI_LINE: Record<EmojiUse, string> = {
  none: "Emoji: none",
  light: "Emoji: sparingly (0-2)",
  lots: "Emoji: freely",
};

const HASHTAG_LINE: Record<HashtagStyle, string> = {
  none: "Hashtags: none",
  few: "Hashtags: a few (1-3)",
  many: "Hashtags: many (5+ where the platform allows)",
};

const LANGUAGE_NAME: Record<string, string> = {
  en: "English",
  de: "German",
  "en+de": "English and German (bilingual)",
};

/**
 * The kit as short `Label: value` lines, in a fixed order. `auto` language renders nothing — it is the
 * default behaviour (answer in the request's language), and saying so would spend tokens on no change.
 */
export const brandKitLines = (profile: BrandProfile): string[] => {
  const lines: string[] = [];
  if (profile.industry !== undefined) lines.push(`Industry: ${profile.industry}`);
  if (profile.tone !== undefined && profile.tone.length > 0) lines.push(`Tone: ${profile.tone.join(", ").toLowerCase()}`);
  if (profile.emojiUse !== undefined) lines.push(EMOJI_LINE[profile.emojiUse]);
  if (profile.hashtagStyle !== undefined) lines.push(HASHTAG_LINE[profile.hashtagStyle]);
  if (profile.language !== undefined && profile.language !== "auto") {
    lines.push(`Language: ${LANGUAGE_NAME[profile.language] ?? profile.language}`);
  }
  if (profile.colors !== undefined && profile.colors.length > 0) {
    lines.push(
      `Brand colours: ${profile.colors.map((c) => (c.name === undefined ? c.hex : `${c.hex} (${c.name})`)).join(", ")}`,
    );
  }
  if (profile.logoPath !== undefined) lines.push("Logo: on file");
  return lines;
};
