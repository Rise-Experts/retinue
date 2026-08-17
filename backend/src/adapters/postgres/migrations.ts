/**
 * Versioned, reversible migrations. Each `up`/`down` is a list of single statements so any
 * `SqlExecutor` (node-postgres or PGlite) applies them identically. `migrate` applies in order;
 * `rollback` reverses.
 */
import type { SqlExecutor } from "./sql.js";

export type Migration = {
  readonly id: string;
  readonly up: readonly string[];
  readonly down: readonly string[];
};

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_conversations",
    up: [
      `CREATE TABLE IF NOT EXISTS conversations (
        tenant_id   text        NOT NULL,
        id          text        NOT NULL,
        title       text        NOT NULL,
        version     integer     NOT NULL DEFAULT 1,
        archived_at timestamptz,
        deleted_at  timestamptz,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS conversations_tenant_created_idx
        ON conversations (tenant_id, created_at, id) WHERE deleted_at IS NULL`,
    ],
    down: [`DROP TABLE IF EXISTS conversations`],
  },
];

export const migrate = async (sql: SqlExecutor): Promise<void> => {
  for (const m of MIGRATIONS) for (const stmt of m.up) await sql.query(stmt);
};

export const rollback = async (sql: SqlExecutor): Promise<void> => {
  for (const m of [...MIGRATIONS].reverse()) for (const stmt of m.down) await sql.query(stmt);
};
