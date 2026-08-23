
## Citation rendering (#138)

The provenance work in #137 has no user-facing effect until a citation is something a person can click and a
grounded claim looks different from an unsupported one.

### Markers inline, panels after the message

A citation arriving mid-stream appends a marker to the claim it grounds and appends a panel to the list below.
It never inserts above the reader's position, and it never renumbers — numbers are assigned once in **arrival
order**, because renumbering as citations stream in would change text the reader is already looking at, which
is the most disorienting form of a layout jump.

That gives the requirement a testable form: **the view model for N citations is a prefix of the one for N+1**.
Every panel already on screen keeps its position and its number, and every marker already rendered keeps its
number. A panel expanding in place between paragraphs would satisfy no such property, which is why the list
goes last — expanding one only ever grows the bottom of the message.

Panels are always in the tree with `hidden` toggled rather than mounted on expand. Mounting on expand changes
the document's height as the reader clicks, and `hidden` keeps the panel out of the accessibility tree too, so
nothing is announced that is not shown.

### Grounded vs ungrounded, without colour

Two mechanisms, because the requirement has two halves:

- **Visual:** a dotted underline on the paragraph and a superscript marker. Neither is a hue, so both survive
  greyscale, colour-blindness and forced-colours mode. A test asserts the shipped stylesheet contains no hex
  colour, no `rgb()`/`hsl()`, and no `color:` property at all — `currentColor` is the one exception and it
  cannot introduce a hue of its own.
- **Non-visual:** visually-hidden text saying whether the claim is supported. A marker and an underline are
  invisible to a screen reader, so the visual treatment alone would leave the distinction unavailable to
  exactly the readers who most need it stated.

`data-grounded` is derived from the citation graph, never from the prose. A claim reading *"According to the Q3
report [1]…"* is **not** grounded unless a citation names it — asserted, because that sentence is what a
heuristic would get wrong.

### Keyboard and semantics

The marker is a real `<button>`: focusable, activating on Enter *and* Space, announcing its expanded state —
none of which has to be reimplemented, and all of which a styled `<div>` with a click handler lacks entirely.
`aria-expanded` and `aria-controls` tie it to its panel, and a test checks the id it claims to control actually
exists.

Its accessible name is the **source**, not the number. A list of buttons all called "[1]", "[2]" tells a
screen-reader user nothing about where they lead.

The focus ring is an `outline`, for the same reason the grounded treatment is an underline.

### Localisation

Every user-visible string goes through `t`, including the brackets around a marker number — not every locale
brackets footnotes, and a component that wrapped the number itself would be unlocalisable in the way hardest to
notice. Ids live in `CITATION_IDS` rather than as literals at call sites, so a component cannot spell one
differently from the catalogue: a mistyped id renders as the id, which looks like a translation gap rather than
a typo.

The sharpest test of "nothing hardcoded" is rendering with the *identity* translator: every user-visible string
is then an id, so any literal in the component shows up as prose among the ids.

### An unresolvable source is a sentence

Three cases, kept apart because a reader needs different sentences:

| Resolution | Meaning |
|---|---|
| `linkable` | A web source with a URL a browser can open |
| `not-linkable` | A retrieval citation — inside the workspace, no external URL ever existed |
| `unresolvable` | Had a URL that no longer works |

Collapsing the last two would tell someone a document was deleted when it never left. Neither renders an
anchor, both render the excerpt — the excerpt is the evidence and it is stored on the part — and both use one
error format, differing only in the sentence.

### Testing note

React is a **peer** dependency the host provides, so it was not installed and components could not be rendered
at all. It is now a *dev* dependency and the tests render to static markup with `react-dom/server` — no DOM, no
jsdom, no test-library. What that cannot exercise is a click, so the expanded state is rendered directly rather
than toggled. Said plainly, because "we tested the component" should not imply interaction was covered.

The ordering logic sits in a React-free `citationViewModel`, for the same reason `part-summary.ts` is
React-free: the append-only property is provable about a list and merely observable about a DOM tree.
