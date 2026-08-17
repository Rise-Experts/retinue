/**
 * Minimal SQL executor the PostgreSQL adapters are written against, so the store code is pure
 * SQL and imports no driver. Production wraps `pg.Pool` (`createPgExecutor`); tests wrap PGlite.
 */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
}
