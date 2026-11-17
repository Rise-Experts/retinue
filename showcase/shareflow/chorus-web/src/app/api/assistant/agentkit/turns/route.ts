/**
 * `POST /api/assistant/agentkit/turns` — start a turn.
 *
 * The package's `sendMessage` returns `{ runId }` and then subscribes; this is the first half. JSON
 * rather than SSE, deliberately: the old `/api/assistant/runs` starts a turn *and* streams it in one
 * response, which is why its client cannot resume a stream without re-sending the message. Splitting
 * them is what makes `subscribeRun`'s `after` cursor usable.
 *
 * ## What a turn carries besides the text — #543
 *
 * - `attachments`: media-bucket paths from the chat box (#549). Only this workspace's own folder is kept.
 *   They were dropped in the browser before this: `Composer` sent the text and nothing else.
 * - `references`: posts and project files the person pointed at with `@` (#548). Each id is checked to be
 *   this workspace's before it is named to the agent.
 * - `settings`: the chat's agent mode, model and effort (#550, #551), forwarded for the run to obey.
 *
 * The first two become blocks inside the message (`turnBlocks.ts`), so they stay in the history.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { forwardJson, resolveAgentkitCaller } from '@/lib/assistant/agentkitProxy';
import { parseReferences, withBlocks, type TurnReference } from '@/lib/assistant/turnBlocks';
import { parseConversationSettings } from '@/lib/assistant/conversationSettings';
import { isStoragePath, MEDIA_MAX_FILES } from '@/lib/media';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

/** Keep only references to this workspace's own posts and project files — one query per kind. */
const ownedReferences = async (workspaceId: string, references: readonly TurnReference[]): Promise<TurnReference[]> => {
  if (references.length === 0) return [];
  const admin = createAdminClient();
  const postIds = references.filter((r) => r.kind === 'post').map((r) => r.id);
  const assetIds = references.filter((r) => r.kind === 'project_asset').map((r) => r.id);
  const [posts, assets] = await Promise.all([
    postIds.length === 0 ? { data: [] } : admin.from('posts').select('id').eq('workspace_id', workspaceId).in('id', postIds),
    assetIds.length === 0 ? { data: [] } : admin.from('project_assets').select('id').eq('workspace_id', workspaceId).in('id', assetIds),
  ]);
  const owned = new Set([...(posts.data ?? []), ...(assets.data ?? [])].map((row) => String((row as { id: string }).id)));
  return references.filter((r) => owned.has(r.id));
};

export async function POST(request: NextRequest) {
  const resolved = await resolveAgentkitCaller(request);
  if (!resolved.ok) return resolved.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { message, conversationId, attachments, references, settings } = (body ?? {}) as {
    message?: unknown;
    conversationId?: unknown;
    attachments?: unknown;
    references?: unknown;
    settings?: unknown;
  };
  const text = typeof message === 'string' ? message.trim() : '';
  if (text === '') return NextResponse.json({ error: 'message is required' }, { status: 400 });

  const workspaceId = resolved.caller.workspaceId;
  const paths = (Array.isArray(attachments) ? attachments : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => isStoragePath(p) && p.startsWith(`${workspaceId}/`) && !p.includes('..'))
    .slice(0, MEDIA_MAX_FILES);
  const owned = await ownedReferences(workspaceId, parseReferences(references)).catch(() => []);

  return forwardJson(resolved.caller, '/api/message', {
    method: 'POST',
    body: {
      message: withBlocks(text, owned, paths),
      // Absent means "start a thread", which the backend answers with a new id.
      ...(typeof conversationId === 'string' && conversationId !== '' ? { conversationId } : {}),
      ...(settings === undefined ? {} : { settings: parseConversationSettings(settings) }),
    },
  });
}
