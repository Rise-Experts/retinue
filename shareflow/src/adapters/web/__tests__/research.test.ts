/**
 * `ResearchService` — REQ-041 (#190).
 *
 * The one adapter with no database, so its tests are here rather than in the live-Postgres suite. What is
 * under test is the mapping and the classification, because the parts that matter most — the egress policy,
 * the redirect refusal, the byte ceiling — are the platform's `toolkit/web.ts` and are tested there. Writing
 * a second fetcher to test here would be writing the second egress policy this adapter exists to avoid.
 *
 * Two assertions carry the weight:
 *
 * - **A failed search is never an empty list.** The old runtime's `websearch.py` is deliberately fail-soft,
 *   and an empty list is indistinguishable from "nothing out there" — which invites a model to answer from
 *   what it already believes.
 * - **A refused host and a slow page are different codes.** An assistant needs to tell "that host is not
 *   allowed" from "that page timed out", and both from "the page had nothing".
 */
import { describe, expect, it } from "vitest";

import type { AgentPlatformError } from "@retinue/agentkit";

import {
  MAX_PASSAGES,
  createWebResearchService,
  decodeResultId,
  encodeResultId,
  toPassages,
} from "../research.js";

const thrown = (value: unknown): AgentPlatformError => {
  if (!(value instanceof Error)) {
    throw new Error(`expected the call to reject, and it returned ${JSON.stringify(value)}`);
  }
  return value as AgentPlatformError;
};

const CONTEXT = { tenantId: "t", principalId: "p", roleIds: [], locale: "en", timezone: "UTC", requestId: "r" } as never;

const serviceWith = (over: Record<string, unknown> = {}) =>
  createWebResearchService({
    search: (async (query: string) => ({
      searched: true as const,
      query,
      hits: [{ title: "A page", url: "https://example.test/a", snippet: "about a thing" }],
    })) as never,
    fetchPage: (async (url: string) => ({
      ok: true as const,
      url,
      status: 200,
      truncated: false,
      content: "First paragraph.\n\nSecond paragraph.",
    })) as never,
    ...over,
  });

describe("search", () => {
  it("returns referenceable results", async () => {
    const outcome = await serviceWith().search(CONTEXT, { query: "impact drivers", maxResults: 5 });
    expect(outcome.searched).toBe(true);
    if (!outcome.searched) return;
    expect(outcome.results[0]).toMatchObject({ title: "A page", url: "https://example.test/a" });
    // Referenceable, so reading a hit does not require the model to echo a URL back.
    expect(decodeResultId(outcome.results[0]!.resultId)).toBe("https://example.test/a");
  });

  it("passes a refusal through with its reason, never as an empty list", async () => {
    /**
     * **The assertion this service exists for.** `ai_backend/app/core/websearch.py` is deliberately
     * fail-soft — network errors, timeouts and a missing package all yield an empty list — and an empty list
     * is indistinguishable from "nothing out there".
     *
     * All three reasons are different things to tell a user, and all three are different from "no results".
     */
    for (const reason of ["not-configured", "unavailable", "timed-out"] as const) {
      const service = serviceWith({
        search: (async (query: string) => ({ searched: false as const, query, reason, detail: "why" })) as never,
      });
      const outcome = await service.search(CONTEXT, { query: "anything", maxResults: 5 });
      expect(outcome.searched).toBe(false);
      if (!outcome.searched) expect(outcome.reason).toBe(reason);
    }
  });

  it("refuses an empty query rather than searching for nothing", async () => {
    const error = thrown(await serviceWith().search(CONTEXT, { query: "  ", maxResults: 5 }).catch((r: unknown) => r));
    expect(error.code).toBe("invalid_input");
  });

  it("caps what it asks the provider for", async () => {
    const asked: (number | undefined)[] = [];
    const service = serviceWith({
      search: (async (query: string, limit?: number) => {
        asked.push(limit);
        return { searched: true as const, query, hits: [] };
      }) as never,
    });
    await service.search(CONTEXT, { query: "q", maxResults: 500 });
    // A model asked for "everything about X" will request a hundred results and summarise them badly.
    expect(asked[0]).toBe(10);
  });
});

