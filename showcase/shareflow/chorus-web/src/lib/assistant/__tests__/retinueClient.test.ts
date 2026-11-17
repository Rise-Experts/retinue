import { describe, expect, it } from 'vitest';

import { answerQuestionWithLists, createRetinueClient, readPendingInteraction } from '../retinueClient';

/**
 * The transport under `@retinue/react`'s hooks.
 *
 * WHY THESE TESTS EXIST: the package owns the ordering buffer and the reducers, so what is left here is
 * *the wire* — which URL, which cursor, and what happens to a half-arrived frame. Each of those has a
 * failure that looks like a working chat: a dropped `after` re-renders a turn on every reconnect, and a
 * throw on one malformed frame ends a run that is still streaming.
 */

const sse = (frames: readonly string[]) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
};

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, async json() { return payload; } }) as unknown as Response;

const recording = (responder: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe('sendMessage', () => {
  it('posts the text and returns the run to follow', async () => {
    const { calls, fetchImpl } = recording(() => json({ runId: 'r1', conversationId: 'c1' }));
    const client = createRetinueClient({ fetchImpl });
    expect(await client.sendMessage({ conversationId: 'c1', text: 'hello' })).toEqual({ runId: 'r1' });
    expect(calls[0]?.url).toBe('/api/assistant/agentkit/turns');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ conversationId: 'c1', message: 'hello' });
  });

  it('fails loudly when the turn started but named no run', async () => {
    /**
     * A run id is what `subscribeRun` follows. Without one the message would render as a question that
     * never gets answered, which is worse than an error while the send button is still what the person
     * just touched.
     */
    const { fetchImpl } = recording(() => json({ conversationId: 'c1' }));
    await expect(createRetinueClient({ fetchImpl }).sendMessage({ conversationId: 'c1', text: 'x' })).rejects.toThrow(
      /which run to follow/,
    );
  });

  it("passes the server's own message through on a refusal", async () => {
    // These reach a person through the hook's `error` state, so the specific sentence is the useful one.
    const { fetchImpl } = recording(() => json({ error: 'That conversation is not yours.' }, 403));
    await expect(createRetinueClient({ fetchImpl }).sendMessage({ conversationId: 'c9', text: 'x' })).rejects.toThrow(
      'That conversation is not yours.',
    );
  });
});

describe('subscribeRun', () => {
  it('forwards the resume cursor, including zero', async () => {
    /**
     * `after=0` means "from the start" and is a real value — dropping it as falsy is how a resumable
     * stream quietly becomes a non-resumable one.
     */
    const { calls, fetchImpl } = recording(() => sse(['data: {"type":"run.started","sequence":1}\n\n']));
    const client = createRetinueClient({ fetchImpl });
    // Only the first frame is needed: the assertion is the URL, not the stream.
    for await (const event of client.subscribeRun({ runId: 'r1', conversationId: 'c1', after: 0 })) {
      expect(event).toBeDefined();
      break;
    }
    expect(calls[0]?.url).toContain('after=0');

    const resumed = recording(() => sse(['data: {"type":"run.completed","sequence":9}\n\n']));
    const second = createRetinueClient({ fetchImpl: resumed.fetchImpl });
    for await (const event of second.subscribeRun({ runId: 'r1', conversationId: 'c1', after: 8 })) {
      expect(event).toBeDefined();
      break;
    }
    expect(resumed.calls[0]?.url).toContain('after=8');
  });

  it('yields the platform events untranslated', async () => {
    /**
     * The package's reducers speak the platform's own vocabulary. Translating here — which is what the
     * old chat's relay does for Agno's frame shape — would be converting a thing into another thing and
     * back.
     */
    const { fetchImpl } = recording(() =>
      sse([
        'data: {"type":"run.content","sequence":1,"delta":"Hel"}\n\n',
        'data: {"type":"run.content","sequence":2,"delta":"lo"}\n\n',
      ]),
    );
    const seen: unknown[] = [];
    for await (const event of createRetinueClient({ fetchImpl }).subscribeRun({
      runId: 'r1',
      conversationId: 'c1',
      after: 0,
    })) {
      seen.push(event);
    }
    expect(seen).toEqual([
      { type: 'run.content', sequence: 1, delta: 'Hel' },
      { type: 'run.content', sequence: 2, delta: 'lo' },
    ]);
  });

  it('skips a malformed frame rather than ending the run', async () => {
    /**
     * One bad line must not end a stream that is still going. The package's buffer notices a missing
     * sequence on its own, which is the right place for that judgement.
     */
    const { fetchImpl } = recording(() =>
      sse([
        'data: {"type":"run.content","sequence":1}\n\n',
        'data: {not json\n\n',
        'data: {"type":"run.completed","sequence":2}\n\n',
      ]),
    );
    const types: unknown[] = [];
    for await (const event of createRetinueClient({ fetchImpl }).subscribeRun({
      runId: 'r1',
      conversationId: 'c1',
      after: 0,
    })) {
      types.push((event as { type: string }).type);
    }
    expect(types).toEqual(['run.content', 'run.completed']);
  });

  it('reassembles a frame that arrived in two chunks', async () => {
    // A stream splits wherever the network decides, not on frame boundaries — a reader that assumes
    // otherwise loses whichever event was unlucky.
    const { fetchImpl } = recording(() => sse(['data: {"type":"run.co', 'ntent","sequence":1}\n\n']));
    const seen: unknown[] = [];
    for await (const event of createRetinueClient({ fetchImpl }).subscribeRun({
      runId: 'r1',
      conversationId: 'c1',
      after: 0,
    })) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: 'run.content', sequence: 1 }]);
  });

  it('ignores the keep-alive and the done marker', async () => {
    // A keep-alive comment holds the connection open and is not an event; `[DONE]` is a terminator.
    const { fetchImpl } = recording(() =>
      sse([': keep-alive\n\n', 'data: [DONE]\n\n', 'data: {"type":"run.completed","sequence":1}\n\n']),
    );
    const seen: unknown[] = [];
    for await (const event of createRetinueClient({ fetchImpl }).subscribeRun({
      runId: 'r1',
      conversationId: 'c1',
      after: 0,
    })) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: 'run.completed', sequence: 1 }]);
  });
});

