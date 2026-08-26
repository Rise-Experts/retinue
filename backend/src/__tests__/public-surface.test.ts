/**
 * What this package promises — REQ-040, #199.
 *
 * The root is the semver boundary: what is exported from it is API, and what is not exported from it cannot be
 * broken. It used to carry **392 runtime values**, which is not a promise anyone can keep — every name on it was
 * something we could not remove without a major version, including the three hundred nobody outside this
 * repository had ever called.
 *
 * These tests are the boundary itself rather than a description of it. Each one is written to fail on an
 * *addition* as well as a removal, because a surface that only grows is the failure mode: nobody notices a name
 * arriving, and by the time anyone counts, it is API.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// Static namespace imports, because Vite cannot resolve a dynamic import whose specifier is a variable — and a
// list written out here is also what makes "a subpath was added and nobody checked it" visible in review.
import * as contextEntry from "../entries/context.js";
import * as hitlEntry from "../entries/hitl.js";
import * as knowledgeEntry from "../entries/knowledge.js";
import * as mcpEntry from "../entries/mcp.js";
import * as observabilityEntry from "../entries/observability.js";
import * as persistenceEntry from "../entries/persistence.js";
import * as runtimeEntry from "../entries/runtime.js";
import * as serverEntry from "../entries/server.js";
import * as toolsEntry from "../entries/tools.js";
import * as usageEntry from "../entries/usage.js";

const ENTRIES: readonly [string, Record<string, unknown>][] = [
  ["./runtime", runtimeEntry],
  ["./tools", toolsEntry],
  ["./persistence", persistenceEntry],
  ["./context", contextEntry],
  ["./knowledge", knowledgeEntry],
  ["./hitl", hitlEntry],
  ["./usage", usageEntry],
  ["./mcp", mcpEntry],
  ["./observability", observabilityEntry],
  ["./server", serverEntry],
];

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
  exports: Record<string, unknown>;
};

/**
 * The documented root surface.
 *
 * Written out here, in one place, so changing it is a deliberate edit to a list rather than a side effect of
 * touching `index.ts`. Types are not in it: every type in the package is still exported from the root by
 * `export type *`, which emits no import and cannot be broken by being imported.
 */
const ROOT_SURFACE = [
  "AgentPlatformError",
  "asId",
  "createRuntime",
  "defineAgent",
  "isAgentPlatformError",
  "resolveCapabilities",
] as const;

const SUBPATHS = [
  "./runtime",
  "./tools",
  "./persistence",
  "./context",
  "./knowledge",
  "./hitl",
  "./usage",
  "./mcp",
  "./observability",
  "./server",
  "./providers",
  "./adapters/postgres",
  "./adapters/redis",
  "./adapters/bullmq",
  "./adapters/otel",
] as const;

describe("the package root", () => {
  it("exports exactly the documented values, and fewer than ten of them", async () => {
    const root = await import("../index.js");
    const exported = Object.keys(root).sort();
    // Equality, not containment: containment passes when a name is added, which is the direction that matters.
    expect(exported).toEqual([...ROOT_SURFACE].sort());
    expect(exported.length).toBeLessThan(10);
  });

  it("still exports every type, which is what makes the cut affordable", async () => {
    // A type surface cannot be introspected at runtime, so this asserts the mechanism instead: `export type *`
    // for each layer, and no `export *`. A single `export *` restored by accident would put 392 values back.
    const source = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
    const valueStars = source.match(/^export \* from/gm) ?? [];
    expect(valueStars, "the root must re-export types only").toEqual([]);
    expect((source.match(/^export type \* from/gm) ?? []).length).toBeGreaterThan(30);
  });
});

describe("the subpaths", () => {
  it("are all declared in the exports map", () => {
    for (const subpath of SUBPATHS) {
      expect(manifest.exports[subpath], `${subpath} is not exported`).toBeDefined();
    }
  });

  it("give every name exactly one home", () => {
    /**
     * AC-2, and the reason it is a test rather than a convention.
     *
     * A name reachable from two subpaths has two futures: it can be deprecated in one and kept in the other, and
     * a consumer has no way to know which import they are supposed to have used. Three of these existed when the
     * split was made — convenience re-exports inside layer modules, each a one-line kindness that quietly made
     * one name into two exports.
     */
    const owner = new Map<string, string>();
    const duplicated: string[] = [];
    // The adapter and provider subpaths are excluded: each is driver-bound and its names are namespaced by the
    // driver they wrap, so `createPostgresRunStore` and `createRedisLock` cannot collide by construction.
    for (const [subpath, module] of ENTRIES) {
      for (const name of Object.keys(module)) {
        const previous = owner.get(name);
        if (previous !== undefined) duplicated.push(`${name}: ${previous} and ${subpath}`);
        else owner.set(name, subpath);
      }
    }
    expect(duplicated, `names with two homes: ${duplicated.join("; ")}`).toEqual([]);
  });

  it("re-export the root's own names as the same binding, not a copy", async () => {
    /**
     * The five names the root keeps also appear on the subpath of the layer that defines them — `asId` and
     * `AgentPlatformError` at `./runtime`, because `./runtime` includes core.
     *
     * That is deliberate, and the alternative is worse: a `./runtime` that exported `ERROR_CODES` but not
     * `AgentPlatformError` would be a subpath with a hole in it, and the hole would be invisible until someone
     * hit it. AC-2 is about names that *left* the root; these did not leave.
     *
     * What must hold is that the two paths lead to the **same object**. Two paths to one binding is a
     * convenience. Two paths to two bindings is a bug that shows up as `instanceof` failing, or a `catch` block
     * that does not recognise the error it was written for — and it is exactly what a duplicated module in the
     * graph produces.
     */
    const root = (await import("../index.js")) as Record<string, unknown>;
    for (const [subpath, module] of ENTRIES) {
      for (const name of ROOT_SURFACE) {
        if (!(name in module)) continue;
        expect(module[name], `${name} at ${subpath} must be the same binding as at the root`).toBe(root[name]);
      }
    }
  });
});

describe("what is not exported cannot be imported", () => {
  /**
   * Run in a child `node`, not in this process — and that is the point rather than a workaround.
   *
   * Vite refuses an unexported specifier at *transform* time, so a `await expect(import(…)).rejects` inside a
   * vitest file fails to load the file at all: the assertion never runs and the failure looks like a broken
   * test. More importantly, Vite's resolver is not the thing being tested. A consumer runs Node, and what has
   * to hold is that **Node's** `exports` map refuses the import.
   */
  const importInNode = (specifier: string): { code: number; output: string } => {
    try {
      const output = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`],
        { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { code: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string; stdout?: string };
      return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  it("refuses a deep import of an adapter internal", () => {
    // The file very much exists. What refuses it is the `exports` map.
    const result = importInNode("@retinue/agentkit/dist/adapters/postgres/stores.js");
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
  });

  it("refuses a deep import of a source module", () => {
    const result = importInNode("@retinue/agentkit/src/index.ts");
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
  });

  it("allows the documented subpaths", () => {
    // The control. Without it the two tests above would pass against an `exports` map that refused everything.
    expect(importInNode("@retinue/agentkit/tools").code).toBe(0);
    expect(importInNode("@retinue/agentkit/persistence").code).toBe(0);
    expect(importInNode("@retinue/agentkit").code).toBe(0);
  });
});
