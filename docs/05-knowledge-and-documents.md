# RAG, Attachments, Vision and Documents

## File pipeline

```mermaid
flowchart LR
  Upload["Upload"] --> Inspect["Inspect and authorize"]
  Inspect --> Store["Store immutable version"]
  Store --> Extract["Extract content"]
  Extract --> OCR["OCR / vision when needed"]
  OCR --> Normalize["Normalize"]
  Normalize --> Chunk["Structure-aware chunks"]
  Chunk --> Index["Keyword and vector indexes"]
  Index --> Retrieve["Permission-aware retrieval"]
```

## Attachments

Support upload sessions, progress, MIME sniffing, size limits, extension checks, optional malware scanning, versions, permissions, signed references and processing state. Original versions are immutable.

Initial formats:

- Images.
- PDF.
- Markdown, text and HTML.
- DOCX.
- CSV/XLSX extraction.
- PPTX extraction.
- Audio/video transcription through adapters.

## PDF, OCR and vision

- Detect pages with usable text before OCR.
- Render and OCR only necessary pages.
- Correct orientation and retain bounding boxes/confidence.
- Extract tables separately.
- Preserve page-level provenance.
- Use vision for charts, diagrams, screenshots and visual meaning.
- Mark low-confidence extraction.
- Treat extracted/OCR content as untrusted data, never instructions.

PDF writing supports report generation, page composition, merge/split and optional watermarking. Deterministic renderers own file creation.

## Document writing

Models produce structured edit proposals. A deterministic writer validates and applies them to a new artifact/file version. Destructive overwrite requires approval.

Artifacts are markdown/structured-content first and support version history, restore and export to HTML, PDF and DOCX.

## RAG ingestion

Stages:

1. Authorization and source registration.
2. Extraction and normalization.
3. Structure-aware chunking.
4. Embedding and keyword indexing.
5. Validation and source publication.

Chunks retain source/version IDs, type, page/slide/sheet/cell/timestamp location, parent relation, metadata, hash and permission scope.

## Retrieval

Use hybrid retrieval:

1. Query interpretation.
2. Authorization filters applied before search.
3. Vector and keyword retrieval.
4. Metadata filtering.
5. Rank fusion.
6. Optional reranking.
7. Context-budget selection.
8. Citation-ready output.

Deletion or permission changes propagate to chunks and indexes. Embedding-model changes support versioned re-indexing.

## Interfaces

- `BlobStore`
- `FileInspector`
- `DocumentParser`
- `OcrProvider`
- `VisionProvider`
- `TranscriptionProvider`
- `ChunkingStrategy`
- `EmbeddingProvider`
- `VectorIndex`
- `KeywordIndex`
- `Reranker`
- `ArtifactRenderer`

## Initial tools

- `list_files`, `read_file`, `search_files`
- `scan_document`, `analyze_image`
- `extract_text`, `extract_tables`
- `summarize_document`, `compare_documents`
- `create_artifact`, `update_artifact`, `export_artifact`
- `create_pdf`, `convert_file`
- `get_file_processing_status`

## Acceptance criteria

- Retrieval never returns another tenant's content.
- Citations resolve to exact source versions and locations.
- Removing a source removes its searchable content.
- OCR confidence and failures are visible.
- Original files remain unchanged unless an explicit approved replacement occurs.
- RAG evaluation covers retrieval relevance, groundedness and citation correctness.


## Attachment storage (#129)

`BlobStore` above is one interface. The implementation is two, and the split is not cosmetic.

`BlobStore` as built in #102 stores **JSON values** — a `put(value: unknown)` returning a `BlobRef`, backed by
a `blobs` table. That is the right home for a large tool result or a checkpoint payload, and the wrong home
for file bytes: bytes in a relational column means base64 in `jsonb`, which #102 declined to do when it
refused to make `blobs` a pointer table. So attachments use two ports:

