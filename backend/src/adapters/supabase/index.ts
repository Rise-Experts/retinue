/**
 * Supabase adapter — Postgres store + RLS + Realtime. Supabase *is* Postgres, so the store is
 * the PostgreSQL `ConversationStore`; this module adds the Supabase-specific RLS policies and a
 * Realtime publisher, and advertises the extra capabilities.
 */
import type { AdapterCapability } from "../../persistence/index.js";

export { createPostgresConversationStore as createSupabaseConversationStore } from "../postgres/conversation-store.js";
export * from "./rls.js";
export * from "./realtime.js";

export const SUPABASE_CAPABILITIES: readonly AdapterCapability[] = [
  "transactions",
  "row-level-security",
  "full-text-search",
  "realtime",
];
