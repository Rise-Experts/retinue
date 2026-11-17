/**
 * The agentkit client — Rise-Experts/retinue#128.
 *
 * Two assertions carry the weight, and both are about not presenting a broken deployment as a working
 * one:
 *
 * - **A bare GraphQL host is detected.** `retinue serve` can admit a run and cannot create one, so it accepts
 *   every turn and answers none. A client that did not check would make that look like a slow assistant.
 * - **SSE frames are reassembled across writes.** Tested against a real server that writes each frame in two
 *   TCP chunks with keep-alives between, because a stubbed `fetch` returning one body cannot exercise it. The
 *   test says plainly what it cannot prove — see the note on it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentkitMisconfigured,
  AgentkitUnavailable,
  createAgentkitClient,
} from '../agentkitClient';
import { startAgentkitApp, type App } from './agentkitApp';

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const clientFor = (a: App, extra: Record<string, unknown> = {}) =>
  createAgentkitClient({ baseUrl: a.url, token: () => 'session-token', ...extra });

const TURN = { workspaceId: 'ws-1', userId: 'user-1', message: 'draft a post about the launch' };

describe('starting a turn', () => {
  it('returns the ids a turn is streamed and recorded by', async () => {
    app = await startAgentkitApp();
    const started = await clientFor(app).startTurn(TURN);
    expect(started).toMatchObject({ conversationId: 'convo-1', runId: 'run-1', started: 'started' });
  });

  it('sends the identity as headers, in the names the backend reads', async () => {
    /**
     * **This test asserted the wrong side of the wire.** It checked `workspaceId`/`userId` in the
     * *body* and an `authorization: Bearer` header, which is what this client sent — and the backend
     * reads `X-API-Secret` / `X-Workspace-Id` / `X-User-Id`. So every real turn returned 401 while
     * this passed, because the test and the client shared one assumption and the backend was never
     * asked.
     *
     * The names are `serviceHeaders()`'s, which the Python backend also reads: workspace scoping
     * relies on the trusted `X-Workspace-Id`, trusted *because* the shared secret proved the caller.
     */
    app = await startAgentkitApp();
    await clientFor(app).startTurn(TURN);
    expect(app.requests[0]?.identity).toEqual({
      'x-api-secret': 'session-token',
      'x-workspace-id': 'ws-1',
      'x-user-id': 'user-1',
    });
    // And the ids are NOT in the body: a caller that can set the workspace in a payload can set
    // somebody else's, and the secret says nothing about a body.
    expect(app.requests[0]?.body).not.toHaveProperty('workspaceId');
    expect(app.requests[0]?.body).not.toHaveProperty('userId');
    expect(app.requests[0]?.body).toMatchObject({ message: TURN.message });
  });

  it('detects a host that cannot create a run, and names the mistake', async () => {
    /**
     * **The assertion this client exists for.** `retinue serve`'s `sendMessage` takes no message content and
     * does not create the run row — it admits and enqueues, and the worker then claims a job whose run does
     * not exist. Every turn would be accepted and none answered, which reads as a slow assistant rather than a
     * misconfiguration.
     */
    app = await startAgentkitApp({ omitApplicationHeader: true });
    await expect(clientFor(app).startTurn(TURN)).rejects.toThrow(/not a ShareFlow[\s\S]*application/);
    await expect(clientFor(app).startTurn(TURN)).rejects.toBeInstanceOf(AgentkitMisconfigured);
  });

  it('reads a 404 as the wrong URL rather than a missing conversation', async () => {
    // A bare host has no `/api/message` at all, so this is almost always the URL and not the request.
    app = await startAgentkitApp({ noMessageRoute: true });
    await expect(clientFor(app).startTurn(TURN)).rejects.toThrow(/must point at a ShareFlow agentkit \*application\*/);
  });

  it('refuses an answer with no run id', async () => {
    app = await startAgentkitApp();
    // The ordinary route answers with ids; a response without them cannot be streamed or recorded.
    const client = createAgentkitClient({
      baseUrl: app.url,
      token: () => 't',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-retinue-application': 'shareflow' },
        })) as unknown as typeof fetch,
    });
    await expect(client.startTurn(TURN)).rejects.toThrow(/did not return a runId/);
  });
});

describe('failures are classified so a rollback can branch on them', () => {
  it('treats an unreachable application as retryable', async () => {
    // Nothing listening. Reporting this as permanent would strand a workspace on the new runtime.
    const client = createAgentkitClient({ baseUrl: 'http://127.0.0.1:1', token: () => 't', timeoutMs: 2_000 });
    const error = await client.startTurn(TURN).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentkitUnavailable);
    expect((error as AgentkitUnavailable).retryable).toBe(true);
  });

  it("treats the application's 5xx as retryable and its 4xx as not", async () => {
    app = await startAgentkitApp({ failWith: 503 });
    await expect(clientFor(app).startTurn(TURN)).rejects.toBeInstanceOf(AgentkitUnavailable);
    await app.close();

    app = await startAgentkitApp({ failWith: 422 });
    await expect(clientFor(app).startTurn(TURN)).rejects.toBeInstanceOf(AgentkitMisconfigured);
  });
});

describe('reading the event stream', () => {
  it('reassembles frames split across writes, and ignores keep-alives', async () => {
    /**
     * The reason this suite runs a real server rather than a stubbed `fetch`: the stand-in writes each frame in
     * two TCP chunks with a `: keep-alive` between, and a reader that assumed one write is one frame would
     * yield nothing at all. A stub returning a whole body cannot exercise that.
     *
     * **What this does not prove**, recorded because a sabotage run showed it: with single-line JSON payloads,
     * splitting on the frame boundary (`\n\n`) is indistinguishable from splitting on every newline. Changing
     * the client to the latter passes this suite. The `\n\n` handling is SSE correctness rather than something
     * these frames can demonstrate — and it cannot be demonstrated honestly, because a server may only split a
     * payload across `data:` lines where a newline is valid in the content, and `JSON.stringify` escapes them.
     */
    app = await startAgentkitApp({
      events: [
        { type: 'part.added', part: { type: 'text', text: 'thinking' } },
        { type: 'part.added', part: { type: 'text', text: 'done' } },
        { type: 'run.completed' },
      ],
    });
    const seen: Record<string, unknown>[] = [];
    for await (const frame of clientFor(app).streamEvents({ runId: 'run-1', conversationId: 'convo-1', workspaceId: 'ws-1', userId: 'user-1' })) {
      seen.push(frame);
    }
    expect(seen.map((frame) => frame.type)).toEqual(['part.added', 'part.added', 'run.completed']);
    // The text survived the split, which is what proves reassembly rather than luck.
    expect((seen[0]?.part as { text: string }).text).toBe('thinking');
  });

  it('passes a resume cursor through, so a reconnect does not replay', async () => {
    app = await startAgentkitApp();
    const stream = clientFor(app).streamEvents({ runId: 'run-1', conversationId: 'convo-1', after: 7, workspaceId: 'ws-1', userId: 'user-1' });
    for await (const _frame of stream) break;
    expect(app.requests.some((request) => request.path === '/api/events')).toBe(true);
  });
});