- **`FileMetadataStore`** — one row per attachment, in Postgres (`0013_files`). Tenant-scoped, keyset-paged,
  soft-deleted, and RLS-forced like every other table.
- **`FileContentStore`** — the bytes, in object storage. `adapters/supabase/storage.ts` implements it over the
  Supabase Storage REST API. This is the only port where the Supabase adapter is *not* the Postgres adapter
  under another name; the conformance matrix marks the port `n/a` for `postgres` and asserts alias identity
  for the other twenty.

### The lifecycle

An upload is two writes, and the order is the design:

1. metadata `pending`
2. bytes
3. metadata `pending → stored`, compare-and-set

A crash between 1 and 2 leaves a `pending` row — visible to reconciliation, invisible to the user. The reverse
order would leave an object nothing references: invisible to everything, and billed for. **An orphan you can
find beats an orphan you cannot.**

Deletion runs the mirror. Deleting a conversation moves every live file to `deleting` in one statement — so a
file uploaded mid-delete cannot be missed — and the bytes go afterwards, in a sweep that deletes the object
*before* moving the row to `deleted`. Object storage cannot join a database transaction; the intermediate
state is named rather than pretended away.

### Limits and access

- The declared size is checked before the stream is accepted, with the limit stated in the refusal. The
  declared size is a *claim*, so the stream is also capped while it is read, and the cap throws from inside
  the generator so the producer is cancelled rather than drained.
- Media types are an exact list. No wildcards: `image/*` is how an SVG becomes an accepted image.
- Reads are mediated. A signed URL's life is clamped to 15 minutes at the service, because a signed URL is a
  bearer token in a query string — it reaches logs, browser history and anything that echoes a URL. An adapter
  that cannot sign returns `null` and the read is proxied; it never invents a URL.
- Entitlement to a file is entitlement to its **conversation**, enforced through `AuthorizationPolicy` as a
  required dependency. An unentitled caller gets the same `not_found` as a nonexistent id, or the endpoint
  confirms which ids exist.

### Reconciliation

The job **reports and never deletes**, both directions: rows with no bytes, and bytes with no row. Deleting on
the strength of "probably an orphan" is how a file whose metadata write was merely slow goes missing.

### Attachments in context (#130)

Governing principle 6 — *"Large files and tool results are referenced, not injected wholesale into model
context"* — is easy to state and easy to break by accident, so it is held structurally rather than by
convention.

**The context provider is constructed with a `FileMetadataStore` and nothing else.** It has no
`FileContentStore`, so it cannot read a byte of an attachment even if a future edit tried to. A rule can be
forgotten; a provider with no way to reach the content cannot forget it.

**An attachment's cost does not grow with the file.** The rendered line carries a rounded, *fixed-width*
size — `  1.0 KB`, `  100 MB` — rather than a byte count, so the cost is exactly constant across every order
of magnitude a file can have. What it does scale with is the filename, which is the user's own text and
belongs in context; that is bounded too. The list itself is capped, because linear in something the user
controls is the same unbounded growth by a slower route, and past the cap the section says so and names the
tool that lists the rest.

The `file` message part is already the reference: `fileId`, `filename`, `mediaType`, `byteSize`, and no
content field. Rather than add a second part type meaning the same thing — which would have forced the
frontend change AC-5 exists to avoid — the part was hardened instead. `providerMetadata` on a `file` or
`image` part is capped at 2 KiB and refuses a `data:` URI at any nesting depth: that bag is
`Record<string, unknown>`, which is exactly the shape a base64 payload fits into, and a part carrying its own
content would satisfy every other rule while breaking the only one that matters.

**Bringing content in is a separate, bounded act.** `read_attachment` returns at most 32 KiB, clamps rather
than refuses a larger request, and reports the offset to continue from — so a model can page a long document
but cannot flood the transcript, which matters because a tool result *is* a message part and therefore
permanent. It reads through `FileService`, so the conversation entitlement check is the same one the read
path uses rather than a second copy. Media types it will decode as text are an exact list, and a refusal
names the alternative, because a refusal that does not say what to do next produces a retry loop.

