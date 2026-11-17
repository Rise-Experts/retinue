/**
 * `GET /api/assistant/agentkit/interactions/pending?runId=…` — what a paused run is waiting for.
 *
 * **This is what made an approval invisible.** A run that reaches a gated tool parks at
 * `waiting-for-approval`, and the engine announces that as an *event* (`approval.requested`, carrying
 * only an interaction id) rather than as a message part. The chat derived its permission card from the
 * message parts — as `@retinue/react`'s own `usePendingInteraction` does — so it found nothing: a greyed
 * tool chip, a disabled composer, and no way to say yes. From the user's side the assistant just stops.
 * It was reported as *"reply to comment gets stuck"*, and it was every gated tool, publishing included.
 *
 * The event carries no detail either, so this fetches the record: the tool, its normalized arguments,
 * the risk category and the summary the card renders.
 *
 * A GET with the run in the query rather than the path, because the caller has a run id and not an
 * interaction id — not knowing what it is waiting for is the entire reason it is asking.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const runId = request.nextUrl.searchParams.get('runId');
  if (runId === null || runId.trim() === '') {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }

  /**
   * The tenant is the caller's, resolved server-side — never a parameter.
   *
   * A pending approval names a tool and carries its arguments, so reading one for somebody else's run
   * would leak what another workspace is doing. `resolveAgentkitCaller` is the same gate the answer and
   * decide routes use.
   */
  return forwardJson(
    resolved.caller,
    `/api/interactions/pending?runId=${encodeURIComponent(runId.trim())}`,
    { method: 'GET' },
  );
}
