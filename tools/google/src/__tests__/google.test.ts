/**
 * Google Workspace — REQ-054 (#232), task #234.
 *
 * Four of these carry real risk, and each is silent when wrong:
 *
 * - **AC-4** threading. A reply without `In-Reply-To` sends perfectly and arrives as a new conversation.
 * - **AC-6** a non-ASCII subject. Raw UTF-8 in a header is mojibake in somebody's inbox and nothing errors.
 * - **AC-3** a missing scope. Google's 403 names the API, not the scope, so a model retries forever.
 * - **AC-1** an expired token. It works for an hour, then looks intermittent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bearer, refreshable, withRefreshingCredentials, type CredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  buildMessage,
  bodyOf,
  CALENDAR_READONLY,
  createGoogleToolkit,
  encodeHeader,
  GMAIL_READONLY,
  GMAIL_SEND,
  GOOGLE_AUTH,
  GOOGLE_SCOPES,
  GOOGLE_TOOL_NAMES,
  grantedScopes,
  htmlToText,
  missingScopes,
  toBase64Url,
  fromBase64Url,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every scope, so a test that is not about scopes is not accidentally about scopes. */
const ALL_SCOPES = GOOGLE_SCOPES.map((entry) => entry.scope).join(" ");

const resolverWith = (scope: string | undefined): CredentialResolver => ({
  async resolve() {
    return scope === undefined ? bearer("ya29.token") : bearer("ya29.token", { scope });
  },
});

const toolkit = (fetchImpl: typeof fetch, resolver: CredentialResolver = resolverWith(ALL_SCOPES)) =>
  createGoogleToolkit({ credentialRef: "google", resolver, fetchImpl });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown, resolver?: CredentialResolver) => {
  const tools = await toolkit(fetchImpl, resolver).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

const sentBody = (fetchImpl: typeof fetch, call = 0): Record<string, unknown> =>
  JSON.parse((fetchImpl as unknown as { mock: { calls: [unknown, { body?: string }][] } }).mock.calls[call]?.[1]?.body ?? "{}");

/** The raw RFC 5322 message a send/draft call produced. */
const rawOf = (fetchImpl: typeof fetch, call = 0): string => {
  const body = sentBody(fetchImpl, call);
  const raw = (body.raw ?? (body.message as Record<string, unknown> | undefined)?.raw) as string;
  return fromBase64Url(raw);
};

describe("the toolkit contract — AC-2, AC-7", () => {
  it("declares exactly the tools it names", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...GOOGLE_TOOL_NAMES]);
  });

  it("gates each write as the issue tabled, and leaves the draft ungated", async () => {
    /**
     * The deliberate asymmetry — AC-2. If drafting cost an approval too, a model would have no reason to
     * prefer it: the cheap path and the irreversible path would be equally expensive, so it would take the one
     * that finishes the task. Making the reversible act free is what makes it the default.
     */
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));

    for (const read of ["gmail_search_messages", "gmail_get_message", "gmail_get_thread", "gmail_list_labels", "calendar_list_events", "calendar_get_event", "calendar_find_free_time"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    for (const write of ["gmail_send_message", "gmail_reply_message", "gmail_modify_labels", "calendar_create_event", "calendar_update_event"]) {
      expect(byName.get(write), write).toMatchObject({ effect: "external-write", approvalPolicy: "always" });
    }
    expect(byName.get("calendar_delete_event")).toMatchObject({ effect: "destructive", approvalPolicy: "always" });

    // The draft: a write, audited, and not gated.
    expect(byName.get("gmail_create_draft")).toMatchObject({ effect: "internal-write", approvalPolicy: "never" });
  });

  it("declares per-tool scopes in metadata, not only in prose — AC-7", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("gmail_search_messages")?.requiredScopes).toEqual([GMAIL_READONLY]);
    // A reply needs both: it sends, and it reads the original to thread correctly.
    expect(byName.get("gmail_reply_message")?.requiredScopes).toEqual([GMAIL_SEND, GMAIL_READONLY]);
    // Every tool declares something — an undeclared scope is one the consent screen will not ask for.
    for (const tool of tools) expect(tool.descriptor.requiredScopes?.length, tool.descriptor.name).toBeGreaterThan(0);
  });

  it("says which scopes are restricted, so an operator learns before the consent screen does", () => {
    // Gmail's are restricted (security assessment); Calendar's are merely sensitive. That is a materially
    // different burden and the difference belongs somewhere machine-readable.
    const restricted = GOOGLE_SCOPES.filter((entry) => entry.restricted).map((entry) => entry.scope);
    // Gmail's four, plus `drive.readonly` — which reads a user's whole Drive and is restricted for the same
    // reason. `drive.file` is not, because it reaches only files this app made or the user picked, and that
    // distinction is exactly why every Drive write here uses the narrow one.
    expect(restricted).toHaveLength(5);
    expect(restricted.filter((scope) => scope.includes("gmail"))).toHaveLength(4);
    expect(restricted).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(restricted).not.toContain("https://www.googleapis.com/auth/drive.file");
    expect(GOOGLE_AUTH).toEqual({ modes: ["oauth2"], schemes: ["bearer"] });
  });

  it("says in every attendee-notifying description that people are emailed — AC-5", async () => {
    /**
     * A model choosing between "create the event" and "find a time and tell me" has to be able to see that one
     * of those is a message to eight people. The only place it can see that is the description.
     */
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const name of ["calendar_create_event", "calendar_update_event", "calendar_delete_event"]) {
      expect(byName.get(name)?.description.toLowerCase(), name).toMatch(/emailed|notif/);
    }
    // And the read that exists to be preferred over them says so.
    expect(byName.get("calendar_find_free_time")?.description).toContain("nobody is notified");
  });

  it("refuses a typo'd exclusion rather than shipping the tool", () => {
    // The tool most likely to be excluded here is `gmail_send_message`, so a silently-ignored typo means an
    // agent that can send mail.
    expect(() => toolkit(vi.fn() as unknown as typeof fetch, resolverWith(ALL_SCOPES)) && createGoogleToolkit({
      credentialRef: "google",
      resolver: resolverWith(ALL_SCOPES),
      exclude: ["gmail_send_mesage"],
    })).toThrow(/gmail_send_mesage/);
  });
});

