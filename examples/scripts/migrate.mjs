#!/usr/bin/env node
/**
 * Migrate the example's schema — #155.
 *
 * Separate from boot on purpose. `AGENTKIT_SCHEMA_MODE=off` means the server never changes the database, which
 * matters here because the example runs in a **dedicated schema inside a database it shares with another
 * project**. A boot that silently migrated would make starting the example an act that modifies someone else's
 * database, and the person starting it would not know.
 *
 * So migrating is a command you run, once, on purpose.
 */
import pg from "pg";
import { migrate, MIGRATIONS, rollback } from "@agentkit/backend";

const SCHEMA = process.env.AGENTKIT_EXAMPLE_SCHEMA ?? "agentkit_example";
const URL_ = process.env.AGENTKIT_DATABASE_URL;
const DOWN = process.argv.includes("--down");

if (!URL_) {
  console.error("✗ AGENTKIT_DATABASE_URL is required. Copy .env.example to .env first.");
  process.exit(2);
}

// A bootstrap connection on the default search_path: the schema may not exist yet, and a connection asking for
// a missing schema fails to open.
const bootstrap = new pg.Pool({ connectionString: URL_, max: 1 });
await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
await bootstrap.end();

const url = new URL(URL_);
url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
const sql = { async query(text, params) { return (await pool.query(text, params ? [...params] : undefined)).rows; } };

const [{ search_path: path }] = await sql.query("SHOW search_path");
// Asserted, not assumed. A silently ignored connection option would put every table in `public` — which here is
// another project's schema.
if (!path.includes(SCHEMA)) throw new Error(`search_path is "${path}", expected ${SCHEMA}`);

if (DOWN) {
  await rollback(sql);
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  console.log(`✓ dropped schema ${SCHEMA}`);
} else {
  await migrate(sql);
  const tables = await sql.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
    [SCHEMA],
  );
  console.log(`✓ ${MIGRATIONS.length} migrations applied to ${SCHEMA} — ${tables.length} tables`);
  const other = await sql.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'public'");
  console.log(`  public schema untouched: ${other[0].n} tables`);
}
await pool.end();
