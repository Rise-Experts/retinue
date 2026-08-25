/**
 * What the package root drags in — #196 AC-2.
 *
 * Before this, `src/index.ts` re-exported every adapter, so `import "@agentkit/backend"` loaded six provider
 * SDKs, a Postgres driver, a Redis client and a queue — whatever the consumer actually used. Someone embedding
 * the runtime in a Next.js route with OpenAI and their own storage installed four SDKs they would never call.
 *
 * The `package.json` is not the check. Declaring nine packages as optional peers proves an *intention*; what
 * matters is whether the root's module graph reaches them, because a single stray re-export puts the requirement
 * back and the manifest still looks right.
 *
 * So this walks the built graph from `dist/index.js` and asserts what it can reach. It reads the build rather
 * than the source deliberately — the build is what gets published, and a `tsconfig` path or a type-only import
 * that erases at compile time would make a source-level check disagree with reality.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST = resolve(import.meta.dirname, "../../dist");

/** Every bare specifier the graph rooted at `entry` can reach, following relative imports only. */
const bareSpecifiersFrom = (entry: string): Set<string> => {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    let code: string;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    /**
     * Line-anchored, and that took two attempts.
     *
     * Matching `from\s*["']` anywhere in the file found `"from"` inside a stopword array in
     * `persistence/index.js`, and `"forbidden" from "no such run"` inside a doc comment in the Supabase
     * realtime adapter. Adding `(?<![\w$])` fixed the identifier case and neither of those.
     *
     * A statement is what we are looking for, so only a line that *begins* with `import` or `export` counts —
     * comment lines begin with `*` or `//`, and an array of words begins with a quote. Dynamic imports are
     * matched separately because they appear mid-expression, and they require the closing paren, which prose
     * does not have.
     */
    for (const line of code.split("\n")) {
      const statement = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/.exec(line);
      const bareImport = /^\s*import\s*["']([^"']+)["']/.exec(line);
      for (const found of [statement?.[1], bareImport?.[1]]) if (found !== undefined) record(found);
    }
    for (const match of code.matchAll(/(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g)) record(match[1]!);

    function record(spec: string) {
      if (spec.startsWith(".")) {
        queue.push(resolve(dirname(file), spec));
        return;
      }
      bare.add(spec.startsWith("node:") ? spec : spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return bare;
};

const OPTIONAL_PEERS = [
  "pg",
  "ioredis",
  "bullmq",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/google",
  "@ai-sdk/mistral",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
];

describe("the package root", () => {
  const reachable = bareSpecifiersFrom(resolve(DIST, "index.js"));

  it("reaches none of the optional peers", () => {
    const leaked = OPTIONAL_PEERS.filter((p) => reachable.has(p));
    // Named individually, because "one of them leaked" sends the reader looking through nine.
    expect(leaked, `the root must not reach: ${leaked.join(", ")}`).toEqual([]);
  });

  it("reaches only ai and zod outside the standard library", () => {
    /**
     * The positive statement, which the negative one above cannot make: a tenth heavy dependency added tomorrow
     * would pass the leak test simply by not being on its list.
     */
    const external = [...reachable].filter((s) => !s.startsWith("node:")).sort();
    expect(external).toEqual(["ai", "zod"]);
  });

  it("still reaches the in-memory adapters, so the package works on install", () => {
    // They are the only adapters with no dependency of their own, and they are what makes a test, a prototype or
    // a first look possible without a database. Keeping them in the root is the point of the split, not an
    // oversight in it.
    const files = bareSpecifiersFrom(resolve(DIST, "index.js"));
    expect(files.size).toBeGreaterThan(0);
    const code = readFileSync(resolve(DIST, "index.js"), "utf8");
    expect(code).toContain("adapters/memory");
  });
});

describe("each subpath entry", () => {
  it("reaches the peer it exists for, and nothing it does not", () => {
    // The other half of the trade: if a subpath did *not* reach its driver, the split would have moved the
    // export without moving the dependency, and the root would still be paying for it somewhere.
    const cases: [string, string][] = [
      ["adapters-bullmq.js", "bullmq"],
      ["adapters-bullmq.js", "ioredis"],
      ["providers.js", "@ai-sdk/openai"],
      ["providers.js", "@ai-sdk/anthropic"],
    ];
    for (const [entry, peer] of cases) {
      const reachable = bareSpecifiersFrom(resolve(DIST, "entries", entry));
      expect(reachable.has(peer), `${entry} should reach ${peer}`).toBe(true);
    }
  });

  it("does not make the Postgres adapter reach pg at all", () => {
    /**
     * The finding that came out of writing this test, and it is worth locking in.
     *
     * `pg` is imported **type-only**: `createPgExecutor(pool)` takes a pool the caller constructed, and
     * `PgTransactionRunner` the same. So the adapter has no runtime dependency on node-postgres — a consumer
     * using a different Postgres client, a pooler, or a serverless driver can satisfy `SqlExecutor` themselves.
     *
     * I had assumed otherwise and wrote this case asserting the opposite, which is how the property surfaced.
     * `pg` stays an optional peer because a consumer calling `createPgExecutor` needs the *types* and the pool —
     * but nothing here imports it, and that should stay true.
     */
    const reachable = bareSpecifiersFrom(resolve(DIST, "entries", "adapters-postgres.js"));
    expect(reachable.has("pg")).toBe(false);
    // It reaches `ai` and `zod`, which are the package's own dependencies and installed for everyone. What it
    // must not reach is any *peer* — an install requirement placed on the consumer.
    expect(OPTIONAL_PEERS.filter((peer) => reachable.has(peer))).toEqual([]);
  });
});
