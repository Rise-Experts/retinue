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
