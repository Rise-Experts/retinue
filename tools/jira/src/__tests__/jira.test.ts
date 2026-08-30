/**
 * The Jira toolkit — REQ-052 (#224), task #225.
 *
 * The two things worth testing hard are the two decisions this package makes rather than inherits: that a
 * transition is not an update and takes an id with **no fuzzy fallback** (AC-3), and that ADF conversion is
 * total — lossy where it must be, never throwing (AC-5).
 */
import { readFileSync } from "node:fs";
import type { ConversationId } from "@retinue/agentkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import { adfToMarkdown, createJiraToolkit, JIRA_AUTH, JIRA_TOOL_NAMES, markdownToAdf } from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId<ConversationId>("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolkit = (fetchImpl: typeof fetch) =>
  createJiraToolkit({
    credentialRef: "atlassian",
    // Basic, not bearer: an account email plus an API token. `credentialHeader` builds the base64.
    resolver: createStaticCredentialResolver({ atlassian: { scheme: "basic", username: "a@b.c", password: "tok" } }),
    siteUrl: "https://acme.atlassian.net",
    fetchImpl,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...JIRA_TOOL_NAMES]);
  });

  it("gates every write and leaves every read ungated", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const read of ["jira_search_issues", "jira_get_issue", "jira_list_projects", "jira_list_transitions"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    for (const write of ["jira_create_issue", "jira_update_issue", "jira_transition_issue", "jira_comment"]) {
      // #228: the effect *derives* the other two, so this proves nothing was overridden.
      expect(byName.get(write), write).toMatchObject({
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
  });

  it("declares Basic auth, because Atlassian is not a bearer API", async () => {
    // `schemes` and `modes` are separate axes for exactly this: the wire format is Basic and the way a tenant
    // gets a token is a manual visit to their account page.
    expect(JIRA_AUTH).toEqual({ modes: ["token"], schemes: ["basic"] });
  });

  it("sends the resolved credential as a Basic header to the site host only", async () => {
    let seen: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ issues: [], total: 0 });
    }) as unknown as typeof fetch;
    await run("jira_search_issues", fetchImpl, { jql: "project = ENG" });
    expect(seen?.get("authorization")).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
  });
});

