/**
 * Settings → Memory's routes — #621. They forward to the agent service with the **authenticated** user and a
 * workspace the user belongs to, and nothing from the request can name another person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

let currentUser: { id: string } | null;
let membership: { workspaceId: string; role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' } | null;
const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];

vi.mock('@/utils/supabase/server', () => ({
  createClientFromRequest: async () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));
vi.mock('@/lib/assistant/workspace', () => ({ ACTIVE_WORKSPACE_COOKIE: 'chorus_active_ws', resolveWorkspace: async () => membership }));

const { GET } = await import('../route.ts');
const { PATCH, DELETE } = await import('../[memoryId]/route.ts');
const ctx = (memoryId: string) => ({ params: Promise.resolve({ memoryId }) });

beforeEach(() => {
  currentUser = { id: 'user-1' };
  membership = { workspaceId: 'ws-1', role: 'EDITOR' };
  calls.length = 0;
  vi.stubEnv('ASSISTANT_AGENTKIT_URL', 'http://agent.test');
  vi.stubEnv('SHARED_API_SECRET', 'secret');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, ...(init.body ? { body: String(init.body) } : {}) });
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /api/assistant/agentkit/memory', () => {
  it('asks for the signed-in user only, whatever the query says', async () => {
    const response = await GET(new NextRequest('http://localhost/api/assistant/agentkit/memory?userId=user-2&principalId=user-2'));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://agent.test/api/memory');
    expect(calls[0]!.headers['X-User-Id']).toBe('user-1');
    expect(calls[0]!.headers['X-Workspace-Id']).toBe('ws-1');
  });

  it('refuses without a session, and without workspace membership', async () => {
    currentUser = null;
    expect((await GET(new NextRequest('http://localhost/api/assistant/agentkit/memory'))).status).toBe(401);
    currentUser = { id: 'user-1' };
    membership = null;
    expect((await GET(new NextRequest('http://localhost/api/assistant/agentkit/memory?workspaceId=ws-9'))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('PATCH and DELETE /api/assistant/agentkit/memory/:id', () => {
  it('forwards only `enabled`, as the signed-in user', async () => {
    const request = new NextRequest('http://localhost/api/assistant/agentkit/memory/mem-1', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false, principalId: 'user-2', text: 'rewritten' }),
    });
    expect((await PATCH(request, ctx('mem-1'))).status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'http://agent.test/api/memory/mem-1', method: 'PATCH' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ enabled: false });
    expect(calls[0]!.headers['X-User-Id']).toBe('user-1');
  });

  it('refuses a body without a boolean', async () => {
    const request = new NextRequest('http://localhost/api/assistant/agentkit/memory/mem-1', { method: 'PATCH', body: '{"enabled":"no"}' });
    expect((await PATCH(request, ctx('mem-1'))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('deletes by id, encoded, as the signed-in user', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/assistant/agentkit/memory/a%2Fb', { method: 'DELETE' }), ctx('a/b'));
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'http://agent.test/api/memory/a%2Fb', method: 'DELETE' });
    expect(calls[0]!.headers['X-User-Id']).toBe('user-1');
  });
});
