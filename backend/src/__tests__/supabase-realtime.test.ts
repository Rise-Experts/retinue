/**
 * Supabase Realtime as a `LiveEventSource`, and transaction-local tenant binding (#104).
 *
 * The tenant-binding cases are the ones that matter most. `setTenantContext` sets a **session-level**
 * GUC, which is correct on a direct connection and a cross-tenant leak behind Supabase's
 * transaction-mode pooler — where a backend is handed to the next client with the setting still on it.
 * That is a leak produced by the mechanism introduced to prevent leaks, so it is asserted rather than
 * described.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { RunId, TenantId } from "../core/ids.js";
import type { RunEvent } from "../core/events.js";
import { openRunEventStream } from "../runtime/streaming.js";
import {
  createPostgresRunEventLog,
  createSingleConnectionOpener,
  createTransactionScope,
  migrate,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import {
  createSupabaseLiveEventSource,
  createSupabaseRealtimePublisher,
  setTenantContext,
  withTenantContext,
  type RealtimeBroadcaster,
  type RealtimeSubscriber,
} from "../adapters/supabase/index.js";

const T1 = asId<TenantId>("sb-t1");
const RUN = asId<RunId>("sb-run1");
const CHANNEL = "run:sb-run1";

const pgliteSql = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const event = (sequence: number, type: RunEvent["type"] = "part.added"): RunEvent =>
  ({
    type,
    runId: RUN,
    sequence,
    occurredAt: `2020-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...(type === "part.added"
      ? { part: { id: `p${sequence}`, type: "text", schemaVersion: 1, createdAt: "2020-01-01T00:00:00.000Z", text: `t${sequence}` } }
      : {}),
  }) as unknown as RunEvent;

/** A subscriber over a manually driven queue, so a test controls exactly when events arrive. */
const manualSubscriber = () => {
  const queues = new Map<string, { items: unknown[]; wake?: () => void; closed: boolean }>();
  const q = (channel: string) => {
    let existing = queues.get(channel);
    if (!existing) queues.set(channel, (existing = { items: [], closed: false }));
    return existing;
  };
  const subscriber: RealtimeSubscriber = {
    subscribe(channel) {
      // Buffering starts here, at subscribe time — the contract openRunEventStream depends on.
      const queue = q(channel);
      return {
        async *[Symbol.asyncIterator]() {
          while (!queue.closed) {
            const next = queue.items.shift();
            if (next === undefined) {
              await new Promise<void>((resolve) => {
                queue.wake = resolve;
              });
              queue.wake = undefined;
              continue;
            }
            yield next;
          }
        },
      };
    },
  };
  return {
    subscriber,
    push(channel: string, payload: unknown) {
      const queue = q(channel);
      queue.items.push(payload);
      queue.wake?.();
    },
    close(channel: string) {
      const queue = q(channel);
      queue.closed = true;
      queue.wake?.();
    },
  };
};

describe("Realtime publisher and live source round-trip", () => {
  it("publishes a run event and receives it back as a validated RunEvent", async () => {
    const bus = manualSubscriber();
    const broadcaster: RealtimeBroadcaster = {
      send: (channel, _type, payload) => bus.push(channel, payload),
    };
    const publisher = createSupabaseRealtimePublisher(broadcaster);
    const live = createSupabaseLiveEventSource(bus.subscriber);

    const iterator = live.subscribe(CHANNEL)[Symbol.asyncIterator]();
    await publisher.publish(CHANNEL, event(1));
    const first = await iterator.next();
    expect(first.value).toMatchObject({ sequence: 1, type: "part.added" });
    await iterator.return?.(undefined);
  });

  it("drops a malformed payload instead of yielding it or tearing down the stream", async () => {
    const bus = manualSubscriber();
    const invalid: unknown[] = [];
    const live = createSupabaseLiveEventSource(bus.subscriber, {
      onInvalid: (_c, payload) => invalid.push(payload),
    });

    const iterator = live.subscribe(CHANNEL)[Symbol.asyncIterator]();
    // A Realtime payload comes off the network, and openRunEventStream feeds whatever the live source
    // yields straight into reduceRunEvents. Unvalidated, this would put attacker-shaped or merely
    // corrupt data into a run's projected state.
    bus.push(CHANNEL, { type: "not-a-real-event", nonsense: true });
    bus.push(CHANNEL, { sequence: "one" });
    bus.push(CHANNEL, event(1));

    const next = await iterator.next();
    // The healthy event still arrives — one bad broadcast must not kill a live stream, and the durable
    // log remains the source of truth either way.
    expect(next.value).toMatchObject({ sequence: 1 });
    expect(invalid).toHaveLength(2);
    await iterator.return?.(undefined);
  });
});