describe("a transition is not an update — AC-3", () => {
  it("refuses a status name and names jira_list_transitions", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("jira_transition_issue", fetchImpl, { key: "ENG-1", transitionId: "Done" })) as {
      ok: false;
      error: { message: string; code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("jira_list_transitions");
    expect(result.error.code).toBe("invalid_input");
    // Refused before the network, so a wrong guess cannot have moved anything.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to a fuzzy match — the sabotage AC-3 asks for", async () => {
    /**
     * The failure a fuzzy match would cause is that it *succeeds*. "Done" is a status in most workflows and a
     * transition in some, the two vocabularies do not correspond, and a wrong guess moves the issue somewhere
     * nobody asked for while reporting success.
     *
     * So this asserts the negative directly: even when the transition list is available and contains an
     * obvious match, nothing is called and nothing is guessed.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] }),
    ) as unknown as typeof fetch;
    for (const guess of ["Done", "done", "In Progress", "id-31", "31a", ""]) {
      const result = (await run("jira_transition_issue", fetchImpl, { key: "ENG-1", transitionId: guess })) as {
        ok: false;
        error: { message: string };
      };
      expect(result.ok, JSON.stringify(guess)).toBe(false);
      expect(result.error.message).toContain("not a transition id");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("trims whitespace around an id, which is normalisation and not a guess", async () => {
    // `"31 "` unambiguously means transition 31. Refusing it would be pedantry; the line this must not cross is
    // interpreting a *name*, and whitespace is not a name.
    const fetchImpl = vi.fn(async (_url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "POST" ? new Response(null, { status: 204 }) : jsonResponse({ fields: { status: { name: "Done" } } }),
    ) as unknown as typeof fetch;
    const result = (await run("jira_transition_issue", fetchImpl, { key: "ENG-1", transitionId: " 31 " })) as {
      ok: true;
      data: { transitionId: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data.transitionId).toBe("31");
  });

  it("accepts a numeric id and reports the status it actually landed in", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if ((init?.method ?? "GET") === "POST") return new Response(null, { status: 204 });
      return jsonResponse({ fields: { status: { name: "In Review", statusCategory: { name: "In Progress" } } } });
    }) as unknown as typeof fetch;
    const result = (await run("jira_transition_issue", fetchImpl, { key: "ENG-1", transitionId: "31" })) as {
      ok: true;
      data: { status: string; statusCategory: string };
    };
    expect(result.ok).toBe(true);
    // Read back rather than assumed: a transition can carry a post-function that lands somewhere else, and
    // echoing the requested id as the outcome would hide that.
    expect(result.data.status).toBe("In Review");
    expect(result.data.statusCategory).toBe("In Progress");
    expect(calls[0]).toContain("POST");
    expect(calls[1]).toContain("fields=status");
  });

  it("survives a 204 with no body, which is what a transition returns", async () => {
    // The `JSON.parse("")` bug from #223, now the transport's problem rather than each toolkit's.
    const fetchImpl = vi.fn(async (_url: unknown, init?: { method?: string }) =>
      (init?.method ?? "GET") === "POST" ? new Response(null, { status: 204 }) : jsonResponse({ fields: { status: {} } }),
    ) as unknown as typeof fetch;
    const result = (await run("jira_transition_issue", fetchImpl, { key: "ENG-1", transitionId: "31" })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("keeps status out of jira_update_issue entirely", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const result = (await run("jira_update_issue", fetchImpl, { key: "ENG-1", summary: "new" })) as {
      ok: true;
      data: { changed: string[] };
    };
    expect(result.data.changed).toEqual(["summary"]);
    const sent = JSON.parse(((fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0]?.[1].body) ?? "{}");
    expect(Object.keys(sent.fields)).toEqual(["summary"]);
    expect(JSON.stringify(sent)).not.toContain("status");
  });

  it("refuses an update with nothing to change instead of succeeding at nothing", async () => {
    // An empty PUT succeeds at Jira and changes nothing, so the model is told the update worked.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("jira_update_issue", fetchImpl, { key: "ENG-1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("nothing to change");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distinguishes unassigning from not supplying an assignee", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await run("jira_update_issue", fetchImpl, { key: "ENG-1", assigneeAccountId: null });
    const sent = JSON.parse(((fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0]?.[1].body) ?? "{}");
    // `null` unassigns, which is a real thing somebody means.
    expect(sent.fields.assignee).toBeNull();
  });
});

describe("ADF converts both ways and never throws — AC-5", () => {
  const cases: readonly [string, string][] = [
    ["a paragraph", "Hello there"],
    ["a heading", "## A heading"],
    ["bold and italic", "This is **bold** and _italic_"],
    ["inline code", "Call `retry()` twice"],
    ["a link", "See [the docs](https://example.com/x)"],
    ["a bullet list", "- one\n- two"],
    ["an ordered list", "1. first\n2. second"],
    ["a code block", "```ts\nconst x = 1;\n```"],
    ["a rule", "---"],
  ];

  for (const [what, markdown] of cases) {
    it(`round-trips ${what}`, () => {
      expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
    });
  }

  it("round-trips a document with several kinds of block at once", () => {
    const markdown = [
      "# Title",
      "",
      "A paragraph with **bold**, _italic_ and `code`.",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "return 1;",
      "```",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });

  it("degrades an unknown node to its text rather than throwing", () => {
    /**
     * The degradation rule. A panel's text is two levels down — inside a paragraph inside the panel — so a
     * shallow `.text` read would return nothing for the most common case, which is why this recurses.
     */
    const withPanel = {
      type: "doc",
      version: 1,
      content: [
        { type: "panel", attrs: { panelType: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Careful" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    };
    expect(adfToMarkdown(withPanel)).toBe("Careful\n\nAfter");
  });

  it("degrades an unknown mark to unmarked text", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "textColor", attrs: { color: "#ff0000" } }] }] }],
    };
    expect(adfToMarkdown(doc)).toBe("x");
  });

  it("keeps a mention's text rather than dropping that somebody was named", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "ping " }, { type: "mention", attrs: { id: "abc", text: "@Ana" } }] }],
    };
    expect(adfToMarkdown(doc)).toBe("ping @Ana");
  });

  it("does not throw on anything, including shapes that are not documents", () => {
    for (const input of [null, undefined, 0, "", "plain text", [], {}, { type: "doc" }, { content: null }]) {
      expect(() => adfToMarkdown(input)).not.toThrow();
    }
    // Some older Jira fields answer in plain text rather than ADF, and returning it is better than "".
    expect(adfToMarkdown("plain text")).toBe("plain text");
  });

  it("does not escape the inside of a code block", () => {
    // Escaping a code block's content would corrupt the code, which is the one content nobody can tolerate
    // being altered.
    const doc = markdownToAdf("```\na * b _c_ [d]\n```");
    const code = (doc.content[0]?.content ?? [])[0];
    expect(code?.text).toBe("a * b _c_ [d]");
    expect(adfToMarkdown(doc)).toBe("```\na * b _c_ [d]\n```");
  });

  it("handles bold containing an underscore, which a replacement chain gets wrong", () => {
    // The reason `parseInline` is one pass with one alternation: a chain of replacements would see the `_`
    // inside markup the first pass already consumed.
    const doc = markdownToAdf("**snake_case**");
    const text = (doc.content[0]?.content ?? [])[0];
    expect(text?.text).toBe("snake_case");
    expect(text?.marks?.[0]?.type).toBe("strong");
  });

  it("sends markdown as ADF on the wire, not as a string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: "ENG-9", id: "1" })) as unknown as typeof fetch;
    await run("jira_create_issue", fetchImpl, { project: "ENG", type: "Task", summary: "s", description: "# Hi" });
    const sent = JSON.parse(((fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0]?.[1].body) ?? "{}");
    expect(sent.fields.description).toMatchObject({ type: "doc", version: 1 });
    expect(sent.fields.description.content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
  });

  it("clears a description with an empty document rather than null", async () => {
    // Jira rejects `null` on some field configurations; an empty doc is accepted everywhere.
    const fetchImpl = vi.fn(async () => jsonResponse({ key: "ENG-9", id: "1" })) as unknown as typeof fetch;
    await run("jira_create_issue", fetchImpl, { project: "ENG", type: "Task", summary: "s" });
    const sent = JSON.parse(((fetchImpl as unknown as { mock: { calls: [unknown, { body: string }][] } }).mock.calls[0]?.[1].body) ?? "{}");
    expect(sent.fields.description).toEqual({ type: "doc", version: 1, content: [] });
  });
});

