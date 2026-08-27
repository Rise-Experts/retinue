/**
 * Generates `llms.txt` (an index) and `llms-full.txt` (the whole corpus) into `static/` — REQ-048 (#207),
 * task #217, AC-6.
 *
 * An agent reading these should get **what a person gets**, and until #217 it did not: this script read only
 * `docs/`, the specifications, so every reader-facing page — installation, the quick start, the concepts, the
 * integrations — was invisible to it. An agent asked "how do I add a tool" would answer from the durability spec.
 *
 * Two corpora, in this order, because the order is the answer to "where should a reader start":
 *
 * 1. `website/content` — the documentation, by subject. What a person reads first.
 * 2. `docs` — the specifications. Decisions and their reasons, for when the documentation is not enough.
 *
 * Links are the site's real URLs, which is the other thing that was wrong: `docs/02-core-and-persistence.md` was
 * linked as `/02-core-and-persistence`, and the specifications instance serves it at
 * `/specifications/core-and-persistence`. A link an agent cannot follow is worse than no link — it is a citation
 * to a 404.
 *
 * Zero dependencies, and it runs in `prebuild`, so the committed files are regenerated on every site build.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const OUT = join(here, "..", "static");
mkdirSync(OUT, { recursive: true });

/** The two corpora, and how each maps a file to the URL the site actually serves. */
const CORPORA = [
  {
    label: "Documentation",
    dir: join(ROOT, "website", "content"),
    // `getting-started/quick-start.md` → `/docs/getting-started/quick-start`; `overview.md` → `/docs/overview`.
    url: (rel) => `/docs/${rel.replace(/\\/g, "/").replace(/\.md$/, "")}`,
  },
  {
    label: "Specifications",
    dir: join(ROOT, "docs"),
    // The Docusaurus instance strips the numeric prefix: `02-core-and-persistence.md` → `core-and-persistence`.
    url: (rel) => `/specifications/${rel.replace(/\\/g, "/").replace(/^\d+-/, "").replace(/\.md$/, "")}`,
  },
];

/** Files whose content is not documentation: an index of the others, or a changelog. */
const SKIP = new Set(["README.md"]);

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith(".md") && !SKIP.has(name)) out.push(path);
  }
  return out;
};

/** Front matter is Docusaurus configuration, not prose — it costs an agent tokens and tells it nothing. */
const stripFrontMatter = (body) => body.replace(/^---\n[\s\S]*?\n---\n/, "");

/**
 * A page may override its own URL with `slug:`, and `overview.md` does.
 *
 * Honoured rather than assumed away: a link derived from the filename when the page declares something else is a
 * citation to a 404, which is the failure this whole script was fixing.
 */
const slugOf = (body) => (/^---\n[\s\S]*?\n---\n/.exec(body)?.[0] ?? "").match(/^slug:\s*(\S+)\s*$/m)?.[1];

const titleOf = (body, fallback) => (stripFrontMatter(body).match(/^#\s+(.+)$/m) ?? [, fallback])[1];

const index = [
  "# Retinue documentation",
  "",
  "> A reusable, provider-neutral AI agent platform for TypeScript: durable runs, classified tools, layered",
  "> memory, human-in-the-loop approvals and permission-aware retrieval.",
  "",
  "> The documentation comes first and the specifications second, which is also the order to read them in:",
  "> the docs say how to use it, the specifications say why it behaves the way it does. Full corpus:",
  "> /llms-full.txt",
];
const full = [];
let count = 0;

for (const corpus of CORPORA) {
  index.push("", `## ${corpus.label}`, "");
  for (const file of walk(corpus.dir)) {
    const rel = relative(corpus.dir, file);
    const body = readFileSync(file, "utf8");
    const declared = slugOf(body);
    const url = declared === undefined ? corpus.url(rel) : corpus.url(declared.replace(/^\//, ""));
    index.push(`- [${titleOf(body, rel)}](${url})`);
    full.push(`\n\n===== ${corpus.label}: ${rel} =====\n\n${stripFrontMatter(body)}`);
    count += 1;
  }
}

writeFileSync(join(OUT, "llms.txt"), `${index.join("\n")}\n`);
writeFileSync(join(OUT, "llms-full.txt"), full.join("\n"));
console.log(`llms.txt + llms-full.txt generated from ${count} pages across ${CORPORA.length} corpora`);
