import { createMemoryConversationStore } from "../adapters/memory/index.js";
import { conversationStoreConformance } from "../testing/conformance.js";

// The in-memory reference adapter must pass the shared conformance suite (tenant isolation,
// pagination, optimistic concurrency, soft-delete) — the same suite every future adapter runs.
conversationStoreConformance(() => createMemoryConversationStore());
