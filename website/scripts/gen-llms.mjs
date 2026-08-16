/**
 * Generates llms.txt (index) and llms-full.txt (concatenated corpus) into static/, so AI
 * editors and a docs MCP server can consume the whole spec set. Zero dependencies.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, "..", "..", "docs");
const OUT = join(here, "..", "static");
mkdirSync(OUT, { recursive: true });

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = walk(DOCS);
const index = ["# @agentkit documentation", "", "> Reusable, provider-neutral AI agent platform. Full corpus: /llms-full.txt", ""];
const full = [];

for (const f of files) {
  const rel = relative(DOCS, f);
  const body = readFileSync(f, "utf8");
  const title = (body.match(/^#\s+(.+)$/m) || [, rel])[1];
  index.push(`- [${title}](/${rel.replace(/\.md$/, "")})`);
  full.push(`\n\n===== ${rel} =====\n\n${body}`);
}

writeFileSync(join(OUT, "llms.txt"), index.join("\n") + "\n");
writeFileSync(join(OUT, "llms-full.txt"), full.join("\n"));
console.log(`llms.txt + llms-full.txt generated from ${files.length} docs`);