/** AC-4. Refused at subscribe, not filtered on delivery. */
describe("channel authorization", () => {
  it("yields nothing for a channel the subscriber is not entitled to", async () => {
    const bus = manualSubscriber();
    const live = createSupabaseLiveEventSource(bus.subscriber, { authorize: () => false });

    const iterator = live.subscribe(CHANNEL)[Symbol.asyncIterator]();
    bus.push(CHANNEL, event(1));
    const next = await iterator.next();
    // An ordinary empty stream, not an error: an error would distinguish "forbidden" from "no such
    // run", which tells an unentitled caller the conversation exists.
    expect(next.done).toBe(true);
    expect(next.value).toBeUndefined();
  });

  it("passes the channel to the authorizer so entitlement can be per-conversation", async () => {
    const bus = manualSubscriber();
    const seen: string[] = [];
    const live = createSupabaseLiveEventSource(bus.subscriber, {
      authorize: (channel) => {
        seen.push(channel);
        return channel === "run:allowed";
      },
    });

    const denied = live.subscribe("run:denied")[Symbol.asyncIterator]();
    expect((await denied.next()).done).toBe(true);

    const allowed = live.subscribe("run:allowed")[Symbol.asyncIterator]();
    bus.push("run:allowed", event(1));
    expect((await allowed.next()).value).toMatchObject({ sequence: 1 });
    expect(seen).toEqual(["run:denied", "run:allowed"]);
    await allowed.return?.(undefined);
  });
});

