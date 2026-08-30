/**
 * WhatsApp Business and Instagram — REQ-053 (#227), task #229.
 *
 * Three ACs carry the risk, and each is about refusing something *before* it reaches Meta:
 *
 * - AC-3: free text outside the 24-hour service window, refused locally with no request.
 * - AC-4: a template parameter count that does not match its definition.
 * - AC-5: a publish that failed after its container succeeded — which must never look retryable.
 */
import { readFileSync } from "node:fs";
import type { ConversationId } from "@retinue/agentkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  assertServiceWindow,
  createMetaToolkit,
  META_AUTH,
  META_TOOL_NAMES,
  metaErrorOf,
  SERVICE_WINDOW_MS,
  templateParameterCount,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const toolkit = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createMetaToolkit({
    credentialRef: "meta",
    resolver: createStaticCredentialResolver({ meta: "EAAG_test" }),
    phoneNumberId: "PN1",
    wabaId: "WABA1",
    instagramAccountId: "IG1",
    fetchImpl,
    now: () => NOW,
    ...extra,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown, extra: Record<string, unknown> = {}) => {
  const tools = await toolkit(fetchImpl, extra).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

const routes = (table: readonly (readonly [RegExp, unknown, number?])[]) => {
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    sent.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    for (const [pattern, payload, status] of table) {
      if (pattern.test(`${init?.method ?? "GET"} ${String(url)}`)) return jsonResponse(payload, status ?? 200);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

/** A template taking two body parameters. */
const TEMPLATE = {
  name: "order_update",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Hi {{1}}, your order {{2}} has shipped." }],
};

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...META_TOOL_NAMES]);
  });

  it("classifies the two public tools as publishing, per #228", async () => {
    /**
     * #228 decided publishing keeps `external-write` and the gated set is an exact list in `docs/23`. These
     * two are on it, so the category has to match or `check:effects` fails the build.
     */
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const name of ["instagram_publish_media", "instagram_reply_comment"]) {
      expect(byName.get(name), name).toMatchObject({
        category: "publishing",
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
    // WhatsApp sends are directed to one recipient, not broadcast — `communication`, deliberately.
    for (const name of ["whatsapp_send_template", "whatsapp_send_message", "whatsapp_send_media"]) {
      expect(byName.get(name), name).toMatchObject({ category: "communication", effect: "external-write", approvalPolicy: "always" });
    }
  });

  it("leaves mark_read ungated, because it changes nothing the recipient did not cause", async () => {
    // Requiring approval for a read receipt trains operators to approve everything, which is how a gate stops
    // meaning anything.
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const descriptor = tools.find((t) => t.descriptor.name === "whatsapp_mark_read")?.descriptor;
    expect(descriptor).toMatchObject({ effect: "internal-write", approvalPolicy: "never" });
  });

  it("offers only the surfaces that are configured", async () => {
    const noInstagram = await createMetaToolkit({
      credentialRef: "meta",
      resolver: createStaticCredentialResolver({ meta: "t" }),
      phoneNumberId: "PN1",
    }).listTools(context);
    expect(noInstagram.map((t) => t.descriptor.name).every((name) => name.startsWith("whatsapp_"))).toBe(true);

    const neither = await createMetaToolkit({
      credentialRef: "meta",
      resolver: createStaticCredentialResolver({ meta: "t" }),
    }).listTools(context);
    // No tools at all, rather than tools that always answer "not configured".
    expect(neither).toEqual([]);
  });

  it("declares OAuth only, because there is no Meta API key", () => {
    expect(META_AUTH).toEqual({ modes: ["oauth2"], schemes: ["bearer"] });
  });

  it("pins the Graph version, because Meta deprecates one a quarter", async () => {
    const { fetchImpl, sent } = routes([[/GET/, { data: [] }]]);
    await run("whatsapp_list_templates", fetchImpl, {});
    expect(sent[0]?.url).toContain("/v21.0/");
  });
});