The storage `contentKey` never appears in front of the model. The reference is the file *id*; the key is the
platform's business, and a model that could see it could put it in a tool argument.

## Document extraction (#131)

Extraction turns an opaque attachment into something the model can reason about. Three decisions shape it.

### Structure, not a flat string

The intermediate is a **block list** — headings keep their level, tables keep their cells, lists keep their
items — not one long string. A flat string is what every quick extractor produces and it destroys exactly the
information a question is usually about: *"what was Q3 revenue?"* is answerable from a table and unanswerable
from that table flattened into prose, because the row and column that gave the number its meaning are gone and
the model has no way to know they were ever there.

The renderer turns blocks back into Markdown for a model, so a table arrives as a table.

### Failure is a value, not an exception

`ExtractionFailureReason` is a closed set, and every value exists because the *user-facing sentence differs*:

| Reason | What the user should do |
|---|---|
| `unsupported-type` / `skipped` | Nothing — this type is not extracted at all |
| `too-large` | Split the document, or attach the part that matters |
| `too-many-pages` | Same, and the limit is named in the message |
| `timed-out` | Retry, or simplify the document |
| `encrypted` | Remove the password protection |
| `no-text-layer` | Run OCR — this is a scan, not a broken file |
| `malformed` | Re-export it |

`no-text-layer` and `malformed` are deliberately separate: collapsing them would send someone to re-export a
file that needed a different pipeline entirely. The pipeline records the failure on the file and never throws
for a document problem, so an unreadable document is visibly unreadable rather than silently empty.

### Bounded in every dimension a document can grow

A document is attacker-controlled input, so a page limit alone is not enough:

- `maxBytes` — bytes read from storage. **Refuses** rather than truncating: half a PDF is malformed, not shorter.
- `maxPages` — refused with the count and the limit both named.
- `maxTextBytes` — extracted text kept. **Truncates** and says so, because half a document is still useful.
- `maxBlocks` — separate from `maxTextBytes`, because a million empty paragraphs costs no text and a great deal
  of everything else.
- `timeoutMs` — enforced by the *pipeline*, not the parser: a parser stuck in a loop cannot check its own clock.
- An **inflated-stream ceiling** inside the PDF parser. Checking the file size does not catch a decompression
  bomb; a small file can inflate to gigabytes, so the ceiling is on the inflated total.

### Asynchronous by construction

Extraction has its own queue, not the run queue. A shared queue would let a hundred-page PDF sit in front of a
user's next message, and the two kinds of work want different concurrency anyway — extraction is CPU-bound, a
run is mostly waiting on a provider. `upload` *requests* extraction and an enqueue failure is logged and
dropped: the bytes and the row are already durable, and an unreachable queue must not turn a successful upload
into a failed one. `sweepStuckExtractions` picks up both silent shapes — a `pending` file whose enqueue was
lost, and a `running` file whose worker died.

A failed *document* completes its job; only an infrastructure failure fails one. Retrying a scan with no text
layer produces the same answer at the same cost forever.

### The PDF parser's limits, stated

Text extraction is over the raw PDF syntax with `node:zlib` and no dependency. It handles what the tools people
actually use produce — Word, LaTeX, print-to-PDF, Google Docs, most report generators — by walking content
streams and following the text operators, inferring headings from font size (a PDF has no headings; it has text
that happens to be bigger) and tables from repeated column positions.

It does **not** handle encrypted documents (refused: extracting from one means implementing the security
handler), scans with no text layer (reported as such, which is the answer that points at OCR), or Type0/CID
fonts whose `ToUnicode` map cannot be applied (detected as mojibake and warned about — a garbled answer is
worse than a refusal). Tables are the honest weak spot: a PDF contains text at coordinates, not tables, so a
grid is recovered when the evidence is strong and the text is left as paragraphs when it is not. A wrong table
is worse than no table, because a wrong one looks authoritative.

