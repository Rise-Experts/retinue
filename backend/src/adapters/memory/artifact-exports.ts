/**
 * In-memory `ArtifactExportStore` — the reference implementation (#134).
 *
 * The only interesting behaviour is `claim`, and it is interesting for one reason: **it must be a claim, not
 * an insert.** Two requests for the same PDF must produce one render, and the second must be told so rather
 * than starting a duplicate. A blind insert would render the same document twice and leave two rows pointing
 * at two identical files.
 */

import type { Page } from "../../core/context.js";
import { AgentPlatformError } from "../../core/errors.js";
import type { ArtifactExport, ArtifactExportStore, ExportFormat } from "../../persistence/index.js";

const tenantMap = <V>(outer: Map<string, Map<string, V>>, tenantId: string): Map<string, V> => {
  let inner = outer.get(tenantId);
  if (!inner) outer.set(tenantId, (inner = new Map<string, V>()));
  return inner;
};

/** The uniqueness the store enforces: one export per version per format. */
const slotKey = (artifactId: string, version: number, format: ExportFormat): string =>
  `${artifactId} ${version} ${format}`;

const assertTimestamp = (at: string, field: string): void => {
  if (Number.isNaN(Date.parse(at)))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be an ISO timestamp, got ${JSON.stringify(at)}`,
      retryable: false,
    });
};

/** Keyset on `(createdAt, id)`, matching the Postgres adapter's encoding so the conformance suite exercises
 * the real contract rather than a simpler one the reference adapter happened to have. */
const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt} ${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { createdAt: string; id: string } | null => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  return createdAt === undefined || id === undefined ? null : { createdAt, id };
};

const paginate = (rows: readonly ArtifactExport[], limit: number, cursor?: string): Page<ArtifactExport> => {
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

export const createMemoryArtifactExportStore = (): ArtifactExportStore => {
  const byTenant = new Map<string, Map<string, ArtifactExport>>();
  const slots = new Map<string, Map<string, string>>();

  return {
    async claim({ tenantId, export: requested }) {
      assertTimestamp(requested.createdAt, "createdAt");
      const rows = tenantMap(byTenant, tenantId);
      const slotIndex = tenantMap(slots, tenantId);
      const key = slotKey(requested.artifactId, requested.version, requested.format);

      const existingId = slotIndex.get(key);
      if (existingId !== undefined) {
        const existing = rows.get(existingId);
        // The slot is taken. Returned rather than refused, because the caller's next move is the same either
        // way: read this row. `claimed: false` is what stops it *rendering*.
        if (existing !== undefined) return { claimed: false, export: existing };
      }

      const created: ArtifactExport = { ...requested, state: "pending" };
      rows.set(created.id, created);
      slotIndex.set(key, created.id);
      return { claimed: true, export: created };
    },

    async complete({ tenantId, id, state, fileId, byteSize, checksum, failureReason, failureMessage, at }) {
      assertTimestamp(at, "at");
      const rows = tenantMap(byTenant, tenantId);
      const existing = rows.get(id);
      // Absent means the export was removed under the worker. Reported rather than thrown: an ordinary race,
      // and a worker that threw would retry a row that no longer exists.
      if (existing === undefined) return { recorded: false };
      rows.set(id, {
        ...existing,
        state,
        ...(fileId === undefined ? {} : { fileId }),
        ...(byteSize === undefined ? {} : { byteSize }),
        ...(checksum === undefined ? {} : { checksum }),
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(failureMessage === undefined ? {} : { failureMessage }),
        renderedAt: at,
      });
      return { recorded: true };
    },

    async get({ tenantId, id }) {
      // Absent from *this tenant's* map, so a foreign id is null without a comparison anyone could get wrong.
      return tenantMap(byTenant, tenantId).get(id) ?? null;
    },

    async find({ tenantId, artifactId, version, format }) {
      const id = tenantMap(slots, tenantId).get(slotKey(artifactId, version, format));
      return id === undefined ? null : (tenantMap(byTenant, tenantId).get(id) ?? null);
    },

    async listByArtifact({ tenantId, artifactId, limit, cursor }) {
      const rows = [...tenantMap(byTenant, tenantId).values()].filter((e) => e.artifactId === artifactId);
      return paginate(rows, limit, cursor);
    },
  };
};
