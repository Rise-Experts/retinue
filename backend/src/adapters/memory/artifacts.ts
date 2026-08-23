/**
 * In-memory `ArtifactStore` — the reference implementation (#133).
 *
 * Two things it takes as seriously as the Postgres adapter will, because the conformance suite measures the
 * others against this one and a laxer reference makes a production failure a passing test (the lesson #129
 * learned when a placeholder timestamp sailed through here and was rejected by Postgres):
 *
 * - **Tenant partitioning is by outer map, not a filter.** An artifact id from one tenant cannot resolve
 *   another's row because it is not in that tenant's map at all.
 * - **`addVersion` is a compare-and-set.** A blind append would let two concurrent regenerations both become
 *   version 2, and one would silently replace the other — which breaks the one property AC-2 asks for.
 */

import type { Page } from "../../core/context.js";
import { AgentPlatformError } from "../../core/errors.js";
import type {
  Artifact,
  ArtifactStore,
  ArtifactVersion,
} from "../../persistence/index.js";

type Entry = { artifact: Artifact; versions: ArtifactVersion[] };

const tenantMap = <V>(outer: Map<string, Map<string, V>>, tenantId: string): Map<string, V> => {
  let inner = outer.get(tenantId);
  if (!inner) outer.set(tenantId, (inner = new Map<string, V>()));
  return inner;
};

/** Keyset cursor on `(createdAt, id)` — the same encoding the other stores use, for the same reason. */
const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt} ${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  return createdAt === undefined || id === undefined ? null : { createdAt, id };
};

const paginate = <T extends { createdAt: string; id: string }>(
  rows: readonly T[],
  limit: number,
  cursor?: string,
): Page<T> => {
  const sorted = [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
  const after = cursor === undefined ? null : decodeCursor(cursor);
  const start =
    after === null
      ? 0
      : sorted.findIndex(
          (r) => r.createdAt > after.createdAt || (r.createdAt === after.createdAt && r.id > after.id),
        );
  const from = start < 0 ? sorted.length : start;
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  return from + limit < sorted.length && last !== undefined
    ? { items, nextCursor: encodeCursor(last.createdAt, last.id) }
    : { items };
};

/** Versions page on the contiguous version number, which is an exact cursor rather than an approximate one. */
const paginateVersions = (
  versions: readonly ArtifactVersion[],
  limit: number,
  cursor?: string,
): Page<ArtifactVersion> => {
  const after = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const items = sorted.filter((v) => v.version > from).slice(0, limit);
  const last = items[items.length - 1];
  return last !== undefined && sorted.some((v) => v.version > last.version)
    ? { items, nextCursor: String(last.version) }
    : { items };
};

const assertTimestamp = (at: string, field: string): void => {
  if (Number.isNaN(Date.parse(at)))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be an ISO timestamp, got ${JSON.stringify(at)}`,
      retryable: false,
    });
};

export const createMemoryArtifactStore = (): ArtifactStore => {
  const byTenant = new Map<string, Map<string, Entry>>();

  return {
    async create({ tenantId, artifact, version }) {
      const entries = tenantMap(byTenant, tenantId);
      if (entries.has(artifact.id))
        throw new AgentPlatformError({
          code: "conflict",
          message: `artifact ${artifact.id} already exists`,
          retryable: false,
        });
      assertTimestamp(artifact.createdAt, "createdAt");
      const created: Artifact = { ...artifact, latestVersion: 1, updatedAt: artifact.createdAt };
      entries.set(artifact.id, {
        artifact: created,
        // Version 1 is created with the artifact: an artifact with no version is not a thing a reader can
        // resolve, and allowing the state would mean every reader handling it.
        versions: [{ ...version, artifactId: artifact.id, version: 1 }],
      });
      return created;
    },

    async addVersion({ tenantId, id, expectedLatestVersion, version }) {
      const entry = tenantMap(byTenant, tenantId).get(id);
      // The compare. Two concurrent regenerations both hold `expectedLatestVersion: 1`; exactly one wins,
      // and the loser is told so rather than silently overwriting the winner's version 2.
      if (entry === undefined || entry.artifact.latestVersion !== expectedLatestVersion) return { added: false };
      if (entry.artifact.deletedAt !== undefined) return { added: false };
      assertTimestamp(version.createdAt, "version.createdAt");
      const next = expectedLatestVersion + 1;
      entry.versions.push({ ...version, artifactId: id, version: next });
      entry.artifact = { ...entry.artifact, latestVersion: next, updatedAt: version.createdAt };
      return { added: true, version: next };
    },

    async get({ tenantId, id }) {
      // Absent from *this tenant's* map, so a foreign id is null without a comparison anyone could get wrong.
      return tenantMap(byTenant, tenantId).get(id)?.artifact ?? null;
    },

    async getVersion({ tenantId, id, version }) {
      const entry = tenantMap(byTenant, tenantId).get(id);
      if (entry === undefined) return null;
      // The latest by default. A reader who does not ask for a version wants the current one, and an earlier
      // version stays resolvable by asking — which is AC-2 from the reading side.
      const wanted = version ?? entry.artifact.latestVersion;
      return entry.versions.find((v) => v.version === wanted) ?? null;
    },

    async listByConversation({ tenantId, conversationId, limit, cursor }) {
      const rows = [...tenantMap(byTenant, tenantId).values()]
        .map((e) => e.artifact)
        // Live only: a deleted artifact reappearing in a conversation is a deleted document coming back.
        .filter((a) => a.conversationId === conversationId && a.deletedAt === undefined);
      return paginate(rows, limit, cursor);
    },

    async listVersions({ tenantId, id, limit, cursor }) {
      const entry = tenantMap(byTenant, tenantId).get(id);
      if (entry === undefined) return { items: [] };
      // Paged on the version *number*, not on `(createdAt, id)` like every other listing here. Versions are
      // 1-based and contiguous, so the number is an exact cursor — and two versions created in the same
      // millisecond would tie under a timestamp keyset, which for a history is the one place order must not
      // be approximate.
      return paginateVersions(entry.versions, limit, cursor);
    },

    async softDelete({ tenantId, id, at }) {
      assertTimestamp(at, "at");
      const entry = tenantMap(byTenant, tenantId).get(id);
      if (entry === undefined) return { deleted: false };
      // Idempotent: deleting twice is the same as deleting once, which a retried request depends on.
      entry.artifact = { ...entry.artifact, deletedAt: entry.artifact.deletedAt ?? at, updatedAt: at };
      return { deleted: true };
    },
  };
};
