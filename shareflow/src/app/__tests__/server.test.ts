/**
 * The ShareFlow application's routes — Rise-Experts/retinue#128.
 *
 * **The contract is the client's, and it lives in another repository.** `social_share`'s `agentkitClient.ts`
 * and the in-process stand-in beside its tests are the executable specification; these assertions mirror what
 * that client actually requires, field for field, because a drift here breaks a client that has no way to tell
 * it is broken except by every turn going unanswered.
 *
 * The two clauses worth the most:
 *
 * - **`shadow` without `await` is refused.** Answering before the run finished would report *no writes*, which
 *   is indistinguishable from a run that would have written nothing — the one mistake parity data must not
 *   contain, because it says the new runtime is safe at exactly the moment it is not.
 * - **`x-retinue-application` on every response, errors included.** It is how a deployment pointed at a bare
 *   `retinue serve` finds out, rather than watching turns be accepted and never answered.
 */
import { describe, expect, it, vi } from "vitest";

import { APPLICATION_HEADER, createShareFlowServer, MAX_MESSAGE_CHARS } from "../server.js";
import type { AuthenticatedCaller, ShareFlowServerDeps } from "../server.js";

const CALLER: AuthenticatedCaller = { tenantId: "ws-1", principalId: "user-1", roleIds: ["editor"] };

const WRITE = { toolName: "publish_post", delegatesTo: "instagram_publish_media", effect: "external-write" };

const serverWith = (over: Partial<ShareFlowServerDeps> = {}) =>
  createShareFlowServer({
    authenticate: () => CALLER,
    async startTurn() {
      return { conversationId: "convo-1", runId: "run-1", messageId: "msg-1", started: "started" };
    },
    async runShadowTurn() {
      return { runId: "run-shadow", writes: [WRITE] as never };
    },
    async *openEvents() {
      yield { type: "part.added", part: { type: "text", text: "thinking" } };
      yield { type: "run.completed" };
    },
    // Long enough that no keep-alive fires during a test; the timer is asserted separately.
    keepAliveMs: 60_000,
    ...over,
  });

