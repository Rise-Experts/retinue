/**
 * The Confluence toolkit — REQ-052 (#224), task #225.
 *
 * The decision this package exists to get right is that an update carries the version it believes it is
 * editing (AC-4). The tempting shortcut — reading the current version inside the update — always succeeds and
 * silently overwrites whatever a person changed in between, so the tests below assert the *absence* of that
 * fallback as carefully as they assert the conflict.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  CONFLUENCE_AUTH,
  CONFLUENCE_TOOL_NAMES,
  createConfluenceToolkit,
  markdownToStorage,
  storageToMarkdown,
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

const toolkit = (fetchImpl: typeof fetch) =>
  createConfluenceToolkit({
    credentialRef: "atlassian",
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

const bodyOf = (fetchImpl: typeof fetch, call = 0): Record<string, unknown> =>
  JSON.parse(
    (fetchImpl as unknown as { mock: { calls: [unknown, { body?: string }][] } }).mock.calls[call]?.[1]?.body ?? "{}",
  ) as Record<string, unknown>;

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...CONFLUENCE_TOOL_NAMES]);
  });

  it("gates every write and leaves every read ungated", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const read of ["confluence_search", "confluence_get_page", "confluence_list_spaces"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    for (const write of ["confluence_create_page", "confluence_update_page", "confluence_comment"]) {
      expect(byName.get(write), write).toMatchObject({
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
  });

  it("shares Jira's auth shape, which is why the two ship together", () => {
    // One Atlassian account email plus one API token authenticates both, against the same site host.
    expect(CONFLUENCE_AUTH).toEqual({ modes: ["token"], schemes: ["basic"] });
  });

  it("classifies its tools as knowledge, not project", async () => {
    // A tenant switching off `project` should keep its wiki. Categories are the lever per-tenant toolsets use.
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    for (const tool of tools) expect(tool.descriptor.category, tool.descriptor.name).toBe("knowledge");
  });
});

describe("an update cannot overwrite an edit it never saw — AC-4", () => {
  it("returns a non-retryable conflict on a stale version, and the page is not modified", async () => {
    /**
     * The whole point. Confluence answers `409` when the version supplied is not the page's current version,
     * which is what happens when a person edited the page after the agent read it.
     *
     * Non-retryable because the runtime's retry replays the identical call — same stale version, same conflict.
     * The message has to say that re-reading is the fix, because "conflict" alone does not.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ status: 409, title: "Version must be incremented" }] }, 409),
    ) as unknown as typeof fetch;
    const result = (await run("confluence_update_page", fetchImpl, {
      id: "123",
      title: "T",
      body: "new text",
      version: 4,
    })) as { ok: false; error: { code: string; retryable: boolean; message: string } };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("conflict");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("confluence_get_page");

    // "The page was not modified": exactly one request was made, it was the PUT that Confluence rejected, and
    // nothing followed it — no retry, no read-then-force, no second attempt with a different version.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = (fetchImpl as unknown as { mock: { calls: [unknown, { method?: string }][] } }).mock.calls;
    expect(calls[0]?.[1]?.method).toBe("PUT");
  });

  it("never looks the version up itself, which is the fallback that would cause the overwrite", async () => {
    // If this tool read the current version, it would always succeed — and quietly discard whatever changed
    // since the page was read. So a missing version is refused *before the network*, not filled in.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const version of [undefined, null, "4", 0, -1, 1.5, Number.NaN]) {
      const result = (await run("confluence_update_page", fetchImpl, { id: "123", title: "T", body: "b", version })) as {
        ok: false;
        error: { code: string; message: string };
      };
      expect(result.ok, JSON.stringify(version)).toBe(false);
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message).toContain("confluence_get_page");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the next version number, not the one being replaced", async () => {
    /**
     * The off-by-one that reads as somebody else editing.
     *
     * v2 wants the version being *created*. Sending the current number is refused as a conflict, which looks
     * exactly like a concurrent edit and sends whoever is debugging it to the wrong place entirely.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "123", title: "T", version: { number: 5 }, _links: { webui: "/x" } }),
    ) as unknown as typeof fetch;
    const result = (await run("confluence_update_page", fetchImpl, { id: "123", title: "T", body: "b", version: 4 })) as {
      ok: true;
      data: { version: number };
    };
    expect(result.ok).toBe(true);
    expect((bodyOf(fetchImpl).version as { number: number }).number).toBe(5);
    expect(result.data.version).toBe(5);
  });

  it("returns the version from a read, at the top level where a model will find it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "123",
        title: "A page",
        spaceId: "9",
        version: { number: 4 },
        body: { storage: { value: "<p>Hello</p>" } },
        _links: { webui: "/wiki/x" },
      }),
    ) as unknown as typeof fetch;
    const result = (await run("confluence_get_page", fetchImpl, { id: "123" })) as {
      data: { version: number; body: string };
    };
    // The version is an *input* to the next call, so it is returned flat rather than nested in a shape a model
    // has to learn.
    expect(result.data.version).toBe(4);
    expect(result.data.body).toBe("Hello");
  });
});

describe("storage format converts both ways and never throws — AC-5", () => {
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
      expect(storageToMarkdown(markdownToStorage(markdown))).toBe(markdown);
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
    expect(storageToMarkdown(markdownToStorage(markdown))).toBe(markdown);
  });

  it("keeps code verbatim, including markup that would otherwise be stripped", () => {
    /**
     * Why code macros are held aside before anything else is converted. A code sample containing `<div>` and
     * `&amp;` is the one content nobody can tolerate being altered, and a single pass over the whole document
     * would strip the tag and unescape the entity.
     */
    const markdown = "```html\n<div class=\"a\">&amp; b</div>\n```";
    const storage = markdownToStorage(markdown);
    expect(storage).toContain("<![CDATA[");
    expect(storageToMarkdown(storage)).toBe(markdown);
  });

  it("splits a CDATA terminator in code rather than closing the section early", () => {
    // `]]>` inside code would end the CDATA section and turn the rest of the page into markup.
    const storage = markdownToStorage("```\na ]]> b\n```");
    expect(storage).toContain("]]]]><![CDATA[>");
    expect(storageToMarkdown(storage)).toBe("```\na ]]> b\n```");
  });

  it("degrades an unknown macro to its text rather than throwing", () => {
    const page =
      '<p>Before</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ENG-1</ac:parameter></ac:structured-macro><p>After</p>';
    const markdown = storageToMarkdown(page);
    expect(markdown).toContain("Before");
    expect(markdown).toContain("After");
    expect(markdown).not.toContain("ac:structured-macro");
  });

  it("says a person was mentioned even though the name is resolved at render time", () => {
    // `<ri:user>` carries only an account id. Emitting nothing would silently drop the fact that somebody was
    // named, which changes what the page means.
    const page = '<p>ping <ac:link><ri:user ri:account-id="abc" /></ac:link></p>';
    expect(storageToMarkdown(page)).toBe("ping @mention");
  });

  it("decodes entities without turning &amp;lt; into a tag", () => {
    // `&amp;` must be decoded last, or `&amp;lt;` becomes `<` and the text changes meaning.
    expect(storageToMarkdown("<p>a &amp;lt; b</p>")).toBe("a &lt; b");
    expect(storageToMarkdown("<p>a &lt; b &amp; c</p>")).toBe("a < b & c");
  });

  it("does not throw on anything, including shapes that are not pages", () => {
    for (const input of [null, undefined, 0, "", [], {}, "<p>unclosed", "<ul><li>x"]) {
      expect(() => storageToMarkdown(input)).not.toThrow();
    }
  });

  it("sends markdown as storage format on the wire, not as markdown", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "1", title: "T", version: { number: 1 } })) as unknown as typeof fetch;
    await run("confluence_create_page", fetchImpl, { spaceId: "9", title: "T", body: "# Hi\n\n- a" });
    const body = bodyOf(fetchImpl).body as { representation: string; value: string };
    expect(body.representation).toBe("storage");
    expect(body.value).toContain("<h1>Hi</h1>");
    expect(body.value).toContain("<ul>");
    expect(body.value).not.toContain("# Hi");
  });
});

