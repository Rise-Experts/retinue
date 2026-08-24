/**
 * Citation rendering (#138).
 *
 * The provenance work in #137 has no user-facing effect until a citation is something a person can click and a
 * grounded claim looks different from an unsupported one. Five decisions carry that.
 *
 * **Markers inline, panels after the message.** A citation arriving mid-stream appends a marker to the claim it
 * grounds and appends a panel to the list below — it never inserts above the reader's position. AC-4 phrased as
 * something testable: the markup for the first N citations is a *prefix* of the markup for N+1, so nothing
 * already on screen moves. A panel expanding in place between paragraphs would satisfy no such property.
 *
 * **The grounded/ungrounded distinction is not colour.** A grounded claim carries a marker and an underline;
 * an ungrounded one carries neither. Both survive greyscale and colour-blindness because neither is a hue —
 * and both are also announced, via visually-hidden text, since a marker and an underline are invisible to a
 * screen reader. AC-2 has a visual half and a non-visual half and they need different mechanisms.
 *
 * **The marker is a `<button>`.** Not a styled `<span>` with a click handler: a button is focusable, activates
 * on Enter *and* Space, and announces its expanded state — all of which AC-5 asks for and none of which has to
 * be reimplemented. `aria-expanded` and `aria-controls` tie it to its panel.
 *
 * **No hardcoded strings.** Every word goes through `t`, including the brackets around a marker number:
 * not every locale brackets footnotes.
 *
 * **An unresolvable source is a sentence, not a dead link.** AC-6. A retrieval citation has no URL a browser
 * can follow, and a deleted source has one that 404s; both render the excerpt with a note, because the excerpt
 * is the evidence and it is stored on the part.
 */

import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { Message, MessagePart } from "../types/index.js";
import { CITATION_IDS } from "../localization.js";
import { citationHref, citationLabel, groundedPartIds, partKey } from "./part-summary.js";
import { citationViewModel, citationResolution } from "../citations.js";
import type { CitationResolution, CitationViewModel } from "../citations.js";

/**
 * Re-exported, not redefined. The view model moved to `../citations.ts` so something without React can build
 * it (#155 AC-5); every existing importer kept working because of this line.
 */
export { citationViewModel, citationResolution };
export type { CitationResolution, CitationViewModel };
import type { T } from "./components.js";

type CitationPart = Extract<MessagePart, { type: "citation" }>;

const identity: T = (id) => id;

/**
 * Visually hidden but announced.
 *
 * Inline styles rather than a class, because this package ships no stylesheet and a host that forgot to include
 * one would otherwise get the text rendered visibly in the middle of a sentence. The clip-rect technique is
 * used rather than `display: none` — the latter removes it from the accessibility tree too, which defeats the
 * purpose.
 */
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

/**
 * The inline marker.
 *
 * `index` is 1-based because it is a footnote number a person reads, not an array position.
 */