describe("a missing scope is refused before the call — AC-3", () => {
  it("stops a send when only read scopes were granted, and names the scope", async () => {
    /**
     * Google's own answer is a 403 naming the API rather than the scope, so a model retries with different
     * arguments and an operator reads a log that does not say what to change.
     */
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run(
      "gmail_send_message",
      fetchImpl,
      { to: ["a@b.c"], subject: "Hi", body: "x" },
      resolverWith(GMAIL_READONLY),
    )) as { ok: false; error: { code: string; message: string; retryable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.message).toContain(GMAIL_SEND);
    expect(result.error.message).toContain("Nothing was sent to Google");
    expect(result.error.retryable).toBe(false);
    // The point of "before the call".
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets a read through on the same read-only grant", async () => {
    // Without this the test above would pass against a toolkit that refused everything.
    const fetchImpl = vi.fn(async () => jsonResponse({ labels: [] })) as unknown as typeof fetch;
    const result = (await run("gmail_list_labels", fetchImpl, {}, resolverWith(GMAIL_READONLY))) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("proceeds when the grant is unstated, rather than breaking a static token", async () => {
    /**
     * A deployment using a token with no scope metadata cannot be checked, and refusing there would break a
     * working configuration to enforce a check that cannot be performed. Unknown means proceed.
     */
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "m1" })) as unknown as typeof fetch;
    const result = (await run(
      "gmail_send_message",
      fetchImpl,
      { to: ["a@b.c"], subject: "Hi", body: "x" },
      resolverWith(undefined),
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("still maps Google's own 403 to something actionable, as the fallback", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "Request had insufficient authentication scopes." } }, 403)) as unknown as typeof fetch;
    const result = (await run("gmail_list_labels", fetchImpl, {}, resolverWith(undefined))) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.message).toContain("scope");
    expect(result.error.retryable).toBe(false);
  });

  it("reads a grant from either metadata shape, and treats absent as unknown", () => {
    expect(grantedScopes(bearer("t", { scope: "a b" }))).toEqual(["a", "b"]);
    expect(grantedScopes(bearer("t", { scopes: "a,b" }))).toEqual(["a", "b"]);
    // `null`, not `[]` — an empty grant would refuse everything, and unstated must not.
    expect(grantedScopes(bearer("t"))).toBeNull();
    expect(missingScopes(bearer("t"), [GMAIL_SEND])).toEqual([]);
    expect(missingScopes(bearer("t", { scope: GMAIL_READONLY }), [GMAIL_SEND])).toEqual([GMAIL_SEND]);
  });
});

