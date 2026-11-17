/**
 * The plumbing every `/api/assistant/agentkit/*` route repeats: who is asking, which workspace, and
 * whether this deployment has a backend to forward to.
 *
 * One helper rather than seven copies. Each copy would be a place to forget one of three things — the
 * session check, the workspace *membership* check, or the secret — and forgetting the second is the one
 * that matters: `workspaceId` arrives from the client, so a route that trusts it lets a member of one
 * workspace read another's conversations.
 *
 * The browser never holds `SHARED_API_SECRET`. That is the whole reason these routes exist rather than
 * the chat calling the backend directly.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createClientFromRequest } from '@/utils/supabase/server';
import { ACTIVE_WORKSPACE_COOKIE, resolveWorkspace, type WorkspaceRole } from '@/lib/assistant/workspace';

export type AgentkitCaller = {
  readonly baseUrl: string;
  readonly secret: string;
  readonly workspaceId: string;
  readonly userId: string;
  /**
   * The role this caller holds in that workspace — #406.
   *
   * Forwarded because the backend cannot infer it and used to guess. Membership was checked here and
   * the role thrown away, so `deployment.ts` fell back to `?? "editor"` and every assistant turn ran
   * with edit rights whatever the caller actually was.
   */
  readonly role: WorkspaceRole;
};

export type Resolved = { readonly ok: true; readonly caller: AgentkitCaller } | { readonly ok: false; readonly response: NextResponse };

/**
 * Resolve the caller, or the response to return instead.
 *
 * A result union rather than throwing, so each route's happy path reads straight down and the failure
 * cases are impossible to skip — a `try`/`catch` around a helper that returns a `Response` is easy to
 * write without ever using the `Response`.
 */
export const resolveAgentkitCaller = async (request: NextRequest): Promise<Resolved> => {
  const supabase = await createClientFromRequest(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  /**
   * The workspace from the query, **checked for membership** by the resolver.
   *
   * `resolveWorkspace` returns null for a workspace this user is not in, which is the check that
   * matters: the id comes from the client. Absent, it picks the user's own — the same behaviour
   * `/api/assistant/runs` has, so a client that sends nothing keeps working.
   *
   * It also returns the **role**, which this resolver used to read and discard. See `workspace.ts`
   * and #406: membership alone was never enough to authorise a turn.
   */
  /*
   * The query wins when a caller names a workspace; otherwise the switcher's cookie. Without the cookie
   * the sidebar's Recents and every chat turn (neither sends `?workspaceId`) ran in the latest-joined
   * workspace, whichever one the header showed (2026-09-29).
   */
  const preferred = request.nextUrl.searchParams.get('workspaceId') ?? request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  const membership = await resolveWorkspace(supabase, user.id, preferred);
  if (membership === null) {
    return { ok: false, response: NextResponse.json({ error: 'No workspace found for user' }, { status: 403 }) };
  }

  const baseUrl = process.env.ASSISTANT_AGENTKIT_URL;
  const secret = process.env.SHARED_API_SECRET;
  if (baseUrl === undefined || baseUrl === '' || secret === undefined || secret === '') {
    /**
     * A named 503, not a fallback.
     *
     * These routes exist only for the new runtime — there is no Agno equivalent to degrade to, and a
     * chat rendering "request failed" would send somebody looking at the browser for a missing
     * environment variable. Which is exactly what happened with `ASSISTANT_AGENTKIT_URL`: absent from
     * compose, silently degrading, for a day.
     */
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'This deployment has no agentkit backend configured (ASSISTANT_AGENTKIT_URL).' },
        { status: 503 },
      ),
    };
  }

  return { ok: true, caller: { baseUrl, secret, workspaceId: membership.workspaceId, userId: user.id, role: membership.role } };
};

/**
 * The headers the backend authenticates with. Named once, so a rename cannot half-land.
 *
 * `x-roles` is the fourth, added for #406. The backend reads it and **refuses a request without it**
 * rather than defaulting — so if this function and the backend ever disagree, the assistant fails
 * loudly with a message naming the header, instead of quietly granting edit rights.
 */
export const agentkitHeaders = (caller: AgentkitCaller): Record<string, string> => ({
  'X-API-Secret': caller.secret,
  'X-Workspace-Id': caller.workspaceId,
  'X-User-Id': caller.userId,
  'x-roles': roleIdFor(caller.role),
});

/**
 * The workspace role as the runtime's role id.
 *
 * Three of the four collapse to `editor` because nothing in the assistant distinguishes them yet — an
 * OWNER and an EDITOR have the same tool surface. Mapped rather than passed through, so that adding
 * an owner-only tool later is a change in one function, and so an unrecognised role cannot reach the
 * backend as itself and match nothing.
 */
const roleIdFor = (role: WorkspaceRole): string => (role === 'VIEWER' ? 'viewer' : 'editor');

/**
 * Forward a JSON request and hand the answer back unchanged.
 *
 * The status travels with it: the backend's refusals are more specific than anything this layer could
 * invent, and flattening a 409 ("no results yet — publish the campaign first") into a 500 would throw
 * away the sentence a person needs.
 */
export const forwardJson = async (
  caller: AgentkitCaller,
  path: string,
  init: { readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly body?: unknown } = { method: 'GET' },
): Promise<NextResponse> => {
  let upstream: Response;
  try {
    upstream = await fetch(`${caller.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers:
        init.body === undefined
          ? agentkitHeaders(caller)
          : { ...agentkitHeaders(caller), 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    // 502: the thing this route depends on is down, not this route.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'the assistant backend could not be reached' },
      { status: 502 },
    );
  }

  const body: unknown = await upstream.json().catch(() => ({}));
  return NextResponse.json(body, {
    status: upstream.status,
    headers: { 'X-Assistant-Runtime': 'agentkit' },
  });
};
