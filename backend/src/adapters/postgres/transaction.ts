/**
 * Transactions for the PostgreSQL adapters (#98).
 *
 * **Why this file has to exist.** `SqlExecutor` is `{ query(text, params) }`, and in production it
 * wraps `pg.Pool` — where `pool.query` takes *a different connection each call*. So `BEGIN`, the
 * work, and `COMMIT` issued as three `query` calls land on three connections and guarantee nothing.
 * Every transactional promise in this SPEC is unreachable through the bare interface.
 *
 * It appears to work under PGlite because PGlite is one embedded connection, so `BEGIN` on it happens
 * to scope everything after — which is what #97's AC-3 test relied on. Correct locally, wrong on a
 * real server. That is the class of bug the CI Postgres service exists to catch.
 *
 * **Why the transaction is ambient.** The port is `UnitOfWork.run<T>(fn: () => Promise<T>)` — the
 * callback receives *nothing*. A store constructed before the transaction has no parameter through
 * which it could be told about one, and the conformance harness constructs it exactly that way. So
 * either the port widens (a bigger decision than this SPEC) or the transaction is discovered from the
 * async context. `AsyncLocalStorage` is that mechanism: `scoped()` wraps a base executor so it uses
 * the ambient transaction's connection while one is running, and the pool otherwise.
 *
 * The cost of ambient propagation is honest to state: it is invisible at the call site. A store built
 * over a *non*-scoped executor silently escapes the transaction rather than failing. See the open
 * question on #98.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlExecutor } from "./sql.js";

/** Runs `fn` with every query inside one transaction. Nesting composes via savepoints. */
export interface TransactionRunner {
  transaction<T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Grants exclusive use of a single connection for the duration of `fn`. The one thing a pool-backed
 * `SqlExecutor` cannot express, and the only primitive the runner needs from the driver.
 */
export type ConnectionOpener = <T>(fn: (sql: SqlExecutor) => Promise<T>) => Promise<T>;

export type TransactionScope = {
  readonly runner: TransactionRunner;
  /**
   * Wrap a base executor so its queries join the ambient transaction when one is running. Stores
   * built over this participate in a `UnitOfWork` without knowing transactions exist.
   */
  readonly scoped: (base: SqlExecutor) => SqlExecutor;
};

type ActiveTransaction = { readonly sql: SqlExecutor; readonly depth: number };

/**
 * A transaction scope over one connection source. The `AsyncLocalStorage` is private to the scope, so
 * two scopes over two different databases cannot pick up each other's transaction — a real hazard
 * when a process holds several executors, as the conformance suite does.
 */
export const createTransactionScope = (open: ConnectionOpener): TransactionScope => {
  const active = new AsyncLocalStorage<ActiveTransaction>();

  const runner: TransactionRunner = {
    async transaction<T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      const current = active.getStore();

      // Nested: a savepoint on the connection we are already holding. Taking a second connection
      // here would deadlock against the row locks the outer transaction is holding.
      if (current) {
        const name = `agentkit_sp_${current.depth}`;
        await current.sql.query(`SAVEPOINT ${name}`);
        try {
          const result = await active.run({ sql: current.sql, depth: current.depth + 1 }, () =>
            fn(current.sql),
          );
          await current.sql.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          // Best-effort: if the rollback itself fails the connection is already unusable, and the
          // original error is the one worth propagating.
          await current.sql.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
          throw error;
        }
      }

      return open(async (sql) => {
        await sql.query("BEGIN");
        try {
          const result = await active.run({ sql, depth: 1 }, () => fn(sql));
          await sql.query("COMMIT");
          return result;
        } catch (error) {
          await sql.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    },
  };

  const scoped = (base: SqlExecutor): SqlExecutor => ({
    query(text, params) {
      return (active.getStore()?.sql ?? base).query(text, params);
    },
  });

  return { runner, scoped };
};

/**
 * Opener over a single shared connection — PGlite, and any other single-connection executor.
 *
 * Serialised deliberately. One connection cannot hold two transactions, so concurrent callers must
 * queue or their `BEGIN`/`COMMIT` pairs interleave into nonsense. The conformance suite fires four
 * concurrent claims at the coordinator, so this is exercised rather than theoretical.
 *
 * The consequence to keep in mind: on this opener, concurrency is *simulated*. It proves ordering and
 * single-flight, never that the database adjudicates a genuine race — which is why #98's AC-1 has a
 * separate two-connection test that only runs against a real server.
 */
export const createSingleConnectionOpener = (sql: SqlExecutor): ConnectionOpener => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T> => {
    // Chained off both outcomes: a rejected predecessor must not strand every later caller.
    const result = tail.then(
      () => fn(sql),
      () => fn(sql),
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};
