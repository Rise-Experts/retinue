/**
 * `POST /api/assistant/agentkit/interactions/:id/answer` — answer a parked question.
 *
 * This was a named 501 until the backend had somewhere to forward to. The sentence it carried is worth
 * repeating, because it is what the work turned out to be: recording an answer is a row, but *waking
 * the run* is not — the turn is parked and resuming it is the worker's business. The platform's
 * `QuestionService` does both, and only resumes claimably when it holds a `RunStore`, which is why
 * this could become a forward rather than staying a refusal.
 *
 * `context.params` is a **Promise** in this version of Next and has to be awaited — one of the
 * breaking changes `AGENTS.md` points at.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ interactionId: string }> }) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const { interactionId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { runId, answers } = (body ?? {}) as { runId?: unknown; answers?: unknown };
  if (typeof runId !== 'string' || runId.trim() === '') {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }
  /**
   * The answers themselves are **not** re-validated here.
   *
   * The backend validates them against the question that was actually asked, and a second, weaker copy
   * of that check in front of it is how the two drift: this layer would accept what the backend
   * refuses, or refuse what it accepts, and the more specific refusal is the one a person needs. What
   * this layer owns is identity — session, workspace membership, secret — which is exactly what
   * `resolveAgentkitCaller` does above.
   */
  return forwardJson(resolved.caller, `/api/interactions/${encodeURIComponent(interactionId)}/answer`, {
    method: 'POST',
    body: { runId: runId.trim(), answers },
  });
}
