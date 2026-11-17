import { describe, it, expect } from 'vitest';
import { resolveWorkspaceId } from '../workspace';

/**
 * Minimal chainable Supabase stub covering the two queries
 * `resolveWorkspaceId` issues against `workspace_members`:
 *
 *  1. Membership-exists check on the preferred workspace:
 *     .from('workspace_members').select('workspace_id')
 *       .eq('workspace_id', preferred).eq('profile_id', userId).maybeSingle()
 *
 *  2. Latest-membership fallback:
 *     .from('workspace_members').select('workspace_id')
 *       .eq('profile_id', userId).order('joined_at', {...}).limit(1).maybeSingle()
 *
 * `memberIds` are the workspace_ids the user belongs to, most-recent first
 * (memberIds[0] is what the "latest membership" query should return).
 */
function makeSb(memberIds: string[]) {
  return {
    from() {
      const eqs: Array<[string, string]> = [];
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: string) {
          eqs.push([col, val]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          // Membership-exists check: eq('workspace_id', X).eq('profile_id', Y)
          const workspaceEq = eqs.find(([col]) => col === 'workspace_id');
          if (workspaceEq) {
            const [, workspaceId] = workspaceEq;
            return { data: memberIds.includes(workspaceId) ? { workspace_id: workspaceId } : null };
          }
          // Latest-membership fallback: eq('profile_id', Y).order(...).limit(1)
          const latest = memberIds[0];
          return { data: latest ? { workspace_id: latest } : null };
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal test double
  } as any;
}

describe('resolveWorkspaceId', () => {
  it('returns the preferred workspace when the user is a member', async () => {
    const r = await resolveWorkspaceId(makeSb(['ws-a', 'ws-b']), 'user-1', 'ws-b');
    expect(r).toBe('ws-b');
  });

  it('falls back to latest membership when preferred is not a member', async () => {
    const r = await resolveWorkspaceId(makeSb(['ws-a']), 'user-1', 'ws-foreign');
    expect(r).toBe('ws-a');
  });

  it('falls back to latest membership when preferred is null', async () => {
    const r = await resolveWorkspaceId(makeSb(['ws-a', 'ws-b']), 'user-1', null);
    expect(r).toBe('ws-a');
  });

  it('returns null when the user has no memberships at all', async () => {
    const r = await resolveWorkspaceId(makeSb([]), 'user-1', null);
    expect(r).toBeNull();
  });
});