describe('history', () => {
  it('reads the session list and one transcript', async () => {
    const { calls, fetchImpl } = recording((url) =>
      url.includes('/messages') ? json({ items: [{ id: 'm1' }] }) : json({ items: [{ id: 'c1', title: 'A thread' }] }),
    );
    const client = createRetinueClient({ fetchImpl });
    expect((await client.listConversations({})).items).toEqual([{ id: 'c1', title: 'A thread' }]);
    expect((await client.listMessages({ conversationId: 'c1' })).items).toEqual([{ id: 'm1' }]);
    expect(calls[1]?.url).toBe('/api/assistant/agentkit/conversations/c1/messages');
  });

  it('encodes a conversation id into the path', async () => {
    // An id is a path segment; an unencoded one would address a different resource.
    const { calls, fetchImpl } = recording(() => json({ items: [] }));
    await createRetinueClient({ fetchImpl }).listMessages({ conversationId: 'a/b' });
    expect(calls[0]?.url).toBe('/api/assistant/agentkit/conversations/a%2Fb/messages');
  });

  it('carries a cursor when there is one, and omits it when there is not', async () => {
    const { calls, fetchImpl } = recording(() => json({ items: [], nextCursor: 'next' }));
    const client = createRetinueClient({ fetchImpl });
    const page = await client.listConversations({});
    expect(calls[0]?.url).toBe('/api/assistant/agentkit/conversations');
    expect(page.nextCursor).toBe('next');
    await client.listConversations({ cursor: 'next' });
    expect(calls[1]?.url).toContain('cursor=next');
  });

  it('treats a body with no items as an empty page rather than crashing the list', async () => {
    // A 200 that does not answer the question is the server's fault, and a chat should render an empty
    // list rather than a stack trace.
    const { fetchImpl } = recording(() => json({}));
    expect((await createRetinueClient({ fetchImpl }).listConversations({})).items).toEqual([]);
  });
});

/**
 * The interaction methods.
 *
 * The assertion carrying the most weight is the multi-select one. `RetinueClient.answerQuestion`
 * declares `answers: Record<string, string>` while the platform accepts `string | readonly string[]`,
 * so the package's interface is narrower than the runtime behind it — and the tempting workaround,
 * joining the choices with a comma, would have the backend record `"instagram, linkedin"` as one
 * literal answer and tell the model the person picked a single option with a comma in its name. That
 * is a wrong answer nothing reports, which is why the array has to survive the trip intact.
 */
