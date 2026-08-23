/**
 * Citation rendering (#138).
 *
 * Rendered to static markup rather than driven in a browser: `react-dom/server` needs no DOM, no jsdom and no
 * test-library, and what these ACs are about — the element chosen, the ARIA wiring, the ordering, the absence
 * of colour — is all in the markup. What it *cannot* test is a click, so the expanded state is rendered
 * directly instead of toggled. Said plainly because "we tested the component" should not imply interaction was
 * exercised.
 *
 * The ordering property behind AC-4 is tested against the React-free view model, where "adding a citation
 * appends and never inserts" is provable about a list rather than merely observable about a tree.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "../types/index.js";
import { CITATION_IDS, DEFAULT_CATALOGS, createTranslator } from "../localization.js";
import {
  CITATION_STYLES,
  CitationPanel,
  CitedMessageView,
  citationResolution,
  citationViewModel,
} from "../ui/citations.js";

const text = (id: string, body: string): MessagePart =>
  ({ id, type: "text", schemaVersion: 1, createdAt: "t", text: body }) as MessagePart;

const retrievalCitation = (id: string, supports: readonly string[]): MessagePart =>
  ({
    id,
    type: "citation",
    schemaVersion: 2,
    createdAt: "t",
    origin: {
      kind: "retrieval",
      sourceType: "file",
      sourceId: "report",
      chunkId: `file:report:${id}`,
      chunkIndex: 2,
      locator: "Quarterly Review > By region",
    },
    excerpt: "Revenue rose nine percent across EMEA.",
    retrievedAt: "2026-08-23T09:30:00.000Z",
    supports,
  }) as MessagePart;

const webCitation = (id: string, supports: readonly string[]): MessagePart =>
  ({
    id,
    type: "citation",
    schemaVersion: 2,
    createdAt: "t",
    origin: { kind: "web", url: "https://example.test/report", title: "Annual report" },
    excerpt: "Revenue rose nine percent.",
    retrievedAt: "2026-08-23T09:30:00.000Z",
    supports,
  }) as MessagePart;

const message = (parts: readonly MessagePart[]): Message =>
  ({ id: "m1", conversationId: "c1", role: "assistant", parts, createdAt: "t" }) as Message;

const t = createTranslator({ catalogs: DEFAULT_CATALOGS, locale: "en" }).t;

describe("AC-1: markers and an expandable panel showing the excerpt", () => {
  it("renders a marker per citation and a panel per citation", () => {
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Revenue rose."), webCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html).toContain('data-citation-marker="c1"');
    expect(html).toContain('data-citation-panel="c1"');
    expect(html).toContain("[1]");
  });

  it("shows the excerpt and when it was read", () => {
    const html = renderToStaticMarkup(
      <CitationPanel
        part={webCitation("c1", ["t1"]) as never}
        index={1}
        id="p1"
        expanded={true}
        t={t}
      />,
    );
    expect(html).toContain("Revenue rose nine percent.");
    // Formatted by Intl for the locale, not concatenated — which is the point of routing it through the
    // catalogue's `intl.dateTime` rather than templating a string.
    expect(html).toContain("Read Aug 23, 2026");
    expect(html).toContain("Annual report");
  });

  it("links a web source, with noreferrer", () => {
    // A cited source has no business learning which conversation linked to it.
    const html = renderToStaticMarkup(
      <CitationPanel part={webCitation("c1", []) as never} index={1} id="p1" expanded={true} t={t} />,
    );
    expect(html).toContain('href="https://example.test/report"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps the panel in the tree but hidden when collapsed", () => {
    // Mounting on expand would change the document's height as the reader clicks, and `hidden` keeps it out of
    // the accessibility tree too — so nothing is announced that is not shown.
    const collapsed = renderToStaticMarkup(
      <CitationPanel part={webCitation("c1", []) as never} index={1} id="p1" expanded={false} t={t} />,
    );
    expect(collapsed).toContain("hidden");
    expect(collapsed).toContain('data-citation-panel="c1"');
  });
});

describe("AC-2: grounded and ungrounded are distinct without colour", () => {
  it("marks a grounded paragraph and leaves an ungrounded one unmarked", () => {
    const html = renderToStaticMarkup(
      <CitedMessageView
        message={message([
          text("t1", "Revenue rose."),
          text("t2", "It will probably continue."),
          webCitation("c1", ["t1"]),
        ])}
        t={t}
      />,
    );
    expect(html).toContain('data-grounded="true"');
    expect(html).toContain('data-grounded="false"');
  });

  it("announces groundedness, since a marker and an underline are not announced", () => {
    // AC-2's non-visual half, which needs a different mechanism from its visual half.
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Revenue rose."), webCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html).toContain("Supported by a source");
    const ungrounded = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Just an opinion.")])} t={t} />,
    );
    expect(ungrounded).toContain("Not attributed to a source");
  });

  it("uses no hue anywhere in the stylesheet", () => {
    // The whole point of AC-2. A colour would not survive greyscale, a colour-blind reader, or a forced-colours
    // mode — so the treatment is an underline, a superscript and an outline, and this asserts no colour crept
    // back in.
    expect(CITATION_STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CITATION_STYLES).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(CITATION_STYLES).not.toMatch(/\bcolor\s*:/);
    // And the non-colour signals are actually there.
    expect(CITATION_STYLES).toContain("underline dotted");
    expect(CITATION_STYLES).toContain("vertical-align: super");
    // `currentColor` is allowed and is the exception that proves the rule: it inherits whatever the host uses,
    // so it cannot introduce a hue of its own.
    expect(CITATION_STYLES).toContain("currentColor");
  });

  it("is mobile first", () => {
    // A max-width query, not a min-width one: the base rules are the small-screen ones.
    expect(CITATION_STYLES).toContain("@media (max-width: 480px)");
    expect(CITATION_STYLES).not.toContain("min-width:");
  });
});

describe("AC-3: every string comes from the catalogue", () => {
  it("renders ids when no catalogue is wired, and words when one is", () => {
    // The sharpest test of "nothing hardcoded": with the identity translator every user-visible string *is* an
    // id, so any literal in the component would show up as prose among the ids.
    const raw = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Revenue rose."), webCitation("c1", ["t1"])])} />,
    );
    for (const id of [
      CITATION_IDS.grounded,
      CITATION_IDS.source,
      CITATION_IDS.retrievedAt,
      CITATION_IDS.sourceCount,
      CITATION_IDS.marker,
    ]) {
      expect(raw).toContain(id);
    }
    // The paragraph text and the excerpt are content, not strings — they come from the message.
    expect(raw).toContain("Revenue rose.");
  });

  it("changes every citation string with the locale", () => {
    const de = createTranslator({
      catalogs: {
        ...DEFAULT_CATALOGS,
        de: {
          "citation.marker": (params) => `(${params.index})`,
          "citation.grounded": "Mit Quelle belegt",
          "citation.source": "Quelle",
          "citation.retrievedAt": "Gelesen am 23.08.2026",
          "citation.sourceCount": "1 Quelle",
          "citation.expand": "Quelle anzeigen",
        },
      },
      locale: "de",
    }).t;
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Umsatz gestiegen."), webCitation("c1", ["t1"])])} t={de} />,
    );
    expect(html).toContain("Mit Quelle belegt");
    expect(html).toContain("1 Quelle");
    expect(html).toContain("(1)");
    // And the English is gone, which is what catches a string the component built itself.
    expect(html).not.toContain("Supported by a source");
    expect(html).not.toContain("[1]");
  });

  it("keeps the brackets in the catalogue, not the component", () => {
    // Not every locale brackets footnotes, and a component that wrapped the number itself would be
    // unlocalisable in exactly the way that is hardest to notice.
    expect(DEFAULT_CATALOGS["en"]?.["citation.marker"]).toBeTypeOf("function");
    const html = renderToStaticMarkup(
      <CitedMessageView
        message={message([text("t1", "x"), webCitation("c1", ["t1"])])}
        t={((id: string, params?: Record<string, unknown>) =>
          id === CITATION_IDS.marker ? `n${String(params?.["index"])}` : id) as never}
      />,
    );
    expect(html).toContain("n1");
    expect(html).not.toContain("[1]");
  });
});

describe("AC-4: a citation arriving mid-stream does not move what is on screen", () => {
  const streaming = (count: number): Message =>
    message([
      text("t1", "Revenue rose."),
      text("t2", "Churn held flat."),
      ...Array.from({ length: count }, (_, i) => webCitation(`c${i + 1}`, [i % 2 === 0 ? "t1" : "t2"])),
    ]);

  it("appends: the view model for N citations is a prefix of the one for N+1", () => {
    // AC-4 as something provable. Every panel already on screen keeps its position *and its number*, and every
    // marker already rendered keeps its number — so nothing the reader is looking at shifts or renumbers.
    for (const n of [0, 1, 2, 3]) {
      const before = citationViewModel(streaming(n));
      const after = citationViewModel(streaming(n + 1));
      expect(after.panels.slice(0, n)).toEqual(before.panels);
      // Markers too: same blocks, and each block's existing markers unchanged.
      expect(after.blocks.map((b) => b.partId)).toEqual(before.blocks.map((b) => b.partId));
      before.blocks.forEach((block, i) => {
        expect(after.blocks[i]?.markers.slice(0, block.markers.length)).toEqual(block.markers);
      });
    }
  });

  it("numbers by arrival, never by position", () => {
    // Renumbering as citations stream in would change text the reader is already looking at, which is the most
    // disorienting form of the jump AC-4 forbids.
    const model = citationViewModel(streaming(3));
    expect(model.panels.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(model.blocks[0]?.markers.map((m) => m.index)).toEqual([1, 3]);
    expect(model.blocks[1]?.markers.map((m) => m.index)).toEqual([2]);
  });

  it("renders panels after the message, never between paragraphs", () => {
    // A panel expanding in place between paragraphs would push everything below it down. The list goes last, so
    // expanding one only ever grows the bottom of the message.
    const html = renderToStaticMarkup(<CitedMessageView message={streaming(2)} t={t} />);
    expect(html.indexOf("Churn held flat.")).toBeLessThan(html.indexOf("data-citation-list"));
    expect(html.indexOf("data-citation-panel")).toBeGreaterThan(html.indexOf("Churn held flat."));
  });

  it("keeps a paragraph's text before its markers", () => {
    // So a marker arriving appends to the end of a sentence rather than inserting before it.
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "Revenue rose."), webCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html.indexOf("Revenue rose.")).toBeLessThan(html.indexOf("data-citation-marker"));
  });
});

describe("AC-5: the marker and panel are keyboard reachable with visible focus", () => {
  it("uses a real button, so Enter and Space both work without reimplementation", () => {
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "x"), webCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-citation-marker="c1"/);
    // Not a div with a click handler, which is focusable by nothing and activates on neither key.
    expect(html).not.toMatch(/<div[^>]*data-citation-marker/);
  });

  it("wires the marker to its panel and announces the expanded state", () => {
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "x"), webCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    // The id it claims to control actually exists, or a screen reader follows it nowhere.
    expect(html).toContain(`id="${controls}"`);
  });

  it("names the marker by its source, not by its number", () => {
    // A list of buttons all called "[1]", "[2]" tells a screen-reader user nothing about where they lead.
    const html = renderToStaticMarkup(
      <CitedMessageView message={message([text("t1", "x"), retrievalCitation("c1", ["t1"])])} t={t} />,
    );
    expect(html).toContain('aria-label="Show source: Quarterly Review &gt; By region"');
  });

  it("labels the panel as a region so it can be jumped to", () => {
    const html = renderToStaticMarkup(
      <CitationPanel part={webCitation("c1", []) as never} index={1} id="p1" expanded={true} t={t} />,
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Source: Annual report"');
  });

  it("provides a focus ring that is an outline rather than a colour", () => {
    expect(CITATION_STYLES).toContain(":focus-visible");
    expect(CITATION_STYLES).toContain("outline: 2px solid currentColor");
  });
});

describe("AC-6: an unresolvable source is a sentence, not a broken link", () => {
  it("classifies the three cases apart", () => {
    // A retrieval citation is *inside* the workspace and never had an external URL; an unresolvable one had a
    // URL that no longer works. Collapsing them would tell someone a document was deleted when it never left.
    expect(citationResolution(webCitation("c1", []) as never)).toBe("linkable");
    expect(citationResolution(retrievalCitation("c1", []) as never)).toBe("not-linkable");
    expect(citationResolution(webCitation("c1", []) as never, true)).toBe("unresolvable");
  });

  it("renders no anchor for a source that cannot be opened", () => {
    const html = renderToStaticMarkup(
      <CitationPanel part={retrievalCitation("c1", []) as never} index={1} id="p1" expanded={true} t={t} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("cannot be opened in a new tab");
    // The excerpt is still there: it is the evidence, and it is stored on the part.
    expect(html).toContain("Revenue rose nine percent across EMEA.");
  });

  it("says the source is gone, and still shows what was read", () => {
    const html = renderToStaticMarkup(
      <CitationPanel
        part={webCitation("c1", []) as never}
        index={1}
        id="p1"
        expanded={true}
        unresolvable={true}
        t={t}
      />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("no longer available");
    expect(html).toContain("Revenue rose nine percent.");
  });

  it("uses one error format for both", () => {
    // The consistent format AC-6 asks for: the same element and the same role, differing only in the sentence.
    for (const html of [
      renderToStaticMarkup(
        <CitationPanel part={retrievalCitation("c1", []) as never} index={1} id="p" expanded={true} t={t} />,
      ),
      renderToStaticMarkup(
        <CitationPanel part={webCitation("c1", []) as never} index={1} id="p" expanded={true} unresolvable t={t} />,
      ),
    ]) {
      expect(html).toContain('data-citation-error');
      expect(html).toContain('role="note"');
    }
  });

  it("marks the resolution on the panel so a host can style it", () => {
    const html = renderToStaticMarkup(
      <CitationPanel part={retrievalCitation("c1", []) as never} index={1} id="p" expanded={true} t={t} />,
    );
    expect(html).toContain('data-resolution="not-linkable"');
  });
});