describe("an expired access token is renewed, not failed — AC-1", () => {
  it("succeeds on a call made after the token expired", async () => {
    /**
     * The reason this task was blocked on #233 rather than sequenced after it: a Google access token lives an
     * hour, so a toolkit on a static token works for one hour per deployment and then fails in a way that
     * looks intermittent.
     */
    let refreshes = 0;
    const expired = refreshable(bearer("dead", { scope: ALL_SCOPES }), new Date(Date.now() - 60_000).toISOString());
    const resolver = withRefreshingCredentials(
      { async resolve() { return expired; } },
      {
        async refresh() {
          refreshes += 1;
          return refreshable(bearer("ya29.fresh", { scope: ALL_SCOPES }), new Date(Date.now() + 3_600_000).toISOString());
        },
      },
    );

    let seen: string | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers).get("authorization") ?? undefined;
      return jsonResponse({ labels: [] });
    }) as unknown as typeof fetch;

    const result = (await run("gmail_list_labels", fetchImpl, {}, resolver)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(refreshes).toBe(1);
    // The *fresh* token reached Google, not the dead one.
    expect(seen).toBe("Bearer ya29.fresh");
  });

  it("checks scopes against the refreshed credential, not the expired one", async () => {
    // The scope gate resolves through the same resolver, so a re-consent that added a scope takes effect
    // without a restart — and a check never runs against a token the call would not have used.
    const resolver = withRefreshingCredentials(
      { async resolve() { return refreshable(bearer("dead", { scope: GMAIL_READONLY }), new Date(Date.now() - 1).toISOString()); } },
      { async refresh() { return refreshable(bearer("fresh", { scope: ALL_SCOPES }), new Date(Date.now() + 3_600_000).toISOString()); } },
    );
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "m1" })) as unknown as typeof fetch;
    const result = (await run("gmail_send_message", fetchImpl, { to: ["a@b.c"], subject: "s", body: "b" }, resolver)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
  });
});

