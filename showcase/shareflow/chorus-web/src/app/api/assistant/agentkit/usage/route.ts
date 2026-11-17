/**
 * `GET /api/assistant/agentkit/usage?days=30` — what this workspace has spent on the assistant.
 *
 * The product's credit meter reads `workspaces.ai_credits_used`, and only the web app's own AI routes
 * increment it — every assistant turn goes through the new runtime and never touches it, so all of it
 * has been invisible since the cutover. The platform records usage per realized step in its own ledger;
 * nothing read it. This does.
 *
 * Tokens and cost, not "credits": what a credit is worth is a billing decision, and this route's job is
 * to report what was actually spent.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller, type AgentkitCaller } from '@/lib/assistant/agentkitProxy';
import { createAdminClient } from '@/lib/supabase-admin';
import { sumCredits } from '@/lib/billing/assistantCredits';

export const runtime = 'nodejs';

/**
 * The upstream answer plus the **Chorus credits** the same turn or chat spent — #499 AC-3.
 *
 * Tokens come from the agent's ledger, credits from the app's (`assistant_credit_charges`, written by
 * `/api/internal/credits`), so they are joined here, scoped to the caller's workspace. A failed credit
 * read reports none rather than failing the token meter it rides along with.
 */
async function withCredits(
  upstream: NextResponse,
  caller: AgentkitCaller,
  scope: { readonly column: 'run_id' | 'conversation_id'; readonly id: string; readonly label: 'turn' | 'conversation' },
): Promise<NextResponse> {
  if (!upstream.ok) return upstream;
  const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  let credits = 0;
  try {
    const { data } = await createAdminClient()
      .from('assistant_credit_charges')
      .select('credits')
      .eq('workspace_id', caller.workspaceId)
      .eq(scope.column, scope.id);
    credits = sumCredits(data as { credits: number | null }[] | null);
  } catch (error) {
    console.warn('[assistant/usage] credits not read:', error instanceof Error ? error.message : error);
  }
  return NextResponse.json({ ...body, credits, creditsScope: scope.label }, { status: upstream.status, headers: upstream.headers });
}

export async function GET(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  /**
   * `?runId=` is the session-context question — how full the model's window was on that turn — and
   * `?days=` is the spend question. One route because both are usage, and the parameter says which.
   */
  const runId = request.nextUrl.searchParams.get('runId');
  if (runId !== null && runId.trim() !== '') {
    const id = runId.trim();
    const upstream = await forwardJson(resolved.caller, `/api/usage?runId=${encodeURIComponent(id)}`, { method: 'GET' });
    return withCredits(upstream, resolved.caller, { column: 'run_id', id, label: 'turn' });
  }

  /**
   * By conversation, for one that was just *opened*: its messages come from the store and carry no run
   * id, so without this the meter appeared only after you sent something — the moment you least need
   * to be told the conversation is getting long.
   */
  const conversationId = request.nextUrl.searchParams.get('conversationId');
  if (conversationId !== null && conversationId.trim() !== '') {
    const id = conversationId.trim();
    const upstream = await forwardJson(resolved.caller, `/api/usage?conversationId=${encodeURIComponent(id)}`, { method: 'GET' });
    return withCredits(upstream, resolved.caller, { column: 'conversation_id', id, label: 'conversation' });
  }

  const asked = Number(request.nextUrl.searchParams.get('days') ?? '30');
  if (!Number.isFinite(asked) || asked <= 0) {
    return NextResponse.json({ error: 'days must be a positive number' }, { status: 400 });
  }

  // The tenant is the caller's, resolved server-side. Spend is workspace data.
  return forwardJson(resolved.caller, `/api/usage?days=${Math.min(Math.floor(asked), 365)}`, { method: 'GET' });
}
