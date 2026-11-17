/**
 * An in-process stand-in for a ShareFlow agentkit application.
 *
 * A real HTTP server rather than a stubbed `fetch`, for the same reason `tools-email` tests against a real
 * SMTP sink: the client's hardest part is **reading an SSE stream**, and a stubbed fetch that returns a whole
 * body at once cannot exercise frame reassembly at all. This one writes frames in deliberately awkward chunks —
 * split mid-frame, with keep-alive comments interleaved — because that is what a real stream does and it is
 * where a reader that splits on every newline breaks.
 *
 * It is also the executable form of the contract. Anything that wants to serve this client has to answer these
 * routes with these shapes, and the `omitApplicationHeader` option is what lets a test prove the client detects
 * a host that cannot actually run a turn.
 */

import { createServer, type Server } from 'node:http';

export type AppOptions = {
  /** Frames to emit on the event stream, in order. Written in awkward chunks on purpose. */
  readonly events?: readonly Record<string, unknown>[];
  /**
   * Answer without `x-retinue-application` — what a bare `retinue serve` looks like.
   *
   * The point of the option: that host admits runs it cannot create, so it would accept every turn and answer
   * none. A client that did not check would present a broken deployment as a working one.
   */
  readonly omitApplicationHeader?: boolean;
  /** Fail every request with this status. */
  readonly failWith?: number;
  /** Return 404 on /api/message, like a host without that route. */
  readonly noMessageRoute?: boolean;
};

export type App = {
  readonly url: string;
  /** Every request, so a test can assert the shape sent rather than only the answer received. */
  readonly requests: {
    path: string;
    body?: Record<string, unknown>;
    authorization?: string;
    /**
     * The identity headers the backend reads — `X-API-Secret`, `X-Workspace-Id`, `X-User-Id`.
     *
     * Recorded because this stand-in previously only captured `authorization` and the body, so it
     * agreed with a client that sent the ids in the body while the real backend read headers. Every
     * turn returned 401 in production and every test passed.
     */
    identity?: Record<string, string>;
  }[];
  readonly close: () => Promise<void>;
};

export const startAgentkitApp = async (options: AppOptions = {}): Promise<App> => {
  const requests: App['requests'] = [];

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const authorization = request.headers.authorization;
    const identity: Record<string, string> = {};
    for (const name of ['x-api-secret', 'x-workspace-id', 'x-user-id']) {
      const value = request.headers[name];
      if (typeof value === 'string') identity[name] = value;
    }

    let body: Record<string, unknown> | undefined;
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    }
    requests.push({
      path: url.pathname,
      ...(body === undefined ? {} : { body }),
      ...(authorization === undefined ? {} : { authorization }),
      ...(Object.keys(identity).length === 0 ? {} : { identity }),
    });

    if (options.failWith !== undefined) {
      response.writeHead(options.failWith, { 'content-type': 'text/plain' });
      response.end('upstream said no');
      return;
    }

    if (url.pathname === '/api/message') {
      if (options.noMessageRoute === true) {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.omitApplicationHeader !== true) headers['x-retinue-application'] = 'shareflow';

      response.writeHead(200, headers);
      response.end(
        JSON.stringify({ conversationId: 'convo-1', runId: 'run-1', messageId: 'msg-1', started: 'started' }),
      );
      return;
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const frames = options.events ?? [{ type: 'run.completed' }];
      /**
       * Written in awkward chunks, deliberately.
       *
       * A frame split across two writes, and a keep-alive comment between frames. Both are ordinary in a real
       * stream and both break a reader that assumes one write is one frame.
       */
      for (const frame of frames) {
        /**
         * One `data:` line per frame, which is what a real server sends for a JSON payload.
         *
         * I tried splitting the JSON across two `data:` lines to make the frame-boundary handling observable,
         * and it was the *stand-in* that was wrong: SSE joins multiple `data:` lines with a newline, so
         * splitting a JSON token across them corrupts the payload for any correct consumer. A server may only
         * split where a newline is acceptable in the content — and `JSON.stringify` escapes newlines, so it
         * never is here.
         *
         * The consequence is recorded in the test: with single-line JSON data, splitting on `\n\n` and on
         * `\n` are indistinguishable, so this suite cannot prove the frame boundary. What it does prove is
         * reassembly across **writes**, which is the failure that actually happens.
         */
        const payload = `data: ${JSON.stringify(frame)}\n\n`;
        const cut = Math.max(1, Math.floor(payload.length / 2));
        response.write(payload.slice(0, cut));
        await new Promise((resolve) => setTimeout(resolve, 1));
        response.write(payload.slice(cut));
        response.write(': keep-alive\n\n');
      }
      response.end();
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};
