/**
 * The auto-reply classifier — `/reply` on the new runtime.
 *
 * ## Why this is not in `toolsViaAgentkit.ts` with its six siblings
 *
 * Because the **worker** calls it. That module serves `/api/ai/*` routes, which run in Next and may
 * use `@/` path aliases freely; the publish worker runs under `node --experimental-strip-types`, which
 * resolves no aliases and no extensionless relative imports. Putting this adapter there pulled the
 * whole route module into the worker's import graph, and `worker-imports.test.ts` immediately found
 * two things it could not load — my own `@/lib/ingest` and a pre-existing extensionless `./mediaRef`
 * that had been harmless until the graph reached it.
 *
 * Fixing those two imports would have worked and left a trap: the next `@/` import added to a route
 * module would break the ingest cycle at runtime, with the error arriving as a worker that dies on
 * start. So the worker-facing adapter lives in a worker-safe module of its own, and its imports are
 * relative and extensioned.
 *
 * ## What it does and does not decide
 *
 * Nothing is re-derived here. The matched rule, the confidence, the escalation flag and the lead all
 * come back from `draft_auto_reply`, whose deterministic half is a transcription of
 * `ai_backend/app/agents/reply.py` verified against it by a differential test over 638 values. A
 * second scoring rule on this side would be a second answer to whether a reply may be sent to a
 * stranger's public comment with nobody having read it.
 *
 * Its contract is the worker's: `ReplyAgentResult | null`, and it **never throws**. The worker reads
 * null as "leave the comment in `needs_review` with no draft", which is the right outcome for every
 * failure here — a throw would abort the account's whole cycle and leave every later comment
 * unprocessed.
 */
import { createAgentkitClient } from './agentkitClient.ts';
import type { ReplyAgentResult } from '../ingest.ts';

/** Where to call, and who is calling. `callTool` is the seam the tests drive. */
export type AutoReplyTarget = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly callTool?: (name: string, body: unknown) => Promise<{ status: number; body: unknown }>;
};

const callerFor = (target: AutoReplyTarget) =>
  target.callTool ??
  (async (name: string, body: unknown) => {
    const client = createAgentkitClient({ baseUrl: target.baseUrl, token: async () => target.secret });
    return client.callTool({ name, body, workspaceId: target.workspaceId, userId: target.userId });
  });

/**
 * `data` off a successful tool result, or `undefined`.
 *
 * Three lines duplicated from `toolsViaAgentkit.ts` rather than imported, which is the whole cost of
 * the split above: importing it would re-pull the route module into the worker graph and undo the
 * reason this file exists.
 */
const dataOf = (body: unknown): Record<string, unknown> | undefined => {
  const data = (body as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
};
export const draftAutoReplyViaAgentkit = async (
  input: AutoReplyTarget & {
    readonly request: {
      readonly comment: string;
      readonly rules: readonly { readonly title: string; readonly description: string | null }[];
      readonly accountName?: string | null;
      readonly persona?: Record<string, unknown>;
      readonly threadContext?: readonly { readonly role: 'commenter' | 'account'; readonly content: string }[];
    };
  },
): Promise<ReplyAgentResult | null> => {
  const { comment, rules, accountName, persona, threadContext } = input.request;
  if (comment.trim() === '') return null;

  let answer: { status: number; body: unknown };
  try {
    answer = await callerFor(input)('draft_auto_reply', {
      comment: comment.trim(),
      rules: rules.map((rule) => ({ title: rule.title, description: rule.description })),
      ...(accountName !== undefined && accountName !== null && accountName.trim() !== ''
        ? { accountName: accountName.trim() }
        : {}),
      ...(persona === undefined ? {} : { persona }),
      ...(threadContext === undefined || threadContext.length === 0 ? {} : { threadContext }),
    });
  } catch (thrown) {
    console.error('[Ingest] draft_auto_reply could not be reached:', thrown instanceof Error ? thrown.message : thrown);
    return null;
  }
  if (answer.status !== 200) {
    console.error(`[Ingest] draft_auto_reply returned ${answer.status}`);
    return null;
  }

  const data = dataOf(answer.body);
  const reply = data?.['reply'];
  const confidence = data?.['confidence'];
  /**
   * The two fields that gate auto-send are checked for **type**, not merely for presence.
   *
   * A missing `confidence` read as `0` is safe; a `confidence` of `"1"` coerced by `>=` would not be.
   * So a malformed answer is null — no draft, human review — rather than a draft with a number nobody
   * produced. The worker's own guard makes the same argument about a "malformed or future backend
   * response".
   */
  if (typeof reply !== 'string' || typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    console.error('[Ingest] draft_auto_reply answered without a usable reply and confidence');
    return null;
  }
  const ruleTitle = data?.['ruleTitle'];
  const escalate = data?.['escalate'];
  const lead = data?.['lead'];
  return {
    reply,
    confidence,
    ruleTitle: typeof ruleTitle === 'string' ? ruleTitle : null,
    /**
     * A non-boolean `escalate` becomes `true`, not `false`.
     *
     * The opposite of how the other fields degrade, and the reason is what the flag does: it *blocks*
     * auto-send regardless of confidence. An unreadable value must therefore fail closed — the cost of
     * a wrong `true` is a person reading a comment, and the cost of a wrong `false` is a refund
     * complaint answered automatically.
     */
    escalate: typeof escalate === 'boolean' ? escalate : true,
    lead:
      lead !== null && typeof lead === 'object' && typeof (lead as { isLead?: unknown }).isLead === 'boolean'
        ? (lead as { isLead: boolean; valueCents?: number | null; reason?: string | null })
        : { isLead: false, valueCents: null, reason: null },
  };
};
