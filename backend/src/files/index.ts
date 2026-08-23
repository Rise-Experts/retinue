/**
 * The attachment lifecycle — `docs/05-knowledge-and-documents.md`, REQ-026 (#129).
 *
 * The ports are in `persistence/`; what lives here is the sequencing that makes them safe together, and it
 * is the part that cannot be a rule someone remembers:
 *
 * - an upload is two writes, metadata then bytes, and the window between them is where orphans live
 * - a declared size is a claim, and the only real defence is a cap enforced while reading
 * - object storage cannot join a database transaction, so deletion is scheduled rather than performed
 */

import { AgentPlatformError } from "../core/errors.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import type { ExecutionContext } from "../core/context.js";
import { asId } from "../core/ids.js";
import type { ConversationId, FileId, TenantId } from "../core/ids.js";
import type { Page } from "../core/context.js";
import type {
  FileContentStore,
  FileMetadata,
  FileMetadataStore,
} from "../persistence/index.js";

/**
 * What a deployment will accept.
 *
 * Configuration rather than constants, because the ceiling belongs to the storage bucket. ShareFlow's
 * `MEDIA_MAX_BYTES` is 50 MB precisely because that *is* its bucket's `file_size_limit` — a limit here
 * larger than the bucket's would refuse at upload time with the wrong number, and one smaller would refuse
 * files the bucket would have taken.
 */
export type UploadLimits = {
  readonly maxBytes: number;
  /** Exact media types. No wildcards: `image/*` is how an SVG becomes an accepted image. */
  readonly allowedMediaTypes: readonly string[];
  /** How long a signed read URL lives. Short — see `MAX_SIGNED_URL_SECONDS`. */
  readonly signedUrlSeconds: number;
};

/**
 * The ceiling on a signed URL's life.
 *
 * A signed URL is a bearer token in a query string: it goes into logs, into a browser's history, and — if a
 * tool result ever carried one — into the run event log, where anyone who can read the conversation can read
 * it long after the check that produced it. #118 refused to return one from a tool for exactly that reason.
 *
 * Fifteen minutes is long enough to load a document and short enough that a leaked URL is usually already
 * dead. `signedReadUrl` clamps rather than trusting the caller.
 */
export const MAX_SIGNED_URL_SECONDS = 900;

/** A conservative default set. A deployment narrows or widens it deliberately. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 25 * 1024 * 1024,
  allowedMediaTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/csv",
    "text/markdown",
  ],
  signedUrlSeconds: 300,
};

const refuse = (code: "invalid_input" | "not_found" | "forbidden" | "conflict", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * The cheap early refusal — AC-2's first half.
 *
 * *"Refused before the bytes are accepted, with the limit stated."* The limit is in the message because an
 * error saying "too large" sends someone to guess; one saying "25 MB" does not.
 *
 * **This check can only ever see the declared size.** A client that declares 1 KB and sends 1 GB passes it,
 * which is why `streamWithCap` exists and is not optional.
 */
export const validateUpload = (
  input: { readonly mediaType: string; readonly declaredBytes: number },
  limits: UploadLimits,
): void => {
  // Normalised, because a browser sends `text/plain; charset=utf-8` and a bare-string comparison would
  // refuse it — a refusal the user cannot act on, for a file that is fine.
  const mediaType = input.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!limits.allowedMediaTypes.includes(mediaType))
    throw refuse(
      "invalid_input",
      `${mediaType || "that file type"} is not accepted. Accepted types: ${limits.allowedMediaTypes.join(", ")}`,
    );
  if (!Number.isFinite(input.declaredBytes) || input.declaredBytes <= 0)
    throw refuse("invalid_input", "the file's size must be stated and greater than zero");
  if (input.declaredBytes > limits.maxBytes)
    throw refuse(
      "invalid_input",
      `that file is ${input.declaredBytes} bytes and the limit is ${limits.maxBytes} bytes`,
    );
};

/**
 * AC-2's second half, and the one that holds.
 *
 * Wraps a byte stream so it **stops** at the cap rather than reading to the end and then complaining. The
 * difference is the whole point: reading a hostile 1 GB body into memory and *then* returning an error is a
 * denial of service that happens to report itself politely.
 *
 * `safefetch.py` in ShareFlow exists for the same reason, and says it plainly: *"the callers parse whole
 * documents in memory, so an unbounded download is a denial-of-service vector on a container capped at
 * 600 MB."*
 */
export const streamWithCap = async function* (
  bytes: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  let seen = 0;
  for await (const chunk of bytes) {
    seen += chunk.byteLength;
    if (seen > maxBytes) {
      // Thrown from inside the generator, so the consumer stops pulling and the producer is cancelled. The
      // partial object is the adapter's to discard — `putFile` says so.
      throw refuse("invalid_input", `the file exceeds the ${maxBytes} byte limit`);
    }
    yield chunk;
  }
};

