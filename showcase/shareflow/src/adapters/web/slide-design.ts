/**
 * The slide design — #620. One stylesheet for every place a slide is drawn: the PDF, the carousel PNGs, the
 * video (all printed from `buildSlidesHtml`) and the panel's preview, which carries a verbatim copy in
 * `web/src/lib/assistant/slideDesign.ts`. The parity test compares the two strings, so a change here that is
 * not made there fails a test instead of shipping a preview of a different design.
 *
 * ## The rules it keeps
 *
 * - **Every measure is `n * var(--u)`**, one hundredth of the slide's shorter side. The print page sets `--u`
 *   in px; the panel sets it in container units. Nothing here knows the slide's size. Corners too: `--r` is the
 *   theme's radius as a bare number (the px it has on a 1080 px slide), so a thumbnail's corners shrink with it.
 * - **Every colour comes from the theme's `--t-*` variables**, mixed with `color-mix` — a blob is the accent
 *   at a quarter strength, a card is the surface, a figure is a primary-to-accent gradient. The only
 *   literals are black and white, for the shade and the glass over a photo, where the photo is the colour.
 * - **Nothing moves unless the slide has `s-play`.** Printed, a slide is its final frame. The panel adds the
 *   class when a slide arrives (and never under `prefers-reduced-motion`); the video's player adds it to each
 *   slide in turn.
 *
 * ## The look
 *
 * A display type scale with tight tracking and balanced breaks; an eyebrow over the heading; content
 * anchored to the top and bottom of an asymmetric grid rather than centred; the slide's number as a large
 * outlined figure; a soft mesh of the palette behind everything and a fine grain over it; a photo graded to
 * the theme's two colours (a duotone) instead of darkened; bullets as numbered cards; glass cards over photos.
 */

/** How long a slide takes to arrive, in present mode and in the video. */
export const SLIDE_TRANSITION_MS = 700;
/** The easing of the arrival — fast out, long settle. */
export const SLIDE_TRANSITION_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

type Frame = Readonly<Record<string, string | number>>;
/**
 * The transitions as Web Animations keyframes, for the slide arriving (`in`) and the one leaving (`out`), moving
 * forward. Going back, `slide` runs mirrored — `transitionFrames` in the panel.
 */
export const SLIDE_TRANSITION_KEYFRAMES: Readonly<Record<"fade" | "slide" | "zoom" | "none", { readonly in: readonly Frame[]; readonly out: readonly Frame[] }>> = {
  fade: { in: [{ opacity: 0 }, { opacity: 1 }], out: [{ opacity: 1 }, { opacity: 0 }] },
  slide: {
    in: [{ transform: "translateX(100%)" }, { transform: "translateX(0%)" }],
    out: [
      { transform: "translateX(0%)", opacity: 1 },
      { transform: "translateX(-28%)", opacity: 0.3 },
    ],
  },
  zoom: {
    in: [
      { opacity: 0, transform: "scale(1.14)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    out: [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.92)" },
    ],
  },
  none: { in: [], out: [] },
};

