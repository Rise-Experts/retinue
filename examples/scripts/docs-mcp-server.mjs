#!/usr/bin/env node
/**
 * A documentation MCP server over stdio — the thing #173 needed to test against.
 *
 * It serves this repository's own `docs/*.md` as three tools. That choice is deliberate rather than convenient:
 *
 * - It is a **real** MCP server, spoken to over the real protocol by the real SDK. A hand-written fake would
 *   verify the example's own mock and nothing else, which is exactly the class of test that let the MCP provider
 *   sit unreachable while looking covered.
 * - It needs no network, no API key and no port. stdio means the client spawns it, so `npm run app` works on a
 *   laptop with no internet.
 * - Its content is genuinely useful to the agent — asking the assistant how the approval loop works and having it
 *   read the specification is a better demonstration than a toy echo tool.
 *
 * **It is read-only by construction.** Every tool reads a file under `docs/`, resolves the path, and refuses
 * anything that escapes — see `resolveDoc`. An MCP server is untrusted *input* to the platform, but this one is
 * also a process on the developer's machine, and a doc server that could be talked into reading `~/.ssh` would be
 * a worse thing to ship in an example than no example at all.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DOCS = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../docs");

/**
 * A path inside `docs/`, or nothing.
 *
 * `resolve` then a prefix check, not string manipulation on the input: `../../etc/passwd` and a symlink both
 * normalise before the check rather than after it. The trailing separator matters — without it, a sibling
 * directory named `docs-secret` would pass a bare `startsWith`.
 */
const resolveDoc = (name) => {
  const candidate = resolve(DOCS, basename(String(name ?? "")));
  return candidate.startsWith(DOCS + sep) ? candidate : null;
};

const listDocs = () =>
  readdirSync(DOCS)
    .filter((f) => f.endsWith(".md"))
    .sort();

const server = new McpServer({ name: "agentkit-docs", version: "1.0.0" });

server.registerTool(
  "list_documents",
  {
    title: "List documentation",
    description: "List the agentkit specification documents available to read.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: listDocs().join("\n") }],
  }),
);

server.registerTool(
  "read_document",
  {
    title: "Read documentation",
    description:
      "Read one agentkit specification document by filename, e.g. '04-durable-runtime-and-hitl.md'. " +
      "Returns the whole document.",
    inputSchema: { name: z.string().describe("The document filename, as given by list_documents.") },
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    const path = resolveDoc(name);
    if (path === null) {
      // Named, so the model can correct itself rather than guessing again. A bare "not found" invites a retry
      // with another guess.
      return {
        content: [{ type: "text", text: `No such document. Available:\n${listDocs().join("\n")}` }],
        isError: true,
      };
    }
    try {
      return { content: [{ type: "text", text: readFileSync(path, "utf8") }] };
    } catch {
      return { content: [{ type: "text", text: `Could not read ${name}.` }], isError: true };
    }
  },
);

server.registerTool(
  "search_documents",
  {
    title: "Search documentation",
    description:
      "Search the agentkit specification for a phrase. Returns matching lines with their document and line " +
      "number, so a follow-up read_document has somewhere to start.",
    inputSchema: { query: z.string().describe("The phrase to search for. Case-insensitive.") },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const needle = String(query ?? "").toLowerCase();
    if (needle.length < 3) {
      return { content: [{ type: "text", text: "Search for at least three characters." }], isError: true };
    }
    const hits = [];
    for (const file of listDocs()) {
      const lines = readFileSync(resolve(DOCS, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
    // Capped. A search for "the" would otherwise return the entire specification one line at a time, which
    // fills the context window with the answer to a question nobody asked.
    const capped = hits.slice(0, 40);
    const note = hits.length > capped.length ? `\n\n… ${hits.length - capped.length} more matches not shown.` : "";
    return {
      content: [
        { type: "text", text: capped.length === 0 ? `No matches for "${query}".` : capped.join("\n") + note },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
