/**
 * `MediaService` over `generated_assets` and Supabase storage — REQ-041 (#190), the sixth and last adapter.
 *
 * The most uneven of the six: two methods read tables, and three depend on things that are not in a database
 * at all. Each is wired to a dependency rather than approximated, and where there is nothing to wire the
 * method says so.
 *
 * ## `bytes` is required by the port and absent from `generated_assets`
 *
 * The table is `id, job_id, workspace_id, storage_path, mime, width, height, duration_ms, created_at` — no
 * size column. `MediaAsset.bytes` is not optional, so there were three options and only one of them is
 * honest:
 *
 * - `bytes: 0` — a lie an assistant will repeat. A model told a video is zero bytes reports it.
 * - Drop the field from the port — it is what a platform's upload limit is checked against.
 * - **Read the real size from `storage.objects.metadata->>'size'`**, which is where Supabase records it, in
 *   this same database. That is what this does.
 *
 * The join has a consequence worth stating: an asset row whose storage object is missing is **excluded** from
 * `listAssets` and answers `not_found` from `inspect`. That is not tidiness — such an asset cannot be
 * published, because the platforms fetch the object themselves, so offering it to a model is offering
 * something that cannot work. `inspect` says which of the two it is.
 *
 * ## What is not here, and why
 *
 * - **`convert`** needs ShareFlow's conversion service. This adapter writes a `media_conversion_jobs` row and
 *   nothing processes it from here, so the conversion is asynchronous with no asset to return — see the
 *   method.
 * - **`checkPlatformCompatibility`** needs platform media rules. `platform_rules` holds character and hashtag
 *   limits and **nothing about media**, so this reports that it could not check rather than passing silently.
 * - **`checkStorage`** proves credentials, signing, a bucket write and an anonymous public read. Every one of
 *   those is outside this package; it is injected, and refused when absent.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { MEDIA_CONVERSION_STATES } from "../../services/index.js";
import type {
  MediaAsset,
  MediaConversion,
  MediaConversionState,
  MediaService,
  MediaStorageCheck,
  Page,
  ValidationIssue,
} from "../../services/index.js";

/** The bucket ShareFlow keeps post media in. A parameter, because a deployment may rename it. */
export const DEFAULT_MEDIA_BUCKET = "media";

/** How many assets a page returns. A tool result enters the context window. */
export const MAX_ASSET_LIMIT = 50;

/**
 * The one issue code this adapter can emit for compatibility, and it is an absence rather than a finding.
 *
 * `platform_rules` has `char_limit`, `hashtag_min` and `hashtag_max` — nothing about accepted formats, file
 * counts or durations. Answering "no issues" would mean this deployment validated nothing for media and the
 * failure would surface as a rejected publish, long after the assistant said the post was fine.
 */