describe("readSource", () => {
  it("returns passages, each carrying what a citation needs", async () => {
    const result = await serviceWith().readSource(CONTEXT, { url: "https://example.test/a", maxPassages: 5 });
    expect(result.passages).toHaveLength(2);
    for (const passage of result.passages) {
      // Per passage, not per document: a document-level citation is an invitation to go and find it.
      expect(passage.url).toBe("https://example.test/a");
      expect(passage.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(passage.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("reads by resultId without being handed the URL again", async () => {
    const outcome = await serviceWith().search(CONTEXT, { query: "q", maxResults: 5 });
    if (!outcome.searched) throw new Error("expected a search");
    const read = await serviceWith().readSource(CONTEXT, {
      resultId: outcome.results[0]!.resultId,
      maxPassages: 3,
    });
    expect(read.passages[0]?.url).toBe("https://example.test/a");
  });

  it("refuses both a URL and a resultId, and neither", async () => {
    /**
     * The port says either, never both, and the reason is that they can disagree: accepting both and
     * preferring one would mean a caller that passed a stale `resultId` beside a fresh URL got whichever this
     * code happened to favour, with nothing saying which was read.
     */
    for (const input of [
      { url: "https://example.test/a", resultId: "src_x", maxPassages: 3 },
      { maxPassages: 3 },
    ]) {
      const error = thrown(await serviceWith().readSource(CONTEXT, input).catch((r: unknown) => r));
      expect(error.code).toBe("invalid_input");
    }
  });

  it("refuses a resultId it did not issue", async () => {
    const error = thrown(
      await serviceWith().readSource(CONTEXT, { resultId: "not-mine", maxPassages: 3 }).catch((r: unknown) => r),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("Search again");
  });

  it("classifies a refused host as forbidden and a slow page as a timeout", async () => {
    /**
     * The port requires `forbidden` for a disallowed host and `timeout` for either limit, *"both distinct
     * from an empty result"*. The reason string is the toolkit's; the code is what a caller branches on, and
     * an assistant needs to tell "that host is not allowed" from "that page is slow".
     */
    const cases = [
      ["private address refused", "forbidden"],
      ["loopback is not allowed", "forbidden"],
      ["url redirects to another host", "forbidden"],
      ["request timed out after 10s", "timeout"],
      ["upstream returned 503", "provider_error"],
    ] as const;
    for (const [reason, code] of cases) {
      const service = serviceWith({
        fetchPage: (async (url: string) => ({ ok: false as const, url, reason })) as never,
      });
      const error = thrown(
        await service.readSource(CONTEXT, { url: "https://example.test/a", maxPassages: 3 }).catch((r: unknown) => r),
      );
      expect(error.code, reason).toBe(code);
      // Only a timeout invites a retry; a refused host will refuse again.
      expect(error.retryable, reason).toBe(code === "timeout");
    }
  });

  it("reports the URL the fetcher returned, not the one it was handed", async () => {
    /**
     * The port: *"The URL that was **actually read**, after redirects. Not the requested one."*
     *
     * The platform refuses redirects outright, so today the two are the same string — which satisfies the
     * requirement by removing the hops rather than checking them. Deriving the value from `page.url` anyway
     * means this stays correct if that policy ever changes, instead of quietly citing the wrong page.
     */
    const service = serviceWith({
      fetchPage: (async () => ({
        ok: true as const,
        url: "https://example.test/canonical",
        status: 200,
        truncated: false,
        content: "Body.",
      })) as never,
    });
    const result = await service.readSource(CONTEXT, { url: "https://example.test/asked", maxPassages: 3 });
    expect(result.passages[0]?.url).toBe("https://example.test/canonical");
    expect(decodeResultId(result.sourceId)).toBe("https://example.test/canonical");
  });

  it("reports truncation from the fetcher's own cap as well as its own", async () => {
    // A body cut at the byte ceiling has more, whatever the passage count says.
    const service = serviceWith({
      fetchPage: (async (url: string) => ({
        ok: true as const,
        url,
        status: 200,
        truncated: true,
        content: "One paragraph.",
      })) as never,
    });
    const result = await service.readSource(CONTEXT, { url: "https://example.test/a", maxPassages: 5 });
    expect(result.truncated).toBe(true);
  });

  it("caps the passage count", async () => {
    const service = serviceWith({
      fetchPage: (async (url: string) => ({
        ok: true as const,
        url,
        status: 200,
        truncated: false,
        content: Array.from({ length: 40 }, (_value, index) => `Paragraph ${index}.`).join("\n\n"),
      })) as never,
    });
    const result = await service.readSource(CONTEXT, { url: "https://example.test/a", maxPassages: 100 });
    expect(result.passages).toHaveLength(MAX_PASSAGES);
    expect(result.truncated).toBe(true);
  });
});

describe("passages", () => {
  it("splits on paragraphs before length", () => {
    // A passage cut mid-sentence cites something nobody wrote.
    const { passages } = toPassages("First one.\n\nSecond one.\n\n\nThird one.", 10);
    expect(passages).toEqual(["First one.", "Second one.", "Third one."]);
  });

  it("cuts a long paragraph on a word boundary", () => {
    const word = "impact ";
    const { passages } = toPassages(word.repeat(400), 10);
    expect(passages.length).toBeGreaterThan(1);
    // No passage ends mid-word, which is what makes an excerpt quotable.
    for (const passage of passages) expect(passage).not.toMatch(/impac$|impa$|imp$/);
  });

  it("says there is more when the cap fell short", () => {
    const { passages, truncated } = toPassages("a\n\nb\n\nc\n\nd", 2);
    expect(passages).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("round-trips a URL through a result id", () => {
    /**
     * Derived from the URL rather than a counter, which is what makes it survive across calls: `readSource`
     * takes a `resultId` from *a prior search*, and a per-call counter would make yesterday's id point at
     * something else today.
     */
    for (const url of ["https://a.test/x?y=1#z", "https://b.test/ünïcode", "https://c.test/"]) {
      expect(decodeResultId(encodeResultId(url))).toBe(url);
    }
    expect(decodeResultId("nonsense")).toBeUndefined();
  });
});
