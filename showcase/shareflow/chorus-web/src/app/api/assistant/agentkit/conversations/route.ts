/**
 * `GET /api/assistant/agentkit/conversations` — the session list.
 *
 * Straight through to the backend's own history surface, which is scoped by the tenant in the headers
 * this proxy sets. The workspace was checked for *membership* before those headers were built — see
 * `resolveAgentkitCaller`, and the reason: the id arrives from the client.
 */
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const cursor = request.nextUrl.searchParams.get('cursor');
  const limit = request.nextUrl.searchParams.get('limit');
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  if (limit) search.set('limit', limit);
  const query = search.toString();
  return forwardJson(resolved.caller, `/api/conversations${query === '' ? '' : `?${query}`}`);
}
