/**
 * `GET /api/assistant/agentkit/events` — one run's event stream, relayed unchanged.
 *
 * **Untranslated**, and that is the point. `agentkitTurn.ts` rewrites the platform's events into the
 * frame shape the old Agno chat reads; that layer exists only because the old UI was written against
 * Agno's stream. `@retinue/react`'s reducers speak the platform's own vocabulary, so translating would
 * be converting a thing into another thing and back.
 *
 * `after` is forwarded because it is what makes a reconnect cheap: the package's buffer resumes from
 * the last sequence it saw, and the backend replays from there. The old chat reconnected from zero and
 * re-rendered the turn.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { agentkitHeaders, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  const params = request.nextUrl.searchParams;
  const runId = params.get('runId');
  const conversationId = params.get('conversationId');
  if (!runId || !conversationId) {
    return NextResponse.json({ error: 'runId and conversationId are required' }, { status: 400 });
  }

  const search = new URLSearchParams({ runId, conversationId });
  const after = params.get('after');
  // `0` is a real value — "from the start" — so this checks for absence rather than falsiness.
  if (after !== null && after !== '') search.set('after', after);

  let upstream: Response;
  try {
    upstream = await fetch(`${resolved.caller.baseUrl.replace(/\/+$/, '')}/api/events?${search.toString()}`, {
      headers: { ...agentkitHeaders(resolved.caller), accept: 'text/event-stream' },
      // No timeout: a stream is meant to stay open. The client aborts when the component unmounts.
      signal: request.signal,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'the assistant backend could not be reached' },
      { status: 502 },
    );
  }

  if (!upstream.ok || upstream.body === null) {
    const body: unknown = await upstream.json().catch(() => ({}));
    return NextResponse.json(body, { status: upstream.status === 200 ? 502 : upstream.status });
  }

  /**
   * The body is passed through rather than read and re-emitted.
   *
   * Buffering it here would defeat streaming — the browser would get the whole turn at the end — and
   * re-encoding frames is a chance to corrupt one. `no-transform` is on the response because a proxy
   * that gzips an SSE stream can hold frames until its buffer fills.
   */
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Assistant-Runtime': 'agentkit',
    },
  });
}
