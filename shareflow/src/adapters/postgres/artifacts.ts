/**
 * `ArtifactService` over `assistant_artifacts` — REQ-041 (#190).
 *
 * The first of the three capabilities that were "a tool away": the rows, the versioning and the reference
 * scheme all exist in ShareFlow already, and the old runtime's Documents agent reached them through
 * `POST /api/internal/artifacts`. What was missing here was a service and three tools.
 *
 * ## It reads ShareFlow's table, not the platform's artifact service
 *
 * `@retinue/agentkit` ships `createArtifactService` with its own storage, and using it would have been less
 * code. It would also have been the wrong table: a customer's existing artifacts are rows in
 * `assistant_artifacts`, every `chorus-artifact:` link in their chat history resolves against that id, and a
 * "replacement" that wrote somewhere else would leave every one of those links dead while reporting a
 * migrated capability. Same defect as mapping a status from the calling code — plausible, and about the wrong
 * thing.
 *
 * ## Archive before update, and now under a lock
 *
 * The old lib's invariant, quoted because the ordering is the whole promise: *"The OLD content is archived
 * before the update, not after — if the archive write fails, the revision is refused and the previous version
 * is still intact."* That is kept exactly.
 *
 * What is added is the lock. The old path is read → archive → update on separate connections, and two
 * concurrent revisions of the same artifact both read version 1, so both try to insert version 1 into
 * `assistant_artifact_versions`. `assistant_artifact_versions_artifact_id_version_key` refuses the second,
 * which is why the old code cannot lose a version — the safety is the unique index, not the sequencing. But
 * the second caller gets "Could not archive the current version" and a 500 for what is a queueing problem.
 *
 * So `revise` takes `select … for update` on the artifact row inside a real transaction. Every version is
 * still archived before its replacement is written; the second writer waits, sees version 2, and produces
 * version 3 instead of an error. That is a **deliberate difference from the old contract**, recorded on the
 * inventory entry rather than smoothed over: the behaviour it removes is a race artifact, and the guarantee
 * the old code actually made — no version is ever lost or overwritten — is the one preserved.
 */

import { AgentPlatformError, asId, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  type Artifact,
  type ArtifactId,
  type ArtifactKind,
  type ArtifactService,
} from "../../services/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `chorus-artifact:` — the app's own scheme, so a link the assistant writes opens the app's panel. */
export const ARTIFACT_SCHEME = "chorus-artifact:";

/**
 * A reference, or `undefined` for anything that is not a uuid.
 *
 * The app's formatter returns null in that case and the reason is worth keeping: a reply streams token by
 * token, so `chorus-artifact:8f14e45` exists for a frame, and a client that rendered a card for it would
 * fetch an artifact that cannot be found. Absent means "do not link to this".
 */
export const artifactReference = (id: string): string | undefined =>
  UUID.test(id.trim()) ? `${ARTIFACT_SCHEME}${id.trim().toLowerCase()}` : undefined;

const KINDS: ReadonlySet<string> = new Set(ARTIFACT_KINDS);

export const isArtifactKind = (value: unknown): value is ArtifactKind =>
  typeof value === "string" && KINDS.has(value);

const invalid = (message: string) =>
  new AgentPlatformError({ code: "invalid_input", message, retryable: false });

const asUuid = (field: string, value: string): string => {
  if (!UUID.test(value.trim())) {
    throw invalid(`${field} must be a UUID — got ${JSON.stringify(value.slice(0, 60))}.`);
  }
  return value.trim();
};

/**
 * The old lib's `validate`, clause for clause and in the same order.
 *
 * In the same order because the *message* is part of the contract: a model that gets "An artifact needs a
 * title" retries with a title, and one that gets a length complaint first would truncate content it did not
 * need to. `content.trim()` rather than `content.length` is theirs too — whitespace is not a document.
 */
