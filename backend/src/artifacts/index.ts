/**
 * The artifact lifecycle — `docs/05-knowledge-and-documents.md`, REQ-028 (#133).
 *
 * The store holds rows; what lives here is the part no store can hold: **entitlement**, and the pairing of a
 * version row with the content it references.
 *
 * - **AC-4 is enforced, not asserted.** `AuthorizationPolicy` is a required dependency and the decision is
 *   about the *conversation*, so an artifact is never more accessible than the conversation that produced it
 *   and there is no second permission model to keep in step with the first. The same shape #129 settled on
 *   for files, deliberately: two different answers to "who may read this" is one too many.
 * - **A version and its content are written in one call**, in the order that makes a crash survivable: blob
 *   first, row second. The reverse leaves a row pointing at content that does not exist, and a dangling
 *   reference reads as corruption while an unreferenced blob is merely waste.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext, Page } from "../core/context.js";
import { asId } from "../core/ids.js";
import type { ArtifactId, ArtifactVersionId, BlobRef, ConversationId } from "../core/ids.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactProvenance,
  ArtifactStore,
  ArtifactVersion,
  BlobStore,
} from "../persistence/index.js";

/**
 * The largest artifact this platform will store.
 *
 * A ceiling exists because an artifact is model output and model output has no natural bound. 4 MiB is a very
 * long report and far past anything a context window produced in one turn — so in practice it catches a loop
 * writing the same paragraph a thousand times, which is what it is for.
 */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export type ArtifactContent = {
  readonly kind: ArtifactKind;
  /** The content itself. Markdown and structured content are both strings or JSON values. */
  readonly value: unknown;
};

export type ArtifactServiceDeps = {
  readonly artifacts: ArtifactStore;
  readonly blobs: BlobStore;
  /**
   * AC-4, enforced rather than asserted.
   *
   * **Required.** A service that would run without a policy is a service someone constructs without one, and
   * at that point every artifact in the tenant is readable by every member of it. Tenant scoping is not AC-4.
   */
  readonly authorization: AuthorizationPolicy;
  readonly clock?: () => string;
  readonly artifactId?: () => string;
  readonly versionId?: () => string;
};

const refuse = (code: "invalid_input" | "not_found" | "conflict", message: string) =>
  new AgentPlatformError({ code, message, retryable: false });

/**
 * The size of a content value once stored.
 *
 * Measured on the serialised form, because that is what is stored and what is billed. Measuring the string
 * before serialisation would under-count a structured value by exactly the amount its encoding adds.
 */
export const contentByteSize = (value: unknown): number =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;

