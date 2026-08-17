/**
 * Localization — `docs/14-localization.md`. The frontend owns all localization; the backend only
 * ever emits stable machine ids + structured params. This module resolves an id to a display string
 * for the active locale, interpolates the event's params, falls back cleanly (requested locale →
 * default locale → the raw id, never a blank), and lets a consuming app merge its own catalog over
 * the built-in one. Catalog entries are data (strings with `{param}` placeholders) or, for anything
 * a placeholder can't express (plurals, locale-aware number/date), a function fed `Intl` helpers.
 */

export type IntlHelpers = {
  readonly locale: string;
  readonly timezone?: string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  dateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  plural(count: number, forms: { readonly one?: string; readonly other: string } & Record<string, string>): string;
};

export type CatalogValue = string | ((params: Record<string, unknown>, intl: IntlHelpers) => string);
export type LocaleCatalog = Record<string, CatalogValue>;
export type Catalogs = Record<string, LocaleCatalog>;

/**
 * Resolve the best available locale: an exact match, else a language-prefix match (`de-DE` → `de`),
 * else the default. Never returns an unavailable locale.
 */
export const resolveLocale = (requested: string, available: readonly string[], defaultLocale: string): string => {
  if (available.includes(requested)) return requested;
  const lang = requested.split("-")[0]!;
  const prefixMatch = available.find((l) => l === lang || l.split("-")[0] === lang);
  return prefixMatch ?? defaultLocale;
};

/** Merge `override` catalogs over `base`, per locale and per key. Override wins. */
export const mergeCatalogs = (base: Catalogs, override: Catalogs): Catalogs => {
  const out: Catalogs = {};
  for (const locale of new Set([...Object.keys(base), ...Object.keys(override)]))
    out[locale] = { ...(base[locale] ?? {}), ...(override[locale] ?? {}) };
  return out;
};

const interpolate = (template: string, params: Record<string, unknown>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => (key in params ? String(params[key]) : `{${key}}`));

export type Translator = {
  readonly locale: string;
  /** Resolve `id` for the active locale, interpolating `params`. Falls back to default then the id. */
  t(id: string, params?: Record<string, unknown>): string;
  readonly intl: IntlHelpers;
};

export const createTranslator = (config: {
  readonly catalogs: Catalogs;
  readonly locale: string;
  readonly defaultLocale?: string;
  readonly timezone?: string;
}): Translator => {
  const defaultLocale = config.defaultLocale ?? "en";
  const available = Object.keys(config.catalogs);
  const locale = resolveLocale(config.locale, available, defaultLocale);

  const intl: IntlHelpers = {
    locale,
    ...(config.timezone ? { timezone: config.timezone } : {}),
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    dateTime: (value, options) =>
      new Intl.DateTimeFormat(locale, { ...(config.timezone ? { timeZone: config.timezone } : {}), ...options }).format(
        typeof value === "string" ? new Date(value) : value,
      ),
    plural: (count, forms) => {
      const category = new Intl.PluralRules(locale).select(count);
      const form = forms[category] ?? forms.other;
      return interpolate(form, { count });
    },
  };

  const lookup = (id: string): CatalogValue | undefined =>
    config.catalogs[locale]?.[id] ?? config.catalogs[defaultLocale]?.[id];

  return {
    locale,
    intl,
    t(id, params = {}) {
      const value = lookup(id);
      if (value === undefined) return id; // fallback chain ends at the raw id, never blank
      return typeof value === "function" ? value(params, intl) : interpolate(value, params);
    },
  };
};

/** Stable id helpers, so callers never hand-write the id strings the backend's enums map to. */
export const statusId = (status: string): string => `status.${status}`;
export const errorId = (code: string): string => `error.${code}`;
export const toolLabelId = (toolName: string): string => `tool.${toolName}.label`;

/** Built-in English catalog for the stable ids the runtime emits. Ship a JSON per language to add one. */
export const DEFAULT_CATALOGS: Catalogs = {
  en: {
    "status.queued": "Queued",
    "status.running": "Running",
    "status.waiting-for-question": "Waiting for your answer",
    "status.waiting-for-approval": "Waiting for approval",
    "status.retry-pending": "Retrying",
    "status.completed": "Completed",
    "status.failed": "Failed",
    "status.cancelled": "Cancelled",
    "retry.pending": (params, intl) =>
      `Attempt ${params.attempt} of ${params.maxAttempts}, retrying at ${intl.dateTime(params.nextAttemptAt as string, { timeStyle: "medium" })}`,
    "error.rate_limited": "The service is busy. Retrying shortly.",
    "error.provider_unavailable": "The AI provider is temporarily unavailable.",
    "error.timeout": "The request timed out.",
    "error.budget_exceeded": "This run reached its usage limit.",
    "error.forbidden": "You don't have permission to do that.",
    "error.approval_required": "This action needs approval before it can run.",
    "error.internal": "Something went wrong.",
  },
};