describe("the 24-hour service window is checked locally — AC-3", () => {
  it("refuses free text with no evidence, naming the template tool, and makes no request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("whatsapp_send_message", fetchImpl, { to: "+1555", text: "hi" })) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_input");
    expect(result.error.message).toContain("whatsapp_send_template");
    // AC-3 names this assertion specifically: no request is made.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a closed window, saying how long ago the user wrote, and makes no request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stale = new Date(NOW - 30 * 3_600_000).toISOString();
    const result = (await run("whatsapp_send_message", fetchImpl, { to: "+1555", text: "hi", lastInboundAt: stale })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("30 hours ago");
    expect(result.error.message).toContain("whatsapp_send_template");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a message inside the window", async () => {
    const { fetchImpl } = routes([[/POST .*\/messages$/, { messages: [{ id: "wamid.1" }] }]]);
    const fresh = new Date(NOW - 3_600_000).toISOString();
    const result = (await run("whatsapp_send_message", fetchImpl, { to: "+1555", text: "hi", lastInboundAt: fresh })) as {
      ok: true;
      data: { messageId: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data.messageId).toBe("wamid.1");
  });

  it("applies the same rule to media, since the window is about the message not its type", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("whatsapp_send_media", fetchImpl, { to: "+1", kind: "image", url: "https://x.test/a.png" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("service window");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a future timestamp, which is not evidence of anything", () => {
    // Accepting it would make the check trivially bypassable.
    expect(() => assertServiceWindow(new Date(NOW + 3_600_000).toISOString(), NOW)).toThrow(/future/);
  });

  it("refuses a timestamp that is not a timestamp", () => {
    expect(() => assertServiceWindow("yesterday", NOW)).toThrow(/ISO timestamp/);
    expect(() => assertServiceWindow(42, NOW)).toThrow(/service window/);
  });

  it("uses Meta's own 24 hours, at the boundary", () => {
    expect(SERVICE_WINDOW_MS).toBe(86_400_000);
    expect(() => assertServiceWindow(new Date(NOW - SERVICE_WINDOW_MS + 1000).toISOString(), NOW)).not.toThrow();
    expect(() => assertServiceWindow(new Date(NOW - SERVICE_WINDOW_MS - 1000).toISOString(), NOW)).toThrow(/closed/);
  });

  it("still explains the window when Meta is the one that refused", async () => {
    // Meta's own error is a numeric code with no explanation, so a model would retry with different words —
    // which cannot ever work, because the words were never the problem.
    const { fetchImpl } = routes([[/POST/, { error: { code: 131047, message: "Re-engagement message" } }, 400]]);
    const fresh = new Date(NOW - 1000).toISOString();
    const result = (await run("whatsapp_send_message", fetchImpl, { to: "+1", text: "hi", lastInboundAt: fresh })) as {
      ok: false;
      error: { code: string; retryable: boolean; message: string };
    };
    expect(result.error).toMatchObject({ code: "invalid_input", retryable: false });
    expect(result.error.message).toContain("whatsapp_send_template");
  });
});

describe("template parameters are checked against the template — AC-4", () => {
  it("counts a template's body placeholders, ignoring repeats", () => {
    expect(templateParameterCount(TEMPLATE)).toBe(2);
    expect(templateParameterCount({ components: [{ type: "BODY", text: "{{1}} and {{1}} again" }] })).toBe(1);
    expect(templateParameterCount({ components: [{ type: "HEADER", text: "{{1}}" }] })).toBe(0);
    expect(templateParameterCount({})).toBe(0);
  });

  it("refuses the wrong parameter count, naming the number the template takes", async () => {
    /**
     * Meta's own error is `Parameter format does not match`, which names neither the count nor the template —
     * so a model retries with the same number of parameters.
     */
    const { fetchImpl, sent } = routes([[/GET .*message_templates/, { data: [TEMPLATE] }]]);
    const result = (await run("whatsapp_send_template", fetchImpl, {
      to: "+1",
      template: "order_update",
      parameters: ["Ana"],
    })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("takes 2 parameters and 1 was supplied");
    // Refused before the send.
    expect(sent.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("refuses a template that is not approved", async () => {
    const { fetchImpl } = routes([[/GET .*message_templates/, { data: [{ ...TEMPLATE, status: "PENDING" }] }]]);
    const result = (await run("whatsapp_send_template", fetchImpl, { to: "+1", template: "order_update", parameters: ["a", "b"] })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("PENDING, not APPROVED");
  });

  it("refuses a template that does not exist, and says how to find one", async () => {
    const { fetchImpl } = routes([[/GET .*message_templates/, { data: [] }]]);
    const result = (await run("whatsapp_send_template", fetchImpl, { to: "+1", template: "nope" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("whatsapp_list_templates");
  });

  it("sends with the parameters in order when the count matches", async () => {
    const { fetchImpl, sent } = routes([
      [/GET .*message_templates/, { data: [TEMPLATE] }],
      [/POST .*\/messages$/, { messages: [{ id: "wamid.2" }] }],
    ]);
    const result = (await run("whatsapp_send_template", fetchImpl, {
      to: "+1",
      template: "order_update",
      parameters: ["Ana", "A-17"],
    })) as { ok: true };
    expect(result.ok).toBe(true);
    const post = sent.find((call) => call.method === "POST");
    const components = (post?.body.template as { components: { parameters: { text: string }[] }[] }).components;
    expect(components[0]?.parameters.map((parameter) => parameter.text)).toEqual(["Ana", "A-17"]);
  });

  it("reports the parameter count each template takes, so a caller need not count placeholders", async () => {
    const { fetchImpl } = routes([[/GET .*message_templates/, { data: [TEMPLATE] }]]);
    const result = (await run("whatsapp_list_templates", fetchImpl, {})) as {
      data: { templates: { name: string; parameterCount: number }[] };
    };
    expect(result.data.templates[0]).toMatchObject({ name: "order_update", parameterCount: 2 });
  });
});

describe("a half-published post never looks retryable — AC-5", () => {
  it("reports which step failed and refuses to be retried", async () => {
    /**
     * The failure this exists for. The container succeeded, so retrying the tool creates a *second* container
     * and can publish the post twice — a duplicate public post under the operator's brand, which is exactly
     * the class of act #228 spent a whole issue reasoning about.
     */
    const { fetchImpl } = routes([
      [/POST .*\/media$/, { id: "container-1" }],
      [/POST .*\/media_publish$/, { error: { code: 9007, message: "Media not ready" } }, 400],
    ]);
    const result = (await run("instagram_publish_media", fetchImpl, { url: "https://x.test/a.jpg", caption: "hi" })) as {
      ok: false;
      error: { code: string; retryable: boolean; message: string; details?: { containerId?: string; step?: string } };
    };
    expect(result.ok).toBe(false);
    // The sabotage AC-5 asks for: the retryable classification must not apply here, whatever the underlying
    // failure was — and `9007` is a Meta code that would otherwise read as transient.
    expect(result.error.retryable).toBe(false);
    expect(result.error.code).toBe("conflict");
    expect(result.error.message).toContain("Do not retry");
    expect(result.error.message).toContain("container-1");
    expect(result.error.details).toMatchObject({ containerId: "container-1", step: "publish" });
  });

  it("stays retryable when the container itself failed, because nothing was created", async () => {
    // The one branch that *is* safely retryable — and without this test, a blanket `retryable: false` would
    // pass the test above while making a genuinely transient failure permanent.
    const { fetchImpl } = routes([[/POST .*\/media$/, { not_an_id: true }]]);
    const result = (await run("instagram_publish_media", fetchImpl, { url: "https://x.test/a.jpg" })) as {
      ok: false;
      error: { retryable: boolean; message: string };
    };
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain("nothing was created");
  });

  it("does not expose the container step as its own tool", async () => {
    // A half-published post is a state no caller wants to be handed.
    const names = (await toolkit(vi.fn() as unknown as typeof fetch).listTools(context)).map((t) => t.descriptor.name);
    expect(names).not.toContain("instagram_create_container");
    expect(names.filter((name) => name.startsWith("instagram_publish"))).toEqual(["instagram_publish_media"]);
  });

  it("publishes in two steps and reports both ids on success", async () => {
    const { fetchImpl, sent } = routes([
      [/POST .*\/media$/, { id: "container-2" }],
      [/POST .*\/media_publish$/, { id: "post-9" }],
    ]);
    const result = (await run("instagram_publish_media", fetchImpl, { url: "https://x.test/a.jpg", caption: "hi" })) as {
      ok: true;
      data: { id: string; containerId: string };
    };
    expect(result.data).toMatchObject({ id: "post-9", containerId: "container-2" });
    expect(sent.map((call) => call.url.split("/").pop())).toEqual(["media", "media_publish"]);
  });
});

describe("Meta's rate tiers and errors — AC-6", () => {
  it("honours Retry-After on a 429 rather than guessing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "47" })) as unknown as typeof fetch;
    const result = (await run("instagram_get_account", fetchImpl, {})) as {
      ok: false;
      error: { code: string; retryable: boolean; retryAfterMs?: number; message: string };
    };
    expect(result.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 47_000 });
    expect(result.error.message).toContain("47s");
  });

  it("accepts an HTTP-date Retry-After too", async () => {
    const when = new Date(Date.now() + 120_000).toUTCString();
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429, { "retry-after": when })) as unknown as typeof fetch;
    const result = (await run("instagram_get_account", fetchImpl, {})) as { ok: false; error: { retryAfterMs?: number } };
    expect(result.error.retryAfterMs).toBeGreaterThan(100_000);
    expect(result.error.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it("treats Meta's application rate-limit codes as rate limits, though they arrive as 400", async () => {
    // Codes 4, 17, 32 and 613 are rate limits that the default classification would call `provider_error`.
    for (const code of [4, 17, 32, 613]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: { code, message: "limit" } }, 400)) as unknown as typeof fetch;
      const result = (await run("instagram_get_account", fetchImpl, {})) as { ok: false; error: { code: string; retryable: boolean } };
      expect(result.error, String(code)).toMatchObject({ code: "rate_limited", retryable: true });
    }
  });

  it("maps an expired token to unauthorized and explains that Meta's tokens are short-lived", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 190, message: "Session expired" } }, 400)) as unknown as typeof fetch;
    const result = (await run("instagram_get_account", fetchImpl, {})) as { ok: false; error: { code: string; retryable: boolean; message: string } };
    expect(result.error).toMatchObject({ code: "unauthorized", retryable: false });
    expect(result.error.message).toContain("short-lived");
  });

  it("parses Meta's error envelope out of the transport's reason string", () => {
    expect(metaErrorOf('That URL returned 400: {"error":{"code":190,"error_subcode":460,"message":"x"}}')).toEqual({
      code: 190,
      subcode: 460,
      message: "x",
    });
    // Total: anything unparseable yields nothing rather than throwing inside a classifier.
    expect(metaErrorOf("no json here")).toEqual({});
    expect(metaErrorOf("returned 500: {broken")).toEqual({});
  });
});

describe("credentials come only from the resolver — AC-7", () => {
  it("reads no environment variable anywhere in the package source", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(`${here}../index.ts`, "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });

  it("resolves the credential on every call, not once at construction", async () => {
    let resolved = 0;
    const provider = createMetaToolkit({
      credentialRef: "meta",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "bearer", token: `t${resolved}` };
        },
      },
      instagramAccountId: "IG1",
      fetchImpl: vi.fn(async () => jsonResponse({ id: "IG1" })) as unknown as typeof fetch,
    });
    const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === "instagram_get_account");
    await tool?.execute({ context, input: {} });
    await tool?.execute({ context, input: {} });
    expect(resolved).toBe(2);
  });
});