describe("a reply stays in its thread — AC-4", () => {
  const ORIGINAL = {
    id: "m-original",
    threadId: "t-1",
    payload: {
      headers: [
        { name: "Message-ID", value: "<abc@mail.example>" },
        { name: "References", value: "<root@mail.example> <second@mail.example>" },
        { name: "Subject", value: "Deployment window" },
        { name: "From", value: "Ana <ana@example.com>" },
        { name: "Cc", value: "bo@example.com, cy@example.com" },
      ],
    },
  };

  it("carries In-Reply-To and References from the fetched original", async () => {
    /**
     * Verified against a fetched message rather than a constructed fixture, as the AC asks: the headers exist
     * only on the real message, and building them from an id the caller passed is precisely the defect.
     */
    const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "GET" ? jsonResponse(ORIGINAL) : jsonResponse({ id: "sent", threadId: "t-1" }),
    ) as unknown as typeof fetch;

    await run("gmail_reply_message", fetchImpl, { messageId: "m-original", body: "Sounds good" });
    const raw = rawOf(fetchImpl, 1);

    expect(raw).toContain("In-Reply-To: <abc@mail.example>");
    // The chain *appends* — a reply carrying only the immediate parent loses the thread's history for any
    // client that walks References.
    expect(raw).toContain("References: <root@mail.example> <second@mail.example> <abc@mail.example>");
    // And Gmail's own threading, which is a separate mechanism from the headers.
    expect(sentBody(fetchImpl, 1).threadId).toBe("t-1");
  });

  it("does not accumulate Re: on an already-replied subject", async () => {
    const already = { ...ORIGINAL, payload: { headers: [...ORIGINAL.payload.headers.filter((h) => h.name !== "Subject"), { name: "Subject", value: "Re: Deployment window" }] } };
    const fetchImpl = vi.fn(async (_url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "GET" ? jsonResponse(already) : jsonResponse({ id: "sent" }),
    ) as unknown as typeof fetch;
    await run("gmail_reply_message", fetchImpl, { messageId: "m", body: "ok" });
    expect(rawOf(fetchImpl, 1)).toContain("Subject: Re: Deployment window");
    expect(rawOf(fetchImpl, 1)).not.toContain("Re: Re:");
  });

  it("refuses to send rather than starting a new thread when the original has no Message-ID", async () => {
    // Sending anyway is the failure: it succeeds, and the recipient gets an orphan with no context.
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "m", payload: { headers: [{ name: "Subject", value: "x" }] } })) as unknown as typeof fetch;
    const result = (await run("gmail_reply_message", fetchImpl, { messageId: "m", body: "hi" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("new conversation");
    // Only the read happened.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("replies to Reply-To where the original set one", async () => {
    const withReplyTo = { ...ORIGINAL, payload: { headers: [...ORIGINAL.payload.headers, { name: "Reply-To", value: "tickets@example.com" }] } };
    const fetchImpl = vi.fn(async (_url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "GET" ? jsonResponse(withReplyTo) : jsonResponse({ id: "sent" }),
    ) as unknown as typeof fetch;
    await run("gmail_reply_message", fetchImpl, { messageId: "m", body: "ok" });
    expect(rawOf(fetchImpl, 1)).toContain("To: tickets@example.com");
  });

  it("only copies Cc when reply-all was asked for", async () => {
    const send = async (replyAll: boolean) => {
      const fetchImpl = vi.fn(async (_url: unknown, init?: { method?: string }) =>
        (init?.method ?? "GET") === "GET" ? jsonResponse(ORIGINAL) : jsonResponse({ id: "sent" }),
      ) as unknown as typeof fetch;
      await run("gmail_reply_message", fetchImpl, { messageId: "m", body: "ok", replyAll });
      return rawOf(fetchImpl, 1);
    };
    expect(await send(true)).toContain("Cc: bo@example.com, cy@example.com");
    expect(await send(false)).not.toContain("Cc:");
  });
});

describe("MIME is built correctly — AC-6", () => {
  it("encodes a non-ASCII subject as an RFC 2047 word", () => {
    /**
     * Silent when wrong: raw UTF-8 in a header does not throw, it arrives as mojibake. The encoded form is
     * asserted rather than the decoded one, because decoding it here would test this test.
     */
    const raw = buildMessage({ to: ["a@b.c"], subject: "Rückfrage zur Buchung", body: "x" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("Subject: Rückfrage");
    // And it decodes back to the original.
    const encoded = /Subject: (.*)\r\n/.exec(raw)?.[1] ?? "";
    const decoded = encoded
      .split(" ")
      .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word)?.[1] ?? "", "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Rückfrage zur Buchung");
  });

  it("leaves an ASCII subject readable, because half of debugging mail is reading it", () => {
    expect(buildMessage({ to: ["a@b.c"], subject: "Plain subject", body: "x" })).toContain("Subject: Plain subject");
  });

  it("never splits a multi-byte character across two encoded-words", () => {
    // Each word must decode on its own; a split character produces a replacement char in one of them.
    const long = "日本語のとても長い件名です".repeat(6);
    const encoded = encodeHeader(long);
    const decoded = encoded
      .split(" ")
      .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word)?.[1] ?? "", "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(long);
    expect(decoded).not.toContain("�");
  });

  it("encodes a non-ASCII body and declares the charset", () => {
    const raw = buildMessage({ to: ["a@b.c"], subject: "s", body: "Grüße aus Zürich" });
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("Grüße aus Zürich");
  });

  it("uses CRLF, which some servers are strict about", () => {
    const raw = buildMessage({ to: ["a@b.c"], subject: "s", body: "x" });
    expect(raw).toContain("\r\n");
    expect(raw.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
  });

  it("round-trips base64url, which is not base64", () => {
    const value = "subjects with + and / and = in them ??>>";
    expect(fromBase64Url(toBase64Url(value))).toBe(value);
    expect(toBase64Url(value)).not.toMatch(/[+/=]/);
  });

  it("prefers the plain-text part over the HTML one", () => {
    // Which is the common case for anything sent by a real mail client, and far more readable.
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: toBase64Url("the plain one") } },
        { mimeType: "text/html", body: { data: toBase64Url("<p>the html one</p>") } },
      ],
    };
    expect(bodyOf(payload as never)).toEqual({ text: "the plain one", hadHtmlOnly: false });
  });

  it("reduces HTML only when there is no alternative, and says it did", () => {
    const payload = { mimeType: "text/html", body: { data: toBase64Url("<h1>Hi</h1><p>there</p>") } };
    const result = bodyOf(payload as never);
    expect(result.hadHtmlOnly).toBe(true);
    expect(result.text).toContain("Hi");
    expect(result.text).not.toContain("<h1>");
  });

  it("skips attachments by filename, not by mime type", () => {
    // A PDF attachment and an inline image are both `application/*`; only the filename separates "part of the
    // message" from "a file that came with it".
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: toBase64Url("body text") } },
        { mimeType: "text/plain", filename: "notes.txt", body: { data: toBase64Url("attached text") } },
      ],
    };
    expect(bodyOf(payload as never).text).toBe("body text");
  });

  it("drops script and style content rather than returning a wall of CSS", () => {
    expect(htmlToText("<style>.a{color:red}</style><p>Hello</p><script>x()</script>")).toBe("Hello");
  });
});

