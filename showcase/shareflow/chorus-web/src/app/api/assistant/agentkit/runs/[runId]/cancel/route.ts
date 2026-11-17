/**
 * `POST /api/assistant/agentkit/runs/:id/cancel` — ask a run to stop.
 *
 * Cancellation is **cooperative**: the backend records the request and the owning worker observes it,
 * so a 200 here means the request is recorded and not that the run has stopped. The backend's answer
 * carries the run's own status for that reason, and this route forwards it unflattened — a client told
 * "cancelled" that then watches three more tool calls arrive has been lied to.
 *
 * `context.params` is a Promise in this version of Next — see `AGENTS.md`.
 */
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const { runId } = await context.params;
  return forwardJson(resolved.caller, `/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}