### Read in windows

`read_document` returns at most 50 blocks or 24,000 characters and reports the block to continue from. The
window is in **blocks, not characters**, because a character bound can land inside a table and hand the model
half of one — worse than none, since the missing rows are invisible and the model answers confidently from what
it can see. When there is nothing to read it reports *why*, and marks the error retryable only when retrying
could change the answer.

## OCR and vision (#132)

A screenshot and a scanned PDF are inert without these. Both feed the *same* derived-artifact path as #131, so
`read_document`, the context section and the blob see one representation regardless of where the text came
from — which is what stops "can the model read this?" depending on the format the user happened to attach.

### Two ports, not one

| Port | Job | Built in? |
|---|---|---|
| `OcrProvider` | **Transcribes.** Returns the words on the page, with a confidence. Does not interpret. | **No** — see below |
| `VisionProvider` | **Describes.** Says what an image shows. The only useful answer for an image with no text. | Yes, over the model registry |

Conflating them would force one adapter to do both badly. For a dashboard screenshot the answer is *both*:
either alone loses half of it — the numbers without the layout, or the layout without the numbers. A vision
description is labelled as one, because a description is the model's *reading* of an image and a transcription
is what the image says; presenting them identically would let a later answer cite an inference as a quote.

**There is no built-in OCR adapter, and there cannot honestly be one.** OCR needs a trained engine —
Tesseract, or a hosted service. The PDF parser in #131 could be written over the raw syntax with `zlib`
because a PDF *contains* its text; a scan does not contain text at all. So `OcrProvider` is a documented port
with no implementation in this package. The alternative — a stub returning empty text — would make every scan
look like a successful extraction of nothing, which is precisely what `no-text-layer` exists to prevent.

The port takes the **original bytes and media type**, not page images: rasterising a PDF needs a renderer, and
every real service (Textract, Document AI, Azure Document Intelligence) accepts a PDF directly and does that
itself.

### A model without vision is never selected

`ModelRegistry.resolve({ role, requiredModalities: ["image"] })` already throws `capability_unavailable` when
nothing satisfies it. So the guarantee holds because the caller cannot *obtain* a model to pass to the vision
call — not because the vision call checks one. A check there would be a second gate to keep in step with the
first, and the weaker of the two would be the one that mattered. The refusal is deliberately not caught: a
fabricated description is the one outcome worse than no description.

### The OCR fallback is narrow on purpose

A scanned PDF is found by the text parser reporting `no-text-layer`, and **only** that reason triggers the
fallback. An encrypted or malformed document is not retried through OCR, because OCR will not decrypt anything
and the second attempt would cost money to reach the same conclusion. This is where #131's insistence that
`no-text-layer` be its own reason rather than folded into `malformed` becomes load-bearing.

### Confidence, and what its absence means