const validate = (title: string, kind: unknown, content: string): ArtifactKind => {
  if (title.trim() === "") throw invalid("An artifact needs a title.");
  if (title.length > ARTIFACT_MAX_TITLE) {
    throw invalid(`A title can be at most ${ARTIFACT_MAX_TITLE} characters.`);
  }
  if (!isArtifactKind(kind)) {
    throw invalid(`kind must be one of: ${ARTIFACT_KINDS.join(", ")}.`);
  }
  if (content.trim() === "") throw invalid("An artifact needs content.");
  if (content.length > ARTIFACT_MAX_CHARS) {
    throw invalid(`Content can be at most ${ARTIFACT_MAX_CHARS} characters.`);
  }
  return kind;
};

type ArtifactRow = {
  id: string;
  title: string;
  kind: string;
  content: string;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
};

const ARTIFACT_COLUMNS = `id, title, kind, content, version, created_at, updated_at`;

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * An unrecognised `kind` reads as `markdown`, matching the app's narrowing rather than casting.
 *
 * The constraint guarantees one of three today. The app narrows anyway — *"a widened union leaking into the
 * renderer would silently pick the wrong view"* — and the same is true of a model: told an artifact is `html`
 * when it is not, it will write html into a markdown document.
 */
const kindFrom = (value: string): ArtifactKind => (isArtifactKind(value) ? value : "markdown");

const toArtifact = (row: ArtifactRow): Artifact => {
  const reference = artifactReference(row.id);
  return {
    id: asId<ArtifactId>(row.id),
    title: row.title,
    kind: kindFrom(row.kind),
    content: row.content,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(reference === undefined ? {} : { reference }),
  };
};

export type ArtifactDeps = {
  readonly sql: SqlExecutor;
  /**
   * Required, because `revise` is a read-then-write and a pooled executor cannot express the lock.
   *
   * The same reason `PublishingService` and `EngagementService` need one: a guard read on one connection and
   * acted on from another is not a guard.
   */
  readonly transaction: TransactionRunner;
  readonly now?: () => number;
};

/**
 * One `audit_log` row per write, best-effort — REQ-041 AC-4, "the same side effects".
 *
 * ShareFlow's `/audit` screen reads this table, and the old runtime writes to it from **every** internal
 * write: artifacts, drafts, schedules, reposts, branding, media. Skipping it would make a customer's audit
 * trail go quiet for exactly the actions an assistant took on their behalf — the ones they most want listed.
 *
 * Failures are swallowed, which is the app's own rule: *"an audit write must never break (or fail the
 * response of) the action it records"*. Logged rather than silent, because a trail that stopped for a week
 * with nobody noticing is the failure this comment is about.
 */