/** Hex SHA-256 of the stored form, so a read-back can be checked rather than assumed. */
const checksumOf = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const createArtifactService = (deps: ArtifactServiceDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const newArtifactId = deps.artifactId ?? (() => `art_${crypto.randomUUID()}`);
  const newVersionId = deps.versionId ?? (() => `ver_${crypto.randomUUID()}`);

  const authorise = async (
    context: ExecutionContext,
    action: "read" | "write",
    conversationId: ConversationId,
    absent: string,
  ): Promise<void> => {
    const decision = await deps.authorization.can(context, action, {
      type: "conversation",
      id: conversationId,
    });
    // `not_found`, never `forbidden`: a distinct answer here confirms the artifact exists to precisely the
    // caller who must not learn that.
    if (!decision.allow) throw refuse("not_found", absent);
  };

  const store = async (
    context: ExecutionContext,
    content: ArtifactContent,
  ): Promise<{ ref: BlobRef; byteSize: number; checksum: string }> => {
    const byteSize = contentByteSize(content.value);
    if (byteSize > MAX_ARTIFACT_BYTES)
      // The limit named, because "too large" sends someone to guess.
      throw refuse(
        "invalid_input",
        `that artifact is ${byteSize} bytes and the limit is ${MAX_ARTIFACT_BYTES} bytes`,
      );
    const checksum = await checksumOf(content.value);
    // Blob first. A crash here leaves an unreferenced blob, which is waste; the reverse leaves a row pointing
    // at nothing, which reads as corruption.
    const ref = await deps.blobs.put({ tenantId: context.tenantId, value: content.value });
    return { ref, byteSize, checksum };
  };

  return {
    /** Create an artifact at version 1. */
    async create(
      context: ExecutionContext,
      input: {
        readonly conversationId: ConversationId;
        readonly name: string;
        readonly content: ArtifactContent;
        readonly provenance: ArtifactProvenance;
      },
    ): Promise<Artifact> {
      await authorise(context, "write", input.conversationId, "no such conversation");
      const { ref, byteSize, checksum } = await store(context, input.content);
      return deps.artifacts.create({
        tenantId: context.tenantId,
        artifact: {
          id: asId<ArtifactId>(newArtifactId()),
          conversationId: input.conversationId,
          kind: input.content.kind,
          name: input.name,
          createdAt: clock(),
        },
        version: {
          id: asId<ArtifactVersionId>(newVersionId()),
          contentRef: ref,
          byteSize,
          checksum,
          provenance: input.provenance,
          createdBy: context.principalId,
          createdAt: clock(),
        },
      });
    },

    /**
     * Regenerate: a new version, never an overwrite — AC-2.
     *
     * `expectedLatestVersion` is read here rather than taken from the caller, and then passed through as the
     * compare. That is not redundant: the read establishes what the caller is regenerating *from*, and the
     * compare makes a concurrent regeneration lose loudly instead of silently replacing this one.
     */
    async regenerate(
      context: ExecutionContext,
      input: {
        readonly id: ArtifactId;
        readonly content: ArtifactContent;
        readonly provenance: ArtifactProvenance;
      },
    ): Promise<{ readonly version: number }> {
      const artifact = await deps.artifacts.get({ tenantId: context.tenantId, id: input.id });
      if (artifact === null || artifact.deletedAt !== undefined) throw refuse("not_found", "no such artifact");
      await authorise(context, "write", artifact.conversationId, "no such artifact");

      const { ref, byteSize, checksum } = await store(context, input.content);
      const result = await deps.artifacts.addVersion({
        tenantId: context.tenantId,
        id: input.id,
        expectedLatestVersion: artifact.latestVersion,
        version: {
          id: asId<ArtifactVersionId>(newVersionId()),
          contentRef: ref,
          byteSize,
          checksum,
          provenance: input.provenance,
          createdBy: context.principalId,
          createdAt: clock(),
        },
      });
      if (!result.added || result.version === undefined)
        // Lost the race, or the artifact was deleted between the read and the write. The blob written above is
        // now unreferenced — waste, and deliberately not cleaned up here: deleting it would risk removing
        // content the *winning* version happens to reference if two regenerations produced identical output.
        throw refuse("conflict", "that artifact changed while this version was being written");
      return { version: result.version };
    },

    /** A version's row and its content together. The latest when no version is asked for. */
    async read(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly version?: number },
    ): Promise<{
      readonly artifact: Artifact;
      readonly version: ArtifactVersion;
      readonly content: unknown;
    }> {
      const artifact = await deps.artifacts.get({ tenantId: context.tenantId, id: input.id });
      if (artifact === null || artifact.deletedAt !== undefined) throw refuse("not_found", "no such artifact");
      await authorise(context, "read", artifact.conversationId, "no such artifact");

      const version = await deps.artifacts.getVersion({
        tenantId: context.tenantId,
        id: input.id,
        ...(input.version === undefined ? {} : { version: input.version }),
      });
      if (version === null) throw refuse("not_found", "no such version of that artifact");

      const content = await deps.blobs.get({ tenantId: context.tenantId, ref: version.contentRef });
      if (content === null)
        // The row says the content is there and it is not. Reported as what it is rather than as an empty
        // artifact, because an empty artifact is something a caller might reasonably export.
        throw refuse("not_found", "that artifact version's content is missing");
      return { artifact, version, content };
    },

    /** The version history, for a restore or an audit. Metadata only — no content is loaded. */
    async history(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly limit: number; readonly cursor?: string },
    ): Promise<Page<ArtifactVersion>> {
      const artifact = await deps.artifacts.get({ tenantId: context.tenantId, id: input.id });
      if (artifact === null || artifact.deletedAt !== undefined) throw refuse("not_found", "no such artifact");
      await authorise(context, "read", artifact.conversationId, "no such artifact");
      return deps.artifacts.listVersions({
        tenantId: context.tenantId,
        id: input.id,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    },

    /**
     * Restore an earlier version by making it the newest one.
     *
     * A *new* version whose content is the old one's, not a pointer moved backwards. Moving a pointer would
     * make the history lie about what happened — and "the version that was current on Tuesday" is exactly the
     * question a shared link asks.
     */
    async restore(
      context: ExecutionContext,
      input: { readonly id: ArtifactId; readonly version: number; readonly producedBy?: string },
    ): Promise<{ readonly version: number }> {
      const artifact = await deps.artifacts.get({ tenantId: context.tenantId, id: input.id });
      if (artifact === null || artifact.deletedAt !== undefined) throw refuse("not_found", "no such artifact");
      await authorise(context, "write", artifact.conversationId, "no such artifact");

      const source = await deps.artifacts.getVersion({
        tenantId: context.tenantId,
        id: input.id,
        version: input.version,
      });
      if (source === null) throw refuse("not_found", "no such version of that artifact");

      const result = await deps.artifacts.addVersion({
        tenantId: context.tenantId,
        id: input.id,
        expectedLatestVersion: artifact.latestVersion,
        version: {
          id: asId<ArtifactVersionId>(newVersionId()),
          // The *same* blob reference. Copying the content would double the storage for a byte-identical
          // value, and a blob is immutable so sharing it is safe.
          contentRef: source.contentRef,
          byteSize: source.byteSize,
          ...(source.checksum === undefined ? {} : { checksum: source.checksum }),
          provenance: {
            producedBy: input.producedBy ?? "restore",
            // The restore records what it restored *from*, so the history explains itself without a reader
            // having to compare content refs.
            inputs: { restoredFromVersion: input.version },
            ...(source.provenance.runId === undefined ? {} : { runId: source.provenance.runId }),
            ...(source.provenance.sourceFileIds === undefined
              ? {}
              : { sourceFileIds: source.provenance.sourceFileIds }),
          },
          createdBy: context.principalId,
          createdAt: clock(),
        },
      });
      if (!result.added || result.version === undefined)
        throw refuse("conflict", "that artifact changed while the restore was being written");
      return { version: result.version };
    },

    async listForConversation(
      context: ExecutionContext,
      input: { readonly conversationId: ConversationId; readonly limit: number; readonly cursor?: string },
    ): Promise<Page<Artifact>> {
      // Authorised before the query runs, not filtered after: for an unentitled caller a page count or a
      // timing difference still answers "does this conversation have artifacts".
      await authorise(context, "read", input.conversationId, "no such conversation");
      return deps.artifacts.listByConversation({ tenantId: context.tenantId, ...input });
    },

    async softDelete(context: ExecutionContext, id: ArtifactId): Promise<{ readonly deleted: boolean }> {
      const artifact = await deps.artifacts.get({ tenantId: context.tenantId, id });
      if (artifact === null) throw refuse("not_found", "no such artifact");
      await authorise(context, "write", artifact.conversationId, "no such artifact");
      return deps.artifacts.softDelete({ tenantId: context.tenantId, id, at: clock() });
    },
  };
};

export type ArtifactService = ReturnType<typeof createArtifactService>;
