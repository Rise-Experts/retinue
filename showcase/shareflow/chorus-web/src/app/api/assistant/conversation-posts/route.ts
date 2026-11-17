import { NextResponse, type NextRequest } from 'next/server';
import { projectCaller } from '@/lib/projects/caller';
import { normalisePlatformIds } from '@/lib/platforms';

/**
 * GET /api/assistant/conversation-posts?conversationId= — every post a chat made (#547).
 *
 * Drafts record the conversation that wrote them (`posts.conversation_id`, #500); this lists them newest
 * first for the "Posts in this chat" pane. The person's own client, so RLS scopes it as it scopes /posts.
 */
const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function GET(request: NextRequest) {
  const caller = await projectCaller(request);
  if (caller instanceof NextResponse) return caller;
  // `?recent=1` (#548's @ picker): the workspace's latest posts, whichever chat made them.
  const recent = request.nextUrl.searchParams.get('recent') === '1';
  const conversationId = request.nextUrl.searchParams.get('conversationId') ?? '';
  if (!recent && !ID.test(conversationId)) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  let query = caller.supabase
    .from('posts')
    .select('id, raw_content, status, target_platforms, media_urls, updated_at, project_id, scheduled_items(scheduled_at, status)')
    .eq('workspace_id', caller.workspaceId);
  if (!recent) query = query.eq('conversation_id', conversationId.toLowerCase());
  const { data, error } = await query.order(recent ? 'updated_at' : 'created_at', { ascending: false }).limit(recent ? 20 : 50);
  if (error) return NextResponse.json({ error: 'Could not read this chat’s posts' }, { status: 500 });
  return NextResponse.json({
    posts: (data ?? []).map((row) => {
      const items = (Array.isArray(row.scheduled_items) ? row.scheduled_items : []) as { scheduled_at: string; status: string }[];
      const next = items.map((i) => i.scheduled_at).sort()[0] ?? null;
      return {
        id: row.id as string,
        caption: String(row.raw_content ?? ''),
        status: row.status as string,
        platforms: normalisePlatformIds(row.target_platforms as string[] | null),
        mediaCount: Array.isArray(row.media_urls) ? row.media_urls.length : 0,
        updatedAt: row.updated_at as string,
        scheduledAt: next,
        projectId: (row.project_id as string | null) ?? null,
      };
    }),
  });
}