export const CitationMarker = (props: {
  readonly part: CitationPart;
  readonly index: number;
  readonly panelId: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly t?: T;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  return (
    <button
      type="button"
      className={props.className}
      data-citation-marker={props.part.id}
      // Ties the marker to the panel it controls, so a screen reader can move between them and so the
      // expanded state is announced rather than only drawn.
      aria-expanded={props.expanded}
      aria-controls={props.panelId}
      // The accessible name is the *source*, not "[1]" — a list of buttons all called "[1]", "[2]" tells a
      // screen-reader user nothing about where they lead.
      aria-label={`${t(CITATION_IDS.expand)}: ${citationLabel(props.part)}`}
      onClick={props.onToggle}
    >
      {t(CITATION_IDS.marker, { index: props.index })}
    </button>
  );
};

/**
 * The expandable source panel.
 *
 * Always rendered, with `hidden` toggled, rather than mounted on expand. Mounting on expand would change the
 * document's height as the reader clicks — and `hidden` keeps it out of the accessibility tree too, so nothing
 * is announced that is not shown.
 */
export const CitationPanel = (props: {
  readonly part: CitationPart;
  readonly index: number;
  readonly id: string;
  readonly expanded: boolean;
  readonly unresolvable?: boolean;
  readonly t?: T;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  const href = citationHref(props.part);
  const resolution = citationResolution(props.part, props.unresolvable === true);
  return (
    <div
      id={props.id}
      className={props.className}
      data-citation-panel={props.part.id}
      data-resolution={resolution}
      hidden={!props.expanded}
      // A region so a screen reader can jump to it, labelled by the source it describes.
      role="region"
      aria-label={`${t(CITATION_IDS.source)}: ${citationLabel(props.part)}`}
    >
      <p data-citation-source>
        {resolution === "linkable" && href !== null ? (
          // `noreferrer` as well as `noopener`: a cited source has no business learning which conversation
          // linked to it.
          <a href={href} rel="noopener noreferrer" target="_blank">
            {citationLabel(props.part)}
          </a>
        ) : (
          <span>{citationLabel(props.part)}</span>
        )}
      </p>
      {resolution !== "linkable" ? (
        // AC-6: the consistent error format, and the same one `PartView` uses for an error part — a labelled
        // note rather than a link that goes nowhere.
        <p data-citation-error role="note">
          {t(resolution === "unresolvable" ? CITATION_IDS.unresolvable : CITATION_IDS.notLinkable)}
        </p>
      ) : null}
      <blockquote data-citation-excerpt>{props.part.excerpt}</blockquote>
      <p data-citation-retrieved>{t(CITATION_IDS.retrievedAt, { retrievedAt: props.part.retrievedAt })}</p>
    </div>
  );
};

/**
 * A text part with its citation markers, and the announcement of whether it is grounded.
 *
 * The markers go *after* the text, which is what makes a mid-stream citation an append rather than an insert.
 * `data-grounded` is the hook a host styles the underline from; the visually-hidden text is what a screen
 * reader gets, because an underline is not announced.
 */
export const GroundedText = (props: {
  readonly text: string;
  readonly partId: string;
  readonly grounded: boolean;
  readonly markers: readonly ReactNode[];
  readonly t?: T;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  return (
    <p className={props.className} data-part="text" data-grounded={props.grounded}>
      {props.text}
      <span style={VISUALLY_HIDDEN}>
        {t(props.grounded ? CITATION_IDS.grounded : CITATION_IDS.ungrounded)}
      </span>
      {props.markers}
    </p>
  );
};

/**
 * A whole message, with grounded text and a footnote list of citations.
 *
 * Ordering is the AC-4 mechanism: text parts in document order, then every citation panel in the order the
 * citations arrived. Appending a citation appends a marker to one paragraph and a panel to the end of the list,
 * so the prefix of the DOM a reader is looking at is unchanged.
 */
export const CitedMessageView = (props: {
  readonly message: Message;
  /** Citation ids whose source could not be resolved. Kept out of the part so it stays a durable snapshot. */
  readonly unresolvable?: readonly string[];
  readonly t?: T;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  const baseId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const unresolvable = new Set(props.unresolvable ?? []);

  const citations = props.message.parts.filter((p): p is CitationPart => p.type === "citation");
  const grounded = groundedPartIds(props.message.parts);
  // 1-based footnote numbers, assigned once in arrival order so a marker's number never changes as more
  // citations stream in — renumbering would move text under the reader's eye, which is exactly AC-4's concern.
  const numberOf = new Map(citations.map((c, i) => [c.id, i + 1]));
  const panelId = (id: string) => `${baseId}-citation-${id}`;
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={props.className} data-role={props.message.role} data-cited-message>
      {props.message.parts.map((part) => {
        if (part.type === "citation") return null;
        if (part.type !== "text")
          return (
            <div key={partKey(part)} data-part={part.type}>
              {"text" in part ? String(part.text) : null}
            </div>
          );
        const supporting = citations.filter((c) => c.supports.includes(part.id));
        return (
          <GroundedText
            key={partKey(part)}
            partId={part.id}
            text={part.text}
            grounded={grounded.has(part.id)}
            t={props.t}
            markers={supporting.map((citation) => (
              <CitationMarker
                key={citation.id}
                part={citation}
                index={numberOf.get(citation.id) ?? 1}
                panelId={panelId(citation.id)}
                expanded={expanded.has(citation.id)}
                onToggle={() => toggle(citation.id)}
                t={props.t}
              />
            ))}
          />
        );
      })}
      {citations.length > 0 ? (
        <div data-citation-list>
          <p data-citation-count>{t(CITATION_IDS.sourceCount, { count: citations.length })}</p>
          {citations.map((citation) => (
            <CitationPanel
              key={citation.id}
              part={citation}
              index={numberOf.get(citation.id) ?? 1}
              id={panelId(citation.id)}
              expanded={expanded.has(citation.id)}
              unresolvable={unresolvable.has(citation.id)}
              t={props.t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The stylesheet a host can include to get the non-colour treatment and focus rings for free.
 *
 * A string constant rather than a `.css` file because this package has no asset pipeline — a host imports it
 * and injects it, or ignores it and styles the `data-` attributes itself.
 *
 * **Every rule here is deliberately hue-free.** The grounded/ungrounded distinction is a dotted underline and a
 * superscript marker; the focus ring is an outline. In greyscale, in high contrast, and to a colour-blind
 * reader they all still read — which is AC-2, and which a colour would not survive.
 */
export const CITATION_STYLES = `
[data-part="text"][data-grounded="true"] {
  /* Not a colour: a dotted underline survives greyscale and colour-blindness. */
  text-decoration: underline dotted;
  text-underline-offset: 0.2em;
}
[data-citation-marker] {
  /* A superscript number is the second non-colour signal, and the conventional one for provenance. */
  vertical-align: super;
  font-size: 0.75em;
  background: none;
  border: 0;
  padding: 0 0.15em;
  cursor: pointer;
  font-weight: 600;
}
[data-citation-marker]:focus-visible,
[data-citation-panel] a:focus-visible {
  /* An outline, not a colour change: visible at any contrast setting and in greyscale. */
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
[data-citation-panel] {
  border-left: 3px solid currentColor;
  padding: 0.5em 0.75em;
  margin: 0.5em 0;
}
[data-citation-excerpt] {
  margin: 0.35em 0;
  font-style: italic;
}
[data-citation-error] {
  /* Marked by weight and a rule rather than red, for the same reason. */
  font-weight: 600;
  border-top: 1px dashed currentColor;
  padding-top: 0.35em;
}
@media (max-width: 480px) {
  /* Mobile first: the panel goes full width and the excerpt keeps its indent. */
  [data-citation-panel] { padding: 0.5em 0.5em; }
}
`;