describe("calendar reads answer what was asked", () => {
  it("expands recurring events into instances", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;
    await run("calendar_list_events", fetchImpl, { timeMin: "2026-09-01T00:00:00Z", timeMax: "2026-09-02T00:00:00Z" });
    // "What is on Tuesday" means the instance, not the rule that generated it.
    expect(String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0])).toContain("singleEvents=true");
  });

  it("keeps an all-day event's date rather than dropping it", async () => {
    // An all-day event has `date` and no `dateTime`; returning only `dateTime` silently loses every one of them.
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [{ id: "e1", summary: "Holiday", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } }] })) as unknown as typeof fetch;
    const result = (await run("calendar_list_events", fetchImpl, { timeMin: "a", timeMax: "b" })) as {
      data: { events: { start: string; allDay: boolean }[] };
    };
    expect(result.data.events[0]).toMatchObject({ start: "2026-09-01", allDay: true });
  });

  it("merges overlapping busy blocks before inverting them", async () => {
    /**
     * Two people busy 09:00–10:00 and 09:30–11:00 are collectively busy 09:00–11:00. Inverting each separately
     * produces a "free" slot at 09:30 that is free for nobody.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        calendars: {
          "a@x.com": { busy: [{ start: "2026-09-01T09:00:00Z", end: "2026-09-01T10:00:00Z" }] },
          "b@x.com": { busy: [{ start: "2026-09-01T09:30:00Z", end: "2026-09-01T11:00:00Z" }] },
        },
      }),
    ) as unknown as typeof fetch;
    const result = (await run("calendar_find_free_time", fetchImpl, {
      attendees: ["a@x.com", "b@x.com"],
      timeMin: "2026-09-01T08:00:00Z",
      timeMax: "2026-09-01T12:00:00Z",
      durationMinutes: 30,
    })) as { data: { free: { start: string; end: string }[] } };
    expect(result.data.free).toEqual([
      { start: "2026-09-01T08:00:00.000Z", end: "2026-09-01T09:00:00.000Z" },
      { start: "2026-09-01T11:00:00.000Z", end: "2026-09-01T12:00:00.000Z" },
    ]);
  });

  it("does not treat a calendar it cannot read as an empty one", async () => {
    // Treating "cannot see" as "free" is how an agent books over somebody's day.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        calendars: {
          "a@x.com": { busy: [] },
          "hidden@x.com": { errors: [{ domain: "global", reason: "notFound" }] },
        },
      }),
    ) as unknown as typeof fetch;
    const result = (await run("calendar_find_free_time", fetchImpl, {
      attendees: ["a@x.com", "hidden@x.com"],
      timeMin: "2026-09-01T08:00:00Z",
      timeMax: "2026-09-01T09:00:00Z",
    })) as { data: { unreadableCalendars: string[]; warning?: string } };
    expect(result.data.unreadableCalendars).toEqual(["hidden@x.com"]);
    expect(result.data.warning).toContain("may still clash");
  });

  it("tells Google to notify attendees explicitly rather than relying on a default", async () => {
    // The default differs by endpoint, and "whatever the API does" is not a decision anybody made.
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "e1" })) as unknown as typeof fetch;
    await run("calendar_create_event", fetchImpl, {
      summary: "Sync",
      start: "2026-09-01T09:00:00Z",
      end: "2026-09-01T09:30:00Z",
      attendees: ["a@x.com"],
    });
    expect(String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0])).toContain("sendUpdates=all");
  });

  it("refuses an update with nothing to change", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("calendar_update_event", fetchImpl, { eventId: "e1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("nothing to change");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("credentials come only from the resolver", () => {
  it("reads no environment variable anywhere in the package source", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["index.ts", "gmail.ts", "calendar.ts", "mime.ts", "transport.ts"]) {
      const source = readFileSync(`${here}../${file}`, "utf8");
      expect(source, file).not.toMatch(/process\s*\.\s*env/);
      expect(source, file).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
    }
  });

  it("does not send a draft, and says so", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "d1", message: { id: "m1" } })) as unknown as typeof fetch;
    const result = (await run("gmail_create_draft", fetchImpl, { to: ["a@b.c"], subject: "s", body: "b" })) as {
      data: { sent: boolean };
    };
    // "Created a draft" and "sent an email" are one word apart in a summary; the field makes it checkable.
    expect(result.data.sent).toBe(false);
    expect(String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0])).toContain("/drafts");
  });
});

describe("a header cannot be injected from untrusted content", () => {
  it("refuses a subject containing a line break, rather than sending two headers", async () => {
    /**
     * A header ends at CRLF, so `Update\r\nBcc: attacker@example.com` is *two* headers and the second copies
     * the mail to somebody. The path is not hypothetical: an agent composing a subject from an email it just
     * read is what `docs/17` treats retrieved content as untrusted for.
     *
     * Non-ASCII subjects are safe by accident — base64 has no CRLF to interpret — but an ASCII one goes in
     * raw, so "it is usually encoded" is not a defence.
     */
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("gmail_send_message", fetchImpl, {
      to: ["a@b.c"],
      subject: "Update\r\nBcc: attacker@example.com",
      body: "x",
    })) as { ok: false; error: { message: string } };

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("inject");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an injected recipient too, and a bare newline as well as CRLF", () => {
    for (const value of ["a@b.c\r\nBcc: x@y.z", "a@b.c\nBcc: x@y.z", "line\rbreak"]) {
      expect(() => buildMessage({ to: [value], subject: "s", body: "b" }), value).toThrow(/inject/);
    }
    expect(() => buildMessage({ to: ["a@b.c"], subject: "s", body: "b", cc: ["c@d.e\r\nBcc: x@y.z"] })).toThrow(/inject/);
  });

  it("leaves a legitimate subject and body untouched, including newlines in the body", () => {
    // Only *headers* are line-sensitive; a body with newlines is ordinary and must not be refused.
    const raw = buildMessage({ to: ["a@b.c"], subject: "Quarterly update", body: "line one\nline two" });
    expect(raw).toContain("Subject: Quarterly update");
    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("line one\nline two");
  });
});

