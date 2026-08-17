import { describe, expect, it } from "vitest";
import {
  createTranslator,
  DEFAULT_CATALOGS,
  errorId,
  mergeCatalogs,
  resolveLocale,
  statusId,
  toolLabelId,
  type Catalogs,
} from "../localization.js";

const catalogs: Catalogs = {
  en: { "tool.create_post.label": "Create post", greeting: "Hello {name}" },
  de: { "tool.create_post.label": "Beitrag erstellen", greeting: "Hallo {name}" },
};

describe("resolveLocale", () => {
  it("matches exact, then language prefix, then default", () => {
    expect(resolveLocale("de", ["en", "de"], "en")).toBe("de");
    expect(resolveLocale("de-DE", ["en", "de"], "en")).toBe("de");
    expect(resolveLocale("fr", ["en", "de"], "en")).toBe("en");
  });
});

describe("translator", () => {
  it("resolves and interpolates for the active locale", () => {
    const t = createTranslator({ catalogs, locale: "de" });
    expect(t.t("tool.create_post.label")).toBe("Beitrag erstellen");
    expect(t.t("greeting", { name: "Alex" })).toBe("Hallo Alex");
  });

  it("falls back requested → default → raw id, never blank", () => {
    const t = createTranslator({ catalogs, locale: "fr", defaultLocale: "en" });
    expect(t.t("tool.create_post.label")).toBe("Create post"); // fell back to en
    expect(t.t("unknown.id")).toBe("unknown.id"); // raw id, not blank
  });

  it("renders function entries with Intl helpers (retry indicator, locale-aware)", () => {
    const t = createTranslator({ catalogs: DEFAULT_CATALOGS, locale: "en", timezone: "UTC" });
    const msg = t.t("retry.pending", { attempt: 2, maxAttempts: 5, nextAttemptAt: "2026-01-01T00:00:03.000Z" });
    expect(msg).toContain("Attempt 2 of 5");
  });

  it("supports plurals via Intl.PluralRules", () => {
    const t = createTranslator({ catalogs: { en: { items: (p, intl) => intl.plural(p.count as number, { one: "{count} item", other: "{count} items" }) } }, locale: "en" });
    expect(t.t("items", { count: 1 })).toBe("1 item");
    expect(t.t("items", { count: 3 })).toBe("3 items");
  });
});

describe("catalog merge & id helpers", () => {
  it("merges a custom catalog over the built-in one", () => {
    const merged = mergeCatalogs(DEFAULT_CATALOGS, { en: { "status.running": "In progress" } });
    const t = createTranslator({ catalogs: merged, locale: "en" });
    expect(t.t("status.running")).toBe("In progress"); // override wins
    expect(t.t("status.failed")).toBe("Failed"); // base preserved
  });

  it("builds stable ids", () => {
    expect(statusId("retry-pending")).toBe("status.retry-pending");
    expect(errorId("rate_limited")).toBe("error.rate_limited");
    expect(toolLabelId("create_post")).toBe("tool.create_post.label");
  });
});
