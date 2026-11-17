/**
 * `GET /api/assistant/agentkit/memory` — what the assistant remembers about the signed-in person (#621).
 *
 * Settings → Personal → Memory. The agent service answers from agentkit's `principal_memory` for the
 * workspace and user in the forwarded headers — the Supabase user this route authenticated, never an id
 * from the request — so a person can only ever list their own memories.
 */
import type { NextRequest } from 'next/server';
import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;
  return forwardJson(resolved.caller, '/api/memory');
}