export const SLIDE_DESIGN_CSS = `
@property --p { syntax: "<number>"; inherits: true; initial-value: 0; }
.slide {
  --ink: var(--t-text);
  --soft: color-mix(in srgb, var(--t-text) 66%, var(--t-bg));
  --faint: color-mix(in srgb, var(--t-text) 42%, var(--t-bg));
  --line: color-mix(in srgb, var(--t-text) 13%, transparent);
  --card: color-mix(in srgb, var(--t-surface) 78%, transparent);
  --card-edge: color-mix(in srgb, var(--t-text) 8%, transparent);
  --lift: 0 calc(0.5 * var(--u)) calc(3 * var(--u)) color-mix(in srgb, var(--t-text) 7%, transparent);
  --accent-ink: color-mix(in srgb, var(--t-accent) 74%, var(--t-text));
  --grad: linear-gradient(115deg, var(--t-primary) 5%, var(--accent-ink) 100%);
  --grad-solid: var(--t-primary);
  --badge: linear-gradient(135deg, var(--t-primary), color-mix(in srgb, var(--t-primary) 55%, var(--t-accent)));
  --blob-a: color-mix(in srgb, var(--t-accent) 24%, transparent);
  --blob-p: color-mix(in srgb, var(--t-primary) 16%, transparent);
  --duo-dark: color-mix(in srgb, var(--t-primary) 38%, black);
  --duo-light: color-mix(in srgb, var(--t-accent) 42%, white);
  --radius: calc(var(--r, 8) * 0.139 * var(--u));
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --pad-x: calc(7.5 * var(--u));
  --pad-y: calc(7.5 * var(--u));
  --fs: 1.1;
  position: relative;
  overflow: hidden;
  isolation: isolate;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: var(--pad-y) var(--pad-x) calc(var(--pad-y) + 2.5 * var(--u));
  background: var(--t-bg);
  color: var(--ink);
  font-family: var(--t-font-body);
  font-size: calc(3.1 * var(--fs) * var(--u));
  line-height: 1.45;
  text-align: left;
  -webkit-font-smoothing: antialiased;
  font-kerning: normal;
}
.slide *, .slide *::before, .slide *::after { box-sizing: border-box; }
.slide.f-landscape { --pad-x: calc(9.5 * var(--u)); --pad-y: calc(7 * var(--u)); --fs: 1.18; font-size: calc(2.8 * var(--fs) * var(--u)); }
.slide.tone-dark {
  --blob-a: color-mix(in srgb, var(--t-accent) 36%, transparent);
  --blob-p: color-mix(in srgb, var(--t-primary) 24%, transparent);
  --card: color-mix(in srgb, var(--t-text) 5%, transparent);
  --card-edge: color-mix(in srgb, var(--t-text) 12%, transparent);
  --lift: 0 calc(0.5 * var(--u)) calc(4 * var(--u)) color-mix(in srgb, black 30%, transparent);
  --accent-ink: color-mix(in srgb, var(--t-accent) 82%, var(--t-text));
}

/* ---- layers: the mesh, a photo and its grade, shapes, grain, the big number ---- */
.slide .s-mesh {
  position: absolute; inset: -8%; z-index: -5; pointer-events: none;
  background:
    radial-gradient(40% 36% at 88% 8%, var(--blob-a), transparent 72%),
    radial-gradient(46% 40% at 6% 94%, var(--blob-p), transparent 72%),
    radial-gradient(28% 24% at 62% 58%, color-mix(in srgb, var(--t-accent) 6%, transparent), transparent 70%);
}
.slide.v1 .s-mesh {
  background:
    radial-gradient(44% 38% at 8% 6%, var(--blob-p), transparent 72%),
    radial-gradient(42% 40% at 94% 90%, var(--blob-a), transparent 72%);
}
.slide.v2 .s-mesh {
  background:
    radial-gradient(64% 34% at 50% 108%, var(--blob-a), transparent 72%),
    radial-gradient(34% 30% at 96% 4%, var(--blob-p), transparent 72%);
}
.slide .s-grain {
  position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: 0.075;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E");
  background-size: calc(26 * var(--u));
}
.slide.tone-dark .s-grain { opacity: 0.11; }
/* A photo behind the slide, graded to the theme: its shadows become a deep primary, its lights a pale accent. */
.slide .s-bg {
  position: absolute; inset: 0; z-index: -4;
  background-color: white;
  background-image: linear-gradient(var(--duo-light), var(--duo-light)), linear-gradient(var(--duo-dark), var(--duo-dark)), var(--bg);
  background-blend-mode: multiply, lighten, luminosity;
  background-size: cover; background-position: center;
  filter: contrast(1.12) saturate(1.1);
}
.slide .s-shade {
  position: absolute; inset: 0; z-index: -3;
  background: linear-gradient(180deg, color-mix(in srgb, var(--duo-dark) 18%, transparent) 0%, color-mix(in srgb, var(--duo-dark) 40%, transparent) 45%, color-mix(in srgb, var(--duo-dark) 82%, transparent) 100%);
}
.slide .s-deco { position: absolute; inset: 0; z-index: -2; pointer-events: none; }
.slide .s-deco i { position: absolute; display: block; border-radius: 50%; }
.slide .s-deco .d1 { width: calc(72 * var(--u)); height: calc(72 * var(--u)); right: calc(-24 * var(--u)); top: calc(-26 * var(--u)); border: calc(0.3 * var(--u)) solid color-mix(in srgb, currentColor 20%, transparent); }
.slide .s-deco .d2 { width: calc(46 * var(--u)); height: calc(46 * var(--u)); right: calc(-11 * var(--u)); top: calc(-13 * var(--u)); border: calc(0.3 * var(--u)) solid color-mix(in srgb, currentColor 13%, transparent); }
.slide .s-deco .d3 { width: calc(3.2 * var(--u)); height: calc(3.2 * var(--u)); right: calc(31 * var(--u)); top: calc(33.5 * var(--u)); background: var(--t-accent); box-shadow: 0 0 calc(4 * var(--u)) calc(0.6 * var(--u)) color-mix(in srgb, var(--t-accent) 60%, transparent); }
.slide .s-index {
  position: absolute; top: calc(var(--pad-y) - 2.2 * var(--u)); right: var(--pad-x); z-index: -1; pointer-events: none;
  font-family: var(--t-font-heading); font-weight: 800; font-size: calc(15 * var(--fs) * var(--u)); line-height: 1; letter-spacing: -0.05em;
  font-variant-numeric: lining-nums;
  color: transparent; -webkit-text-stroke: calc(0.2 * var(--u)) color-mix(in srgb, var(--t-text) 24%, transparent);
}
.slide.logo-top-right .s-index { top: calc(var(--pad-y) + 6 * var(--u)); }

/* ---- type ---- */
.slide .s-body { position: relative; z-index: 1; flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: calc(3 * var(--u)); }
.slide h1, .slide h2, .slide h3, .slide h4 {
  font-family: var(--t-font-heading); color: var(--ink); margin: 0; font-weight: 700;
  letter-spacing: -0.03em; line-height: 1.04; text-wrap: balance;
}
.slide h1 { font-size: calc(8 * var(--fs) * var(--u)); }
.slide h2 { font-size: calc(6.2 * var(--fs) * var(--u)); }
.slide h3 { font-size: calc(3.6 * var(--fs) * var(--u)); letter-spacing: -0.015em; line-height: 1.15; }
.slide h4 { font-size: calc(3 * var(--fs) * var(--u)); letter-spacing: -0.01em; }
.slide :is(h1, h2) strong { color: transparent; background: var(--grad); -webkit-background-clip: text; background-clip: text; }
.slide p { margin: 0; text-wrap: pretty; }
.slide strong { font-weight: 700; }
.slide a { color: var(--accent-ink); text-decoration: none; }
.slide code { font-family: "JetBrains Mono", monospace; font-size: 0.88em; background: var(--card); border: 1px solid var(--card-edge); border-radius: calc(0.8 * var(--u)); padding: 0 calc(0.6 * var(--u)); }
.slide pre { background: var(--card); border: 1px solid var(--card-edge); border-radius: var(--radius); padding: calc(2.4 * var(--u)); font-size: calc(2.4 * var(--fs) * var(--u)); line-height: 1.5; white-space: pre-wrap; margin: 0; }
.slide pre code { background: none; border: 0; padding: 0; }
.slide table { border-collapse: collapse; font-size: calc(2.6 * var(--fs) * var(--u)); }
.slide th, .slide td { border-bottom: 1px solid var(--line); padding: calc(1.2 * var(--u)) calc(1.8 * var(--u)); text-align: left; }
.slide th { color: var(--soft); font-weight: 600; font-size: 0.85em; letter-spacing: 0.04em; text-transform: uppercase; }
.slide img { max-width: 100%; }
.slide ul, .slide ol { margin: 0; padding-left: calc(4.4 * var(--u)); }
.slide li::marker { color: var(--t-accent); }
.slide .s-head { display: flex; flex-direction: column; gap: calc(2.2 * var(--u)); max-width: 78%; }
.slide .s-head p { color: var(--soft); font-size: calc(3.3 * var(--fs) * var(--u)); max-width: 32em; }
.slide .s-eyebrow {
  display: inline-flex; align-items: center; gap: calc(1.6 * var(--u)); align-self: flex-start;
  font-family: var(--t-font-body); font-size: calc(1.9 * var(--fs) * var(--u)); font-weight: 700; line-height: 1.2;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent-ink);
}
.slide .s-eyebrow::before { content: ""; width: calc(4.4 * var(--u)); height: calc(0.32 * var(--u)); border-radius: calc(0.3 * var(--u)); background: var(--grad); }
.slide .s-num {
  position: absolute; right: var(--pad-x); bottom: calc(3.4 * var(--u)); z-index: 1;
  font-size: calc(1.8 * var(--fs) * var(--u)); font-weight: 700; letter-spacing: 0.14em; color: var(--ink); font-variant-numeric: tabular-nums;
}
.slide .s-num::before { content: ""; display: inline-block; vertical-align: middle; width: calc(4.4 * var(--u)); height: calc(0.24 * var(--u)); margin-right: calc(1.4 * var(--u)); background: currentColor; opacity: 0.35; }
.slide .s-num span { color: var(--faint); font-weight: 500; }
.slide .s-credit { position: absolute; left: var(--pad-x); bottom: calc(3.4 * var(--u)); z-index: 1; max-width: 55%; font-size: calc(1.7 * var(--fs) * var(--u)); color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slide .s-missing { color: var(--soft); font-size: calc(2.6 * var(--fs) * var(--u)); padding: calc(3 * var(--u)); text-align: center; }

/* ---- title: the deck's cover, on a field of the primary ---- */
.slide.l-title { background: var(--t-primary); --grad: linear-gradient(115deg, var(--t-on-primary) 0%, color-mix(in srgb, var(--t-accent) 78%, var(--t-on-primary)) 100%); --grad-solid: color-mix(in srgb, var(--t-accent) 78%, var(--t-on-primary)); --ink: var(--t-on-primary); --soft: color-mix(in srgb, var(--t-on-primary) 76%, transparent); --accent-ink: var(--t-on-primary); color: var(--ink); }
.slide.l-title .s-mesh {
  background:
    radial-gradient(52% 46% at 96% 0%, color-mix(in srgb, var(--t-accent) 72%, transparent), transparent 70%),
    radial-gradient(46% 40% at 72% 30%, color-mix(in srgb, var(--t-accent) 22%, transparent), transparent 72%),
    radial-gradient(60% 50% at 0% 100%, color-mix(in srgb, var(--t-on-primary) 12%, transparent), transparent 70%);
}
.slide.tone-dark.l-title { --grad: linear-gradient(115deg, var(--t-primary) 5%, var(--accent-ink) 100%); --grad-solid: var(--t-primary); background: var(--t-bg); --ink: var(--t-text); --soft: color-mix(in srgb, var(--t-text) 72%, transparent); --accent-ink: var(--t-text); }
.slide.tone-dark.l-title .s-mesh {
  background:
    radial-gradient(50% 44% at 92% 4%, color-mix(in srgb, var(--t-accent) 55%, transparent), transparent 70%),
    radial-gradient(50% 46% at 4% 100%, color-mix(in srgb, var(--t-primary) 42%, transparent), transparent 70%),
    radial-gradient(30% 26% at 60% 40%, color-mix(in srgb, var(--t-primary) 12%, transparent), transparent 70%);
}
.slide.l-title .s-body { justify-content: flex-end; gap: calc(3 * var(--u)); }
.slide.l-title h1 { font-size: calc(10.4 * var(--fs) * var(--u)); line-height: 0.98; letter-spacing: -0.045em; max-width: 94%; }
.slide.f-landscape.l-title h1 { max-width: 72%; font-size: calc(11 * var(--fs) * var(--u)); }
.slide.l-title .s-body > p { font-size: calc(3.6 * var(--fs) * var(--u)); color: var(--soft); max-width: 70%; }
.slide.l-title .s-eyebrow { padding: calc(1.1 * var(--u)) calc(2.2 * var(--u)); border-radius: calc(10 * var(--u)); border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: var(--ink); gap: calc(1.2 * var(--u)); }
.slide.l-title .s-eyebrow::before { width: calc(1.2 * var(--u)); height: calc(1.2 * var(--u)); border-radius: 50%; background: var(--t-accent); }
.slide.l-title .s-num { display: none; }

/* ---- section: a full-colour divider with its number set huge ---- */
.slide.l-section { background: var(--t-primary); --grad: linear-gradient(115deg, var(--t-on-primary) 0%, color-mix(in srgb, var(--t-accent) 78%, var(--t-on-primary)) 100%); --grad-solid: color-mix(in srgb, var(--t-accent) 78%, var(--t-on-primary)); --ink: var(--t-on-primary); --soft: color-mix(in srgb, var(--t-on-primary) 76%, transparent); --accent-ink: var(--t-on-primary); color: var(--ink); }
.slide.l-section .s-mesh {
  background:
    linear-gradient(140deg, transparent 35%, color-mix(in srgb, var(--t-accent) 50%, transparent) 100%),
    radial-gradient(50% 46% at 6% 4%, color-mix(in srgb, var(--t-on-primary) 12%, transparent), transparent 70%);
}
.slide.tone-dark.l-section { --grad: linear-gradient(115deg, var(--t-primary) 5%, var(--accent-ink) 100%); --grad-solid: var(--t-primary); background: color-mix(in srgb, var(--t-primary) 16%, var(--t-bg)); --ink: var(--t-text); --soft: color-mix(in srgb, var(--t-text) 72%, transparent); --accent-ink: var(--t-accent); }
.slide.l-section .s-body { justify-content: flex-end; }
.slide.l-section :is(h1, h2, h3) { font-size: calc(9 * var(--fs) * var(--u)); line-height: 1; letter-spacing: -0.045em; max-width: 88%; }
.slide.l-section .s-body > p { font-size: calc(3.4 * var(--fs) * var(--u)); color: var(--soft); max-width: 70%; }
.slide.l-section .s-index { left: calc(var(--pad-x) - 1 * var(--u)); right: auto; top: calc(var(--pad-y) - 4 * var(--u)); font-size: calc(40 * var(--fs) * var(--u)); -webkit-text-stroke: calc(0.28 * var(--u)) color-mix(in srgb, var(--ink) 50%, transparent); }
.slide.l-section .s-eyebrow::before { background: currentColor; }

/* ---- bullets: the head, and the list as numbered cards ---- */
.slide.l-bullets .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide.l-bullets .s-main :is(ul, ol) { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: calc(1.6 * var(--u)); counter-reset: sd-item; }
.slide.l-bullets .s-main li {
  counter-increment: sd-item; position: relative; min-height: calc(8.6 * var(--u));
  padding: calc(2.2 * var(--u)) calc(3 * var(--u)) calc(2.2 * var(--u)) calc(10.6 * var(--u));
  display: flex; flex-direction: column; justify-content: center;
  background: var(--card); border: 1px solid var(--card-edge); border-radius: var(--radius); box-shadow: var(--lift);
  font-size: calc(3 * var(--fs) * var(--u)); line-height: 1.35;
}
.slide.l-bullets .s-main li::before {
  content: counter(sd-item, decimal-leading-zero);
  position: absolute; left: calc(2.4 * var(--u)); top: 50%; margin-top: calc(-2.8 * var(--u));
  width: calc(5.6 * var(--u)); height: calc(5.6 * var(--u)); display: grid; place-items: center;
  border-radius: min(50%, calc(var(--r, 8) * 0.13 * var(--u))); background: var(--badge); color: var(--t-on-primary);
  font-family: var(--t-font-heading); font-size: calc(1.9 * var(--fs) * var(--u)); font-weight: 700; letter-spacing: 0.02em; line-height: 1;
}
.slide.l-bullets .s-main li :is(ul, ol) { display: none; }
.slide.f-landscape.l-bullets .s-body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); align-items: center; gap: calc(9 * var(--u)); }
.slide.f-landscape.l-bullets .s-head { max-width: none; }
.slide.l-bullets .s-main > p { color: var(--soft); }

/* ---- agenda: numbered rows between hairlines ---- */
.slide.l-agenda .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide.f-landscape.l-agenda .s-body { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 7fr); align-items: center; gap: calc(9 * var(--u)); }
.slide.f-landscape.l-agenda .s-head { max-width: none; }
.slide .s-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.slide .s-item { display: flex; align-items: baseline; gap: calc(4 * var(--u)); padding: calc(2.4 * var(--u)) 0; border-top: 1px solid var(--line); font-size: calc(3.7 * var(--fs) * var(--u)); font-weight: 600; letter-spacing: -0.015em; line-height: 1.2; }
.slide .s-item:last-child { border-bottom: 1px solid var(--line); }
.slide .s-k { flex: none; min-width: calc(5 * var(--u)); font-family: var(--t-font-heading); font-size: calc(2.2 * var(--fs) * var(--u)); font-weight: 700; letter-spacing: 0.08em; color: var(--accent-ink); font-variant-numeric: tabular-nums; }
.slide .s-t { flex: 1; min-width: 0; }

/* ---- timeline: steps on a line, across in landscape and down in portrait ---- */
.slide.l-timeline .s-body { justify-content: space-between; gap: calc(6 * var(--u)); }
.slide .s-steps { list-style: none; margin: 0; padding: 0; position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: calc(3.4 * var(--u)); }
.slide .s-steps::before { content: ""; position: absolute; left: 0; right: 0; top: calc(1.62 * var(--u)); height: calc(0.36 * var(--u)); border-radius: calc(0.3 * var(--u)); background: linear-gradient(90deg, var(--t-primary), var(--t-accent)); transform-origin: left center; }
.slide .s-step { position: relative; display: flex; flex-direction: column; gap: calc(1.4 * var(--u)); padding-top: calc(6.4 * var(--u)); }
.slide .s-dot { position: absolute; left: 0; top: 0; width: calc(3.6 * var(--u)); height: calc(3.6 * var(--u)); border-radius: 50%; background: var(--t-bg); border: calc(0.8 * var(--u)) solid var(--t-accent); box-shadow: 0 0 0 calc(1 * var(--u)) color-mix(in srgb, var(--t-accent) 16%, transparent); }
.slide .s-when { font-family: var(--t-font-heading); font-size: calc(4.4 * var(--fs) * var(--u)); font-weight: 800; letter-spacing: -0.03em; line-height: 1; color: var(--ink); }
.slide .s-what { color: var(--soft); font-size: calc(2.8 * var(--fs) * var(--u)); line-height: 1.35; }
.slide.f-portrait .s-steps { grid-auto-flow: row; gap: calc(4.4 * var(--u)); padding-left: calc(8.4 * var(--u)); }
.slide.f-portrait .s-steps::before { left: calc(1.62 * var(--u)); right: auto; top: calc(1.8 * var(--u)); bottom: calc(1.8 * var(--u)); width: calc(0.36 * var(--u)); height: auto; background: linear-gradient(180deg, var(--t-primary), var(--t-accent)); transform-origin: center top; }
.slide.f-portrait .s-step { padding-top: 0; gap: calc(0.8 * var(--u)); }
.slide.f-portrait .s-dot { left: calc(-8.4 * var(--u)); top: calc(0.3 * var(--u)); }
.slide.f-portrait .s-when { font-size: calc(4 * var(--fs) * var(--u)); }

/* ---- stat: one figure, set huge in the theme's gradient ---- */
.slide .s-stat {
  font-family: var(--t-font-heading); font-weight: 800; line-height: 0.92; letter-spacing: -0.045em; white-space: nowrap;
  font-variant-numeric: lining-nums; padding-bottom: 0.06em;
  color: transparent; background: var(--grad); -webkit-background-clip: text; background-clip: text;
}
.slide.l-stat .s-body { justify-content: space-between; gap: calc(4 * var(--u)); }
.slide.l-stat .s-main { display: flex; flex-direction: column; align-items: flex-start; gap: calc(2.6 * var(--u)); }
.slide.l-stat .s-stat { font-size: calc(min(30, 140 / var(--n)) * var(--u)); }
.slide.l-stat .s-main p { font-size: calc(3.9 * var(--fs) * var(--u)); line-height: 1.28; color: var(--soft); max-width: 20em; }
.slide.f-landscape.l-stat .s-main { flex-direction: row; align-items: flex-end; gap: calc(7 * var(--u)); }
.slide.f-landscape.l-stat .s-stat { font-size: calc(min(34, 180 / var(--n)) * var(--u)); }
.slide.f-landscape.l-stat .s-main > :not(.s-stat, .s-bar, .s-ring) { max-width: 38%; padding-bottom: calc(2 * var(--u)); }
.slide.f-landscape.l-stat .s-bar { display: none; }
.slide .s-bar { width: calc(16 * var(--u)); height: calc(1 * var(--u)); border-radius: calc(1 * var(--u)); background: var(--grad); transform-origin: left center; }
.slide .s-ring { --p: 0; position: relative; flex: none; width: calc(52 * var(--u)); height: calc(52 * var(--u)); display: grid; place-items: center; }
.slide .s-ring::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(var(--t-primary), var(--t-accent) calc(var(--p) * 1%), color-mix(in srgb, var(--t-text) 9%, transparent) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.8 * var(--u)), black calc(100% - 2.8 * var(--u)));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.8 * var(--u)), black calc(100% - 2.8 * var(--u)));
}
.slide .s-ring::after { content: ""; position: absolute; inset: calc(6 * var(--u)); border-radius: 50%; background: var(--card); border: 1px solid var(--card-edge); }
.slide .s-ring .s-stat { position: relative; z-index: 1; font-size: calc(min(14, 62 / var(--n)) * var(--u)) !important; }
.slide.f-landscape .s-ring { width: calc(58 * var(--u)); height: calc(58 * var(--u)); }

/* ---- stat grid: two to four figures on cards ---- */
.slide.l-stat-grid .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide .s-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(2 * var(--u)); }
.slide.f-landscape .s-grid { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
.slide .s-cell {
  position: relative; overflow: hidden; min-height: calc(28 * var(--u));
  display: flex; flex-direction: column; justify-content: flex-end; gap: calc(1.6 * var(--u));
  padding: calc(4 * var(--u)) calc(3.6 * var(--u)) calc(3.6 * var(--u));
  background: var(--card); border: 1px solid var(--card-edge); border-radius: var(--radius); box-shadow: var(--lift);
}
.slide .s-cell::before { content: ""; position: absolute; left: calc(3.6 * var(--u)); top: 0; width: calc(6 * var(--u)); height: calc(0.7 * var(--u)); border-radius: 0 0 calc(0.5 * var(--u)) calc(0.5 * var(--u)); background: var(--grad); }
.slide.l-stat-grid .s-stat { font-size: calc(min(12, 56 / var(--n)) * var(--u)); }
.slide.f-landscape.l-stat-grid .s-stat { font-size: calc(min(13, 150 / var(--count, 3) / var(--n)) * var(--u)); }
.slide .s-label { color: var(--soft); font-size: calc(2.6 * var(--fs) * var(--u)); line-height: 1.3; }

/* ---- two columns, and a comparison that takes a side ---- */
.slide:is(.l-two-column, .l-comparison) .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide .s-cols { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: calc(2.4 * var(--u)); align-items: stretch; }
.slide .s-col { display: flex; flex-direction: column; gap: calc(2.2 * var(--u)); padding: calc(4.2 * var(--u)) calc(4 * var(--u)); background: var(--card); border: 1px solid var(--card-edge); border-radius: var(--radius); box-shadow: var(--lift); min-width: 0; }
.slide .s-col :is(h2, h3, h4, h5, h6) { font-size: calc(3.8 * var(--fs) * var(--u)); letter-spacing: -0.02em; }
.slide .s-col :is(ul, ol) { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: calc(1.5 * var(--u)); font-size: calc(2.8 * var(--fs) * var(--u)); line-height: 1.35; }
.slide .s-col li { position: relative; padding-left: calc(3.8 * var(--u)); }
.slide .s-col li::before { content: ""; position: absolute; left: 0; top: 0.5em; width: calc(1.5 * var(--u)); height: calc(1.5 * var(--u)); border-radius: 50%; background: var(--t-accent); }
.slide .s-col > p { color: var(--soft); font-size: calc(2.8 * var(--fs) * var(--u)); }
.slide.l-comparison .s-cols { gap: calc(5.6 * var(--u)); }
.slide.l-comparison .s-col:first-child { background: transparent; box-shadow: none; border: 1px dashed color-mix(in srgb, var(--t-text) 22%, transparent); color: var(--soft); }
.slide.l-comparison .s-col:first-child :is(h2, h3, h4, h5, h6) { color: var(--soft); }
.slide.l-comparison .s-col:first-child li::before { background: var(--faint); border-radius: calc(0.3 * var(--u)); height: calc(0.4 * var(--u)); top: 0.68em; }
.slide.l-comparison .s-col:last-child { background: color-mix(in srgb, var(--t-primary) 8%, var(--t-bg)); border-color: color-mix(in srgb, var(--t-primary) 32%, transparent); }
.slide.tone-dark.l-comparison .s-col:last-child { background: color-mix(in srgb, var(--t-primary) 12%, transparent); }
.slide .s-vs {
  position: absolute; left: 50%; top: 50%; z-index: 2; transform: translate(-50%, -50%);
  width: calc(8.4 * var(--u)); height: calc(8.4 * var(--u)); border-radius: 50%; display: grid; place-items: center;
  background: var(--badge); color: var(--t-on-primary); box-shadow: 0 0 0 calc(1.2 * var(--u)) var(--t-bg);
  font-family: var(--t-font-heading); font-size: calc(2.3 * var(--fs) * var(--u)); font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1;
}

/* ---- two to four even columns (issue 664) — pricing tiers, plans — side by side in every format, never stacked ---- */
.slide.l-columns .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide.l-columns .s-cols, .slide.f-portrait.l-columns .s-cols { grid-template-columns: repeat(var(--count, 3), minmax(0, 1fr)); gap: calc(2 * var(--u)); }
.slide.l-columns .s-col, .slide.f-portrait.l-columns .s-col { gap: calc(1.8 * var(--u)); padding: calc(3.4 * var(--u)) calc(2.8 * var(--u)); }
.slide.l-columns .s-col li { padding-left: calc(3 * var(--u)); }
.slide.f-portrait.l-columns .s-col :is(h2, h3, h4, h5, h6) { font-size: calc(4 * var(--fs) * var(--u)); }
.slide.f-portrait.l-columns .s-col :is(ul, ol), .slide.f-portrait.l-columns .s-col > p { font-size: calc(2.9 * var(--fs) * var(--u)); gap: calc(1.6 * var(--u)); }
.slide.l-columns .s-cols:has(> :nth-child(4)) .s-col :is(h2, h3, h4, h5, h6) { font-size: calc(3.2 * var(--fs) * var(--u)); }
.slide.l-columns .s-cols:has(> :nth-child(4)) .s-col :is(ul, ol), .slide.l-columns .s-cols:has(> :nth-child(4)) .s-col > p { font-size: calc(2.4 * var(--fs) * var(--u)); }

/* ---- landscape: the main element sits in the middle of the room the head leaves ---- */
.slide.f-landscape:is(.l-timeline, .l-two-column, .l-comparison, .l-columns, .l-stat-grid, .l-team, .l-logos) .s-body { justify-content: flex-start; }
.slide.f-landscape:is(.l-timeline, .l-two-column, .l-comparison, .l-columns, .l-stat-grid, .l-team, .l-logos) .s-body > :last-child { margin-block: auto; }

/*
 * ---- portrait: the same centring, and the content grown to fill a phone-shaped slide ----
 * Production, 2026-09-29: on 4:5 the logo wall and two-column slides pinned their content to the bottom, under a
 * band of empty space, because the body spaced head and content apart and the landscape rule stopped at landscape.
 */
.slide.f-portrait:is(.l-two-column, .l-comparison, .l-columns, .l-stat-grid, .l-team, .l-logos) .s-body { justify-content: flex-start; }
.slide.f-portrait:is(.l-two-column, .l-comparison, .l-columns, .l-stat-grid, .l-team, .l-logos) .s-body > :last-child { margin-block: auto; }
.slide.f-portrait .s-cols { grid-template-columns: minmax(0, 1fr); gap: calc(3.2 * var(--u)); }
.slide.f-portrait.l-comparison .s-cols { gap: calc(7 * var(--u)); }
.slide.f-portrait .s-col { gap: calc(2.6 * var(--u)); }
.slide.f-portrait .s-col :is(h2, h3, h4, h5, h6) { font-size: calc(5 * var(--fs) * var(--u)); }
.slide.f-portrait .s-col :is(ul, ol) { gap: calc(2 * var(--u)); font-size: calc(3.6 * var(--fs) * var(--u)); }
.slide.f-portrait .s-col > p { font-size: calc(3.6 * var(--fs) * var(--u)); }
.slide.f-portrait .s-brands { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(3 * var(--u)); }
.slide.f-portrait .s-brand { aspect-ratio: 3 / 2; }
.slide.f-portrait .s-photo { width: calc(28 * var(--u)); }

/* ---- team and logos ---- */
.slide:is(.l-team, .l-logos) .s-body { justify-content: space-between; gap: calc(5 * var(--u)); }
.slide .s-people { display: grid; grid-template-columns: repeat(auto-fit, minmax(calc(24 * var(--u)), 1fr)); gap: calc(4.4 * var(--u)) calc(3 * var(--u)); }
.slide .s-person { margin: 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: calc(2.2 * var(--u)); }
.slide .s-photo { width: calc(22 * var(--u)); aspect-ratio: 1; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: var(--card); box-shadow: 0 0 0 calc(0.7 * var(--u)) var(--t-bg), 0 0 0 calc(1.1 * var(--u)) color-mix(in srgb, var(--t-accent) 55%, transparent); }
.slide .s-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide .s-person strong { display: block; font-family: var(--t-font-heading); font-size: calc(3 * var(--fs) * var(--u)); letter-spacing: -0.015em; line-height: 1.15; }
.slide .s-person figcaption span { display: block; margin-top: calc(0.5 * var(--u)); color: var(--soft); font-size: calc(2.3 * var(--fs) * var(--u)); }
.slide .s-brands { display: grid; grid-template-columns: repeat(auto-fit, minmax(calc(24 * var(--u)), 1fr)); gap: calc(2 * var(--u)); }
.slide .s-brand { aspect-ratio: 16 / 10; display: grid; place-items: center; padding: calc(3.4 * var(--u)); background: var(--card); border: 1px solid var(--card-edge); border-radius: var(--radius); }
.slide.tone-dark .s-brand { background: color-mix(in srgb, var(--t-text) 92%, transparent); border-color: transparent; }
.slide.f-landscape .s-brands { grid-template-columns: repeat(auto-fit, minmax(calc(30 * var(--u)), 1fr)); gap: calc(2.4 * var(--u)); }
.slide .s-brand img { max-width: 100%; max-height: 100%; object-fit: contain; filter: grayscale(1) contrast(1.05); opacity: 0.86; }
.slide .s-foot { color: var(--soft); }

/* ---- quote: an oversized mark, the words in the display face, a portrait ---- */
.slide.l-quote { background: color-mix(in srgb, var(--t-surface) 55%, var(--t-bg)); }
.slide.l-quote .s-body { justify-content: center; gap: calc(1 * var(--u)); }
.slide .s-mark {
  height: calc(16 * var(--u)); margin-left: calc(-1.4 * var(--u));
  font-family: var(--t-font-heading); font-size: calc(36 * var(--fs) * var(--u)); font-weight: 700; line-height: 0.82;
  color: transparent; background: var(--grad); -webkit-background-clip: text; background-clip: text;
}
.slide.l-quote .s-main { display: flex; flex-direction: column; gap: calc(4.4 * var(--u)); }
.slide.l-quote blockquote { margin: 0; padding: 0; border: 0; font-family: var(--t-font-heading); font-size: calc(6 * var(--fs) * var(--u)); font-weight: 500; line-height: 1.18; letter-spacing: -0.022em; color: var(--ink); text-wrap: balance; }
.slide.l-quote blockquote p + p { margin-top: calc(2 * var(--u)); }
.slide.f-landscape.l-quote .s-main { max-width: 80%; }
.slide .s-cite { display: flex; align-items: center; gap: calc(2.4 * var(--u)); }
.slide .s-portrait { margin: 0; flex: none; width: calc(11 * var(--u)); height: calc(11 * var(--u)); border-radius: 50%; overflow: hidden; box-shadow: 0 0 0 calc(0.5 * var(--u)) var(--t-bg), 0 0 0 calc(0.9 * var(--u)) var(--t-accent); }
.slide .s-portrait img { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide .s-attr { font-size: calc(2.7 * var(--fs) * var(--u)); font-weight: 600; color: var(--soft); letter-spacing: 0.01em; }

/* ---- image: the picture edge to edge, its words on a glass card ---- */
.slide.l-image .s-body { position: static; justify-content: flex-end; }
.slide.l-image .s-figure { position: absolute; inset: 0; z-index: -3; margin: 0; display: grid; place-items: center; overflow: hidden; background: var(--t-surface); }
.slide.l-image .s-figure img { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide.l-image .s-figure::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 55%, color-mix(in srgb, var(--duo-dark) 50%, transparent) 100%); }
.slide .s-card {
  align-self: flex-start; max-width: 84%; display: flex; flex-direction: column; gap: calc(1.6 * var(--u));
  padding: calc(3.6 * var(--u)) calc(4 * var(--u)); border-radius: calc(var(--radius) + 0.8 * var(--u));
  background: color-mix(in srgb, var(--t-bg) 72%, transparent); border: 1px solid color-mix(in srgb, white 30%, transparent);
  -webkit-backdrop-filter: blur(calc(2.4 * var(--u))) saturate(1.4); backdrop-filter: blur(calc(2.4 * var(--u))) saturate(1.4);
  box-shadow: 0 calc(2 * var(--u)) calc(6 * var(--u)) color-mix(in srgb, black 22%, transparent);
}
.slide .s-card h2 { font-size: calc(5 * var(--fs) * var(--u)); }
.slide .s-card p { color: var(--soft); }
.slide.l-image :is(.s-num, .s-credit) { color: white; text-shadow: 0 1px 3px color-mix(in srgb, black 45%, transparent); }
.slide.l-image .s-num span { color: color-mix(in srgb, white 75%, transparent); }

/* ---- a picture beside the text ---- */
.slide:is(.l-image-left, .l-image-right) .s-body { position: static; }
.slide .s-split { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.slide .s-split .s-figure { position: relative; margin: calc(3 * var(--u)); min-height: 0; overflow: hidden; display: grid; place-items: center; border-radius: calc(var(--radius) + 1 * var(--u)); background: var(--t-surface); }
.slide .s-split .s-figure img { width: 100%; height: 100%; object-fit: cover; display: block; }
.slide .s-split .s-text { display: flex; flex-direction: column; justify-content: center; gap: calc(2.6 * var(--u)); min-width: 0; padding: var(--pad-y) var(--pad-x); }
.slide .s-split .s-text h2 { font-size: calc(5.8 * var(--fs) * var(--u)); }
.slide .s-split .s-text :is(ul, ol) { display: flex; flex-direction: column; gap: calc(1.2 * var(--u)); }
.slide .s-split .s-text p { color: var(--soft); }
.slide.l-image-left .s-split .s-figure { order: 0; margin-right: 0; }
.slide.l-image-right .s-split .s-figure { order: 2; margin-left: 0; }
.slide.f-portrait .s-split { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1.1fr) minmax(0, 1fr); }
.slide.f-portrait.l-image-left .s-split .s-figure { margin: calc(3 * var(--u)) calc(3 * var(--u)) 0; }
.slide.f-portrait.l-image-right .s-split .s-figure { margin: 0 calc(3 * var(--u)) calc(3 * var(--u)); }
.slide.f-portrait .s-split .s-text { padding: calc(5 * var(--u)) var(--pad-x) calc(7 * var(--u)); justify-content: flex-start; }
.slide.f-portrait.l-image-right .s-split .s-text { padding-top: var(--pad-y); justify-content: center; }
.slide.f-landscape.l-image-right .s-num { right: auto; left: var(--pad-x); }
.slide.f-portrait.l-image-right .s-num { color: white; text-shadow: 0 1px 3px color-mix(in srgb, black 45%, transparent); right: calc(6 * var(--u)); bottom: calc(6 * var(--u)); }

/* ---- call to action: a button, and where it goes ---- */
.slide.l-cta { background: color-mix(in srgb, var(--t-surface) 50%, var(--t-bg)); }
.slide.l-cta .s-mesh {
  background:
    radial-gradient(50% 44% at 100% 0%, color-mix(in srgb, var(--t-accent) 34%, transparent), transparent 70%),
    radial-gradient(56% 50% at 0% 100%, color-mix(in srgb, var(--t-primary) 26%, transparent), transparent 70%);
}
.slide.l-cta .s-body { justify-content: center; gap: calc(5.4 * var(--u)); }
.slide.l-cta :is(h1, h2) { font-size: calc(8.6 * var(--fs) * var(--u)); letter-spacing: -0.04em; line-height: 1; }
.slide.l-cta .s-head { max-width: 90%; }
.slide.l-cta .s-head p { font-size: calc(3.6 * var(--fs) * var(--u)); }
.slide .s-action { display: flex; flex-direction: column; align-items: flex-start; gap: calc(2.4 * var(--u)); }
.slide .s-button {
  display: inline-flex; align-items: center; gap: calc(2.2 * var(--u));
  padding: calc(2.5 * var(--u)) calc(4.6 * var(--u)); border-radius: min(calc(10 * var(--u)), calc(var(--r, 8) * 0.28 * var(--u)));
  background: var(--badge); color: var(--t-on-primary); font-weight: 700; font-size: calc(3.3 * var(--fs) * var(--u)); letter-spacing: -0.005em; line-height: 1.1;
  box-shadow: 0 calc(1.6 * var(--u)) calc(5 * var(--u)) color-mix(in srgb, var(--t-primary) 34%, transparent), inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
}
.slide .s-arrow { display: inline-block; width: calc(1.7 * var(--u)); height: calc(1.7 * var(--u)); border-top: calc(0.45 * var(--u)) solid currentColor; border-right: calc(0.45 * var(--u)) solid currentColor; transform: rotate(45deg); margin-left: calc(-0.2 * var(--u)); }
.slide .s-link { font-size: calc(2.6 * var(--fs) * var(--u)); font-weight: 600; letter-spacing: 0.02em; color: var(--soft); }

/* ---- a photo behind the slide: white type, glass cards ---- */
.slide.has-bg {
  --ink: white; --soft: color-mix(in srgb, white 84%, transparent); --faint: color-mix(in srgb, white 62%, transparent);
  --line: color-mix(in srgb, white 24%, transparent); --card: color-mix(in srgb, white 11%, transparent);
  --card-edge: color-mix(in srgb, white 24%, transparent); --lift: none; --accent-ink: var(--duo-light);
  --grad: linear-gradient(115deg, white 10%, var(--duo-light) 100%); --grad-solid: white;
  background: var(--duo-dark); color: var(--ink);
}
.slide.has-bg .s-mesh { display: none; }
.slide.has-bg :is(h1, h2, h3, blockquote) { text-shadow: 0 calc(0.2 * var(--u)) calc(2 * var(--u)) color-mix(in srgb, black 30%, transparent); }
.slide.has-bg :is(.s-main li, .s-cell, .s-col, .s-brand, .s-card) {
  -webkit-backdrop-filter: blur(calc(1.8 * var(--u))) saturate(1.3); backdrop-filter: blur(calc(1.8 * var(--u))) saturate(1.3);
}
.slide.has-bg .s-card { background: color-mix(in srgb, white 12%, transparent); }
.slide.has-bg.l-comparison .s-col:last-child { background: color-mix(in srgb, white 16%, transparent); }
.slide.has-bg .s-logo { background: color-mix(in srgb, white 88%, transparent); border-radius: calc(var(--r, 8) * 0.093 * var(--u)); padding: calc(0.8 * var(--u)) calc(1.4 * var(--u)); }

/* ---- the project's logo in the theme's corner ---- */
.slide .s-logo { position: absolute; z-index: 2; max-height: calc(6.4 * var(--u)); max-width: calc(22 * var(--u)); object-fit: contain; }
.slide .s-logo.top-left { top: calc(3.6 * var(--u)); left: var(--pad-x); }
.slide .s-logo.top-right { top: calc(3.6 * var(--u)); right: var(--pad-x); }
.slide .s-logo.bottom-left { bottom: calc(3 * var(--u)); left: var(--pad-x); }
.slide .s-logo.bottom-right { bottom: calc(3 * var(--u)); right: var(--pad-x); }
.slide.logo-bottom-right .s-num { bottom: calc(11 * var(--u)); }
.slide.logo-bottom-left .s-credit { bottom: calc(11 * var(--u)); }
.slide:is(.logo-top-left, .logo-top-right) { padding-top: calc(var(--pad-y) + 5 * var(--u)); }

/* ---- portrait: a feed image is read on a phone, so the head is bigger and the content fuller ---- */
.slide.f-portrait .s-head :is(h1, h2) { font-size: calc(7.4 * var(--fs) * var(--u)); }
.slide.f-portrait.l-bullets .s-main li { min-height: calc(10 * var(--u)); font-size: calc(3.3 * var(--fs) * var(--u)); padding-left: calc(11.4 * var(--u)); }
.slide.f-portrait.l-bullets .s-main li::before { width: calc(6.2 * var(--u)); height: calc(6.2 * var(--u)); margin-top: calc(-3.1 * var(--u)); font-size: calc(2.1 * var(--fs) * var(--u)); }
.slide.f-portrait .s-item { font-size: calc(4.4 * var(--fs) * var(--u)); padding: calc(3 * var(--u)) 0; }
.slide.f-portrait .s-k { font-size: calc(2.4 * var(--fs) * var(--u)); }
.slide.f-portrait .s-steps { gap: calc(5.6 * var(--u)); }
.slide.f-portrait .s-when { font-size: calc(4.8 * var(--fs) * var(--u)); }
.slide.f-portrait .s-what { font-size: calc(3.1 * var(--fs) * var(--u)); }
.slide.f-portrait .s-cell { min-height: calc(34 * var(--u)); }
.slide.f-portrait .s-label { font-size: calc(2.9 * var(--fs) * var(--u)); }
.slide.f-portrait .s-col { padding: calc(4.6 * var(--u)) calc(4 * var(--u)); }
.slide.f-portrait .s-col :is(ul, ol) { font-size: calc(3 * var(--fs) * var(--u)); gap: calc(1.8 * var(--u)); }
.slide.f-portrait .s-people:has(> :nth-child(4):last-child) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.slide.f-portrait .s-people:has(> :nth-child(7)) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.slide.f-portrait .s-people:has(> :nth-child(7)) .s-photo { width: calc(16 * var(--u)); }
.slide.f-landscape .s-people:has(> :nth-child(7)) .s-photo { width: calc(17 * var(--u)); }

.slide.f-portrait .s-split .s-text h2 { font-size: calc(6.4 * var(--fs) * var(--u)); }
.slide.f-portrait .s-split .s-text { font-size: calc(3.3 * var(--fs) * var(--u)); }
.slide.f-portrait.l-cta .s-body { justify-content: flex-end; }

/*
 * ---- print: the PDF keeps the design, less what PDF readers draw badly ----
 * Measured with macOS Preview (Core Graphics): text clipped to a gradient printed as the gradient's box
 * beside the word, and soft shadows and backdrop blurs as grey rectangles. Chromium's own viewer drew both
 * correctly; a LinkedIn reader or an iPhone may not. So the printed page sets the figures and highlighted words
 * in the gradient's solid colour and leaves the shadows and blurs out (and, for size, the grain and the photo's
 * contrast). The carousel and the video are screenshots, and keep all of it.
 */
@media print {
  .slide, .slide *, .slide *::before, .slide *::after { box-shadow: none !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; text-shadow: none !important; }
  .slide :is(.s-stat, .s-mark), .slide :is(h1, h2) strong { background: none; -webkit-background-clip: border-box; background-clip: border-box; color: var(--grad-solid); }
  /* Measured too: the grain added about 1.8 MB to every printed page and the photo's contrast filter about 7 MB,
     both printed as full-page bitmaps. Without them a page with a photo is about 0.4 MB. */
  .slide .s-grain { display: none; }
  .slide .s-bg { filter: none; }
}

/* ---- build-ins: only on a slide that is playing ---- */
@keyframes sd-rise { from { opacity: 0; transform: translateY(calc(3.2 * var(--u))); } to { opacity: 1; transform: none; } }
@keyframes sd-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes sd-pop { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: none; } }
@keyframes sd-ring { from { --p: 0; } }
@keyframes sd-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sd-grow-y { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes sd-drift { from { transform: translate3d(0, 0, 0) scale(1); } to { transform: translate3d(-2.5%, 1.8%, 0) scale(1.06); } }
@keyframes sd-kenburns { from { transform: scale(1.1); } to { transform: scale(1); } }
@keyframes sd-reveal { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0 0 0 0); } }
@keyframes sd-orbit { from { opacity: 0; transform: scale(0.8) rotate(-20deg); } to { opacity: 1; transform: none; } }
.slide.s-play .s-mesh { animation: sd-drift 14s ease-in-out both alternate infinite; }
.slide.s-play .s-deco i { animation: sd-orbit 1.4s var(--ease) both; }
.slide.s-play .s-deco .d2 { animation-delay: 0.12s; }
.slide.s-play .s-deco .d3 { animation-delay: 0.5s; }
.slide.s-play .s-index { animation: sd-fade 1.2s ease-out both 0.25s; }
.slide.s-play .s-eyebrow { animation: sd-rise 0.7s var(--ease) both 0.05s; }
.slide.s-play :is(.s-body, .s-head, .s-text, .s-card) > :is(h1, h2, h3) { animation: sd-rise 0.9s var(--ease) both 0.14s; }
.slide.s-play :is(.s-body, .s-head, .s-text, .s-card) > :is(p, ul, ol, table, pre) { animation: sd-rise 0.9s var(--ease) both 0.34s; }
.slide.s-play.l-bullets .s-main > :is(ul, ol) { animation: none; }
.slide.s-play.l-bullets .s-main li { animation: sd-rise 0.7s var(--ease) both 0.45s; }
.slide.s-play.l-bullets .s-main li:nth-child(2) { animation-delay: 0.57s; }
.slide.s-play.l-bullets .s-main li:nth-child(3) { animation-delay: 0.69s; }
.slide.s-play.l-bullets .s-main li:nth-child(4) { animation-delay: 0.81s; }
.slide.s-play.l-bullets .s-main li:nth-child(5) { animation-delay: 0.93s; }
.slide.s-play.l-bullets .s-main li:nth-child(6) { animation-delay: 1.05s; }
.slide.s-play.l-bullets .s-main li:nth-child(n + 7) { animation-delay: 1.17s; }
.slide.s-play :is(.s-item, .s-cell, .s-person, .s-brand, .s-col) { animation: sd-rise 0.75s var(--ease) both; animation-delay: calc(0.4s + var(--i, 0) * 0.13s); }
.slide.s-play .s-steps::before { animation: sd-grow-x 1.3s var(--ease) both 0.3s; }
.slide.s-play.f-portrait .s-steps::before { animation-name: sd-grow-y; }
.slide.s-play .s-step { animation: sd-rise 0.75s var(--ease) both; animation-delay: calc(0.5s + var(--i, 0) * 0.2s); }
.slide.s-play .s-stat { animation: sd-pop 0.9s var(--ease) both 0.2s; }
.slide.s-play .s-ring::before { animation: sd-ring 1.6s var(--ease) both 0.3s; }
.slide.s-play .s-bar { animation: sd-grow-x 1s var(--ease) both 0.55s; }
.slide.s-play .s-vs { animation: sd-fade 0.6s ease-out both 0.75s; }
.slide.s-play .s-mark { animation: sd-pop 1s var(--ease) both 0.02s; }
.slide.s-play.l-quote .s-main > * { animation: sd-rise 0.9s var(--ease) both 0.2s; }
.slide.s-play .s-cite { animation-delay: 0.6s !important; }
.slide.s-play .s-card { animation: sd-rise 0.9s var(--ease) both 0.35s; }
.slide.s-play.l-image .s-figure img, .slide.s-play .s-bg { animation: sd-kenburns 9s ease-out both; }
.slide.s-play .s-split .s-figure { animation: sd-reveal 1.1s var(--ease) both 0.05s; }
.slide.s-play .s-action { animation: sd-pop 0.8s var(--ease) both 0.5s; }
@media (prefers-reduced-motion: reduce) {
  .slide.s-play, .slide.s-play *, .slide.s-play *::before, .slide.s-play *::after { animation: none !important; }
}
`;

