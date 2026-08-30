/**
 * `tools-email` — REQ-056 (#240), task #241.
 *
 * Two blocks carry the weight, and both are about telling the truth rather than about mail:
 *
 * - **AC-6** a rejected send must never be reported as a send. Every other defect here costs somebody a
 *   confusing error; this one costs them the message, silently, because the caller stops trying.
 * - **AC-3** the preview must be byte-identical to the send. A rehearsal of a different message invites
 *   somebody to approve one thing and dispatch another, with the difference in exactly the parts nobody reads
 *   carefully — the encoded subject, the multipart ordering, the bcc line.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { ConversationId } from "@retinue/agentkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asId, type ExecutionContext } from "@retinue/agentkit";
import { createCredential, type CredentialResolver } from "@retinue/agentkit/tools";

import {
  composeFor,
  createEmailToolkit,
  dotStuff,
  EMAIL_GATED,
  EMAIL_TOOL_NAMES,
  httpProvider,
  MAX_RECIPIENTS,
  SEND_RESULT_KEYS,
  smtpProvider,
  type EmailProvider,
} from "../index.js";
import { startSink, type Sink } from "./sink.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const basicResolver: CredentialResolver = {
  async resolve() {
    return createCredential({ scheme: "basic", username: "postmaster", password: "s3cret" });
  },
};
const bearerResolver: CredentialResolver = {
  async resolve() {
    return createCredential({ scheme: "bearer", token: "re_live_key" });
  },
};

const FROM = "alerts@retinue.test";

const localSmtp = (sink: Sink, extra: Record<string, unknown> = {}) =>
  smtpProvider({
    host: "127.0.0.1",
    port: sink.port,
    // The sink is on loopback and speaks plaintext. Everywhere else this refusal is the point — see the test.
    requireTls: false,
    credentialRef: "smtp",
    resolver: basicResolver,
    timeoutMs: 5_000,
    ...extra,
  });

const run = async (provider: EmailProvider, name: string, input: unknown) => {
  const tools = await createEmailToolkit({ provider, from: FROM }).listTools(context);
  const tool = tools.find((candidate) => candidate.descriptor.name === name)!;
  return tool.execute({ context, input });
};

const BASIC = { to: ["someone@example.test"], subject: "Nightly report", text: "All green." };

let open: Sink | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("the surface is one send and three reads — AC-2", () => {
  it("email_send is the only write, and the rest are reads", async () => {
    const sink = (open = await startSink());
    const tools = await createEmailToolkit({ provider: localSmtp(sink), from: FROM }).listTools(context);
    expect(tools.map((tool) => tool.descriptor.name).sort()).toEqual([...EMAIL_TOOL_NAMES].sort());
    for (const tool of tools) {
      const expected = EMAIL_GATED[tool.descriptor.name] ?? "read";
      expect(tool.descriptor.effect, tool.descriptor.name).toBe(expected);
    }
    const send = tools.find((tool) => tool.descriptor.name === "email_send")!.descriptor;
    expect(send.approvalPolicy).toBe("always");
    // A send cannot be recalled, so a retry that duplicates it is its own harm.
    expect(send.requiresIdempotencyKey).toBe(true);
    for (const tool of tools.filter((candidate) => candidate.descriptor.effect === "read")) {
      expect(tool.descriptor.approvalPolicy, tool.descriptor.name).toBe("never");
    }
    // The gated list names tools that exist, so a rename cannot leave a stale entry excusing one from `read`.
    for (const name of Object.keys(EMAIL_GATED)) expect(EMAIL_TOOL_NAMES as readonly string[]).toContain(name);
  });
});

describe("the preview is byte-identical to the send — AC-3", () => {
  it("what the preview shows is what the sink receives", async () => {
    const sink = (open = await startSink());
    const provider = localSmtp(sink);
    const input = {
      to: ["a@example.test"],
      cc: ["b@example.test"],
      subject: "Rückfrage zur Lieferung",
      text: "Guten Tag.",
      html: "<p>Guten Tag.</p>",
    };

    const preview = (await run(provider, "email_compose_preview", input)) as { ok: true; data: { raw: string; sent: boolean } };
    expect(preview.data.sent).toBe(false);
    expect(sink.messages).toHaveLength(0);

    const sent = (await run(provider, "email_send", input)) as { ok: true; data: { sent: boolean } };
    expect(sent.data.sent).toBe(true);
    expect(sink.messages).toHaveLength(1);

    /**
     * The whole point. Composed once, in one function, with no `Date` and no `Message-ID` — either would make
     * two composes of the same message differ by construction, and the boundary is derived from a hash of the
     * content for the same reason.
     */
    expect(sink.messages[0]!.trimEnd()).toBe(preview.data.raw.trimEnd());
  });

  it("two separate composes of the same message are identical", () => {
    // Determinism stated directly, since it is what makes the assertion above meaningful rather than lucky.
    const config = { provider: { name: "x" } as unknown as EmailProvider, from: FROM };
    const input = { to: ["a@example.test"], subject: "S", text: "t", html: "<p>t</p>" };
    expect(composeFor(config, input).raw).toBe(composeFor(config, input).raw);
  });

  it("the preview shows bcc, and the SMTP transmission does not", async () => {
    const sink = (open = await startSink());
    const provider = localSmtp(sink);
    const input = { ...BASIC, bcc: ["hidden@example.test"] };

    const preview = (await run(provider, "email_compose_preview", input)) as { ok: true; data: { raw: string } };
    expect(preview.data.raw).toContain("Bcc: hidden@example.test");

    await run(provider, "email_send", input);
    /**
     * The single most embarrassing mail bug there is: the envelope already carries every recipient, so a `Bcc`
     * header adds nothing but the ability for each blind recipient to read the whole blind list.
     */
    expect(sink.messages[0]).not.toContain("Bcc:");
    // And the blind recipient still receives it, because the envelope carries them.
    expect(sink.commands.some((line) => line.includes("hidden@example.test"))).toBe(true);
  });
});

