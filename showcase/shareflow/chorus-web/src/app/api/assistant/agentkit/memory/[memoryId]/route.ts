/**
 * `PATCH` (`{ enabled }`) and `DELETE /api/assistant/agentkit/memory/:id` — switch one of the signed-in
 * person's memories off or on, or forget it (#621).
 *
 * Scoped by the caller the backend authenticates from the forwarded headers: a memory id belonging to
 * anybody else answers 404, the same as one that never existed. Only `enabled` is forwarded — the text
 * of a memory is changed by telling the assistant, not by editing a row.
 *
 * `context.params` is a Promise in this version of Next — see `AGENTS.md`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

type Context = { params: Promise<{ memoryId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
  }
  const { memoryId } = await context.params;
  return forwardJson(resolved.caller, `/api/memory/${encodeURIComponent(memoryId)}`, {
    method: 'PATCH',
    body: { enabled: body.enabled },
  });
}

export async function DELETE(request: NextRequest, context: Context) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;
  const { memoryId } = await context.params;
  return forwardJson(resolved.caller, `/api/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
}