/** AC-3. Catch-up from the durable log, then live, with nothing lost or repeated at the seam. */
describe("catch-up interleaved with live events", () => {
  const seeded = async () => {
    const sql = pgliteSql(new PGlite());
    await migrate(sql);
    await sql.query(
      `INSERT INTO conversations (tenant_id, id, title, created_at, updated_at)
       VALUES ($1, 'c1', 't', now(), now())`,
      [T1],
    );
    await sql.query(
      `INSERT INTO runs (tenant_id, id, conversation_id, agent_id, agent_version, status, created_at)
       VALUES ($1, $2, 'c1', 'a1', 1, 'running', now())`,
      [T1, RUN],
    );
    return { sql, log: createPostgresRunEventLog(sql) };
  };

  it("delivers the complete ordered history across a mid-stream reconnect", async () => {
    const { log } = await seeded();
    const bus = manualSubscriber();
    const live = createSupabaseLiveEventSource(bus.subscriber);

    // Events 1–3 already durable — what a client missed while disconnected.
    for (const n of [1, 2, 3]) await log.append({ tenantId: T1, event: event(n) });

    const stream = openRunEventStream({
      tenantId: T1,
      runId: RUN,
      channel: CHANNEL,
      after: 0,
      log,
      live,
    });

    const received: number[] = [];
    const pump = (async () => {
      for await (const e of stream) {
        received.push(e.sequence);
        if (e.type === "run.completed") break;
      }
    })();

    // Published only after catch-up could have started. openRunEventStream subscribes before reading
    // the log precisely so this cannot be lost in the gap.
    await new Promise((r) => setTimeout(r, 10));
    bus.push(CHANNEL, event(4));
    bus.push(CHANNEL, event(5, "run.completed"));
    await pump;

    expect(received).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not redeliver an event that arrives live after catch-up already had it", async () => {
    const { log } = await seeded();
    const bus = manualSubscriber();
    const live = createSupabaseLiveEventSource(bus.subscriber);
    for (const n of [1, 2]) await log.append({ tenantId: T1, event: event(n) });

    const stream = openRunEventStream({ tenantId: T1, runId: RUN, channel: CHANNEL, after: 0, log, live });
    const received: number[] = [];
    const pump = (async () => {
      for await (const e of stream) {
        received.push(e.sequence);
        if (e.type === "run.completed") break;
      }
    })();

    await new Promise((r) => setTimeout(r, 10));
    // The overlap case: 1 and 2 were already delivered from the log, and Realtime replays them.
    // Without the sequence cursor a client would render duplicate parts.
    bus.push(CHANNEL, event(1));
    bus.push(CHANNEL, event(2));
    bus.push(CHANNEL, event(3, "run.completed"));
    await pump;

    expect(received).toEqual([1, 2, 3]);
  });

  it("resumes from a cursor without re-sending what the client already has", async () => {
    const { log } = await seeded();
    const bus = manualSubscriber();
    const live = createSupabaseLiveEventSource(bus.subscriber);
    for (const n of [1, 2, 3]) await log.append({ tenantId: T1, event: event(n) });

    const stream = openRunEventStream({ tenantId: T1, runId: RUN, channel: CHANNEL, after: 2, log, live });
    const received: number[] = [];
    const pump = (async () => {
      for await (const e of stream) {
        received.push(e.sequence);
        if (e.type === "run.completed") break;
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    bus.push(CHANNEL, event(4, "run.completed"));
    await pump;

    expect(received).toEqual([3, 4]);
  });
});

/**
 * Tenant binding, and why the pooling mode changes the answer.
 *
 * PGlite is a single session, which is exactly what makes this demonstrable: a session-level setting
 * surviving a transaction boundary here is the same mechanism by which it would survive being handed
 * to another client behind a transaction-mode pooler.
 */
describe("tenant binding scope", () => {
  const migrated = async () => {
    const base = pgliteSql(new PGlite());
    await migrate(base);
    const scope = createTransactionScope(createSingleConnectionOpener(base));
    return { base, sql: scope.scoped(base), runner: scope.runner };
  };

  const currentTenant = async (sql: SqlExecutor): Promise<string> => {
    const rows = await sql.query<{ t: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS t`,
    );
    return rows[0]?.t ?? "";
  };

  it("session-level binding outlives the transaction — the pooler leak", async () => {
    const { sql } = await migrated();
    await setTenantContext(sql, "tenant-a");
    expect(await currentTenant(sql)).toBe("tenant-a");

    // Nothing cleared it. Behind a transaction-mode pooler this backend is now handed to the next
    // client with tenant-a still bound, and that client's RLS-scoped queries resolve against
    // tenant-a's rows. The policy makes it look handled, which is what makes it dangerous.
    await sql.query(`SELECT 1`);
    expect(await currentTenant(sql)).toBe("tenant-a");
  });

  it("transaction-local binding is gone after the transaction", async () => {
    const { sql, runner } = await migrated();
    const inside = await withTenantContext(runner, { tenantId: "tenant-a" }, async (tx) =>
      currentTenant(tx),
    );
    expect(inside).toBe("tenant-a");
    // Discarded at commit, so the next client on this backend inherits nothing.
    expect(await currentTenant(sql)).toBe("");
  });

  it("binds the principal transaction-locally too, when one is supplied", async () => {
    const { sql, runner } = await migrated();
    const inside = await withTenantContext(
      runner,
      { tenantId: "tenant-a", principalId: "p1" },
      async (tx) => {
        const rows = await tx.query<{ p: string | null }>(
          `SELECT current_setting('app.principal_id', true) AS p`,
        );
        return rows[0]?.p ?? "";
      },
    );
    expect(inside).toBe("p1");
    const after = await sql.query<{ p: string | null }>(
      `SELECT current_setting('app.principal_id', true) AS p`,
    );
    // Principal memory is the most sensitive thing RLS scopes, so a leaked principal binding is the
    // worst version of this bug.
    expect(after[0]?.p ?? "").toBe("");
  });

  it("discards the binding on rollback as well as commit", async () => {
    const { sql, runner } = await migrated();
    await expect(
      withTenantContext(runner, { tenantId: "tenant-a" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A failed request must not leave its tenant bound for whoever gets the connection next.
    expect(await currentTenant(sql)).toBe("");
  });
});