export const MEDIA_UNCHECKED_CODE = "media-rules-unavailable";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (field: string, value: string): string => {
  if (!UUID.test(value.trim())) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be a UUID — got ${JSON.stringify(value.slice(0, 60))}.`,
      retryable: false,
    });
  }
  return value.trim();
};

const asCursor = (value: string): string => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `cursor must be one this endpoint returned — got ${JSON.stringify(value.slice(0, 60))}. ` +
        "Pass `nextCursor` from a previous page, or omit it to start from the beginning.",
      retryable: false,
    });
  }
  return value;
};

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** `kind` from the MIME type. `document` is the fallback, which is what "not image, not video" means. */
export const assetKindFrom = (mime: string): MediaAsset["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "document";

/**
 * The label, from the storage path's last segment.
 *
 * `generated_assets` has no filename or caption column, so the path's basename is the only human-readable
 * thing about an asset — and the port is explicit that `label` is *"Filename or caption. Never a signed
 * URL"*. The path is not a URL and is not signed; it is the object key.
 */
export const labelFrom = (storagePath: string): string => storagePath.split("/").filter(Boolean).pop() ?? storagePath;

type AssetRow = {
  id: string;
  storage_path: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  size: string | number | null;
  created_at: string | Date;
};

/**
 * The columns, joined to storage for the size.
 *
 * An **inner** join on purpose: an asset whose object is gone cannot be published, so listing it would offer
 * a model something that cannot work. `metadata->>'size'` is where Supabase records the byte count.
 */
const ASSET_COLUMNS = `select a.id, a.storage_path, a.mime, a.width, a.height, a.duration_ms,
                              o.metadata->>'size' as size, a.created_at
                         from public.generated_assets a
                         join storage.objects o
                           on o.bucket_id = $2::text and o.name = a.storage_path`;

const toAsset = (row: AssetRow): MediaAsset => ({
  id: row.id as never,
  kind: assetKindFrom(row.mime),
  mimeType: row.mime,
  bytes: Number(row.size ?? 0),
  ...(row.width === null ? {} : { width: row.width }),
  ...(row.height === null ? {} : { height: row.height }),
  // Milliseconds in the column, seconds in the port. A duration reported a thousand times too large would
  // make every video look longer than every platform allows.
  ...(row.duration_ms === null ? {} : { durationSeconds: row.duration_ms / 1_000 }),
  label: labelFrom(row.storage_path),
});

export type MediaDeps = {
  readonly sql: SqlExecutor;
  /** Serialises the read-append-write in `attachToDraft`, so two callers cannot lose one another's file. */
  readonly transaction: TransactionRunner;
  /** The bucket post media lives in. Defaults to `media`, which is the bucket this schema ships. */
  readonly bucket?: string;
  /**
   * Runs a conversion. **Absent means `convert` refuses.**
   *
   * ShareFlow's converter is a worker in another repository, and unlike a scheduled publish there is no sweep
   * that would pick up an unprocessed row — so writing a `media_conversion_jobs` row from here would produce
   * a job nothing runs and a caller waiting for an asset that never arrives. That is the
   * "enqueued before its row exists" failure with the halves swapped, and refusing is better than a queue
   * with no consumer.
   */
  /**
   * Queues a conversion and returns its **job id** — REQ-041 (#190).
   *
   * It used to return an asset id, which could only describe a conversion that had already finished.
   * ShareFlow's converter is asynchronous for video and records `media_conversion_jobs` rows, so a job id is
   * what it actually produces; a synchronous converter simply returns one whose row is already `succeeded`.
   * The adapter reads the row back either way, so there is one story about what a conversion is.
   */
  readonly convert?: (input: {
    readonly context: ExecutionContext;
    readonly assetId: string;
    readonly sourcePath: string;
    readonly targetFormat: string;
  }) => Promise<{ readonly jobId: string }>;
  /**
   * Proves the media path end to end. **Absent means `checkStorage` refuses.**
   *
   * It writes a diagnostic object, signs a URL and fetches it **anonymously** — *"because the platforms fetch
   * media with no credentials and a bucket that is private fails only at publish time"*. Credentials, signing
   * and an outbound fetch are all outside this package.
   */
  readonly checkStorage?: (input: { readonly context: ExecutionContext }) => Promise<MediaStorageCheck>;
};

export const createPostgresMediaService = (deps: MediaDeps): MediaService => {
  const { sql } = deps;
  const bucket = deps.bucket ?? DEFAULT_MEDIA_BUCKET;

  /**
   * One asset, or the reason there is none. A local function rather than `this.inspect`, which `convert`
   * first called: `this` is bound only while the method is reached through the object, and
   * `const { convert } = services.media` would break it with nothing in the type saying so.
   */
  const inspectOne = async (context: ExecutionContext, rawId: string): Promise<MediaAsset> => {
    const id = asUuid("id", rawId);
    const rows = await sql.query<AssetRow>(
      `${ASSET_COLUMNS} where a.workspace_id = $1::uuid and a.id = $3::uuid`,
      [String(context.tenantId), bucket, id],
    );
    const row = rows[0];
    if (row !== undefined) return toAsset(row);

    /**
     * Two different absences, told apart — and only on the failure path, so the ordinary read stays one
     * query.
     *
     * "There is no such asset" and "the asset row exists but its object is gone" need different actions: the
     * first is a wrong id, the second is a broken upload somebody has to fix. A single `not_found` for both
     * would send a user looking for a typo.
     */
    const orphan = await sql.query<{ storage_path: string }>(
      "select storage_path from public.generated_assets where workspace_id = $1::uuid and id = $2::uuid",
      [String(context.tenantId), id],
    );
    if (orphan[0] !== undefined) {
      throw new AgentPlatformError({
        code: "not_found",
        message:
          `Asset ${id} is recorded but its file is missing from storage, so it cannot be attached or ` +
          "published — the platforms fetch the file themselves. Re-upload it.",
        retryable: false,
        details: { storagePath: orphan[0].storage_path, bucket },
      });
    }
    // `not_found`, never `forbidden` — absent and another tenant's must be indistinguishable.
    throw new AgentPlatformError({ code: "not_found", message: `No media asset ${id}.`, retryable: false });
  };

  /**
   * One conversion, read from `media_conversion_jobs`.
   *
   * **The asset is attached only on `succeeded`.** The old tool's docstring is the rule: *"Only 'succeeded'
   * means the file exists — until then there is no path to use or show. If it is still queued or running, say
   * so; do not guess a path, and do not attach one to a post."* A shape that carried a path on every state
   * would invite a model to read one off a `running` job and attach it, and the post would fail at publish
   * with a file that was never written.
   */
  /**
   * The draft, locked, with its editability re-asserted **at write time**.
   *
   * ShareFlow's writer does the same and says why: *"the post may have been approved and published between
   * the read above and this update."* Shared by all three attachment writers so the guard cannot be present
   * in two of them and forgotten in the third.
   */
  const lockedDraft = async (
    tx: { query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> },
    context: ExecutionContext,
    draftId: string,
  ): Promise<{ id: string; status: string; media_urls: string[] | null }> => {
    const rows = await tx.query<{ id: string; status: string; media_urls: string[] | null }>(
      `select id, status, media_urls from public.posts
        where workspace_id = $1::uuid and id = $2::uuid for update`,
      [String(context.tenantId), draftId],
    );
    const draft = rows[0];
    if (draft === undefined) {
      throw new AgentPlatformError({ code: "not_found", message: `No post draft ${draftId}.`, retryable: false });
    }
    if (draft.status.toUpperCase() === "PUBLISHED") {
      throw new AgentPlatformError({
        code: "conflict",
        message:
          "That post is already published, so its attachments cannot be changed. Duplicate it to make an " +
          "edited copy.",
        retryable: false,
        details: { remedy: "duplicate" },
      });
    }
    return draft;
  };

  const conversionOf = async (context: ExecutionContext, jobId: string): Promise<MediaConversion> => {
    const rows = await sql.query<{
      id: string;
      status: string;
      target: string;
      result_path: string | null;
      error: string | null;
    }>(
      `select id, status, target, result_path, error from public.media_conversion_jobs
        where workspace_id = $1::uuid and id = $2::uuid`,
      [String(context.tenantId), asUuid("jobId", jobId)],
    );
    const row = rows[0];
    if (row === undefined) {
      // `not_found` for absent and for another workspace's alike, as everywhere else.
      throw new AgentPlatformError({ code: "not_found", message: `No conversion ${jobId}.`, retryable: false });
    }

    const state = MEDIA_CONVERSION_STATES.includes(row.status as MediaConversionState)
      ? (row.status as MediaConversionState)
      : /**
         * An unrecognised status reads as `running`, which is the reading that invites another look.
         *
         * `succeeded` would claim a file exists, and `failed` would tell a user to start again — both worse
         * than "not finished yet" when the truth is that this code does not recognise the value.
         */
        "running";

    /**
     * The asset is resolved from `result_path`, and a `succeeded` job with no path is reported as `failed`.
     *
     * That combination means the converter recorded success and wrote nothing, which is indistinguishable
     * from a finished conversion to any caller reading `state` alone — and the caller would then attach
     * nothing to a post and be told it worked.
     */
    if (state === "succeeded") {
      if (row.result_path === null || row.result_path === "") {
        return {
          jobId: jobId as never,
          state: "failed",
          targetFormat: row.target,
          failure:
            "The conversion reported success but recorded no output file, so there is nothing to attach. " +
            "Convert it again.",
        };
      }
      const asset = await sql.query<AssetRow>(
        `${ASSET_COLUMNS} where a.workspace_id = $1::uuid and a.storage_path = $3::text`,
        [String(context.tenantId), bucket, row.result_path],
      );
      return asset[0] === undefined
        ? {
            jobId: jobId as never,
            state: "failed",
            targetFormat: row.target,
            failure:
              `The conversion finished but its output (${row.result_path}) is not a readable file in this ` +
              "workspace, so it cannot be attached or published.",
          }
        : { jobId: jobId as never, state: "succeeded", targetFormat: row.target, asset: toAsset(asset[0]) };
    }

    return {
      jobId: jobId as never,
      state,
      targetFormat: row.target,
      ...(state === "failed" && row.error !== null && row.error !== "" ? { failure: row.error } : {}),
    };
  };

  return {
    async listAssets(context, input): Promise<Page<MediaAsset>> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_ASSET_LIMIT);
      const rows = await sql.query<AssetRow>(
        `${ASSET_COLUMNS}
          where a.workspace_id = $1::uuid
            and ($3::timestamptz is null or a.created_at < $3::timestamptz)
          order by a.created_at desc
          limit $4`,
        [String(context.tenantId), bucket, input.cursor === undefined ? null : asCursor(input.cursor), limit + 1],
      );
      const page = rows.slice(0, limit);
      const items = page.map(toAsset);
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.created_at) }
        : { items };
    },

    async inspect(context, input): Promise<MediaAsset> {
      return inspectOne(context, String(input.id));
    },

    async convert(context, input): Promise<MediaConversion> {
      const id = asUuid("id", String(input.id));
      if (input.targetFormat.trim() === "") {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "A target format is required.",
          retryable: false,
        });
      }
      /**
       * `targetFormat` is deliberately **not** checked against a list.
       *
       * The port: *"The accepted set is the conversion service's own capability and can grow; a second copy
       * would eventually refuse something the service supports."* An unsupported target comes back from the
       * converter as `invalid_input` naming what it does support.
       */
      const source = await sql.query<{ storage_path: string }>(
        "select storage_path from public.generated_assets where workspace_id = $1::uuid and id = $2::uuid",
        [String(context.tenantId), id],
      );
      if (source[0] === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No media asset ${id}.`, retryable: false });
      }

      const run = deps.convert;
      if (run === undefined) {
        throw new AgentPlatformError({
          code: "capability_unavailable",
          message:
            "This deployment cannot convert media: no conversion service is wired. Attach the file in a " +
            "format the destination already accepts, or convert it before uploading.",
          retryable: false,
        });
      }

      const queued = await run({
        context,
        assetId: id,
        sourcePath: source[0].storage_path,
        targetFormat: input.targetFormat.trim(),
      });
      /**
       * Read the job back rather than trusting what the converter returned.
       *
       * Same reason the old code read the asset back: the row is what the rest of the system sees, and a
       * converter that reported success while writing nothing would otherwise hand a caller a path that does
       * not exist. For a synchronous converter this returns `succeeded` immediately; for video it returns
       * `queued`, which is the case that could not be expressed before.
       */
      return conversionOf(context, queued.jobId);
    },

    async getConversion(context, input): Promise<MediaConversion> {
      return conversionOf(context, String(input.jobId));
    },

    async attachToDraft(context, input) {
      const draftId = asUuid("draftId", String(input.draftId));
      const assetIds = input.assetIds.map((assetId) => asUuid("assetIds", String(assetId)));
      if (assetIds.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "No asset was given to attach.",
          retryable: false,
        });
      }

      /**
       * Every asset is resolved to its **storage path**, because that is what the column holds.
       *
       * `posts.media_urls` is a text array of URLs, not asset ids — the content adapter records the same
       * thing. So attaching by id means resolving the id here, and an id whose object is missing is refused
       * rather than written: a draft carrying a path the platforms cannot fetch fails at publish time, which
       * is exactly the lateness this whole check exists to avoid.
       */
      const resolved = await sql.query<{ id: string; storage_path: string }>(
        `select a.id, a.storage_path
           from public.generated_assets a
           join storage.objects o on o.bucket_id = $2::text and o.name = a.storage_path
          where a.workspace_id = $1::uuid and a.id = any($3::uuid[])`,
        [String(context.tenantId), bucket, assetIds],
      );
      if (resolved.length !== assetIds.length) {
        const found = new Set(resolved.map((row) => row.id));
        const missing = assetIds.filter((assetId) => !found.has(assetId));
        throw new AgentPlatformError({
          code: "not_found",
          message:
            `These assets are not attachable: ${missing.join(", ")}. Either they are not in this workspace, ` +
            "or their files are missing from storage — `inspect` says which.",
          retryable: false,
        });
      }

      const updated = await deps.transaction.transaction(async (tx) => {
        /**
         * The draft is locked, and its editability re-asserted **at write time**.
         *
         * ShareFlow's writer does the same and says why: *"the post may have been approved and published
         * between the read above and this update."* Locking makes the append safe against a second attach
         * losing a file, which a read-modify-write over a pool cannot be.
         */
        const rows = await tx.query<{ id: string; status: string; media_urls: string[] | null }>(
          `select id, status, media_urls from public.posts
            where workspace_id = $1::uuid and id = $2::uuid for update`,
          [String(context.tenantId), draftId],
        );
        const draft = rows[0];
        if (draft === undefined) {
          throw new AgentPlatformError({ code: "not_found", message: `No post draft ${draftId}.`, retryable: false });
        }
        if (draft.status.toUpperCase() === "PUBLISHED") {
          throw new AgentPlatformError({
            code: "conflict",
            message:
              "That post is already published, so its attachments cannot be changed. Duplicate it to make an " +
              "edited copy.",
            retryable: false,
            // The same machine-readable remedy `updateDraft` carries, so a repair step can branch on it.
            details: { remedy: "duplicate" },
          });
        }

        /**
         * An **append**, and duplicates are dropped.
         *
         * The port is explicit that this is not `updateDraft({ mediaAssetIds })`: *"To append one file through
         * a replace the caller has to read the current list, append and write it back."* Attaching the same
         * file twice would publish it twice, so the union is taken rather than concatenated.
         */
        const existing = draft.media_urls ?? [];
        const next = [...existing];
        for (const row of resolved) if (!next.includes(row.storage_path)) next.push(row.storage_path);

        const written = await tx.query<{ media_urls: string[] | null }>(
          `update public.posts set media_urls = $3::text[], updated_at = now()
            where workspace_id = $1::uuid and id = $2::uuid
            returning media_urls`,
          [String(context.tenantId), draftId, next],
        );
        return written[0];
      });

      if (updated === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The attachment was not written.", retryable: true });
      }
      /**
       * The stored paths are returned, not the asset ids that were asked for.
       *
       * Truthful rather than convenient: the column holds paths, so this is what the draft now carries. The
       * content adapter reports `mediaAssetIds` from the same column for the same reason — one story about
       * what that field is, rather than two.
       */
      return { draftId: draftId as never, mediaAssetIds: (updated.media_urls ?? []) as never };
    },

    async detachFromDraft(context, input) {
      /**
       * Removal resolves ids to paths **without** requiring the storage object to exist.
       *
       * `attachToDraft` joins `storage.objects` because attaching a path the platforms cannot fetch fails at
       * publish time. Detaching is the opposite: an asset whose file has gone missing is exactly the one a
       * caller most needs to take off a draft, and requiring the object would make the orphan unremovable.
       */
      const draftId = asUuid("draftId", String(input.draftId));
      const assetIds = input.assetIds.map((assetId) => asUuid("assetIds", String(assetId)));
      if (assetIds.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "No asset was given to remove.",
          retryable: false,
        });
      }

      const resolved = await sql.query<{ id: string; storage_path: string }>(
        `select id, storage_path from public.generated_assets
          where workspace_id = $1::uuid and id = any($2::uuid[])`,
        [String(context.tenantId), assetIds],
      );
      /**
       * An id this workspace does not own is `not_found`, but an id it owns that is simply *not attached* is
       * handled below against the draft — those are different facts and a caller can act on each.
       */
      if (resolved.length !== assetIds.length) {
        const found = new Set(resolved.map((row) => row.id));
        throw new AgentPlatformError({
          code: "not_found",
          message: `These are not assets in this workspace: ${assetIds.filter((id) => !found.has(id)).join(", ")}.`,
          retryable: false,
        });
      }

      const updated = await deps.transaction.transaction(async (tx) => {
        const draft = await lockedDraft(tx, context, draftId);
        const existing = draft.media_urls ?? [];
        const removing = new Set(resolved.map((row) => row.storage_path));
        const next = existing.filter((path) => !removing.has(path));

        /**
         * Refused when nothing was attached, rather than reported as a success that changed nothing.
         *
         * ShareFlow says *"None of those files are attached to that post"* and 404s. A silent no-op would let
         * an assistant tell a user it removed a file that was never there — and the file it meant to remove
         * is still on the post.
         */
        if (next.length === existing.length) {
          throw new AgentPlatformError({
            code: "not_found",
            message: "None of those files are attached to that post.",
            retryable: false,
          });
        }

        const written = await tx.query<{ media_urls: string[] | null }>(
          `update public.posts set media_urls = $3::text[], updated_at = now()
            where workspace_id = $1::uuid and id = $2::uuid
            returning media_urls`,
          [String(context.tenantId), draftId, next],
        );
        return written[0];
      });

      if (updated === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The removal was not written.", retryable: true });
      }
      return { draftId: draftId as never, mediaAssetIds: (updated.media_urls ?? []) as never };
    },

    async replaceOnDraft(context, input) {
      /**
       * In place, by index — which is the whole reason this is not detach-then-attach.
       *
       * ShareFlow: *"It replaces IN PLACE, so the file keeps its position — which matters because media order
       * is the order a platform shows a carousel in."* Two calls would move the new file to the end.
       */
      const draftId = asUuid("draftId", String(input.draftId));
      const outgoing = asUuid("remove", String(input.remove));
      const incoming = asUuid("add", String(input.add));

      // The incoming file must be attachable — the same join `attachToDraft` uses, for the same reason. The
      // outgoing one is only ever compared against what is stored, so it needs no object.
      const rows = await sql.query<{ id: string; storage_path: string; attachable: boolean }>(
        `select a.id, a.storage_path,
                exists (select 1 from storage.objects o where o.bucket_id = $2::text and o.name = a.storage_path) as attachable
           from public.generated_assets a
          where a.workspace_id = $1::uuid and a.id = any($3::uuid[])`,
        [String(context.tenantId), bucket, [outgoing, incoming]],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const out = byId.get(outgoing);
      const inc = byId.get(incoming);
      if (out === undefined || inc === undefined) {
        throw new AgentPlatformError({
          code: "not_found",
          message: `${out === undefined ? outgoing : incoming} is not an asset in this workspace.`,
          retryable: false,
        });
      }
      if (!inc.attachable) {
        throw new AgentPlatformError({
          code: "not_found",
          message:
            `Asset ${incoming} is recorded but its file is missing from storage, so it cannot replace ` +
            "anything — the platforms fetch the file themselves. Re-upload it.",
          retryable: false,
        });
      }

      const updated = await deps.transaction.transaction(async (tx) => {
        const draft = await lockedDraft(tx, context, draftId);
        const existing = [...(draft.media_urls ?? [])];
        const at = existing.indexOf(out.storage_path);
        if (at === -1) {
          throw new AgentPlatformError({
            code: "conflict",
            message: "That file is not attached to that post, so there is nothing to replace.",
            retryable: false,
          });
        }
        /**
         * Refused when the replacement is already attached.
         *
         * ShareFlow refuses it too, and the reason is the carousel again: writing it over the outgoing slot
         * would leave the same file twice and then dedupe to one, silently shortening the post by a slide.
         */
        if (existing.includes(inc.storage_path) && inc.storage_path !== out.storage_path) {
          throw new AgentPlatformError({
            code: "conflict",
            message: "That replacement is already attached to the post.",
            retryable: false,
          });
        }

        existing[at] = inc.storage_path;
        const written = await tx.query<{ media_urls: string[] | null }>(
          `update public.posts set media_urls = $3::text[], updated_at = now()
            where workspace_id = $1::uuid and id = $2::uuid
            returning media_urls`,
          [String(context.tenantId), draftId, existing],
        );
        return written[0];
      });

      if (updated === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The replacement was not written.", retryable: true });
      }
      return { draftId: draftId as never, mediaAssetIds: (updated.media_urls ?? []) as never };
    },

    async checkPlatformCompatibility(context, input): Promise<readonly ValidationIssue[]> {
      /**
       * Reported as unchecked, per platform, rather than answered "no issues".
       *
       * `platform_rules` holds `char_limit`, `hashtag_min` and `hashtag_max` and nothing about media — no
       * accepted formats, no file counts, no duration ceilings. Returning an empty list would say the media is
       * publishable everywhere, and the failure would arrive as a rejected publish long after the assistant
       * said the post was fine. `PublishingService.validate` reports the same absence with `media-unchecked`.
       *
       * Not repairable: rewriting or re-encoding does not supply a rule set.
       */
      const assetIds = input.assetIds.map((assetId) => asUuid("assetIds", String(assetId)));
      if (assetIds.length === 0) return [];
      return input.platformIds.map((platformId) => ({
        code: MEDIA_UNCHECKED_CODE,
        platformId,
        message:
          `Media rules for ${String(platformId)} are not configured in this deployment, so the attachments ` +
          "could not be checked against them.",
        repairable: false,
      }));
    },

    async checkStorage(context, _input): Promise<MediaStorageCheck> {
      const check = deps.checkStorage;
      if (check === undefined) {
        /**
         * Refused rather than answered `ok: true`, and this is the one that would be dangerous.
         *
         * The check exists to catch a bucket that is private — which *"fails only at publish time"* because
         * the platforms fetch media anonymously. A deployment with nothing to run the check that reported
         * `ok` would be asserting exactly the thing the check exists to doubt.
         */
        throw new AgentPlatformError({
          code: "capability_unavailable",
          message:
            "This deployment cannot verify the media path: no storage check is wired. It proves credentials, " +
            "signing, a bucket write and an anonymous read — the last one is what catches a private bucket, " +
            "which otherwise fails only when a platform tries to fetch the file.",
          retryable: false,
        });
      }
      return check({ context });
    },
  };
};
