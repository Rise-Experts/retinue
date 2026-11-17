import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The workspace a request acts on, and the role the caller holds in it.
 *
 * `preferred` (typically the `chorus_active_ws` cookie value) is only a hint: it wins over the
 * latest-joined membership if and only if the user is actually a member of that workspace. A
 * foreign/invalid/stale value falls back to the latest membership. Never returns a workspace the user
 * isn't a member of.
 *
 * ## Why the role comes back too — #406
 *
 * This resolver was the membership check and nothing else, and its caller's comment said so: "checked
 * for membership by the resolver ... which is the check that matters". It was, for the question being
 * asked. But the assistant proxy forwarded only the workspace and the user, the backend defaulted a
 * missing role to `"editor"`, and so **every assistant turn ran as an editor whatever the caller
 * was** — a VIEWER could ask the assistant to publish and it would.
 *
 * The role was already in the row being read. Returning it costs nothing and is the difference between
 * a membership check and a permission.
 *
 * The same bug existed in the worker and is documented in `shareflow/src/app/worker-context.ts`: "a
 * hardcoded `roleIds: ["editor"]` gave a viewer editor rights ... the catalogue filtering that makes a
 * viewer read-only held on the API side only." It was fixed there by refusing to substitute an
 * identity. This is the other half.
 */
/**
 * The httpOnly cookie the WorkspaceSwitcher sets through `POST /api/workspace/active`. It is only a
 * hint — `resolveWorkspace` re-checks membership on every read — so every session-authed route passes
 * it as `preferred` and nothing else needs to trust it.
 */
export const ACTIVE_WORKSPACE_COOKIE = 'chorus_active_ws';

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

export type ResolvedWorkspace = {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
};

/**
 * Anything unrecognised is treated as `VIEWER`.
 *
 * Fail-closed, deliberately. A role this code does not know about — one added by a later migration,
 * or a typo in a seed — must not be handed the widest permission by default. That is the whole shape
 * of the bug this function exists to close: `?? "editor"` was one character of optimism.
 */
const asRole = (raw: unknown): WorkspaceRole => {
  const value = typeof raw === 'string' ? raw.toUpperCase() : '';
  return value === 'OWNER' || value === 'ADMIN' || value === 'EDITOR' ? value : 'VIEWER';
};

export async function resolveWorkspace(
  supabase: SupabaseClient,
  userId: string,
  preferred: string | null,
): Promise<ResolvedWorkspace | null> {
  if (preferred) {
    const { data } = await supabase
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('workspace_id', preferred)
      .eq('profile_id', userId)
      .maybeSingle();

    if (data?.workspace_id) {
      return { workspaceId: data.workspace_id as string, role: asRole(data.role) };
    }
  }

  const { data: latest } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('profile_id', userId)
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest?.workspace_id) return null;
  return { workspaceId: latest.workspace_id as string, role: asRole(latest.role) };
}

/**
 * The previous signature, kept for the callers that only need the id.
 *
 * Not a deprecation shim: several routes genuinely only ask "which workspace", and making them
 * destructure a role they ignore would be noise. It delegates, so there is one query and one
 * membership rule rather than two that can drift.
 */
export async function resolveWorkspaceId(
  supabase: SupabaseClient,
  userId: string,
  preferred: string | null,
): Promise<string | null> {
  return (await resolveWorkspace(supabase, userId, preferred))?.workspaceId ?? null;
}
