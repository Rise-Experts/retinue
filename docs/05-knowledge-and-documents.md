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

