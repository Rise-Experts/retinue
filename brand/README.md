# Brand

<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

The palette, the type pairing and the usage rules live in **[`tokens.json`](tokens.json)**, with the reasoning for
each choice on the token itself. This file explains the shape of that decision; the token file is the decision.

Read from `tokens.json` by `npm run check:brand`, which measures every documented contrast pair against WCAG's
own formula and fails if the site's stylesheet stops mentioning a colour. A token file nothing reads is a
document, and the stylesheet drifts from it in the first hurry.

## Built on the identity that already existed

**#234b7e** navy, **#4f81bd** blue, **#7aa6d8** for dark grounds — the same navy the organisation's documents
already use. A rebrand nobody asked for is a cost with no benefit, so the work here was applying an identity
rather than inventing one.

## The marks

| File | What it is |
|---|---|
| `retinue-mark.svg` | The product mark — a principal and its retinue |
| `retinue-lockup.svg` | The same with the wordmark, so the name can be judged *as* a logo |
| `og-retinue.svg` | The social preview, 1200×630 inside a square canvas — see the note in the file |
| `retinue-avatar.svg` / `.png` | The organisation avatar, 512², mark on its own navy ground. npm renders it on both light and dark chrome, so it is not transparent |
| `rise-experts-mark.svg` | The organisation's mark, icon only |
| `rise-experts-lockup.svg` | Mark plus wordmark, for a site header or a letterhead |
| `steward-mark.svg` | An alternative candidate — custody rather than control |
| `steward-lockup.svg` | As above |

**The sweep is deliberately open.** A closed ring of dots is a loading spinner, and every multi-agent product
already ships one; the gap makes it a retinue attending someone rather than a circle of nodes. It is also the
honest picture — a team is assembled around a person, not a topology. That gap is the mark's one distinguishing
feature, which is why `usage.clearSpace` exists and why the social preview embeds the mark's real geometry rather
than redrawing it. The first attempt at the preview moved the dots by hand and closed the sweep.

**The favicon is not the mark scaled down.** Below about 20px the five attendant dots merge into the centre and it
reads as a blob, so `website/static/img/favicon.svg` keeps three of them and enlarges everything: the *shape* of
an attended centre survives, which is what a reader recognises in a tab strip.

## What is not production-ready

**The wordmarks use `<text>` with a font stack, not outlined paths.** They render with whatever font the viewer
has, so the letter shapes are not fixed — the same file looks different on two machines, and a logo whose shapes
move is not a logo. Outlining against a licensed face is the last step before public use, and the name was not
settled when the marks were drawn.

**Two things need a human with an account**, and neither can be done from a repository:

- The **GitHub social preview** is set through the repository's Settings page. `og-retinue.png` is the image;
  the API has no field for it.
- The **npm organisation avatar** is set on npmjs.com, and `retinue-avatar.png` is the file to upload. There is no
  per-package icon — the avatar on a package page belongs to the organisation — which is why "an icon on the
  package" means the org avatar plus a mark in the README, by absolute URL, since a relative one is a 404 on
  npmjs.com.

Both PNGs are committed rather than built. The only rasteriser on the machine that produced them is `qlmanage`,
which is macOS-only, and a build step that works on one developer's machine is a build step that breaks CI. Each
SVG carries its own regeneration note.

## Where the tokens are applied

| Surface | File |
|---|---|
| Documentation site | `website/src/css/custom.css`, both themes |
| Site favicon, logo, social preview | `website/docusaurus.config.ts` + `website/static/img/` |
| The reference app | `examples/public/index.html` |
| Package READMEs | The mark, by absolute URL |

No web font anywhere. A Google Fonts stylesheet is a third party learning every reader's IP address and a page
whose type shifts when their CDN is slow; `check:brand` fails on any external asset host in the built site.