/**
 * A narrow deployment needs only its own scopes — REQ-054 (#232), parent AC-6.
 *
 * The AC says **verified, not asserted**, and the distinction is the whole reason this block exists. Declaring
 * `requiredScopes` per tool and writing them into a documentation table is the *asserting* half; both were
 * already done. Neither establishes the property an operator actually cares about, which is that a consent
 * screen limited to the scopes of the tools they enabled will not produce a toolkit that refuses its own work.
 *
 * The failure this catches is a tool quietly needing a scope beyond the ones it declares — a helper call added
 * later against a different API, say. It typechecks, it works in development where the token was granted
 * everything, and it fails only for the operator who granted the narrow set. Exactly the shape #245 exists for.
 */
describe("a subset of tools needs only that subset's scopes — parent AC-6", () => {
  /** The scopes a chosen set of tools declares between them, which is what a narrow grant would contain. */
  const scopesFor = async (include: readonly string[]): Promise<string[]> => {
    const tools = await createGoogleToolkit({
      credentialRef: "google",
      resolver: resolverWith(ALL_SCOPES),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      include,
    }).listTools(context);
    return [...new Set(tools.flatMap((tool) => tool.descriptor.requiredScopes ?? []))];
  };

  it("a calendar-only deployment works with only the calendar scopes", async () => {
    const include = ["calendar_list_events", "calendar_get_event", "calendar_find_free_time"];
    const granted = await scopesFor(include);
    // The narrow grant is genuinely narrow: no Gmail, no Drive, and none of Google's restricted scopes.
    expect(granted).toEqual([CALENDAR_READONLY]);
    for (const scope of granted) {
      expect(GOOGLE_SCOPES.find((entry) => entry.scope === scope)?.restricted, scope).toBe(false);
    }

    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], calendars: {} })) as unknown as typeof fetch;
    const tools = await createGoogleToolkit({
      credentialRef: "google",
      resolver: resolverWith(granted.join(" ")),
      fetchImpl,
      include,
    }).listTools(context);

    // Every included tool runs. A refusal here would mean a tool needs a scope it does not declare.
    for (const tool of tools) {
      const outcome = (await tool.execute({
        context,
        input: {
          timeMin: "2026-09-01T00:00:00Z",
          timeMax: "2026-09-02T00:00:00Z",
          eventId: "e1",
          attendees: ["a@example.com"],
        },
      })) as { ok: boolean; error?: { code: string } };
      expect(outcome.ok, `${tool.descriptor.name}: ${outcome.error?.code}`).toBe(true);
    }
  });

  it("the same narrow grant refuses a tool outside the subset, naming the scope", async () => {
    // The other half: the grant is narrow because the gate is real, not because nothing checks it.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = (await run(
      "gmail_send_message",
      fetchImpl,
      { to: ["a@example.com"], subject: "hi", body: "hello" },
      resolverWith(CALENDAR_READONLY),
    )) as { ok: false; error: { code: string; message: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("unauthorized");
    expect(outcome.error.message).toContain(GMAIL_SEND);
    // Nothing was sent, so a missing scope costs a refusal rather than a rejected API call.
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("every scope a tool declares is documented, and every documented scope is used", async () => {
    // The table an operator reads when deciding what to consent to has to match what the tools ask for, in
    // both directions: an undocumented scope surprises them at the consent screen, and a documented one no
    // tool needs is a scope they were talked into granting for nothing.
    const tools = await createGoogleToolkit({
      credentialRef: "google",
      resolver: resolverWith(ALL_SCOPES),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }).listTools(context);
    const declared = new Set(tools.flatMap((tool) => tool.descriptor.requiredScopes ?? []));
    const documented = new Set(GOOGLE_SCOPES.map((entry) => entry.scope));
    expect([...declared].filter((scope) => !documented.has(scope))).toEqual([]);
    expect([...documented].filter((scope) => !declared.has(scope))).toEqual([]);
    // And no tool ships with no scope at all, which would slip past both lists.
    for (const tool of tools) {
      expect((tool.descriptor.requiredScopes ?? []).length, tool.descriptor.name).toBeGreaterThan(0);
    }
  });
});
