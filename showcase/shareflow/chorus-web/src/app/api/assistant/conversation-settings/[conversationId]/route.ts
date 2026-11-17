import { NextResponse, type NextRequest } from 'next/server';
import { projectCaller } from '@/lib/projects/caller';
import { DEFAULT_CONVERSATION_SETTINGS, parseConversationSettings } from '@/lib/assistant/conversationSettings';

/**
 * GET/PUT /api/assistant/conversation-settings/:conversationId — a chat's mode, model and effort
 * (#550, #551). The person's own client, so RLS (workspace members) decides; a chat with no row reads
 * as the defaults, which is also what a brand-new chat is.
 */
const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const caller = await projectCaller(request);
  if (caller instanceof NextResponse) return caller;
  const { conversationId } = await context.params;
  if (!ID.test(conversationId)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });
  const { data } = await caller.supabase
    .from('assistant_conversation_settings')
    .select('mode, model, effort')
    .eq('conversation_id', conversationId.toLowerCase())
    .eq('workspace_id', caller.workspaceId)
    .maybeSingle();
  return NextResponse.json({ settings: data ? parseConversationSettings(data) : DEFAULT_CONVERSATION_SETTINGS });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  const caller = await projectCaller(request);
  if (caller instanceof NextResponse) return caller;
  const { conversationId } = await context.params;
  if (!ID.test(conversationId)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });
  const settings = parseConversationSettings(await request.json().catch(() => null));
  const { error } = await caller.supabase.from('assistant_conversation_settings').upsert(
    {
      conversation_id: conversationId.toLowerCase(),
      workspace_id: caller.workspaceId,
      mode: settings.mode,
      model: settings.model ?? null,
      effort: settings.effort,
      updated_by: caller.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'conversation_id' },
  );
  if (error) return NextResponse.json({ error: 'Could not save the chat settings' }, { status: 403 });
  return NextResponse.json({ settings });
}
