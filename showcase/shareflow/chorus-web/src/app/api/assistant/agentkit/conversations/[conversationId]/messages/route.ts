/**
 * `GET /api/assistant/agentkit/conversations/:id/messages` — one conversation's transcript.
 *
 * `context.params` is a **Promise** in this version of Next and has to be awaited. That is one of the
 * breaking changes `AGENTS.md` points at, and the app's existing dynamic routes do the same.
 */
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const { conversationId } = await context.params;
  const cursor = request.nextUrl.searchParams.get('cursor');
  const limit = request.nextUrl.searchParams.get('limit');
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  if (limit) search.set('limit', limit);
  const query = search.toString();
  return forwardJson(
    resolved.caller,
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query === '' ? '' : `?${query}`}`,
  );
}