`confidence` is **required** on `OcrResult`. An optional field would default to the optimistic answer and
nobody would notice — an engine that cannot report one says `0` and lets the flag fire. Below
`LOW_CONFIDENCE_THRESHOLD` (0.7, roughly where OCR stops being "a few wrong characters" and becomes "wrong
words" — and a wrong word is worse than a gap, because the sentence still reads) the extraction is flagged in
three places, because a consumer might look at any of them: a warning in the document, `lowConfidence` on the
read result, and a marker on the attachment's reference line so a model choosing between attachments knows
before it reads any of them.

On `ExtractedDocument` **and** on the file record, so a listing can flag a low-confidence extraction without
fetching the blob. Absent means the extraction was not probabilistic — a PDF's text layer is *read*, not
recognised, so a confidence there would be a number with nothing behind it, and `1.0` would be a lie about a
different kind of extraction.

### Cost

A vision call is reported on the parse result and the pipeline forwards it to `onPricedOperation` *before*
writing the blob and strips it from what is stored — a priced operation already happened, so a crash must
still have billed it, and a stored document has no business carrying billing data. A ledger write that fails
is logged, not thrown: an unbilled call is a smaller problem than a document the user paid for and cannot read.

`UsageEvent.runId` is required and an extraction is **not a run**, so it borrows the field with a namespaced
`extraction:<fileId>`. Two consequences: the ledger stays single, which is what "through the existing usage
hook" asks for; and `usageDedupeKey` is `(runId, stepId)`, so a re-enqueued extraction records **once** rather
than charging a tenant twice for the same image. The wart is that `runId` no longer always names a run — a
separate cost dimension would be cleaner if the ledger ever needs to distinguish them.

## Artifacts (#133)

An artifact is how substantial assistant output becomes a named, versioned thing rather than text buried in a
thread — the prerequisite for exporting it.

### Two tables, not one

`artifacts` holds the identity that outlives any single version: a name, an owning conversation, a shared
link's target. `artifact_versions` holds the versions. Folding them together would mean either duplicating
that identity on every version or having no row to point a deleted link at.

`latest_version` is **denormalised** onto the artifact row on purpose. It is read on every resolve of "the
current version", and a `MAX()` subquery there would be a second source of truth that can disagree with the
rows it summarises under concurrency — which is the exact race `addVersion`'s compare-and-set exists to settle.

### Versioning is a compare-and-set

`addVersion` takes `expectedLatestVersion` and the `UPDATE` carries `WHERE latest_version = $expected`. Two
concurrent regenerations both hold `expectedLatestVersion: 1`; exactly one wins, and the loser is *told* so.
Without that, both become version 2 and one silently replaces the other — which is "earlier versions remain
resolvable" failing in the way nobody notices. `UNIQUE (tenant_id, artifact_id, version)` says the same thing
a second time, at the level the application cannot be wrong about.

**Restore makes a new version**, it does not move a pointer backwards. Moving one would make the history lie
about what happened, and *"the version that was current on Tuesday"* is exactly the question a shared link
asks. The restored version reuses the original's `contentRef` — a blob is immutable, so sharing it is safe, and
copying would double the storage for a byte-identical value.

### Content by reference, and the write order

The version row holds a `BlobRef` and there is no column content could be inlined into. An artifact is the
thing a user exports, so it grows without limit, and an unbounded value in a row is the antipattern `0011`
rejected for blobs and `0013` for file bytes.

The blob is written **before** the row. A crash between them leaves an unreferenced blob, which is waste; the
reverse leaves a row pointing at content that does not exist, and a dangling reference reads as corruption.
Same reasoning, opposite order, as the file upload in #129 — because there the metadata row is the evidence
reconciliation needs, and here the reference is the thing that must never dangle.

### Provenance is required

`ArtifactProvenance` is required on every version: the run, the producing tool, the normalised inputs, and any
attachments the content was derived from. Provenance that *can* be absent is provenance that will be, on the
version someone eventually asks about. The inputs are the **normalised** ones rather than the model's prose
request, because a regeneration that produced a different result should be explicable by comparing two
versions' inputs — and free text does not compare.

The conversation is on the *artifact*, not repeated per version: it owns the artifact, so duplicating it would
be a second place for it to disagree.

### Access follows the conversation

`AuthorizationPolicy` is a required dependency of `ArtifactService` and every entry point takes the decision
on the **conversation** — read, write, history, restore, delete and list alike. An artifact is therefore never
more accessible than the conversation that produced it, and there is no second permission model to keep in
step with the first. An unentitled caller gets the same `not_found` and the same message as a nonexistent id.

Rendered formats — PDF, DOCX — are *exports* of an artifact rather than kinds of one, which is why
`ARTIFACT_KINDS` does not list them: an artifact exported twice is still one artifact, and making PDF a kind
would make it two things that drift. Export is #134.
