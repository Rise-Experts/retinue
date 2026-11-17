/**
 * `GET /api/assistant/agentkit/models` — the models this workspace's chats may pick (#551).
 *
 * The agent service answers from the same catalogue the engine honours (`model-catalogue.ts`), so the
 * chat box cannot offer a model the turn would then refuse.
 */
import type { NextRequest } from 'next/server';
import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;
  return forwardJson(resolved.caller, '/api/models');
}
