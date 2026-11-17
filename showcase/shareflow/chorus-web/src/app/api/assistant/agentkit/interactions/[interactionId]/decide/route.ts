/**
 * `POST /api/assistant/agentkit/interactions/:id/decide` — decide a pending approval.
 *
 * The decision is forwarded **unchecked** by this layer and validated by the backend against the
 * platform's own `APPROVAL_DECISIONS`. A copy of that list here would be a second vocabulary to keep
 * in step, and the failure when it drifts is silent in the worst direction: a decision this route
 * rejected would look to the person like an approval that did nothing.
 *
 * `context.params` is a Promise in this version of Next — see `AGENTS.md`.
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
  const { runId, decision, conversationId } = (body ?? {}) as {
    runId?: unknown;
    decision?: unknown;
    conversationId?: unknown;
  };
  if (typeof runId !== 'string' || runId.trim() === '') {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }
  if (typeof decision !== 'string' || decision === '') {
    return NextResponse.json({ error: 'decision is required' }, { status: 400 });
  }
  return forwardJson(resolved.caller, `/api/interactions/${encodeURIComponent(interactionId)}/decide`, {
    method: 'POST',
    body: {
      runId: runId.trim(),
      decision,
      ...(typeof conversationId === 'string' && conversationId !== '' ? { conversationId } : {}),
    },
  });
}