describe("reads render what a model needs", () => {
  it("turns an issue's ADF description and comments into markdown", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        key: "ENG-1",
        fields: {
          summary: "A bug",
          description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "It fails" }] }] },
          status: { name: "In Progress", statusCategory: { name: "In Progress" } },
          issuetype: { name: "Bug" },
          assignee: { displayName: "Ana" },
          labels: ["retry"],
          project: { key: "ENG" },
          comment: {
            comments: [
              { author: { displayName: "Bo" }, created: "2026-01-01", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Seen it" }] }] } },
            ],
          },
        },
      }),
    ) as unknown as typeof fetch;
    const result = (await run("jira_get_issue", fetchImpl, { key: "ENG-1" })) as {
      data: { description: string; status: string; statusCategory: string; comments: { body: string }[] };
    };
    expect(result.data.description).toBe("It fails");
    expect(result.data.comments[0]?.body).toBe("Seen it");
    // `statusCategory` is what tells a model whether "In Review" counts as done.
    expect(result.data.statusCategory).toBe("In Progress");
  });

  it("posts JQL rather than putting it in a query string", async () => {
    // A JQL string with quotes and spaces in a query parameter is the single most common way this call fails.
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [], total: 0, isLast: true })) as unknown as typeof fetch;
    await run("jira_search_issues", fetchImpl, { jql: 'project = ENG AND summary ~ "a b"' });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, { method: string; body: string }][] } }).mock.calls[0] ?? [];
    expect(String(url)).not.toContain("jql=");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body ?? "{}").jql).toBe('project = ENG AND summary ~ "a b"');
  });

  it("reports truncation rather than implying it saw everything", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [{ key: "A", fields: {} }], total: 90, isLast: false })) as unknown as typeof fetch;
    const result = (await run("jira_search_issues", fetchImpl, { jql: "x" })) as { data: { truncated: boolean } };
    expect(result.data.truncated).toBe(true);
  });

  it("gives each transition the status it lands in, which is often not its own name", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ transitions: [{ id: "21", name: "Start work", to: { name: "In Progress", statusCategory: { name: "In Progress" } } }] }),
    ) as unknown as typeof fetch;
    const result = (await run("jira_list_transitions", fetchImpl, { key: "ENG-1" })) as {
      data: { transitions: { id: string; name: string; to: string }[] };
    };
    // "move it to In Progress" is about `to`, not `name`.
    expect(result.data.transitions[0]).toMatchObject({ id: "21", name: "Start work", to: "In Progress" });
  });
});

