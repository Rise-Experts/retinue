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

import { APPROVAL_DECISIONS } from "@retinue/agentkit/hitl";

import { APPLICATION_HEADER, createShareFlowServer, MAX_MESSAGE_CHARS } from "../server.js";
import type { AuthenticatedCaller, ShareFlowServerDeps } from "../server.js";

const CALLER: AuthenticatedCaller = { tenantId: "ws-1", principalId: "user-1", roleIds: ["editor"] };

/**
 * The argument types of the three interaction deps.
 *
 * `vi.fn(async () => …)` records its calls as an **empty tuple**, so `mock.calls[0]?.[0]` is a type
 * error — which CI's `tsc -p tsconfig.test.json` catches and `vitest run` does not. Declaring the
 * parameter fixes that and buys something better than silence: the recorded call is typed, so these
 * assertions read real field names rather than going through `as never as { … }`, which is the cast
 * that turns checking off.
 */
type AnswerInput = Parameters<NonNullable<ShareFlowServerDeps["answerQuestion"]>>[0];
type DecideInput = Parameters<NonNullable<ShareFlowServerDeps["decideApproval"]>>[0];
type CancelInput = Parameters<NonNullable<ShareFlowServerDeps["cancelRun"]>>[0];
type PendingInput = Parameters<NonNullable<ShareFlowServerDeps["pendingInteraction"]>>[0];

