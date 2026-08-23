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
