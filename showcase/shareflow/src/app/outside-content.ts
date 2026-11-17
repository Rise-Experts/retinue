/**
 * Whether a run has read outside content — #662, Guardrail F.
 *
 * Only `external-write` and `destructive` tools ask by their effect, so the 35 `internal-write` tools (drafts, the
 * brand profile, remembered rules, …) ran unchecked even right after the agent read a web page. Once untrusted text is
 * in the context, a write it asked for must not follow from it unchecked ("Design Patterns for Securing LLM Agents",
 * CaMeL). So a run that has fetched a page, searched, read an external document or read comments is *marked*, and
 * from then on `agent-mode.ts` sends its internal writes through the same approval card as Ask-first mode.
 *
 * Derived from which tool ran, **not** a fifth `ToolEffect`: effect derives approval in three places, and a new value
 * is silently ungated wherever one is missed (the tool-effect decision, #228).
 *
 * The mark lives in memory for the process that saw the read, and is looked up in `run_events` for a run resumed
 * elsewhere — an approval pauses a run and a decision resumes it as a job, often on another worker, and a run that
 * forgot its mark there would write unchecked after the first approval.
 */
import type { ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

/** The tools whose results carry text nobody in this workspace wrote. */
export const OUTSIDE_CONTENT_TOOLS: readonly string[] = ["search_web", "read_source", "read_pdf", "extract_brand_kit", "list_comments"];

/**
 * Internal writes that stay free after an outside read: the document being edited in this chat (#662's scope), and
 * the screenshot tool, which stores a picture of a page the person named and reads nothing back.
 */
export const FREE_AFTER_OUTSIDE_READ: readonly string[] = ["create_artifact", "update_artifact", "generate_pdf", "capture_website"];

export type OutsideReads = {
  /** Whether this run has read outside content. False for a context with no run. */
  has(context: ExecutionContext): Promise<boolean>;
  /** Records that this run just read outside content. */
  mark(context: ExecutionContext): void;
};

type Lookup = (tenantId: string, runId: string) => Promise<boolean>;

/** Looks the run's completed tool calls up in `run_events`, by the tool that actually ran. */
export const outsideReadsInRunEvents =
  (sql: SqlExecutor): Lookup =>
  async (tenantId, runId) => {
    const rows = await sql.query<{ found: number }>(
      `SELECT 1 AS found FROM run_events
        WHERE tenant_id = $1 AND run_id = $2 AND type = 'tool.completed'
          AND (event->>'toolName' = ANY($3) OR event->>'ranToolName' = ANY($3))
        LIMIT 1`,
      [tenantId, runId, OUTSIDE_CONTENT_TOOLS],
    );
    return rows.length > 0;
  };

/**
 * Only the *mark* is cached. "Not marked" is asked again on each write, because a run resumed on another worker may
 * have read something there since: the lookup is one primary-key-prefixed query, and a turn makes few writes.
 */
export const createOutsideReads = (lookup: Lookup, capacity = 500): OutsideReads => {
  const marked = new Set<string>();
  const keyOf = (context: ExecutionContext): string | undefined =>
    context.runId === undefined ? undefined : `${String(context.tenantId)}:${String(context.runId)}`;
  const mark = (key: string) => {
    marked.add(key);
    if (marked.size > capacity) marked.delete(marked.values().next().value as string);
  };
  return {
    async has(context) {
      const key = keyOf(context);
      if (key === undefined) return false;
      if (marked.has(key)) return true;
      try {
        if (!(await lookup(String(context.tenantId), String(context.runId)))) return false;
      } catch (error) {
        // Asking once too often is the safe direction.
        console.warn(`[shareflow] run ${String(context.runId)}'s outside reads could not be read (${error instanceof Error ? error.message : String(error)}); asking before writes.`);
        return true;
      }
      mark(key);
      return true;
    },
    mark(context) {
      const key = keyOf(context);
      if (key !== undefined) mark(key);
    },
  };
};
