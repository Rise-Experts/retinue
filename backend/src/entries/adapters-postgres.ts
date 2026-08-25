/**
 * `@agentkit/backend/adapters/postgres` — the Postgres and Supabase adapters, and the migrations.
 *
 * Its own entry because `pg` is an optional peer. Supabase ships here rather than separately: it *is* these
 * adapters over a connection with row-level security enabled, so splitting them would suggest a second
 * implementation exists.
 */

export * from "../adapters/postgres/index.js";
export * from "../adapters/supabase/index.js";