describe('interactions', () => {
  it('sends a multi-select answer as an array, not a joined string', async () => {
    const { calls, fetchImpl } = recording(() => json({ ok: true, resumed: true }));
    await answerQuestionWithLists(
      { interactionId: 'int-1', runId: 'run-1', answers: { tone: 'dry', channels: ['instagram', 'linkedin'] } },
      fetchImpl,
    );

    expect(calls[0]?.url).toBe('/api/assistant/agentkit/interactions/int-1/answer');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.runId).toBe('run-1');
    // A string stays a string and a list stays a list — both arms of `QuestionAnswer`, unchanged.
    expect(body.answers).toEqual({ tone: 'dry', channels: ['instagram', 'linkedin'] });
  });

  it('encodes an interaction id that would otherwise change the path', async () => {
    const { calls, fetchImpl } = recording(() => json({ ok: true, resumed: true }));
    await answerQuestionWithLists({ interactionId: 'a/b', runId: 'r', answers: { k: 'v' } }, fetchImpl);
    expect(calls[0]?.url).toBe('/api/assistant/agentkit/interactions/a%2Fb/answer');
  });

  it("raises the server's own sentence when an answer is refused", async () => {
    const { fetchImpl } = recording(() => json({ error: 'that conversation is not yours' }, 403));
    await expect(
      answerQuestionWithLists({ interactionId: 'int-1', runId: 'r', answers: { k: 'v' } }, fetchImpl),
    ).rejects.toThrow('that conversation is not yours');
  });

  it('posts a decision and a cancellation to their own routes', async () => {
    const { calls, fetchImpl } = recording(() => json({ ok: true }));
    const client = createRetinueClient({ fetchImpl });
    await client.decideApproval({ interactionId: 'int-2', runId: 'run-2', decision: 'allow-once' });
    await client.cancelRun({ runId: 'run-2' });

    expect(calls[0]?.url).toBe('/api/assistant/agentkit/interactions/int-2/decide');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ runId: 'run-2', decision: 'allow-once' });
    expect(calls[1]?.url).toBe('/api/assistant/agentkit/runs/run-2/cancel');
    expect(calls[1]?.init?.method).toBe('POST');
  });

  it('raises rather than resolving when a cancellation is refused', async () => {
    const { fetchImpl } = recording(() => json({ error: 'no run run-9' }, 404));
    // A client that swallowed this would show a stopped run that is still running.
    await expect(createRetinueClient({ fetchImpl }).cancelRun({ runId: 'run-9' })).rejects.toThrow('no run run-9');
  });
});

/**
 * `readPendingInteraction` — the client half of making a paused run visible.
 *
 * The chat asks this when the run's status says it is waiting, because the pause arrives as an event
 * with an interaction id and no detail. Everything the permission card renders — the tool, its
 * arguments, the risk category, the summary — comes from here.
 */
describe('readPendingInteraction', () => {
  it('asks for the run it was given', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await readPendingInteraction({ runId: 'run-9' }, fetchImpl);

    expect(calls[0]).toContain('/interactions/pending?runId=run-9');
  });

  it('returns the approval, arguments and all', async () => {
    const approval = {
      interactionId: 'int-1',
      toolName: 'reply_to_comment',
      toolArgs: { commentId: 'c-1', text: 'On its way.' },
      riskCategory: 'engagement',
      summary: 'Reply to @sofiab on Instagram',
      expiresAt: '2026-09-10T09:00:00.000Z',
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ approval }), { status: 200 })) as unknown as typeof fetch;

    expect((await readPendingInteraction({ runId: 'run-9' }, fetchImpl)).approval).toEqual(approval);
  });

  it('encodes the run id, so an id with a slash cannot become a different path', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await readPendingInteraction({ runId: 'run/../conversations' }, fetchImpl);

    expect(calls[0]).toContain('runId=run%2F..%2Fconversations');
  });

  it('is empty rather than throwing when the run is no longer waiting', async () => {
    /**
     * It is asked on a status change, so a run that resumed between the event and this request is an
     * ordinary race — not a failure to show the user. A throw here would surface as a broken chat for
     * something that simply finished.
     */
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await readPendingInteraction({ runId: 'run-9' }, fetchImpl)).toEqual({});
  });

  it('is empty rather than throwing on a body that is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>gateway</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await readPendingInteraction({ runId: 'run-9' }, fetchImpl)).toEqual({});
  });
});
