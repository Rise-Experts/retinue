/**
 * The thread rail's page, newest-touched first.
 *
 * ## The defect
 *
 * `createPostgresConversationStore`'s `list` is
 *
 *     SELECT * FROM conversations WHERE tenant_id = $1 AND deleted_at IS NULL
 *     ORDER BY created_at, id LIMIT $2
 *
 * with a forward `(created_at, id) > (…)` cursor. **Ascending.** The default limit is 30
 * (`DEFAULT_HISTORY_LIMIT`), so the sidebar was handed the thirty *oldest* conversations in the
 * workspace, oldest first, and nothing between the store and the DOM re-sorted them: the proxy route
 * forwards the body unchanged and `useConversations` renders `data` in order.
 *
 * What a user saw: one "Earlier" heading over thirty rows from whenever they started using the
 * assistant, no "Today" section at all, and the thread from five minutes ago not in the list — it was
 * behind `fetchMore()`, several pages down. The day grouping and the per-row timestamps were doing
 * precise work on the wrong thirty rows.
 *
 * It was invisible because every layer's comment asserted the opposite. `threadGroups.ts` said "the
 * API returns conversations newest first and that is the order to show them in"; `module.ts` said
 * `list` "orders by `(updated_at, id)`". Both were written from the same assumption and neither from
 * the query. A workspace with fewer than thirty conversations shows all of them, so during
 * development the list looked complete — merely in a strange order that read as "no order".
 *
 * ## Why a wrapper
 *
 * The ordering lives in the platform package, so it cannot be changed here, and the two ways to paper
 * over it in the web app are both worse. Sorting the fetched page client-side fixes the order of the
 * wrong thirty rows. Walking every page in the proxy makes a sidebar load O(conversations) and
 * silently breaks `fetchMore`'s cursor contract.
 *
 * Overriding `list` fixes it at the source: the page really is the newest thirty, the cursor really
 * does page backwards through time, and every layer above — proxy, hook, grouping, stamps, search —
 * is correct without knowing anything about this.
 *
 * ## Ordered by `updated_at`, not `created_at`
 *
 * Deliberately different from the store it wraps. The rail's column is "last touched" and
 * `groupFor`/`threadStamp` both read `updatedAt`, so ordering by `created_at` would sort the list by
 * one field and label it with another — an old conversation replied to this morning belongs at the
 * top, and under the store's ordering it sat wherever it began.
 */
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

/** The subset of `ConversationStore` this file replaces. Everything else is delegated untouched. */
type ConversationPage = {
  readonly items: readonly unknown[];
  readonly nextCursor?: string;
};

type ListInput = {
  readonly tenantId: string;
  readonly limit: number;
  readonly cursor?: string;
};

type ConversationStoreLike = {
  list(input: ListInput): Promise<ConversationPage>;
};

type Row = Record<string, unknown> & {
  readonly id: string;
  readonly tenant_id: string;
  readonly title: string;
  readonly version: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly archived_at: unknown;
  readonly deleted_at: unknown;
};

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

/**
 * The row shape the platform's own `toConversation` produces, reproduced field for field.
 *
 * Transcribed rather than imported because the adapter does not export it. The fields that are
 * *omitted* when null matter as much as the ones that are present: `ConversationSummary` distinguishes
 * an absent `archivedAt` from a null one, and the react hook's `includeArchived` filter reads it.
 */
const toConversation = (row: Row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  title: row.title,
  version: row.version,
  ...(row.archived_at === null ? {} : { archivedAt: iso(row.archived_at) }),
  ...(row.deleted_at === null ? {} : { deletedAt: iso(row.deleted_at) }),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/**
 * `(updated_at, id)` of the last row on this page, base64 JSON.
 *
 * The platform's cursor is `{ c, i }` over `created_at`; this one is `{ u, i }` over `updated_at`, and
 * the different key is the point — a cursor minted by one ordering and read by the other would page
 * through the list in an order neither of them intends. Distinct keys make that a decode failure
 * rather than a silently wrong page.
 */
const encodeCursor = (row: Row): string =>
  Buffer.from(JSON.stringify({ u: iso(row.updated_at), i: row.id })).toString("base64");

const decodeCursor = (cursor: string): { readonly u: string; readonly i: string } | undefined => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { u, i } = parsed as { u?: unknown; i?: unknown };
    return typeof u === "string" && typeof i === "string" ? { u, i } : undefined;
  } catch {
    // A cursor this function did not mint — a stale one from the old ordering, or a mangled URL.
    // Undefined means "start from the newest", which is the right answer for a sidebar: it shows the
    // top of the list rather than an error, and the next scroll pages correctly from there.
    return undefined;
  }
};

/**
 * Wrap a conversation store so `list` returns the newest-touched page first.
 *
 * Only `list` is replaced. `create`, `findById`, `update` and the rest are delegated by spread, so
 * this stays correct when the adapter grows a method — the alternative, re-declaring the whole
 * interface, is the wrapper that silently drops a method the day one is added.
 */
export const withNewestFirstConversations = <T extends ConversationStoreLike>(
  store: T,
  sql: SqlExecutor,
): T => ({
  ...store,
  async list({ tenantId, limit, cursor }: ListInput): Promise<ConversationPage> {
    const params: unknown[] = [tenantId, limit + 1];
    let where = "tenant_id = $1 AND deleted_at IS NULL";

    const decoded = cursor === undefined || cursor === "" ? undefined : decodeCursor(cursor);
    if (decoded !== undefined) {
      // Row-wise comparison, matching the ORDER BY: strictly older than the last row seen, and for
      // rows sharing a timestamp, strictly lower id. Comparing the fields separately would either skip
      // rows or repeat them across the boundary.
      where += " AND (updated_at, id) < ($3, $4)";
      params.push(decoded.u, decoded.i);
    }

    const rows = (await sql.query(
      `SELECT * FROM conversations WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $2`,
      params,
    )) as readonly Row[];

    // `limit + 1` is fetched so "is there another page" is answered without a second COUNT query —
    // the same trick the adapter uses, kept so paging behaves identically from the caller's side.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toConversation);
    const last = hasMore ? page[page.length - 1] : undefined;
    return last === undefined ? { items } : { items, nextCursor: encodeCursor(last) };
  },
}) as unknown as T;
