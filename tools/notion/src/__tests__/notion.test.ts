/**
 * The Notion toolkit — REQ-052 (#224), task #226.
 *
 * Three ACs carry the risk, and all three are about Notion telling you something misleading:
 *
 * - AC-4: it accepts an unknown property, changes nothing, and reports success.
 * - AC-5: an empty search cannot be distinguished from an unshared integration.
 * - AC-6: a page is a block tree, and walking it unbounded hangs.
 */
import { readFileSync } from "node:fs";
import type { ConversationId } from "@retinue/agentkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  createNotionToolkit,
  flattenBlocks,
  markdownToBlocks,
  NOTION_TOOL_NAMES,
  richTextToMarkdown,
  type Block,
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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolkit = (fetchImpl: typeof fetch) =>
  createNotionToolkit({
    credentialRef: "notion",
    resolver: createStaticCredentialResolver({ notion: "secret_test" }),
    fetchImpl,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

/** Answers by URL and method, so a test states only what it cares about. */
const routes = (table: readonly (readonly [RegExp, unknown])[]) => {
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
    });
    for (const [pattern, payload] of table) {
      if (pattern.test(`${init?.method ?? "GET"} ${String(url)}`)) return jsonResponse(payload);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

const SCHEMA = {
  properties: {
    Name: { type: "title" },
    Status: { type: "select" },
    Estimate: { type: "number" },
  },
};

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...NOTION_TOOL_NAMES]);
  });

  it("gates every write and leaves every read ungated", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const read of ["notion_search", "notion_get_page", "notion_query_database"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    for (const write of ["notion_create_page", "notion_update_page", "notion_append_blocks", "notion_comment"]) {
      expect(byName.get(write), write).toMatchObject({
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
  });

  it("pins the API version, because Notion versions by header", async () => {
    let seen: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ results: [{ id: "p1" }] });
    }) as unknown as typeof fetch;
    await run("notion_search", fetchImpl, {});
    // An unpinned client breaks on Notion's schedule rather than ours.
    expect(seen?.get("notion-version")).toBe("2022-06-28");
    expect(seen?.get("authorization")).toBe("Bearer secret_test");
  });
});

