/**
 * What the package root drags in — #196 AC-2.
 *
 * Before this, `src/index.ts` re-exported every adapter, so `import "@retinue/agentkit"` loaded six provider
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST = resolve(import.meta.dirname, "../../dist");

/**
 * This file asserts things about the **build**, so a missing build is a precondition failure rather than a
 * result. Without it, three tests across two files fail with messages about a missing module, and the one that
 * asserts the root reaches *nothing* passes — because an absent graph reaches nothing. One explicit failure
 * naming the command is worth more than three implicit ones pointing elsewhere.
 */
describe("the build these tests read", () => {
  it("exists", () => {
    expect(existsSync(resolve(DIST, "index.js")), "run `npm run build` first: these tests read dist/").toBe(true);
  });
});

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

/**
 * Every *file* the graph rooted at `entry` can reach, following relative imports.
 *
 * The companion to `bareSpecifiersFrom`: a barrel restored by accident adds no bare specifier, because every
 * layer is a relative import — so counting packages would stay green while the root loaded the package again.
 */
const reachableFiles = (entry: string): Set<string> => {
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
      seen.delete(file); // A specifier that does not resolve to a file is not a file this reached.
      continue;
    }
    for (const line of code.split("\n")) {
      const statement = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["\']([^"\']+)["\']/.exec(line);
      if (statement?.[1]?.startsWith(".")) queue.push(resolve(dirname(file), statement[1]));
    }
    for (const match of code.matchAll(/(?<![\w$.])import\s*\(\s*["\']([^"\']+)["\']\s*\)/g)) {
      if (match[1]!.startsWith(".")) queue.push(resolve(dirname(file), match[1]!));
    }
  }
  return seen;
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

  it("reaches nothing outside the standard library at all", () => {
    /**
     * `ai` and `zod` used to be here, and the surface cut (#199) removed even those.
     *
     * The root exports five values — `createRuntime`, `resolveCapabilities`, `defineAgent`, `asId` and the
     * platform error — and none of them needs a model SDK or a schema library. Every type is still exported
     * from here by `export type *`, which emits no import, so the whole type surface costs nothing.
     *
     * Asserted as *empty* rather than as a shrinking list, because that is the strong form: a dependency added
     * to any of those five files tomorrow fails this immediately, whatever it is. `ai` and `zod` remain real
     * dependencies of the package — `./runtime` and `./tools` need them — and stay `dependencies` rather than
     * peers, because a consumer who installs the package will use at least one subpath and should not have to
     * install two more things to do it.
     */
    const external = [...reachable].filter((s) => !s.startsWith("node:")).sort();
    expect(external).toEqual([]);
  });

  it("reaches no runtime module of its own either", () => {
    /**
     * The stronger claim, and the one that would catch a value creeping back onto the root.
     *
     * A `export * from "./knowledge/index.js"` restored by accident would not add a *bare* specifier — every
     * layer is a relative import — so the check above would stay green while the root loaded the whole package
     * again. Counting the reachable files catches it: five hand-picked exports reach a handful of small
     * modules, and a barrel reaches a hundred.
     */
    const files = reachableFiles(resolve(DIST, "index.js"));
    expect(files.size).toBeLessThan(20);
  });

  it("no longer reaches the in-memory adapters, and that is the reversal it looks like", () => {
    /**
     * #196 kept them in the root on purpose: "they are the only adapters with no dependency of their own, and
     * they are what makes the package usable the moment it is installed".
     *
     * That reasoning was right and its conclusion does not survive #199, because the root has no store factory
     * of any kind now — keeping `createMemoryRunStore` while dropping `createPostgresRunStore` would be a root
     * that exports one adapter and calls it the API. The property it was protecting is intact: `./persistence`
     * still has no dependency of its own, so a test, a prototype or a first look still needs no database. It
     * needs one more import.
     */
    const code = readFileSync(resolve(DIST, "index.js"), "utf8");
    expect(code).not.toContain("adapters/memory");

    const persistence = bareSpecifiersFrom(resolve(DIST, "entries/persistence.js"));
    expect([...persistence].filter((s) => !s.startsWith("node:"))).toEqual([]);
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

describe("the published shape", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
  ) as {
    files?: string[];
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it("ships no source maps", () => {
    /**
     * They were 1.7 MB of a 4.2 MB unpacked install and every one of them pointed at `../src/index.ts`, which
     * is not shipped. A map that cannot resolve its source is worse than no map: a debugger fails to find the
     * file instead of falling back to the emitted JavaScript.
     *
     * Either ship sources too or ship neither. Neither, at this size.
     */
    expect(manifest.files).toContain("!dist/**/*.map");
  });

  it("ships no sources and no tests", () => {
    const patterns = manifest.files ?? [];
    // An allowlist, not a denylist: `dist/**/*.js` cannot accidentally include `src/`, whereas a list of
    // exclusions has to anticipate every directory somebody adds later.
    expect(patterns.some((p) => p.startsWith("src"))).toBe(false);
    expect(patterns).toContain("dist/**/*.js");
    expect(patterns).toContain("dist/**/*.d.ts");
  });

  it("declares every subpath a consumer is documented to import", () => {
    // A subpath missing from `exports` is not importable at all, and the failure surfaces as
    // ERR_PACKAGE_PATH_NOT_EXPORTED in someone else's project rather than here.
    for (const subpath of [
      ".",
      "./server",
      "./providers",
      "./adapters/postgres",
      "./adapters/redis",
      "./adapters/bullmq",
      "./adapters/otel",
    ]) {
      expect(Object.keys(manifest.exports ?? {}), `${subpath} must be exported`).toContain(subpath);
    }
  });

  it("keeps every heavy dependency optional", () => {
    // Verified against a real install: the tarball in a clean project pulls 12 packages — the runtime, `ai` and
    // its transitive dependencies, and `zod`. Not one driver, not one provider SDK, no GraphQL server.
    for (const peer of OPTIONAL_PEERS) {
      expect(manifest.dependencies?.[peer], `${peer} must not be a dependency`).toBeUndefined();
      expect(manifest.peerDependenciesMeta?.[peer]?.optional, `${peer} must be optional`).toBe(true);
    }
  });
});