const serverWith = (over: Partial<ShareFlowServerDeps> = {}) =>
  createShareFlowServer({
    authenticate: () => CALLER,
    async startTurn() {
      return { conversationId: "convo-1", runId: "run-1", messageId: "msg-1", started: "started" };
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

describe("POST /api/message — shadow turns are gone (#712)", () => {
  it("refuses `shadow: true` rather than running the turn for real", async () => {
    const startTurn = vi.fn();
    const server = serverWith({ startTurn: startTurn as never });
    const response = await server.handle(post({ message: "draft a post", shadow: true, await: true }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/no longer supported/);
    expect(startTurn).not.toHaveBeenCalled();
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

describe("the health routes", () => {
  const get = (path: string) => new Request(`http://app.test${path}`, { method: "GET" });

  it("answer without credentials, because a healthcheck has none", async () => {
    /**
     * **They were behind the authenticator**, which answered `/healthz` with 401 — so the container's
     * own healthcheck marked it unhealthy, and `shareflow_worker` depends on `shareflow`. A liveness
     * probe that needs a secret is not a liveness probe.
     *
     * The authenticator here refuses everything, so a 200 can only come from a route that runs before
     * it. That is the whole assertion.
     */
    const server = serverWith({ authenticate: () => null });
    expect((await server.handle(get("/healthz"))).status).toBe(200);
    expect((await server.handle(get("/readyz"))).status).toBe(200);
    // And an ordinary route still refuses, so this is not auth being off.
    expect((await server.handle(post({ message: "hi" }))).status).toBe(401);
  });

  it("report liveness without touching the database", async () => {
    /**
     * No probe is called for `/healthz`, deliberately. An orchestrator that restarts a process because
     * a *dependency* is unavailable turns a blip into a restart storm, and the replacement is no more
     * able to reach the database than the one it killed.
     */
    let probed = 0;
    const server = serverWith({
      ready: async () => {
        probed += 1;
        return { ok: true };
      },
    });
    expect((await server.handle(get("/healthz"))).status).toBe(200);
    expect(probed).toBe(0);
  });

  it("report 503 and a reason when readiness fails", async () => {
    const server = serverWith({ ready: async () => ({ ok: false, detail: "the schema has no applied migrations" }) });
    const response = await server.handle(get("/readyz"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).toContain("no applied migrations");
  });

  it("report 503 rather than crashing when the probe throws", async () => {
    // A probe that threw would otherwise take the whole request down with a 500, which reads as the
    // process being broken rather than its dependency.
    const server = serverWith({
      ready: async () => {
        throw new Error("ECONNREFUSED 10.0.0.5:5432");
      },
    });
    expect((await server.handle(get("/readyz"))).status).toBe(503);
  });

  it("are ready by default, since no probe means nothing to check", async () => {
    expect((await serverWith().handle(get("/readyz"))).status).toBe(200);
  });
});


/**
 * The interaction routes — answering a question, deciding an approval, cancelling a run.
 *
 * These were three named 501s until the platform's question and approval services were wired through,
 * and the assertions worth the most are the ones about **who** may answer and **what** counts as an
 * answer:
 *
 * - the caller's own tenant reaches the service, never anything from the body or the path, because an
 *   interaction id is opaque and arrives from the client — a route that trusted it would let one
 *   workspace decide another's approval;
 * - an unknown decision is a 400 rather than something recorded, because only *allow* decisions
 *   authorize the stored call, so a typo would resume the run as a denial with nothing saying why;
 * - `resumed: false` survives to the client, because a second answer is a deliberate no-op in the
 *   platform and "already answered" is a different fact from "resumed".
 */
describe("POST /api/interactions/:id/answer", () => {
  const answerUrl = "http://app.test/api/interactions/int-1/answer";

  it("passes the answers and the caller's own tenant to the service", async () => {
    const answerQuestion = vi.fn(async (_input: AnswerInput) => ({ resumed: true }));
    const response = await serverWith({ answerQuestion }).handle(
      /**
       * A hostile `tenantId` in the body, deliberately.
       *
       * Without it this test passed against a route that read the tenant *from the body* — there was no
       * competing value, so `ws-1` came back either way. A test that cannot fail for the reason it
       * names is the failure mode this project keeps cataloguing, and the sabotage run is what found it.
       */
      post(
        { runId: "run-7", tenantId: "ws-someone-else", answers: { tone: "playful", channels: ["instagram", "linkedin"] } },
        answerUrl,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: true });
    const call = answerQuestion.mock.calls[0]?.[0];
    expect(call?.interactionId).toBe("int-1");
    expect(call?.runId).toBe("run-7");
    // The caller's tenant, not a value from the body — the check that makes an opaque id safe to accept.
    expect(call?.context.tenantId).toBe("ws-1");
    // Both arms of `QuestionAnswer` reach the service unchanged: a single answer stays a string.
    expect(call?.answers).toEqual({ tone: "playful", channels: ["instagram", "linkedin"] });
  });

  it("reports resumed: false rather than flattening a repeat answer into a bare ok", async () => {
    const response = await serverWith({ answerQuestion: async () => ({ resumed: false }) }).handle(
      post({ runId: "run-7", answers: { tone: "dry" } }, answerUrl),
    );
    expect(await response.json()).toEqual({ ok: true, resumed: false });
  });

  it("refuses an answer that is not a string or a list of strings", async () => {
    const answerQuestion = vi.fn(async (_input: AnswerInput) => ({ resumed: true }));
    const response = await serverWith({ answerQuestion }).handle(
      post({ runId: "run-7", answers: { tone: { nested: true } } }, answerUrl),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("tone");
    // Refused *before* the service — a run must not resume with `[object Object]` as the person's reply.
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("refuses an empty multi-select rather than recording it as an answer", async () => {
    const response = await serverWith({ answerQuestion: async () => ({ resumed: true }) }).handle(
      post({ runId: "run-7", answers: { channels: [] } }, answerUrl),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("empty list");
  });

  it("refuses an answers map with nothing in it", async () => {
    const response = await serverWith({ answerQuestion: async () => ({ resumed: true }) }).handle(
      post({ runId: "run-7", answers: {} }, answerUrl),
    );
    expect(response.status).toBe(400);
  });

  it("requires a runId, because the interaction says what was asked and the run says what to wake", async () => {
    const response = await serverWith({ answerQuestion: async () => ({ resumed: true }) }).handle(
      post({ answers: { tone: "dry" } }, answerUrl),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("runId");
  });

  it("refuses when the deployment has no interaction surface", async () => {
    const response = await serverWith().handle(post({ runId: "run-7", answers: { tone: "dry" } }, answerUrl));
    expect(response.status).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const answerQuestion = vi.fn(async (_input: AnswerInput) => ({ resumed: true }));
    const response = await serverWith({ authenticate: () => null, answerQuestion }).handle(
      post({ runId: "run-7", answers: { tone: "dry" } }, answerUrl),
    );
    expect(response.status).toBe(401);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("does not answer a path that means something else", async () => {
    const answerQuestion = vi.fn(async (_input: AnswerInput) => ({ resumed: true }));
    for (const path of [
      "http://app.test/api/interactions/int-1/answer/extra",
      "http://app.test/api/interactions//answer",
      "http://app.test/api/interactions/int-1",
    ]) {
      const response = await serverWith({ answerQuestion }).handle(post({ runId: "run-7", answers: { a: "b" } }, path));
      expect(response.status).toBe(404);
    }
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});

describe("POST /api/interactions/:id/decide", () => {
  const decideUrl = "http://app.test/api/interactions/int-2/decide";

  it("records an allowed decision and reports whether a standing grant was issued", async () => {
    const decideApproval = vi.fn(async (_input: DecideInput) => ({ resumed: true, granted: false }));
    const response = await serverWith({ decideApproval }).handle(
      // The hostile tenant, for the reason the answer test above carries one.
      post({ runId: "run-9", tenantId: "ws-someone-else", decision: "allow-once" }, decideUrl),
    );

    expect(response.status).toBe(200);
    /**
     * `granted: false` for `allow-once` is the point of reporting it separately: the call *is*
     * authorized, and no standing grant exists. Collapsing the two would tell a client an approved
     * one-time call had been denied.
     */
    expect(await response.json()).toEqual({ ok: true, resumed: true, granted: false });
    const call = decideApproval.mock.calls[0]?.[0];
    expect(call?.decision).toBe("allow-once");
    expect(call?.context.tenantId).toBe("ws-1");
  });

  it("accepts every decision the platform defines, and only those", async () => {
    const decideApproval = vi.fn(async (_input: DecideInput) => ({ resumed: true, granted: true }));
    const server = serverWith({ decideApproval });
    for (const decision of APPROVAL_DECISIONS) {
      const body = decision === "allow-conversation" ? { runId: "r", decision, conversationId: "c" } : { runId: "r", decision };
      const response = await server.handle(post(body, decideUrl));
      expect(response.status, decision).toBe(200);
    }
    expect(decideApproval).toHaveBeenCalledTimes(APPROVAL_DECISIONS.length);
  });

  it("refuses an unknown decision instead of recording it as a denial", async () => {
    const decideApproval = vi.fn(async (_input: DecideInput) => ({ resumed: true, granted: false }));
    const response = await serverWith({ decideApproval }).handle(post({ runId: "run-9", decision: "approve" }, decideUrl));

    expect(response.status).toBe(400);
    // The refusal names the valid values, so a client with the wrong vocabulary learns the right one.
    expect((await response.json()).error).toContain("allow-once");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("refuses allow-conversation with no conversation for the grant to be scoped to", async () => {
    const decideApproval = vi.fn(async (_input: DecideInput) => ({ resumed: true, granted: true }));
    const response = await serverWith({ decideApproval }).handle(
      post({ runId: "run-9", decision: "allow-conversation" }, decideUrl),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("conversationId");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const decideApproval = vi.fn(async (_input: DecideInput) => ({ resumed: true, granted: true }));
    const response = await serverWith({ authenticate: () => null, decideApproval }).handle(
      post({ runId: "run-9", decision: "deny" }, decideUrl),
    );
    expect(response.status).toBe(401);
    expect(decideApproval).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs/:id/cancel", () => {
  const cancelUrl = "http://app.test/api/runs/run-3/cancel";

  it("reports the request as recorded, not the run as stopped", async () => {
    const cancelRun = vi.fn(async (_input: CancelInput) => ({ status: "running" }));
    const response = await serverWith({ cancelRun }).handle(post({}, cancelUrl));

    expect(response.status).toBe(200);
    /**
     * `requested`, and the run's status is still `running`. Cancellation is cooperative — the worker
     * observes the request and stops — so a client told "cancelled" and then watching three more tool
     * calls arrive has been lied to.
     */
    expect(await response.json()).toEqual({ ok: true, requested: true, status: "running" });
    expect(cancelRun.mock.calls[0]?.[0]?.runId).toBe("run-3");
  });

  it("answers 404 for a run this tenant does not have, the same as one that never existed", async () => {
    const response = await serverWith({ cancelRun: async () => null }).handle(post({}, cancelUrl));
    // Not 403: confirming that somebody else's run id is real turns this route into an enumeration oracle.
    expect(response.status).toBe(404);
  });

  it("scopes the cancellation to the caller's own tenant", async () => {
    const cancelRun = vi.fn(async (_input: CancelInput) => ({ status: "running" }));
    await serverWith({ cancelRun }).handle(post({ tenantId: "ws-someone-else" }, cancelUrl));
    expect(cancelRun.mock.calls[0]?.[0]?.context.tenantId).toBe("ws-1");
  });

  it("refuses an unauthenticated caller", async () => {
    const cancelRun = vi.fn(async (_input: CancelInput) => ({ status: "running" }));
    const response = await serverWith({ authenticate: () => null, cancelRun }).handle(post({}, cancelUrl));
    expect(response.status).toBe(401);
    expect(cancelRun).not.toHaveBeenCalled();
  });
});

/**
 * `GET /api/interactions/pending` — the read that made a paused run visible.
 *
 * A gated tool parks the run at `waiting-for-approval` and the engine announces it as an *event*
 * carrying an interaction id and nothing else. There is no `approval` part on the message, so a client
 * deriving its permission card from `parts` — which is what the platform's own hook does — found
 * nothing: a greyed chip, a disabled composer, and no way to say yes. "Reply to comment gets stuck",
 * and it was every gated tool, publishing included.
 */
describe("GET /api/interactions/pending", () => {
  const get = (url: string) => new Request(url, { method: "GET" });

  it("reports the approval a run is waiting on, arguments included", async () => {
    const pendingInteraction = vi.fn(async (_input: PendingInput) => ({
      approval: {
        interactionId: "int-1",
        toolName: "reply_to_comment",
        toolArgs: { commentId: "c-1", text: "On its way — thanks for asking." },
        riskCategory: "engagement",
        summary: "Reply to @sofiab on Instagram",
        expiresAt: "2026-09-10T09:00:00.000Z",
      },
    }));
    const server = serverWith({ pendingInteraction });

    const response = await server.handle(get("http://app.test/api/interactions/pending?runId=run-9"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { approval?: { toolName?: string; toolArgs?: Record<string, unknown> } };
    expect(body.approval?.toolName).toBe("reply_to_comment");
    /**
     * The arguments matter as much as the tool name: the card shows them so a person can see what they
     * are approving, and "reply to a comment" with no reply in it is not a decision anyone can make.
     */
    expect(body.approval?.toolArgs?.["text"]).toBe("On its way — thanks for asking.");
    expect(pendingInteraction.mock.calls[0]?.[0]?.runId).toBe("run-9");
  });

  it("takes the tenant from the caller, never from the query", async () => {
    // A pending approval names a tool and carries its input, so reading another workspace's would leak
    // what they are doing. Same rule as every other route here.
    const pendingInteraction = vi.fn(async (_input: PendingInput) => ({}));
    const server = serverWith({ pendingInteraction });

    await server.handle(get("http://app.test/api/interactions/pending?runId=run-9&tenantId=someone-else"));

    expect(String(pendingInteraction.mock.calls[0]?.[0]?.context.tenantId)).toBe(CALLER.tenantId);
  });

  it("reports a question the same way", async () => {
    const pendingInteraction = vi.fn(async (_input: PendingInput) => ({
      question: { interactionId: "int-2", questions: [{ key: "when", prompt: "Which day?" }] },
    }));
    const server = serverWith({ pendingInteraction });

    const body = (await (
      await server.handle(get("http://app.test/api/interactions/pending?runId=run-9"))
    ).json()) as { question?: { interactionId?: string } };

    expect(body.question?.interactionId).toBe("int-2");
  });

  it("refuses without a runId, because the run is the whole question", async () => {
    const server = serverWith({ pendingInteraction: vi.fn(async (_input: PendingInput) => ({})) });
    const response = await server.handle(get("http://app.test/api/interactions/pending"));
    expect(response.status).toBe(400);
  });

  it("is 404 on a deployment with no interaction surface", async () => {
    // Not 500: a deployment can legitimately compose without one, and a client should be able to tell
    // "this deployment does not do approvals" from "this deployment is broken".
    const response = await serverWith().handle(get("http://app.test/api/interactions/pending?runId=run-9"));
    expect(response.status).toBe(404);
  });

  it("answers an empty object when the run is waiting for nothing", async () => {
    // Asked on a status change, so a run that resumed in the meantime is an ordinary race.
    const server = serverWith({ pendingInteraction: vi.fn(async (_input: PendingInput) => ({})) });
    const response = await server.handle(get("http://app.test/api/interactions/pending?runId=run-9"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });
});

/**
 * `GET /api/usage` — two questions on one route, and the parameter says which.
 *
 * `?days=` is spend over time. `?runId=` and `?conversationId=` are the session-context meter: how full
 * the model's window was. The conversation form exists because a conversation the user just *opened* has
 * no run in the session — its messages come from the store and carry no run id — and a meter that
 * appears only after you send something appears at the moment you least need it.
 */
describe("GET /api/usage", () => {
  const get = (url: string) => new Request(url, { method: "GET" });
  type UsageInput = Parameters<NonNullable<ShareFlowServerDeps["usage"]>>[0];
  type RunUsageInput = Parameters<NonNullable<ShareFlowServerDeps["runUsage"]>>[0];

  const totals = { inputTokens: 4_900, outputTokens: 210, costMinorUnits: 13, currency: "USD", turns: 31 };
  const context = { inputTokens: 4_900, outputTokens: 210, steps: 3, contextLimit: 120_000 };

  it("reports spend over a window of days", async () => {
    const usage = vi.fn(async (_input: UsageInput) => totals);
    const response = await serverWith({ usage }).handle(get("http://app.test/api/usage?days=7"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { days?: number; turns?: number };
    expect(body.days).toBe(7);
    expect(body.turns).toBe(31);
    // A window, not two instants: every caller wants "recently", and two clients computing ISO
    // timestamps in their own timezones would disagree about the same word.
    const asked = usage.mock.calls[0]?.[0];
    expect(new Date(String(asked?.to)).getTime() - new Date(String(asked?.from)).getTime()).toBe(7 * 86_400_000);
  });

  it("caps the window rather than scanning history", async () => {
    const usage = vi.fn(async (_input: UsageInput) => totals);
    await serverWith({ usage }).handle(get("http://app.test/api/usage?days=99999"));
    const asked = usage.mock.calls[0]?.[0];
    expect(new Date(String(asked?.to)).getTime() - new Date(String(asked?.from)).getTime()).toBe(365 * 86_400_000);
  });

  it("defaults to thirty days when asked for nothing", async () => {
    const usage = vi.fn(async (_input: UsageInput) => totals);
    await serverWith({ usage }).handle(get("http://app.test/api/usage"));
    const asked = usage.mock.calls[0]?.[0];
    expect(new Date(String(asked?.to)).getTime() - new Date(String(asked?.from)).getTime()).toBe(30 * 86_400_000);
  });

  it("reports one run's context when given a run", async () => {
    const runUsage = vi.fn(async (_input: RunUsageInput) => context);
    const response = await serverWith({ runUsage }).handle(get("http://app.test/api/usage?runId=run-9"));

    expect(response.status).toBe(200);
    expect(runUsage.mock.calls[0]?.[0]?.runId).toBe("run-9");
    // The limit comes from the manifest, so the bar cannot be drawn against a number nothing enforces.
    expect((await response.json()) as unknown).toMatchObject({ contextLimit: 120_000 });
  });

  it("reports a conversation's context when given a conversation", async () => {
    const runUsage = vi.fn(async (_input: RunUsageInput) => context);
    await serverWith({ runUsage }).handle(get("http://app.test/api/usage?conversationId=convo-1"));
    expect(runUsage.mock.calls[0]?.[0]?.conversationId).toBe("convo-1");
    expect(runUsage.mock.calls[0]?.[0]?.runId).toBeUndefined();
  });

  it("prefers the run when given both, since it is the more precise question", async () => {
    const runUsage = vi.fn(async (_input: RunUsageInput) => context);
    await serverWith({ runUsage }).handle(
      get("http://app.test/api/usage?runId=run-9&conversationId=convo-1"),
    );
    expect(runUsage.mock.calls[0]?.[0]?.runId).toBe("run-9");
  });

  it("takes the tenant from the caller for both forms", async () => {
    const usage = vi.fn(async (_input: UsageInput) => totals);
    const runUsage = vi.fn(async (_input: RunUsageInput) => context);
    const server = serverWith({ usage, runUsage });

    await server.handle(get("http://app.test/api/usage?days=1&tenantId=someone-else"));
    await server.handle(get("http://app.test/api/usage?runId=run-9&tenantId=someone-else"));

    expect(String(usage.mock.calls[0]?.[0]?.context.tenantId)).toBe(CALLER.tenantId);
    expect(String(runUsage.mock.calls[0]?.[0]?.context.tenantId)).toBe(CALLER.tenantId);
  });

  it("is 404 on a deployment that does not report usage", async () => {
    expect((await serverWith().handle(get("http://app.test/api/usage?days=7"))).status).toBe(404);
    expect((await serverWith().handle(get("http://app.test/api/usage?runId=run-9"))).status).toBe(404);
  });
});


/**
 * Settings → Memory — #621. The caller's own memories only: the routes build the context from the
 * authenticated caller, and the real service reads the principal from it. A memory id belonging to someone
 * else answers exactly like one that never existed.
 */
describe("/api/memory — the caller's personal memory", () => {
  const setup = async () => {
    const { createMemoryPrincipalMemoryStore } = await import("@retinue/agentkit/persistence");
    const { createPersonalMemoryService } = await import("../../adapters/personal-memory.js");
    const service = createPersonalMemoryService({ store: createMemoryPrincipalMemoryStore() });
    const as = (tenantId: string, principalId: string) => ({ tenantId, principalId, roleIds: ["editor"] }) as never;
    const mine = await service.remember(as("ws-1", "user-1"), { text: "Writes in British English." });
    const theirs = await service.remember(as("ws-1", "user-2"), { text: "Writes in German." });
    const elsewhere = await service.remember(as("ws-2", "user-1"), { text: "Prefers emoji." });
    return { service, mine: mine.memory, theirs: theirs.memory, elsewhere: elsewhere.memory, server: serverWith({ personalMemory: service }) };
  };
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`http://app.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("lists only the caller's memories in the caller's workspace", async () => {
    const { server } = await setup();
    const response = await server.handle(req("GET", "/api/memory"));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: { text: string; enabled: boolean }[] };
    expect(items.map((m) => m.text)).toEqual(["Writes in British English."]);
    expect(items[0]!.enabled).toBe(true);
  });

  it("switches a memory off and on", async () => {
    const { server, service, mine } = await setup();
    const off = await server.handle(req("PATCH", `/api/memory/${mine.id}`, { enabled: false }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as { memory: { enabled: boolean } }).memory.enabled).toBe(false);
    expect((await service.list({ tenantId: "ws-1", principalId: "user-1" } as never))[0]!.enabled).toBe(false);
    const on = await server.handle(req("PATCH", `/api/memory/${mine.id}`, { enabled: true }));
    expect(((await on.json()) as { memory: { enabled: boolean } }).memory.enabled).toBe(true);
    expect((await server.handle(req("PATCH", `/api/memory/${mine.id}`, { enabled: "yes" }))).status).toBe(400);
  });

  it("deletes the caller's memory", async () => {
    const { server, service, mine } = await setup();
    const response = await server.handle(req("DELETE", `/api/memory/${mine.id}`));
    expect(response.status).toBe(200);
    expect(await service.list({ tenantId: "ws-1", principalId: "user-1" } as never)).toEqual([]);
  });

  it("cannot reach another person's memory, or the caller's own in another workspace, by id", async () => {
    const { server, service, theirs, elsewhere } = await setup();
    // The in-memory store's ids are global, so these are distinct from the caller's own and must 404.
    for (const id of [theirs.id, elsewhere.id]) {
      expect((await server.handle(req("DELETE", `/api/memory/${encodeURIComponent(id)}`))).status).toBe(404);
      expect((await server.handle(req("PATCH", `/api/memory/${encodeURIComponent(id)}`, { enabled: false }))).status).toBe(404);
    }
    await server.handle(req("PATCH", `/api/memory/nope`, { enabled: false })).then((r) => expect(r.status).toBe(404));
    expect((await service.list({ tenantId: "ws-1", principalId: "user-2" } as never)).map((m) => m.text)).toEqual(["Writes in German."]);
    expect((await service.list({ tenantId: "ws-2", principalId: "user-1" } as never)).map((m) => m.text)).toEqual(["Prefers emoji."]);
  });

  it("uses the authenticated caller, never a principal from the request", async () => {
    const setEnabled = vi.fn(async (_context: unknown, _input: unknown) => ({ id: "m1", text: "x", enabled: false, createdAt: "", updatedAt: "" }));
    const server = serverWith({ personalMemory: { list: async () => [], setEnabled, remove: async () => ({ deleted: true }) } });
    await server.handle(req("PATCH", "/api/memory/m1?principalId=user-9", { enabled: false, principalId: "user-9", tenantId: "ws-9" }));
    const context = setEnabled.mock.calls[0]![0] as { tenantId: string; principalId: string };
    expect(String(context.tenantId)).toBe("ws-1");
    expect(String(context.principalId)).toBe("user-1");
  });

  it("refuses without a caller, and 404s on a deployment without memory", async () => {
    expect((await serverWith({ authenticate: () => null }).handle(req("GET", "/api/memory"))).status).toBe(401);
    expect((await serverWith().handle(req("GET", "/api/memory"))).status).toBe(404);
  });
});