const audit = async (
  sql: SqlExecutor,
  context: ExecutionContext,
  input: { readonly action: string; readonly artifactId: string; readonly detail: Record<string, unknown> },
): Promise<void> => {
  try {
    await sql.query(
      `insert into public.audit_log (workspace_id, actor_id, action, target_type, target_id, detail)
       values ($1::uuid, $2::uuid, $3, 'artifact', $4, $5::jsonb)`,
      [
        String(context.tenantId),
        String(context.principalId),
        input.action,
        input.artifactId,
        JSON.stringify({ source: "assistant", ...input.detail }),
      ],
    );
  } catch (error) {
    console.warn(
      `[shareflow] audit_log write failed for ${input.action} on ${input.artifactId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const createPostgresArtifactService = (deps: ArtifactDeps): ArtifactService => {
  const now = deps.now ?? Date.now;
  const { sql } = deps;

  const one = async (context: ExecutionContext, id: string): Promise<ArtifactRow> => {
    const rows = await sql.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS} from public.assistant_artifacts
        where workspace_id = $1::uuid and id = $2::uuid`,
      [String(context.tenantId), asUuid("artifactId", id)],
    );
    const row = rows[0];
    if (row === undefined) {
      /**
       * `not_found` for absent and for another workspace's alike.
       *
       * The app's own comment says why: *"a foreign artifact reads as not-found rather than forbidden"* —
       * `forbidden` confirms the id exists, which is a fact about another tenant's data.
       */
      throw new AgentPlatformError({ code: "not_found", message: `No artifact ${id}.`, retryable: false });
    }
    return row;
  };

  return {
    async create(context, input): Promise<Artifact> {
      const title = input.title.trim();
      const kind = validate(title, input.kind, input.content);

      const rows = await sql.query<ArtifactRow>(
        `insert into public.assistant_artifacts
           (workspace_id, created_by, session_id, title, kind, content)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6)
         returning ${ARTIFACT_COLUMNS}`,
        [
          String(context.tenantId),
          String(context.principalId),
          /**
           * Provenance only, and nullable on purpose.
           *
           * `session_id` is `text` with no foreign key, and the app's comment is explicit that *"the artifact
           * outlives the session, so this is not a foreign key and is never used for access control"*. The
           * platform's `conversationId` is the nearest true thing; absent when a tool runs outside one, which
           * is a fact rather than a gap to fill with a placeholder.
           */
          context.conversationId === undefined ? null : String(context.conversationId),
          title,
          kind,
          input.content,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({
          code: "provider_error",
          message: "The artifact was not created.",
          retryable: true,
        });
      }

      await audit(sql, context, {
        action: "artifact.created",
        artifactId: row.id,
        detail: { kind, title },
      });
      return toArtifact(row);
    },

    async revise(context, input): Promise<Artifact> {
      const existing = await one(context, String(input.id));

      const updated = await deps.transaction.transaction(async (tx) => {
        /**
         * The lock, and it is re-read inside the transaction rather than trusting the row above.
         *
         * Re-read because between the two statements another revision may have committed: acting on the
         * version this call first saw would archive a version that is no longer current and write a version
         * number that already exists. The unique index would catch that — the whole point is not to rely on
         * it.
         */
        const current = (
          await tx.query<ArtifactRow>(
            `select ${ARTIFACT_COLUMNS} from public.assistant_artifacts
              where workspace_id = $1::uuid and id = $2::uuid
              for update`,
            [String(context.tenantId), existing.id],
          )
        )[0];
        if (current === undefined) return undefined;

        const title = (input.title ?? current.title).trim();
        /**
         * The stored kind is passed because `validate` needs *a* valid one to reach the title and content
         * checks — and that is all this call does with it.
         *
         * The first version of this comment claimed the stored kind was what stopped a revision changing the
         * kind, and a sabotage proved otherwise: replacing `current.kind` with a literal `"markdown"` broke
         * **no test**, because `validate` only asks whether a kind is one of the three and this statement
         * never writes the column. The real guarantee is two other things — `ArtifactService.revise` has no
         * `kind` field and the tool schema is `.strict()` — and both are tested. The `UPDATE` below not
         * mentioning `kind` is the third, and it is pinned by a source scan, because no assertion on the
         * result can tell "did not write it" from "wrote the same value".
         */
        validate(title, current.kind, input.content);

        // Archive first. If this fails the revision is refused and the previous version is still intact.
        await tx.query(
          `insert into public.assistant_artifact_versions (artifact_id, version, title, content)
           values ($1::uuid, $2, $3, $4)`,
          [current.id, current.version, current.title, current.content],
        );

        const rows = await tx.query<ArtifactRow>(
          `update public.assistant_artifacts
              set title = $3, content = $4, version = $5, updated_at = $6::timestamptz
            where workspace_id = $1::uuid and id = $2::uuid
            returning ${ARTIFACT_COLUMNS}`,
          [
            String(context.tenantId),
            current.id,
            title,
            input.content,
            current.version + 1,
            new Date(now()).toISOString(),
          ],
        );
        return rows[0];
      });

      if (updated === undefined) {
        // Deleted between the read and the lock. Reported as gone rather than retried into a new artifact.
        throw new AgentPlatformError({
          code: "not_found",
          message: `Artifact ${String(input.id)} no longer exists.`,
          retryable: false,
        });
      }

      await audit(sql, context, {
        action: "artifact.updated",
        artifactId: updated.id,
        detail: { version: updated.version, title: updated.title },
      });
      return toArtifact(updated);
    },

    async get(context, input): Promise<Artifact> {
      return toArtifact(await one(context, String(input.id)));
    },
  };
};