/**
 * The video's player — #620. Runs in the deck page built with `mode: "play"`: shows each slide in turn with its
 * transition, restarts its build-ins (`s-play`), counts its figures up, and resolves when the plan is done. The
 * recorder waits on `window.__slides.play(plan)`.
 *
 * `countUp` is a transcription of `countUpText` in `slides.ts`; a test runs both over one matrix.
 */
export const SLIDE_PLAYER_JS = `(function () {
  var FRAMES = ${JSON.stringify(SLIDE_TRANSITION_KEYFRAMES)};
  var DURATION = ${SLIDE_TRANSITION_MS};
  var EASING = ${JSON.stringify(SLIDE_TRANSITION_EASING)};
  function countUp(figure, progress) {
    var m = /^(\\D*?)(\\d(?:[\\d.,]*\\d)?)(.*)$/.exec(figure);
    if (m === null || progress >= 1) return figure;
    var prefix = m[1] || "", digits = m[2] || "", suffix = m[3] || "";
    var last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
    var decimal = last !== -1 && digits.length - last - 1 !== 3 ? digits[last] : "";
    var group = decimal === "" ? (last === -1 ? "" : digits[last]) : (digits.slice(0, last).replace(/\\d/g, "")[0] || "");
    var places = decimal === "" ? 0 : digits.length - last - 1;
    var intPart = decimal === "" ? digits : digits.slice(0, last);
    var value = Number((group === "" ? intPart : intPart.split(group).join("")) + (decimal === "" ? "" : "." + digits.slice(last + 1)));
    var t = Math.max(0, progress);
    var eased = 1 - Math.pow(1 - t, 3);
    var parts = (value * eased).toFixed(places).split(".");
    var whole = parts[0] || "0", fraction = parts[1] || "";
    var grouped = group === "" ? whole : whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, group);
    return prefix + grouped + (places > 0 ? decimal + fraction : "") + suffix;
  }
  function slides() { return Array.prototype.slice.call(document.querySelectorAll("section.slide")); }
  var current = -1;
  function count(slide) {
    var figures = Array.prototype.slice.call(slide.querySelectorAll(".s-stat[data-figure]"));
    var start = performance.now() + 250, span = 1400;
    function tick(now) {
      var p = Math.min(1, Math.max(0, (now - start) / span));
      figures.forEach(function (el) { el.textContent = countUp(el.getAttribute("data-figure") || "", p); });
      if (p < 1) requestAnimationFrame(tick);
    }
    figures.forEach(function (el) { el.textContent = countUp(el.getAttribute("data-figure") || "", 0); });
    requestAnimationFrame(tick);
  }
  function show(index, transition) {
    var all = slides(), next = all[index], prev = current >= 0 ? all[current] : null;
    if (!next || next === prev) return;
    next.classList.remove("s-play");
    void next.offsetWidth;
    next.classList.add("s-on", "s-play");
    next.style.zIndex = "2";
    if (prev) prev.style.zIndex = "1";
    count(next);
    var frames = FRAMES[transition] || FRAMES.fade;
    if (transition === "none" || !next.animate) {
      if (prev) prev.classList.remove("s-on", "s-play");
    } else {
      next.animate(frames.in, { duration: DURATION, easing: EASING, fill: "both" });
      if (prev) {
        var out = prev.animate(frames.out, { duration: DURATION, easing: EASING, fill: "both" });
        out.onfinish = function () { prev.classList.remove("s-on", "s-play"); out.cancel(); };
      }
    }
    current = index;
  }
  function play(plan) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      plan.steps.forEach(function (step) {
        setTimeout(function () { show(step.index, step.transition); }, Math.max(0, step.atMs - (performance.now() - t0)));
      });
      setTimeout(function () { resolve(true); }, plan.totalMs);
    });
  }
  window.__slides = { count: slides().length, show: show, play: play, countUp: countUp };
})();`;
