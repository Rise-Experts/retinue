/**
 * Every context provider the example puts in a prompt, in one place.
 *
 * Two callers need this list and they must not disagree: the app module, which assembles the prompt the model
 * actually sees, and `/api/context`, which reports how full the window is. A second list would make the
 * utilization figure a report about a different prompt — the most useless kind of monitoring, the kind that is
 * confidently wrong.
 */

import { createPostgresPrincipalMemoryStore, createPrincipalMemoryProvider } from "@agentkit/backend";
import type { ContextProvider, SqlExecutor } from "@agentkit/backend";
import { exampleContextProviders } from "./agent.js";
import { exampleStore } from "./store.js";

/** How many memories may reach a prompt. Retrieval is salience-ranked, so this is a budget, not a cap on recall. */
export const MEMORY_ENTRIES_IN_PROMPT = 8;

export const exampleProviders = (sql: SqlExecutor): readonly ContextProvider[] => [
  ...exampleContextProviders(exampleStore),
  /**
   * The platform's provider over `PrincipalMemoryStore`, not a local one.
   *
   * The example used to hand-roll this over an in-process `Map`, which is why a fact told in one conversation was
   * gone in the next: the map lived in the worker process and died with it (#164).
   */
  createPrincipalMemoryProvider({ store: createPostgresPrincipalMemoryStore(sql), maxEntries: MEMORY_ENTRIES_IN_PROMPT }),
];