const post = (body: unknown, url = "http://app.test/api/message") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/message — a live turn", () => {
  it("answers with the ids the client streams and records by", async () => {
    const response = await serverWith().handle(post({ message: "draft a post" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversationId: "convo-1",
      runId: "run-1",
      messageId: "msg-1",
      started: "started",
    });
  });

  it("identifies itself on every response, errors included", async () => {
    /**
     * The header the client checks. Without it, pointing `ASSISTANT_AGENTKIT_URL` at a bare `retinue serve`
     * looks like a slow assistant rather than a misconfiguration — that host admits runs it cannot create, so
     * it accepts every turn and answers none.
     *
     * Asserted on the error paths too: a client diagnosing a 400 or a 404 still needs to know it reached the
     * right service.
     */
    const server = serverWith();
    for (const request of [
      post({ message: "hi" }),
      post({}),
      new Request("http://app.test/api/nope", { method: "POST" }),
    ]) {
      const response = await server.handle(request);
      expect(response.headers.get(APPLICATION_HEADER), request.url).toBe("shareflow");
    }
  });

  it("refuses an empty message and one over the ceiling", async () => {
    const server = serverWith();
    expect((await server.handle(post({}))).status).toBe(400);
    expect((await server.handle(post({ message: "   " }))).status).toBe(400);
    expect((await server.handle(post({ message: "a".repeat(MAX_MESSAGE_CHARS + 1) }))).status).toBe(400);
  });

  it("refuses an unauthenticated caller before doing any work", async () => {
    const startTurn = vi.fn();
    const server = serverWith({ authenticate: () => null, startTurn: startTurn as never });
    expect((await server.handle(post({ message: "hi" }))).status).toBe(401);
    // A permissive default in a server is how a permissive default reaches a deployment.
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("passes the caller's identity into the turn, never the body's", async () => {
    /**
     * The identity comes from `authenticate` and nowhere else. A body-supplied tenant would let any caller
     * pose as any workspace, which is the failure tenant isolation exists to prevent.
     */
    const seen: { tenantId: unknown; principalId: unknown }[] = [];
    const server = serverWith({
      async startTurn({ context }) {
        seen.push({ tenantId: context.tenantId, principalId: context.principalId });
        return { conversationId: "c", runId: "r", messageId: "m", started: "started" };
      },
    });
    await server.handle(post({ message: "hi", tenantId: "someone-else", principalId: "admin" }));
    expect(seen[0]).toEqual({ tenantId: "ws-1", principalId: "user-1" });
  });
});

describe("POST /api/message — a shadow turn", () => {
  it("returns the writes rather than ids", async () => {
    const response = await serverWith().handle(post({ message: "draft a post", shadow: true, await: true }));
    expect(await response.json()).toEqual({ runId: "run-shadow", writes: [WRITE] });
  });

  it("always includes `writes`, even when empty", async () => {
    /**
     * The client refuses a shadow answer without the key, because an application that ignored the flag ran the
     * turn *for real*. An empty array is a genuine result — "it would have written nothing" — and has to be
     * distinguishable from the key being absent.
     */
    const server = serverWith({ async runShadowTurn() { return { runId: "r", writes: [] }; } });
    const body = (await (await server.handle(post({ message: "hi", shadow: true, await: true }))).json()) as {
      writes: unknown;
    };
    expect(body.writes).toEqual([]);
  });

  it("refuses `shadow` without `await`, rather than answering empty", async () => {
    /**
     * **The most consequential refusal in this file.**
     *
     * Answering before the run finished would report no writes, and that is indistinguishable from a run that
     * would have written nothing. Feeding that into a parity gate says the new runtime is safe at precisely
     * the moment it published something.
     *
     * Silently awaiting anyway was the other option and is worse: it makes the flag meaningless, and the next
     * caller reasonably assumes it did what it said.
     */
    const runShadowTurn = vi.fn();
    const server = serverWith({ runShadowTurn: runShadowTurn as never });
    const response = await server.handle(post({ message: "hi", shadow: true }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/must not contain/);
    expect(runShadowTurn).not.toHaveBeenCalled();
  });

  it("marks the context as shadow, which is what suppresses the writes", async () => {
    /**
     * The suppression is the *platform's* — the delegating envelope drops gated effects when `context.shadow`
     * is true, before the approval gate. This application's job is to set the flag; a second implementation
     * here would be a second place the rule lived.
     */
    const seen: unknown[] = [];
    const server = serverWith({
      async runShadowTurn({ context }) {
        seen.push((context as unknown as { shadow?: boolean }).shadow);
        return { runId: "r", writes: [] };
      },
    });
    await server.handle(post({ message: "hi", shadow: true, await: true }));
    expect(seen[0]).toBe(true);
  });

  it("does not mark a live turn as shadow", async () => {
    const seen: unknown[] = [];
    const server = serverWith({
      async startTurn({ context }) {
        seen.push((context as unknown as { shadow?: boolean }).shadow);
        return { conversationId: "c", runId: "r", messageId: "m", started: "started" };
      },
    });
    await server.handle(post({ message: "hi" }));
    expect(seen[0]).toBeUndefined();
  });
});

describe("GET /api/events", () => {
  const get = (query: string, headers: Record<string, string> = {}) =>
    new Request(`http://app.test/api/events?${query}`, { headers });

  const read = async (response: Response): Promise<string> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  };

  it("streams each event as one data line, terminated by a blank line", async () => {
    /**
     * One `data:` line per frame, and it matters: SSE joins multiple `data:` lines with a newline, so splitting
     * a JSON token across them corrupts the payload for any correct consumer. Found from the client's side
     * while testing frame reassembly, and asserted here so this end cannot reintroduce it.
     */
    const response = await serverWith().handle(get("runId=run-1&conversationId=convo-1"));
    const body = await read(response);
    const frames = body.split("\n\n").filter((frame) => frame.startsWith("data:"));
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.split("\n").filter((line) => line.startsWith("data:"))).toHaveLength(1);
    expect(JSON.parse(frames[1]!.slice(5))).toEqual({ type: "run.completed" });
  });

  it("sets the headers a proxy needs to not buffer it", async () => {
    // Without `x-accel-buffering`, an nginx in front holds the stream until it ends — which for a live run is
    // indistinguishable from the feature not working.
    const response = await serverWith().handle(get("runId=run-1&conversationId=convo-1"));
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get(APPLICATION_HEADER)).toBe("shareflow");
  });

  it("prefers Last-Event-ID over the query parameter", async () => {
    /**
     * A reconnecting browser sends the header automatically and does not rewrite its URL. Trusting the
     * parameter alone would replay from the start on every reconnect — for a long run, a user watching their
     * answer restart.
     */
    const seen: (number | undefined)[] = [];
    const server = serverWith({
      async *openEvents({ after }) {
        seen.push(after);
        yield { type: "run.completed" };
      },
    });
    await read(await server.handle(get("runId=r&conversationId=c&after=3", { "last-event-id": "9" })));
    expect(seen[0]).toBe(9);
    await read(await server.handle(get("runId=r&conversationId=c&after=3")));
    expect(seen[1]).toBe(3);
  });

  it("requires both ids", async () => {
    const server = serverWith();
    expect((await server.handle(get("runId=r"))).status).toBe(400);
    expect((await server.handle(get("conversationId=c"))).status).toBe(400);
  });

  it("reports a mid-stream failure as a frame rather than by closing the socket", async () => {
    /**
     * A client that saw the connection drop cannot tell a finished run from a failed one. A frame can say
     * which.
     */
    const server = serverWith({
      async *openEvents() {
        yield { type: "part.added" };
        throw new Error("the event log went away");
      },
    });
    const body = await read(await server.handle(get("runId=r&conversationId=c")));
    expect(body).toContain("stream.failed");
    expect(body).toContain("the event log went away");
  });
});
