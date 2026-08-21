/**
 * Supabase conformance entrypoint (#92) — the Supabase column of the adapter × port matrix.
 *
 * This column needs no hosted Supabase project and no CI secrets, which resolves the open question
 * the SPEC left for DevOps. `createSupabaseConversationStore` is an alias re-export of
 * `createPostgresConversationStore` (`adapters/supabase/index.ts`), so the Supabase store *is* the
 * Postgres store — one implementation, no drift. What is genuinely Supabase-specific is row-level
 * security and Realtime, and those keep their own cases in `supabase-adapter.test.ts`.
 *
 * The column is still worth running rather than assuming: the alias could be repointed, and RLS
 * changes the executor's effective privileges, so "same code" is a claim the suite should keep
 * checking rather than trust.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createSupabaseConversationStore, migrate, type SqlExecutor } from "../index.js";
import { createPostgresConversationStore } from "../adapters/postgres/index.js";
import { ADAPTER_COVERAGE } from "../testing/conformance/index.js";
import { conversationStoreConformance } from "../testing/conformance/conversation-store.js";

const pgliteSql = (db: PGlite): SqlExecutor => ({
  query: (text, params) => db.query(text, params ? [...params] : undefined).then((r) => r.rows as never),
});

const freshExecutor = (): SqlExecutor => {
  let ready: Promise<SqlExecutor> | null = null;
  const init = () =>
    (ready ??= (async () => {
      const sql = pgliteSql(new PGlite());
      await migrate(sql);
      return sql;
    })());
  return {
    async query(text, params) {
      return (await init()).query(text, params);
    },
  };
};

const coverage = ADAPTER_COVERAGE.find((a) => a.adapter === "supabase");

// ---------------------------------------------------------------------------------------------
// Implemented ports.
// ---------------------------------------------------------------------------------------------

conversationStoreConformance(() => createSupabaseConversationStore(freshExecutor()));

// ---------------------------------------------------------------------------------------------
// The alias contract and the registry contract.
// ---------------------------------------------------------------------------------------------

describe("supabase adapter coverage", () => {
  it("is the Postgres store, not a second implementation", () => {
    // If this ever stops holding, Supabase becomes a real second adapter and every port it claims
    // needs its own conformance run rather than inheriting Postgres's.
    expect(createSupabaseConversationStore).toBe(createPostgresConversationStore);
  });

  it("implements exactly the ports the registry claims", () => {
    expect(coverage).toBeDefined();
    expect([...(coverage?.implemented ?? [])]).toEqual(["ConversationStore"]);
  });

  it("tracks every unimplemented port to #104, which brings the Postgres stores across", () => {
    expect(coverage?.notImplemented.length).toBe(18);
    for (const { port, trackedBy } of coverage?.notImplemented ?? []) {
      expect(trackedBy, `${port} must name its tracking issue`).toBe("#104");
    }
  });
});
