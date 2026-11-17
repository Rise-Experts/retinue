import { resolveLocale, type Locale } from "@/lib/locale";

const EXPLICIT_LANGUAGE_PATTERN = /\b(?:in|auf|language\s*:|sprache\s*:)\s*(english|englisch|german|deutsch)\b/gi;

function localeForLanguageName(value: string): Locale {
  return value.toLowerCase() === "german" || value.toLowerCase() === "deutsch" ? "de" : "en";
}

/**
 * Resolves the language for generated social content. An explicit request in
 * the message wins; otherwise this mirrors the app-wide profile/cookie locale
 * resolution and safely falls back to English.
 */
export function resolveContentLocale(
  message: string,
  profileLocale?: string | null,
  cookieLocale?: string | null,
): Locale {
  let explicitLocale: Locale | undefined;

  for (const match of message.matchAll(EXPLICIT_LANGUAGE_PATTERN)) {
    explicitLocale = localeForLanguageName(match[1]);
  }

  return explicitLocale ?? resolveLocale(profileLocale, cookieLocale);
}