describe("an unknown property is refused before the call — AC-4", () => {
  it("names the properties that exist when one does not", async () => {
    /**
     * The defect this prevents is the worst kind: Notion returns `200`, changes nothing, and reports success.
     * Without this check a typo reaches the model as a completed edit.
     */
    const { fetchImpl, sent } = routes([
      [/GET .*\/v1\/databases\/db1$/, SCHEMA],
    ]);
    const result = (await run("notion_create_page", fetchImpl, {
      databaseId: "db1",
      properties: { Name: { title: [] }, Staus: { select: { name: "Done" } } },
    })) as { ok: false; error: { message: string } };

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('"Staus"');
    expect(result.error.message).toContain("Name, Status, Estimate");
    expect(result.error.message).toContain("report success");
    // Refused before the write: only the schema was fetched.
    expect(sent.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("refuses a create with no value for the database's title property", async () => {
    const { fetchImpl } = routes([[/GET .*\/v1\/databases\/db1$/, SCHEMA]]);
    const result = (await run("notion_create_page", fetchImpl, { databaseId: "db1", properties: { Status: { select: { name: "Done" } } } })) as {
      ok: false;
      error: { message: string };
    };
    // A page created without it is untitled and effectively unfindable.
    expect(result.error.message).toContain('title property is "Name"');
  });

  it("accepts a plain title and puts it in whichever property is the title one", async () => {
    // A database's title property is never actually called "title" — it is "Name", or whatever it was renamed
    // to — so a caller cannot be expected to know its name.
    const { fetchImpl, sent } = routes([
      [/GET .*\/v1\/databases\/db1$/, SCHEMA],
      [/POST .*\/v1\/pages$/, { id: "p9", properties: { Name: { type: "title", title: [{ plain_text: "Hi" }] } } }],
    ]);
    const result = (await run("notion_create_page", fetchImpl, { databaseId: "db1", title: "Hi" })) as { ok: true; data: { title: string } };
    expect(result.ok).toBe(true);
    const posted = sent.find((call) => call.method === "POST");
    expect((posted?.body.properties as Record<string, unknown>).Name).toBeDefined();
    expect(result.data.title).toBe("Hi");
  });

  it("validates an update's properties against the parent database", async () => {
    const { fetchImpl, sent } = routes([
      [/GET .*\/v1\/pages\/p1$/, { id: "p1", parent: { type: "database_id", database_id: "db1" } }],
      [/GET .*\/v1\/databases\/db1$/, SCHEMA],
    ]);
    const result = (await run("notion_update_page", fetchImpl, { id: "p1", properties: { Estimat: { number: 3 } } })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain('"Estimat"');
    expect(sent.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("skips validation for a page whose parent is a page, since there is no schema", async () => {
    // A page under a page has exactly one property and no schema, so a check there would silently do nothing
    // for half its inputs — worse than saying it does not apply.
    const { fetchImpl, sent } = routes([
      [/GET .*\/v1\/pages\/p1$/, { id: "p1", parent: { type: "page_id", page_id: "parent" } }],
      [/PATCH .*\/v1\/pages\/p1$/, { id: "p1" }],
    ]);
    const result = (await run("notion_update_page", fetchImpl, { id: "p1", properties: { title: { title: [] } } })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(sent.some((call) => call.url.includes("/databases/"))).toBe(false);
  });

  it("refuses a create that names both a parent page and a database", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("notion_create_page", fetchImpl, { parentPageId: "p", databaseId: "d", title: "x" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("exactly one");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("an empty result says whether anything is shared — AC-5", () => {
  it("explains that nothing may be shared with the integration", async () => {
    /**
     * The two cases are indistinguishable from the API, and reporting "no results" sends people to rewrite a
     * query when the fix is three clicks in Notion's UI.
     */
    const { fetchImpl } = routes([[/POST .*\/v1\/search$/, { results: [] }]]);
    const result = (await run("notion_search", fetchImpl, { query: "anything" })) as { data: { note: string } };
    expect(result.data.note).toContain("explicitly shared with");
    expect(result.data.note).toContain("Connections");
  });

  it("says the same thing for an empty database query", async () => {
    const { fetchImpl } = routes([[/POST .*\/query$/, { results: [] }]]);
    const result = (await run("notion_query_database", fetchImpl, { databaseId: "db1" })) as { data: { note: string } };
    expect(result.data.note).toContain("explicitly shared with");
  });

  it("omits the note when there were results, so it stays a signal", async () => {
    const { fetchImpl } = routes([[/POST .*\/v1\/search$/, { results: [{ id: "p1", object: "page", properties: {} }] }]]);
    const result = (await run("notion_search", fetchImpl, {})) as { data: { note?: string } };
    expect(result.data.note).toBeUndefined();
  });

  it("says a 404 is probably an unshared page rather than a missing one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "x" }, 404)) as unknown as typeof fetch;
    const result = (await run("notion_get_page", fetchImpl, { id: "p1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("shared with this integration");
  });
});

describe("the block tree is bounded and says so — AC-6", () => {
  const paragraph = (text: string, children = false): Block => ({
    id: `b-${text}`,
    type: "paragraph",
    has_children: children,
    paragraph: { rich_text: [{ plain_text: text, annotations: {} }] },
  });

  it("stops at the block ceiling and reports it", async () => {
    const many = Array.from({ length: 50 }, (_, i) => paragraph(String(i)));
    const result = await flattenBlocks(many, async () => [], { blocks: 10 });
    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("blocks");
    expect(result.markdown.split("\n")).toHaveLength(10);
  });

  it("stops at the character ceiling and reports it", async () => {
    const result = await flattenBlocks([paragraph("x".repeat(100)), paragraph("y")], async () => [], { chars: 50 });
    expect(result.stoppedBy).toBe("characters");
  });

  it("stops descending at the depth ceiling and reports it rather than dropping silently", async () => {
    // The page *has* more here, and a summary that does not know that is a summary of a different document.
    const result = await flattenBlocks([paragraph("top", true)], async () => [paragraph("deeper", true)], { depth: 1 });
    expect(result.stoppedBy).toBe("depth");
    expect(result.markdown).toContain("top");
  });

  it("terminates on a tree that would otherwise recurse forever", async () => {
    // A block whose children include itself. Without the depth bound this never returns.
    const self: Block = { id: "loop", type: "paragraph", has_children: true, paragraph: { rich_text: [{ plain_text: "x" }] } };
    const result = await flattenBlocks([self], async () => [self], { depth: 3 });
    expect(result.truncated).toBe(true);
    expect(result.blocksRead).toBeLessThan(10);
  });

  it("renders the block types a real page uses, indented by depth", async () => {
    const blocks: Block[] = [
      { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "one" }] } },
      { type: "to_do", to_do: { rich_text: [{ plain_text: "done" }], checked: true } },
      { type: "code", code: { rich_text: [{ plain_text: "x = 1" }], language: "python" } },
      { type: "divider", divider: {} },
    ];
    const result = await flattenBlocks(blocks, async () => []);
    expect(result.markdown).toBe("# Title\n- one\n- [x] done\n```python\nx = 1\n```\n---");
    expect(result.truncated).toBe(false);
  });

  it("keeps marks and links, which plain_text alone would lose", () => {
    expect(
      richTextToMarkdown([
        { plain_text: "bold", annotations: { bold: true } },
        { plain_text: " and " },
        { plain_text: "a link", href: "https://x.test" },
      ]),
    ).toBe("**bold** and [a link](https://x.test)");
  });

  it("degrades an unknown block type to its text rather than dropping it", async () => {
    const result = await flattenBlocks(
      [{ type: "some_future_block", some_future_block: { rich_text: [{ plain_text: "still readable" }] } }],
      async () => [],
    );
    expect(result.markdown).toBe("still readable");
  });

  it("names a child page instead of descending into it", async () => {
    // Following it would make "read this page" unbounded in the one direction the caller cannot see.
    const result = await flattenBlocks([{ type: "child_page", child_page: { title: "Sub" } }], async () => []);
    expect(result.markdown).toContain("[child page] Sub");
  });

  it("surfaces truncation and which limit it hit through the tool, not just the helper", async () => {
    // The bound is useless if the tool swallows the report — a model summarising half a page while believing
    // it read all of it is worse than one told to narrow its request.
    const { fetchImpl } = routes([
      [/GET .*\/v1\/pages\/p1$/, { id: "p1", properties: {}, url: "u" }],
      [/GET .*\/children/, { results: [paragraph("top", true)] }],
    ]);
    const result = (await run("notion_get_page", fetchImpl, { id: "p1", maxDepth: 0 })) as {
      data: { body: string; truncated: boolean; truncatedBy: string; blocksRead: number };
    };
    expect(result.data.body).toContain("top");
    expect(result.data.truncated).toBe(true);
    expect(result.data.truncatedBy).toBe("depth");
    expect(result.data.blocksRead).toBe(1);
  });

  it("does not claim truncation for a page that fitted", async () => {
    // Without this, a tool that always reported `truncated: true` would pass the test above.
    const { fetchImpl } = routes([
      [/GET .*\/v1\/pages\/p1$/, { id: "p1", properties: {}, url: "u" }],
      [/GET .*\/children/, { results: Array.from({ length: 30 }, (_, i) => paragraph(String(i))) }],
    ]);
    const result = (await run("notion_get_page", fetchImpl, { id: "p1" })) as {
      data: { truncated: boolean; truncatedBy?: string };
    };
    expect(result.data.truncated).toBe(false);
    expect(result.data.truncatedBy).toBeUndefined();
  });
});

describe("markdown becomes blocks Notion accepts", () => {
  it("maps each supported line to its block type", () => {
    const blocks = markdownToBlocks("# H\n- a\n1. b\n- [ ] c\n> q\n---\ntext");
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "quote",
      "divider",
      "paragraph",
    ]);
  });

  it("gives a fenced block without a language one Notion accepts", () => {
    // Notion rejects an unknown language outright, and `plain text` is always accepted.
    const blocks = markdownToBlocks("```\nx\n```");
    expect((blocks[0]?.code as { language: string }).language).toBe("plain text");
  });

  it("refuses an append with nothing in it", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("notion_append_blocks", fetchImpl, { id: "p1", body: "   " })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("nothing to append");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("credentials come only from the resolver — AC-7", () => {
  it("reads no environment variable anywhere in the package source", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["index.ts", "blocks.ts"]) {
      const source = readFileSync(`${here}../${file}`, "utf8");
      expect(source, file).not.toMatch(/process\s*\.\s*env/);
      expect(source, file).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
    }
  });

  it("resolves the credential on every call, not once at construction", async () => {
    let resolved = 0;
    const provider = createNotionToolkit({
      credentialRef: "notion",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "bearer", token: `t${resolved}` };
        },
      },
      fetchImpl: vi.fn(async () => jsonResponse({ results: [{ id: "x" }] })) as unknown as typeof fetch,
    });
    const tools = await provider.listTools(context);
    const tool = tools.find((t) => t.descriptor.name === "notion_search");
    await tool?.execute({ context, input: {} });
    await tool?.execute({ context, input: {} });
    expect(resolved).toBe(2);
  });
});