describe("reads and failures stay actionable — AC-6", () => {
  it("strips markup out of a search excerpt", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          { content: { id: "1", title: "A", type: "page" }, excerpt: "the <b>retry</b> budget", resultGlobalContainer: { title: "ENG" } },
        ],
        totalSize: 1,
      }),
    ) as unknown as typeof fetch;
    const result = (await run("confluence_search", fetchImpl, { cql: 'text ~ "retry"' })) as {
      data: { results: { excerpt: string; space: string }[] };
    };
    expect(result.data.results[0]?.excerpt).toBe("the retry budget");
    expect(result.data.results[0]?.space).toBe("ENG");
  });

  it("reports truncation from the count CQL matched, not the page returned", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ content: { id: "1" } }], totalSize: 40 })) as unknown as typeof fetch;
    const result = (await run("confluence_search", fetchImpl, { cql: "x" })) as { data: { truncated: boolean } };
    expect(result.data.truncated).toBe(true);
  });

  it("reports truncation for spaces from the cursor link, which is v2's only honest signal", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: [{ id: "1", key: "ENG", name: "Eng" }], _links: { next: "/wiki/api/v2/spaces?cursor=x" } }),
    ) as unknown as typeof fetch;
    const result = (await run("confluence_list_spaces", fetchImpl, {})) as { data: { truncated: boolean } };
    expect(result.data.truncated).toBe(true);
  });

  it("classifies 429, 401 and an unreachable host the way the runtime expects", async () => {
    const cases: readonly [number | "down", string, boolean][] = [
      [429, "rate_limited", true],
      [401, "unauthorized", false],
      [403, "unauthorized", false],
      ["down", "provider_unavailable", true],
    ];
    for (const [status, code, retryable] of cases) {
      const fetchImpl = (
        status === "down"
          ? vi.fn(async () => {
              throw new TypeError("fetch failed");
            })
          : vi.fn(async () => jsonResponse({ message: "x" }, status))
      ) as unknown as typeof fetch;
      const result = (await run("confluence_get_page", fetchImpl, { id: "1" })) as { ok: false; error: { code: string; retryable: boolean } };
      expect(result.error, String(status)).toMatchObject({ code, retryable });
    }
  });

  it("says a 404 may be permission rather than absence", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "x" }, 404)) as unknown as typeof fetch;
    const result = (await run("confluence_get_page", fetchImpl, { id: "1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("cannot see it");
  });
});

describe("credentials come only from the resolver — AC-7", () => {
  it("reads no environment variable anywhere in the package source", () => {
    // The failure mode is a *convenience* somebody adds later: `process.env.CONFLUENCE_TOKEN ?? ref` works
    // perfectly for one tenant and is copied into twenty packages before a second customer appears.
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["index.ts", "storage.ts"]) {
      const source = readFileSync(`${here}../${file}`, "utf8");
      expect(source, file).not.toMatch(/process\s*\.\s*env/);
      expect(source, file).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
    }
  });

  it("resolves the credential on every call, not once at construction", async () => {
    let resolved = 0;
    const provider = createConfluenceToolkit({
      credentialRef: "atlassian",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "basic", username: "a@b.c", password: `tok${resolved}` };
        },
      },
      siteUrl: "https://acme.atlassian.net",
      fetchImpl: vi.fn(async () => jsonResponse({ id: "1" })) as unknown as typeof fetch,
    });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "confluence_get_page");
    await tool?.execute({ context, input: { id: "1" } });
    await tool?.execute({ context, input: { id: "2" } });
    expect(resolved).toBe(2);
  });
});