export type FileServiceDeps = {
  readonly metadata: FileMetadataStore;
  readonly content: FileContentStore;
  /**
   * AC-3, enforced rather than asserted.
   *
   * **Required, not optional.** Entitlement to a file is entitlement to its conversation, and a service that
   * would run without a policy is a service someone constructs without one — at which point every
   * attachment in the tenant is readable by every member of it. Tenant scoping alone is not AC-3.
   */
  readonly authorization: AuthorizationPolicy;
  readonly limits?: UploadLimits;
  readonly clock?: () => string;
  /**
   * Mints the opaque content key.
   *
   * Injectable so it can be asserted, and **not** derived from the filename or the file id: a key a caller
   * can construct is a key a caller can guess. `sanitizeMediaRefs` in ShareFlow is the cautionary tale — its
   * workspace-prefix check was *"the ONLY thing standing between a forged path and a signed URL to another
   * tenant's private object."*
   */
  readonly contentKey?: () => string;
  readonly fileId?: () => string;
  /**
   * Asks for text extraction after a successful upload (#131).
   *
   * A function rather than the service itself, so `files` does not depend on `documents` — the dependency
   * runs the other way, and a cycle here would make attaching a file require the extraction pipeline to
   * exist. Optional: a deployment with no extraction is a valid one.
   *
   * **It is not awaited in a way that can fail the upload.** AC-2 is that the user's next request is served
   * without waiting, so a rejection here is logged and dropped — the file is stored, and the sweep will find
   * an extraction that never got requested.
   */
  readonly requestExtraction?: (input: {
    readonly tenantId: TenantId;
    readonly fileId: FileId;
    readonly mediaType: string;
  }) => Promise<unknown>;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

/**
 * The attachment lifecycle.
 *
 * Every method takes an `ExecutionContext`, and entitlement to a file *is* entitlement to its conversation —
 * so there is no second permission model to keep in step with the first.
 */
export const createFileService = (deps: FileServiceDeps) => {
  const limits = deps.limits ?? DEFAULT_UPLOAD_LIMITS;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const newKey = deps.contentKey ?? (() => `f_${crypto.randomUUID()}`);
  const newId = deps.fileId ?? (() => `file_${crypto.randomUUID()}`);

  return {
    limits,

    /**
     * Upload: validate, record `pending`, write bytes, then move to `stored`.
     *
     * The order is the point, and the alternative is worse in a specific way. Writing bytes first and
     * metadata second means a crash between them leaves an object nothing references — invisible, and
     * billed for. Metadata first means a crash leaves a row in `pending`, which reconciliation can see and
     * a user cannot. **An orphan you can find beats an orphan you cannot.**
     */
    async upload(
      context: ExecutionContext,
      input: {
        readonly conversationId: ConversationId;
        readonly filename: string;
        readonly mediaType: string;
        readonly declaredBytes: number;
        readonly bytes: AsyncIterable<Uint8Array>;
      },
    ): Promise<FileMetadata> {
      validateUpload({ mediaType: input.mediaType, declaredBytes: input.declaredBytes }, limits);

      // Before anything is written. An unentitled upload that got as far as creating a `pending` row would
      // put a filename of someone else's choosing into a conversation they cannot read.
      const decision = await deps.authorization.can(context, "write", {
        type: "conversation",
        id: input.conversationId,
      });
      if (!decision.allow) throw refuse("not_found", "no such conversation");

      const id = asId<FileId>(newId());
      const contentKey = newKey();
      const createdAt = clock();
      const pending: FileMetadata = {
        id,
        conversationId: input.conversationId,
        filename: input.filename,
        mediaType: input.mediaType,
        byteSize: input.declaredBytes,
        contentKey,
        state: "pending",
        uploadedBy: context.principalId,
        createdAt,
      };
      await deps.metadata.create({ tenantId: context.tenantId, file: pending });

      // A failure here leaves the row in `pending`, deliberately and with no cleanup. That row is the
      // evidence reconciliation uses to find a partial object; deleting it would hide exactly the case this
      // ordering exists to make visible.
      const stored = await deps.content.putFile({
        tenantId: context.tenantId,
        contentKey,
        mediaType: input.mediaType,
        bytes: streamWithCap(input.bytes, limits.maxBytes),
        maxBytes: limits.maxBytes,
      });

      const moved = await deps.metadata.transition({
        tenantId: context.tenantId,
        id,
        from: "pending",
        to: "stored",
        at: clock(),
        checksum: stored.checksum,
      });
      if (!moved.moved) {
        // Something else moved it — a conversation deleted mid-upload is the realistic case. The bytes are
        // now unreferenced, so they are removed here rather than left for the sweep.
        await deps.content.deleteFile({ tenantId: context.tenantId, contentKey });
        throw refuse("conflict", "that conversation was deleted while the file was uploading");
      }

      // Extraction is *requested*, not performed — AC-2 of #131. Deliberately after the transition to
      // `stored`, so a worker picking the job up immediately finds a file it can read.
      //
      // The `catch` is not laziness. The upload has succeeded; the bytes and the row are both durable. An
      // unreachable queue must not turn that into a failed upload, and the extraction sweep exists precisely
      // to pick up what a lost enqueue dropped.
      if (deps.requestExtraction !== undefined) {
        try {
          await deps.requestExtraction({
            tenantId: context.tenantId,
            fileId: id,
            mediaType: input.mediaType,
          });
        } catch (error) {
          (deps.log ?? (() => {}))("extraction request failed after upload", { id, error });
        }
      }

      // The size as *written*, not as declared. They differ when a client lies, and the record should say
      // what is actually there.
      return { ...pending, state: "stored", byteSize: stored.byteSize, checksum: stored.checksum };
    },

    /** AC-3: only through the owning conversation, and a foreign file is `not_found`, never `forbidden`. */
    async get(context: ExecutionContext, id: FileId): Promise<FileMetadata> {
      const file = await deps.metadata.get({ tenantId: context.tenantId, id });
      // Indistinguishable from absent, so the endpoint cannot be used to probe which ids exist — the same
      // rule ShareFlow's `getPost` states: "the two must be indistinguishable, or the endpoint confirms the
      // existence of other tenants' ids."
      if (file === null || file.deletedAt !== undefined) throw refuse("not_found", "no such file");
      if (file.state !== "stored") throw refuse("not_found", "that file is not available");

      // The decision is about the *conversation*, so there is no second permission model to keep in step
      // with the first: whoever may read the thread may read what is attached to it.
      const decision = await deps.authorization.can(context, "read", {
        type: "conversation",
        id: file.conversationId,
      });
      // `not_found` again, and the same message: a `forbidden` here would confirm the file exists to
      // exactly the caller who is not allowed to know that.
      if (!decision.allow) throw refuse("not_found", "no such file");
      return file;
    },

    /**
     * A short-lived URL, or a stream when the adapter proxies.
     *
     * The expiry is clamped rather than trusted: a caller asking for a day gets fifteen minutes. AC-6 is
     * about what is *reachable*, and a caller's optimism is not a reason to widen it.
     */
    async signedReadUrl(context: ExecutionContext, id: FileId): Promise<string | null> {
      const file = await this.get(context, id);
      return deps.content.signedUrl({
        tenantId: context.tenantId,
        contentKey: file.contentKey,
        expiresInSeconds: Math.min(limits.signedUrlSeconds, MAX_SIGNED_URL_SECONDS),
      });
    },

    /** The proxied read, for an adapter that cannot sign — and the fallback when one can. */
    async read(context: ExecutionContext, id: FileId): Promise<AsyncIterable<Uint8Array>> {
      const file = await this.get(context, id);
      const bytes = await deps.content.readFile({
        tenantId: context.tenantId,
        contentKey: file.contentKey,
      });
      if (bytes === null)
        // Metadata says `stored` and the bytes are gone: the other orphan direction, seen from the read
        // path. Reported as what it is rather than as an empty file, because an empty file is something a
        // caller might reasonably use.
        throw refuse("not_found", "that file's contents are missing");
      return bytes;
    },

    /**
     * The listing is authorised on the conversation before it runs, not filtered afterwards.
     *
     * Filtering results would mean the query ran, which for an unentitled caller is a query whose *shape*
     * — a page count, a cursor, a timing difference — still answers "does this conversation have files".
     */
    async listForConversation(
      context: ExecutionContext,
      input: { readonly conversationId: ConversationId; readonly limit: number; readonly cursor?: string },
    ): Promise<Page<FileMetadata>> {
      const decision = await deps.authorization.can(context, "read", {
        type: "conversation",
        id: input.conversationId,
      });
      if (!decision.allow) throw refuse("not_found", "no such conversation");
      return deps.metadata.listByConversation({ tenantId: context.tenantId, ...input });
    },

    /**
     * AC-4: deleting a conversation removes the metadata and schedules the bytes.
     *
     * Two steps, and they cannot be one: object storage does not join a database transaction. So the
     * metadata moves to `deleting` — gone from the user's view — and `sweepDeletions` removes the bytes
     * afterwards. The intermediate state is named rather than pretended away.
     */
    async deleteConversationFiles(
      context: ExecutionContext,
      conversationId: ConversationId,
    ): Promise<{ readonly scheduled: number }> {
      return deps.metadata.scheduleConversationDeletion({
        tenantId: context.tenantId,
        conversationId,
        at: clock(),
      });
    },

    /**
     * Remove the bytes of files marked `deleting`.
     *
     * Bytes first, then the state — the opposite order from upload, and for the mirrored reason. Marking
     * `deleted` first means a crash leaves an object nothing references and nothing will look for again.
     * Deleting bytes first means a crash leaves the row in `deleting`, and the next sweep retries it;
     * `deleteFile` is idempotent so the retry costs nothing.
     */
    async sweepDeletions(
      context: ExecutionContext,
      input: { readonly olderThan: string; readonly limit: number },
    ): Promise<{ readonly deleted: number; readonly failed: number }> {
      const page = await deps.metadata.listByState({
        tenantId: context.tenantId,
        state: "deleting",
        olderThan: input.olderThan,
        limit: input.limit,
      });
      let deleted = 0;
      let failed = 0;
      for (const file of page.items) {
        try {
          await deps.content.deleteFile({ tenantId: context.tenantId, contentKey: file.contentKey });
          await deps.metadata.transition({
            tenantId: context.tenantId,
            id: file.id,
            from: "deleting",
            to: "deleted",
            at: clock(),
          });
          deleted += 1;
        } catch {
          // Counted, not thrown. One unreachable object must not stop the sweep — the row stays `deleting`
          // and the next run retries it, which is the whole reason bytes are deleted before the state moves.
          failed += 1;
        }
      }
      return { deleted, failed };
    },
  };
};

export type FileService = ReturnType<typeof createFileService>;

/** What reconciliation found. Reported, never acted on — see `reconcileFiles`. */
export type ReconciliationReport = {
  /** Metadata with no bytes: stuck in `pending` past the threshold. */
  readonly stuckPending: readonly FileId[];
  /** Deletion scheduled and never completed. */
  readonly stuckDeleting: readonly FileId[];
  /** Bytes with nothing referencing them. The direction that costs money silently. */
  readonly orphanedObjects: readonly string[];
  /** Metadata that says `stored` while the bytes are gone. */
  readonly missingContent: readonly FileId[];
};

/**
 * AC-5: detect and report orphans.
 *
 * **Reports, never deletes**, and that is the AC's own wording rather than caution for its own sake: a
 * reconciliation job that deletes is a job that can delete a file whose metadata write is merely slow. The
 * threshold makes that unlikely; deleting on the strength of "unlikely" is how data goes missing.
 *
 * Both directions are covered, and only one of them is visible to the metadata store — bytes with no
 * metadata can only be found by listing the objects, which is why `FileContentStore.listObjects` exists.
 */
export const reconcileFiles = async (
  context: ExecutionContext,
  deps: { readonly metadata: FileMetadataStore; readonly content: FileContentStore },
  input: { readonly olderThan: string; readonly limit: number },
): Promise<ReconciliationReport> => {
  const scope = { tenantId: context.tenantId };
  const [pending, deleting] = await Promise.all([
    deps.metadata.listByState({ ...scope, state: "pending", olderThan: input.olderThan, limit: input.limit }),
    deps.metadata.listByState({ ...scope, state: "deleting", olderThan: input.olderThan, limit: input.limit }),
  ]);

  const objects = await deps.content.listObjects({ ...scope, limit: input.limit });
  const known = new Set<string>();
  const missingContent: FileId[] = [];
  const storedKeys = new Set(objects.items.map((o) => o.contentKey));

  // Every state, not only the live ones: an object referenced by a `deleting` row is not an orphan, it is
  // a sweep that has not run yet. Reporting it as orphaned would send someone to delete something already
  // scheduled for deletion, and the report would never come clean.
  for (const state of ["pending", "stored", "deleting"] as const) {
    const page = await deps.metadata.listByState({
      ...scope,
      state,
      // Everything, not only the old: this pass is building the set of referenced keys, and a recent file
      // is still a reference.
      olderThan: new Date(8_640_000_000_000).toISOString(),
      limit: input.limit,
    });
    for (const file of page.items) {
      known.add(file.contentKey);
      if (state === "stored" && !storedKeys.has(file.contentKey)) missingContent.push(file.id);
    }
  }

  return {
    stuckPending: pending.items.map((f) => f.id),
    stuckDeleting: deleting.items.map((f) => f.id),
    orphanedObjects: objects.items.filter((o) => !known.has(o.contentKey)).map((o) => o.contentKey),
    missingContent,
  };
};
