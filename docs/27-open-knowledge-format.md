# The Open Knowledge Format, Read Against Our Document Model

Status: read, decided — **wait for 1.0**, 27 Aug 2026 · REQ-050
([#209](https://github.com/Rise-Experts/retinue/issues/209)), task
[#220](https://github.com/Rise-Experts/retinue/issues/220)
Sources: [the announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
· [the specification](https://github.com/GoogleCloudPlatform/open-knowledge-format) (Apache-2.0)

## What it is

A directory of Markdown files, one per **concept** — a table, a metric, a policy, a runbook — each with a block
of YAML front matter for structured fields and prose for everything else. Optional `index.md` files give a
navigable hierarchy; an optional `log.md` gives a chronological history. Links between concepts are
bundle-relative paths. There is no required manifest: a bundle may declare its version in the root `index.md`'s
front matter and otherwise a consumer is expected to make a best effort.

The distinction that decides whether this is relevant to us: **OKF is an ingestion and exchange format, not a
retrieval strategy.** It says nothing about embeddings, chunking or ranking. It sits *before* our chunker, beside
the document parsers.

## The first finding is the version number

The issue was written against **v0.1**. The specification is now at **0.2**, and the changes are breaking:

| v0.1 | 0.2 |
|---|---|
| `timestamp` | `generated: { by, at }` |
| a `# Citations` section in the body | a `sources` list in front matter |

Additive in the same release: `verified`, `status`, `stale_after`, credibility signals on sources, an actor
convention, and a new concept type (*Attested Computation*). The `okf/` directory in the original repository is
already "a frozen snapshot, no longer maintained" — the format moved to its own repository.

So: two breaking renames and a substantially larger metadata vocabulary, in roughly ten weeks. That is not a
criticism of the format — Google describes 0.1 as a starting point and says so plainly — but it is the single most
important input to the adopt-or-wait decision, and it arrived before any code was written.

## Read against `Document` / `Block` / `Chunk`

### What maps cleanly, demonstrated rather than asserted

A real concept file from the reference `acme_retail` bundle, through **our own** `parseMarkdown` and
`chunkDocument`:

```
blocks: 8   chunks: 3   locators: ["Definition", "Reporting cuts", "Trust and freshness"]
```

The body needs nothing new. OKF's structure — one concept per file, `#` sections within it — is a good fit for our
chunker's heading-aware boundaries, and the heading trail becomes the `locator` that makes a citation name a
*section* rather than a document. One concept file is one source: `sourceType: "file"`, `sourceId` the
bundle-relative path.

| OKF | Ours | Fit |
|---|---|---|
| Concept body (headings, prose, lists, tables) | `DocumentBlock[]` | Clean; every block kind has a counterpart |
| `#` sections | `Chunk.locator` | Clean, and better than most corpora give us |
| One concept file | One `IndexSourceInput` source | Clean |
| `index.md` hierarchy | `OutlineCatalogue` (from [#219](https://github.com/Rise-Experts/retinue/issues/219)) | Clean — and see below, this is the interesting one |
| Bundle-relative links | *nothing* | No counterpart |

### What has no counterpart, OKF → us

| OKF field | What it says | Why we have nowhere to put it |
|---|---|---|
| `type` | The concept's *kind* — `Metric`, `Table`, `Attested Computation` | `KnowledgeSourceType` is `file \| artifact \| message \| external`: **provenance**, not meaning. `type: Metric` is a semantic claim and there is no field for it |
| `status`, `stale_after` | Lifecycle: this definition is stable, and re-verify it after this date | We have no notion of a chunk expiring. Retrieval cannot decline to serve stale material because nothing records staleness |
| `generated: { by, at }`, `verified: [{ by, at }]` | Who produced this and who signed it off | No provenance on a knowledge source beyond which embedding model ran |
| `sources` | The material *this* concept derives from, with credibility signals | We model citations **out** — a chunk supporting a claim — and not citations **in** |
| `tags` | Cross-cutting categorisation | No counterpart. `authSubjects` is access, not topic |
| `log.md` | Per-bundle history | No counterpart; no per-source history anywhere |
| Concept-to-concept links | A knowledge *graph* | Our chunks have no edges. `listBySource` gives siblings inside one source and nothing across sources |

The lifecycle group is the one worth taking seriously. `stale_after` encodes something our retrieval genuinely
cannot express: *this answer was correct when written and must be re-checked after a date.* A platform that serves
a two-year-old policy definition with full confidence has a real defect, and we have no field that would let a
retriever notice.

### What has no counterpart, us → OKF

**`authSubjects`.** A bundle is a directory; who may read which concept is entirely outside the format. Our whole
retrieval path is permission-filtered — `scope()` before the query, `filterTools` before discovery, a citation
refused when the reader may not open the source — and an OKF bundle carries none of that. This is not a flaw in an
exchange format, but it means **"ingest an OKF bundle" is always a policy decision at the boundary**, never a
straight import: somebody has to say who may read what, per concept or per bundle, and the format will not say it
for them.

Also absent: `page` (our PDF provenance), embeddings and chunk boundaries — the last two exactly as the issue
predicted, since OKF is not a retrieval strategy.

## What a source adapter would cost — AC-2

Concretely, and the parts are unequal.

| Work | Ports touched | Cost |
|---|---|---|
| A concept parser beside `parseMarkdown` | `DocumentParser` | Small — the body already works |
| Reading the front matter properly | none | **The real cost. See below** |
| Carrying `type`, `status`, `stale_after` to retrieval | `IndexSourceInput`, `KnowledgeChunk`, `KnowledgeStore` | A port change plus a Postgres migration |
| Honouring `stale_after` at query time | `Retriever` | Small, once the field exists |
| Bundle walking, `index.md`, links | `OutlineCatalogue` (already exists) | Small |
| Chunking | **nothing** | Nothing at all — see below |

**Chunking needs nothing.** [#219](https://github.com/Rise-Experts/retinue/issues/219) measured 400/800 against
200/400 and 800/1600 over exactly this kind of corpus: the default is right for prose, and an OKF concept is
prose. That is a concrete answer rather than an assumption, and it is the cheapest half of this estimate.

**The front matter is the expensive half, and the reason is YAML.** OKF 0.2 uses flow mappings
(`generated: { by: x, at: y }`), lists of mappings (`verified`, `sources`), and inline arrays. This package has
**no YAML dependency and no YAML parser**, and both ways forward have a real cost:

- *Write a subset parser.* A wrong parse of provenance is worse than no parse: `generated: { by: agent, at: … }`
  silently read as a string is provenance recorded as if it had been understood, and nothing downstream could
  tell.
- *Add a dependency.* The runtime's root reaches nothing third-party today, and that is a property with a test
  behind it. A YAML library for a format at 0.2 is a dependency acquired for something that may rename its fields
  again.

**Estimate: 2–3 PD**, plus a standing migration cost every time the format moves. The 0.1 → 0.2 renames would have
cost a day on their own, and there was no code to migrate yet.

## The decision: wait for 1.0 — AC-3

**Not now.** Three reasons, in order of weight:

1. **The format has already broken twice in ten weeks.** Adopting a 0.2 buys a migration, and the fields we would
   most want (`generated`, `sources`) are precisely the two that were renamed.
2. **The valuable parts require port and schema changes.** `status`/`stale_after` are worth having, and designing
   `KnowledgeChunk` around a moving vocabulary is how a format's churn becomes our migration. If we want lifecycle
   metadata on knowledge — and we should — the right order is to design it from *our* needs and then map OKF onto
   it. An importer is then a mapping, not an adoption.
3. **Nobody has a bundle.** No customer has asked, and the reference bundles are Google's own datasets. Building
   an importer for a format nobody is handing us is the "built, tested and unreachable" shape this repository has
   found seven times.

**Not declined, either.** The format is genuinely well-judged for what it is: Markdown a person can read and edit,
metadata a machine can use, no server, no schema registry, Apache-2.0. If organisational knowledge exchange
standardises anywhere, this is a plausible where.

**Revisit when either happens:**

- OKF reaches **1.0**, or publishes a compatibility commitment.
- **Somebody arrives with a bundle.** One real bundle is worth more than any amount of reading, because it says
  which fields are actually used.

Until then, this document is the mapping, and the two things below are what was taken now.

## What was taken now, for nothing

**A defect in our own parser, found by reading someone else's format.** OKF concept files carry a lot of front
matter, which raised the question of what ours does with it. The answer was: treats it as **content**. The real
`acme_retail` metric file produced 13 blocks, five of which were YAML soup, and a chunk whose entire text was
`--- type: Metric title: Revenue …` — embedded, retrievable, and citable. A question about revenue policy could be
answered with a block of YAML.

It was already happening to **this repository's own documentation site**: every page starts with a
`sidebar_position`. `parseMarkdown` now splits the front matter off, keeps the scalar keys on
`ExtractedDocument.frontMatter`, and **names in `warnings` the keys it could not read** rather than half-reading
them. The retrieval eval's corpus lost 18 chunks of metadata, and #219's numbers were re-measured against the fixed
parser.

**Confirmation that `OutlineCatalogue` is the right shape.** #219 found that `KnowledgeStore` cannot enumerate its
sources, and introduced a host-supplied outline port for the vector-less spike. OKF's `index.md` hierarchy is
exactly that port's data, arrived at independently by somebody else — which is the strongest evidence available
that the seam is in the right place.

## For the next reader

If you are picking this up because a bundle arrived: the mapping tables above are the design, the cost estimate is
the plan, and the order matters — **design our own lifecycle fields first**, then map OKF's onto them. The
temptation will be to copy `status` and `stale_after` verbatim because they are right there. They are 0.2's names.