describe("the recipient cap is combined, not per field — AC-4", () => {
  it("counts to + cc + bcc together", async () => {
    const sink = (open = await startSink());
    const provider = localSmtp(sink);
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${index}@example.test`);

    // Three fields of ten is thirty recipients. A per-field cap is one somebody routes around by accident.
    const outcome = (await run(provider, "email_send", {
      ...BASIC,
      to: many("to", 10),
      cc: many("cc", 10),
      bcc: many("bcc", 10),
    })) as { ok: false; error: { code: string; message: string } };

    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain(`limit is ${MAX_RECIPIENTS} combined`);
    expect(sink.messages).toHaveLength(0);
  });

  it("accepts exactly the cap and refuses one more", async () => {
    const sink = (open = await startSink());
    const provider = localSmtp(sink);
    const addresses = (count: number) =>
      Array.from({ length: count }, (_, index) => `r${index}@example.test`);
    expect(((await run(provider, "email_send", { ...BASIC, to: addresses(MAX_RECIPIENTS) })) as { ok: boolean }).ok).toBe(true);
    expect(
      ((await run(provider, "email_send", { ...BASIC, to: addresses(MAX_RECIPIENTS + 1) })) as { ok: boolean }).ok,
    ).toBe(false);
  });
});

describe("MIME correctness — AC-5", () => {
  const compose = (input: Parameters<typeof composeFor>[1]) =>
    composeFor({ provider: { name: "x" } as unknown as EmailProvider, from: FROM }, input).raw;

  it("encodes a non-ASCII subject as RFC 2047, and leaves an ASCII one readable", () => {
    const raw = compose({ to: ["a@example.test"], subject: "Rückfrage zur Lieferung", text: "x" });
    // The header bytes, asserted — an unencoded umlaut does not throw, it arrives as mojibake.
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/m);
    expect(raw).not.toContain("Subject: Rückfrage");
    // Decoding it returns what was meant.
    const encoded = /^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/m.exec(raw)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Rückfrage zur Lieferung");

    // An ASCII subject stays legible, because half of debugging mail is reading it with your eyes.
    expect(compose({ to: ["a@example.test"], subject: "Nightly report", text: "x" })).toContain("Subject: Nightly report");
  });

  it("puts text before html in multipart/alternative", () => {
    const raw = compose({ to: ["a@example.test"], subject: "S", text: "plain", html: "<p>rich</p>" });
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="=_retinue_[0-9a-f]{32}"/);
    /**
     * Order is load-bearing. The spec orders parts least-faithful first, and a client that shows the last part
     * it understands would otherwise display the plain-text fallback and never the HTML — mail that looks
     * broken to the recipient and fine to the sender.
     */
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
    expect(Buffer.from(/text\/plain[\s\S]*?\r\n\r\n([A-Za-z0-9+/=]+)/.exec(raw)![1]!, "base64").toString()).toBe("plain");
    expect(Buffer.from(/text\/html[\s\S]*?\r\n\r\n([A-Za-z0-9+/=]+)/.exec(raw)![1]!, "base64").toString()).toBe("<p>rich</p>");
  });

  it("carries an attachment with its filename and content type intact", () => {
    const content = Buffer.from("id,name\n1,Ada\n", "utf8").toString("base64");
    const raw = compose({
      to: ["a@example.test"],
      subject: "S",
      text: "See attached.",
      attachment: { filename: "résumé.csv", contentType: "text/csv", contentBase64: content },
    });
    expect(raw).toMatch(/Content-Type: multipart\/mixed/);
    expect(raw).toContain("Content-Disposition: attachment");
    // A non-ASCII filename is encoded in the header, the same way a subject is.
    expect(raw).toMatch(/filename="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="/);
    expect(raw).toContain("text/csv");
    expect(raw).toContain(content);
    // The body survives alongside the attachment rather than being replaced by it. With a single body there
    // is no `multipart/alternative` inside the `mixed` — only the text part and the attachment.
    expect(raw).not.toContain("multipart/alternative");
    expect(raw).toMatch(/text\/plain/);
    expect(Buffer.from(/text\/plain[\s\S]*?\r\n\r\n([A-Za-z0-9+/=]+)/.exec(raw)![1]!, "base64").toString()).toBe(
      "See attached.",
    );
  });

  it("refuses a header that would inject another header", () => {
    // Reachable from untrusted content: a subject composed from a page the agent scraped.
    expect(() => compose({ to: ["a@example.test"], subject: "Update\r\nBcc: attacker@evil.test", text: "x" })).toThrow(
      /line break/,
    );
  });

  it("dot-stuffs a body line that would end the DATA phase", () => {
    // A line of a single dot ends DATA, so everything after it is read as SMTP commands — a truncated mail and
    // a command-injection primitive at the same time.
    expect(dotStuff("before\r\n.\r\nafter")).toBe("before\r\n..\r\nafter");
  });
});

describe("a rejection is never reported as a send — AC-6", () => {
  it("a 5xx at RCPT is permanent, and the tool says NOT sent", async () => {
    const sink = (open = await startSink({ rejectAt: { command: "RCPT", code: 550, text: "5.1.1 No such user" } }));
    const outcome = (await run(localSmtp(sink), "email_send", BASIC)) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(outcome.ok).toBe(false);
    /**
     * The assertion this package exists to make. A caller told "sent" stops trying, nobody is told, and the
     * message simply never arrives.
     */
    expect(outcome.error.message).toContain("NOT sent");
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.message).toMatch(/permanent/);
    expect(sink.messages).toHaveLength(0);
  });

  it("a 5xx at the terminating dot is a failure, not a success", async () => {
    // The nastiest case: everything succeeded until the very last reply. A client that stops checking after
    // DATA reports this as sent.
    const sink = (open = await startSink({ rejectAt: { command: "DATA-END", code: 554, text: "5.7.1 Message rejected as spam" } }));
    const outcome = (await run(localSmtp(sink), "email_send", BASIC)) as {
      ok: false;
      error: { message: string; retryable: boolean };
    };
    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).toContain("NOT sent");
    expect(outcome.error.message).toContain("5.7.1");
    expect(outcome.error.retryable).toBe(false);
  });

  it("a 4xx is transient and says so", async () => {
    const sink = (open = await startSink({ rejectAt: { command: "MAIL", code: 451, text: "4.7.1 Greylisted, try later" } }));
    const outcome = (await run(localSmtp(sink), "email_send", BASIC)) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    // Greylisting is *designed* around a real sender trying again. Reporting it as permanent throws away a
    // message that would have been delivered on the second attempt.
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.code).toBe("provider_unavailable");
    expect(outcome.error.message).toMatch(/temporary/);
  });

  it("attempts STARTTLS when the server offers it", async () => {
    /**
     * The sink cannot complete a TLS handshake, so the send fails — and the failure is not what is being
     * asserted. What matters is that the command was *issued*: opportunistic upgrade is the behaviour, and a
     * client that skipped it would send credentials in the clear against every server that offers encryption.
     */
    const sink = (open = await startSink({ capabilities: ["STARTTLS", "AUTH PLAIN"] }));
    await run(localSmtp(sink), "email_send", BASIC);
    expect(sink.commands).toContain("STARTTLS");
    expect(sink.messages).toHaveLength(0);
  });

  it("refuses to send in the clear when the server offers no STARTTLS", async () => {
    // A downgrade an attacker on the path can force by stripping the advertisement, not a fallback.
    const sink = (open = await startSink());
    const provider = smtpProvider({
      host: "127.0.0.1",
      port: sink.port,
      credentialRef: "smtp",
      resolver: basicResolver,
      timeoutMs: 5_000,
    });
    const outcome = (await run(provider, "email_send", BASIC)) as { ok: false; error: { message: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).toMatch(/STARTTLS/);
    expect(sink.messages).toHaveLength(0);
  });
});

describe("both providers, one shape — AC-1 and AC-7", () => {
  it("SMTP and the HTTP API produce the same result keys for the same input", async () => {
    const sink = (open = await startSink());
    const smtpOutcome = (await run(localSmtp(sink), "email_send", BASIC)) as {
      ok: true;
      data: Record<string, unknown>;
    };

    const captured: { url: string; body: string }[] = [];
    const stub = (async (url: string, init: { body?: string }) => {
      captured.push({ url: String(url), body: String(init.body ?? "") });
      return new Response(JSON.stringify({ id: "re_abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const http = httpProvider({
      name: "resend",
      credentialRef: "resend",
      resolver: bearerResolver,
      fetchImpl: stub,
    });
    const httpOutcome = (await run(http, "email_send", BASIC)) as { ok: true; data: Record<string, unknown> };

    expect(smtpOutcome.ok).toBe(true);
    expect(httpOutcome.ok).toBe(true);
    for (const key of SEND_RESULT_KEYS.filter((key) => key !== "messageId")) {
      expect(smtpOutcome.data, `smtp is missing ${key}`).toHaveProperty(key === "recipientsAccepted" ? "recipients" : key);
      expect(httpOutcome.data, `http is missing ${key}`).toHaveProperty(key === "recipientsAccepted" ? "recipients" : key);
    }
    expect(smtpOutcome.data.sent).toBe(true);
    expect(httpOutcome.data.sent).toBe(true);
    expect(httpOutcome.data.messageId).toBe("re_abc123");
    // The queue id the sink put in its reply, parsed back out.
    expect(smtpOutcome.data.messageId).toBe("ABC123");

    /**
     * The HTTP provider transmits the **composed MIME**, not structured fields.
     *
     * Sending `{to, subject, html}` would mean the provider composes the message, which makes the preview a
     * rehearsal of something nobody transmits — our MIME shown, theirs delivered.
     */
    const sentBody = JSON.parse(captured[0]!.body) as { raw: string };
    expect(Buffer.from(sentBody.raw, "base64").toString("utf8")).toContain("Subject: Nightly report");
  });

  it("an HTTP 4xx is permanent and a 429 is not", async () => {
    const responder = (status: number) =>
      (async () => new Response("nope", { status })) as unknown as typeof fetch;
    const at = async (status: number) => {
      const provider = httpProvider({
        name: "resend",
        credentialRef: "resend",
        resolver: bearerResolver,
        fetchImpl: responder(status),
      });
      return (await run(provider, "email_send", BASIC)) as { ok: false; error: { retryable: boolean; message: string } };
    };
    expect((await at(422)).error.retryable).toBe(false);
    expect((await at(422)).error.message).toContain("NOT sent");
    // A rate limit is the HTTP equivalent of greylisting: the server will take this message, just not yet.
    expect((await at(429)).error.retryable).toBe(true);
    expect((await at(503)).error.retryable).toBe(true);
  });
});

describe("capability differences are reported, not simulated — AC-8", () => {
  it("email_get_status under SMTP says it cannot answer", async () => {
    const sink = (open = await startSink());
    const outcome = (await run(localSmtp(sink), "email_get_status", { messageId: "ABC123" })) as {
      ok: true;
      data: { status: string; supported: boolean; reason: string };
    };
    expect(outcome.data.supported).toBe(false);
    /**
     * `unknown`, never `sent`. What actually happened is that a relay accepted the message and may have
     * bounced it thirty seconds later; a caller reading `sent` would believe delivery was confirmed.
     */
    expect(outcome.data.status).toBe("unknown");
    expect(outcome.data.reason).toMatch(/does not report delivery status/);
  });

  it("email_list_sent under SMTP distinguishes 'cannot answer' from 'nothing sent'", async () => {
    const sink = (open = await startSink());
    const outcome = (await run(localSmtp(sink), "email_list_sent", {})) as {
      ok: true;
      data: { messages: unknown[]; supported: boolean; reason: string };
    };
    expect(outcome.data.messages).toEqual([]);
    expect(outcome.data.supported).toBe(false);
    // An empty list without this reads as "nothing has been sent", which is a different and wrong answer.
    expect(outcome.data.reason).toMatch(/not an empty mailbox/);
  });

  it("the HTTP provider does answer, and maps an unrecognised state to unknown", async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ last_event: "delivered", created_at: "2026-08-30T09:00:00Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const provider = httpProvider({ name: "resend", credentialRef: "resend", resolver: bearerResolver, fetchImpl: stub });
    const outcome = (await run(provider, "email_get_status", { messageId: "re_abc" })) as {
      ok: true;
      data: { status: string; supported: boolean };
    };
    expect(outcome.data.supported).toBe(true);
    expect(outcome.data.status).toBe("delivered");
  });

  it("a send through SMTP warns that a bounce will not be visible", async () => {
    const sink = (open = await startSink());
    const outcome = (await run(localSmtp(sink), "email_send", BASIC)) as { ok: true; data: { note?: string } };
    expect(outcome.data.note).toMatch(/does not report what happened afterwards/);
  });
});

describe("credentials come from the resolver only — AC-9", () => {
  it("no source file reads the environment", () => {
    const dir = new URL("../", import.meta.url).pathname;
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(3);
    /**
     * Comments stripped first, so a *mention* is not read as a use.
     *
     * The same distinction `check:transport` draws, and it earned its keep immediately: this file's own header
     * explains what the check is for, and the first version of the check failed on that sentence.
     */
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const name of files) {
      const source = withoutComments(readFileSync(`${dir}${name}`, "utf8"));
      // An SMTP host configured from the environment is a toolkit that works where it was set up and nowhere
      // else — and, worse, one that might pick up a *different* deployment's relay.
      expect(source, `${name} reads the environment`).not.toContain("process.env");
    }
  });

  it("refuses a credential of the wrong scheme rather than sending unauthenticated", async () => {
    const sink = (open = await startSink());
    const provider = smtpProvider({
      host: "127.0.0.1",
      port: sink.port,
      requireTls: false,
      credentialRef: "smtp",
      // A bearer where SMTP needs a username and password.
      resolver: bearerResolver,
      timeoutMs: 5_000,
    });
    const outcome = (await run(provider, "email_send", BASIC)) as { ok: false; error: { code: string; message: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).toMatch(/must be a basic credential/);
    expect(sink.messages).toHaveLength(0);
  });

  it("resolves the credential per call, so a rotation takes effect without a restart", async () => {
    const sink = (open = await startSink());
    const resolve = vi.fn(async () => createCredential({ scheme: "basic", username: "u", password: "p" }));
    const provider = smtpProvider({
      host: "127.0.0.1",
      port: sink.port,
      requireTls: false,
      credentialRef: "smtp",
      resolver: { resolve },
      timeoutMs: 5_000,
    });
    await run(provider, "email_send", BASIC);
    await run(provider, "email_send", BASIC);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("addresses and configuration", () => {
  it("refuses something that is not an address, before connecting", async () => {
    const sink = (open = await startSink());
    const outcome = (await run(localSmtp(sink), "email_send", { ...BASIC, to: ["not-an-address"] })) as {
      ok: false;
      error: { code: string };
    };
    expect(outcome.error.code).toBe("invalid_input");
    expect(sink.commands).toHaveLength(0);
  });

  it("the From address is configuration and cannot be set by a caller", async () => {
    const sink = (open = await startSink());
    // SPF and DKIM align against `From`; a caller-supplied one is the fastest route to mail that lands in spam
    // — and a model that could choose it could send as anyone the domain permits.
    await run(localSmtp(sink), "email_send", { ...BASIC, from: "ceo@retinue.test" } as never);
    expect(sink.messages[0]).toContain(`From: ${FROM}`);
    expect(sink.messages[0]).not.toContain("ceo@retinue.test");
  });

  it("refuses an unknown include or exclude name", () => {
    expect(() =>
      createEmailToolkit({ provider: { name: "x" } as unknown as EmailProvider, from: FROM, exclude: ["email_sent"] }),
    ).toThrow(/does not have/);
  });
});
