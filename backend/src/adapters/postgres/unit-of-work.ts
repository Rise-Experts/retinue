/**
 * PostgreSQL `UnitOfWork` (#98) — the mechanism that makes "usage and session state written
 * atomically in the completion transaction" true rather than aspirational.
 *
 * Thin on purpose. All of the substance is in `transaction.ts`: the runner holds one connection for
 * the duration and binds it to the async context, so stores built over a `scoped()` executor join the
 * transaction without being passed anything. This function only has to translate the port's
 * zero-argument `run` onto that.
 *
 * The reference in-memory adapter cannot do this — it offers caller-registered compensations through
 * its own `runTx`, which the bare port cannot express, which is why `unitOfWorkConformance` gates the
 * rollback case on the `transactions` capability. Postgres is the first adapter for which that gate
 * opens, so that case now runs for real instead of standing down everywhere.
 */
import type { UnitOfWork } from "../../persistence/index.js";
import type { TransactionRunner } from "./transaction.js";

export const createPostgresUnitOfWork = (runner: TransactionRunner): UnitOfWork => ({
  run<T>(fn: () => Promise<T>): Promise<T> {
    // The executor is deliberately dropped: the port gives `fn` no parameter to receive it through,
    // so propagation is ambient (see transaction.ts). Nested `run` calls become savepoints.
    return runner.transaction(() => fn());
  },
});