describe("failures stay actionable — AC-6", () => {
  const failing = (status: number, body: unknown = { errorMessages: ["nope"] }) =>
    vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch;

  it("classifies 429 as a retryable rate limit", async () => {
    const result = (await run("jira_get_issue", failing(429), { key: "ENG-1" })) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("classifies 401 and 403 as unauthorized and not retryable", async () => {
    for (const status of [401, 403]) {
      const result = (await run("jira_get_issue", failing(status), { key: "ENG-1" })) as { ok: false; error: { code: string; retryable: boolean } };
      expect(result.error, String(status)).toMatchObject({ code: "unauthorized", retryable: false });
    }
  });

  it("says a 404 may be permission rather than absence", async () => {
    // Jira answers 404 identically for "does not exist" and "you cannot see it", so reporting "not found"
    // sends a model looking for a different key when the real problem is a scope.
    const result = (await run("jira_get_issue", failing(404), { key: "ENG-1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("cannot see it");
  });

  it("classifies an edit conflict as conflict and tells the model to re-read", async () => {
    const result = (await run("jira_update_issue", failing(409), { key: "ENG-1", summary: "x" })) as {
      ok: false;
      error: { code: string; retryable: boolean; message: string };
    };
    // Non-retryable because the runtime replays the identical call, which would conflict again.
    expect(result.error).toMatchObject({ code: "conflict", retryable: false });
    expect(result.error.message).toContain("Re-read");
  });

  it("classifies an unreachable host as provider_unavailable and retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = (await run("jira_get_issue", fetchImpl, { key: "ENG-1" })) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error).toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});

describe("credentials come only from the resolver — AC-7", () => {
  it("reads no environment variable anywhere in the package source", () => {
    /**
     * A source-level assertion rather than a behavioural one, because the failure mode is a *convenience*
     * somebody adds later: `process.env.JIRA_TOKEN ?? config.credentialRef` works perfectly for one tenant and
     * is copied into twenty packages before anybody notices a second customer needs a second token.
     *
     * `import.meta.env` too — the same shortcut in a bundler's clothing.
     */
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["index.ts", "adf.ts"]) {
      const source = readFileSync(`${here}../${file}`, "utf8");
      expect(source, file).not.toMatch(/process\s*\.\s*env/);
      expect(source, file).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
    }
  });

  it("resolves the credential on every call, not once at construction", async () => {
    // A credential read once at startup is one that survives its own rotation, and the failure looks like the
    // vendor rejecting a token that "has not changed".
    let resolved = 0;
    const provider = createJiraToolkit({
      credentialRef: "atlassian",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "basic", username: "a@b.c", password: `tok${resolved}` };
        },
      },
      siteUrl: "https://acme.atlassian.net",
      fetchImpl: vi.fn(async () => jsonResponse({ fields: {} })) as unknown as typeof fetch,
    });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "jira_get_issue");
    await tool?.execute({ context, input: { key: "ENG-1" } });
    await tool?.execute({ context, input: { key: "ENG-2" } });
    expect(resolved).toBe(2);
  });
});
