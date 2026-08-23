/**
 * Proves the boundary checker actually catches a planted violation (SPEC #11 AC:
 * "forbidden-import check fails CI on a planted violation") and passes a clean tree.
 * Uses only node:test + node:fs — no external test runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./check-boundaries.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "agentkit-bound-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("clean tree yields no violations", () => {
  const dir = fixture({
    "backend/src/core/ids.ts": `export type Id = string;\nimport { z } from "./util.js";\n`,
    "frontend/src/x.ts": `import type { RunEvent } from "@agentkit/backend";\n`,
    "backend/src/models/openai.ts": `import { openai } from "@ai-sdk/openai";\n`,
    // R11: OTel inside its own adapter is the allowed case, and its test is too -- the test's whole job is to
    // import the real package and prove the structural types hold against it.
    "backend/src/adapters/otel/index.ts": `import { trace } from "@opentelemetry/api";\n`,
    "backend/src/adapters/otel/__tests__/otel.test.ts": `import { trace } from "@opentelemetry/api";\n`,
  });
  try { assert.deepEqual(scan([dir]), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("planted violations are all caught", () => {
  const dir = fixture({
    // R2: frontend value-imports the backend
    "frontend/src/bad.ts": `import { runtime } from "@agentkit/backend";\n`,
    // R3: AI SDK imported outside the models layer
    "backend/src/runtime/bad.ts": `import { openai } from "@ai-sdk/openai";\n`,
    // R4: a port imports an adapter
    "backend/src/persistence/bad.ts": `import { PostgresStore } from "@agentkit/postgres";\n`,
    // R5: a forbidden product name
    "backend/src/tools/bad.ts": `import { Workspace } from "twenty-server";\n`,
    // R6: core reaches outside itself
    "backend/src/core/bad.ts": `import { x } from "../models/index.js";\n`,
    // R11: OTel outside its adapter. The import that would quietly acquire a vendor for the whole platform.
    "backend/src/runtime/otel-bad.ts": `import { trace } from "@opentelemetry/api";\n`,
  });
  try {
    const rules = new Set(scan([dir]).map((v) => v.rule.slice(0, 3).trim()));
    for (const r of ["R2", "R3", "R4", "R5", "R6", "R11"]) assert.ok(rules.has(r), `expected ${r} violation`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * #114 — the rules that make the integration package safe to add.
 *
 * Every case here plants a violation and asserts the checker fires, because AC-6 asks for exactly
 * that: "a planted boundary violation is caught by the build". A rule nobody has watched fail is a
 * comment with a filename.
 */
test("R8: a generic package must not import an integration package", () => {
  const dir = fixture({
    "backend/src/tools/bad.ts": `import { createShareFlowToolProvider } from "@agentkit/shareflow";\n`,
    "frontend/src/bad.ts": `import type { PostDraft } from "@agentkit/shareflow";\n`,
    "server/src/bad.ts": `import { x } from "@agentkit/shareflow/dist/index.js";\n`,
  });
  try {
    const byFile = new Map(scan([dir]).map((v) => [v.file.split("/").slice(-2).join("/"), v]));
    for (const f of ["tools/bad.ts", "src/bad.ts"]) {
      assert.ok([...byFile.keys()].some((k) => k.endsWith(f)), `expected a violation in ${f}`);
    }
    // Type-only does not help: importing the integration package's types still makes a generic
    // package unbuildable without it, which is the thing docs/01 forbids.
    const rules = scan([dir]).map((v) => v.rule.slice(0, 2));
    assert.equal(rules.filter((r) => r === "R8").length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R8 survives renaming the package, where R5 would not", () => {
  // The point of keying R8 on the package name rather than the word "shareflow": R5 catches
  // `@agentkit/shareflow` only because of how it is spelled. This asserts R8 is the rule doing the
  // work, so a future rename cannot silently drop the guarantee.
  const dir = fixture({ "backend/src/bad.ts": `import { x } from "@agentkit/shareflow";\n` });
  try {
    const rules = new Set(scan([dir]).map((v) => v.rule.slice(0, 2)));
    assert.ok(rules.has("R8"), "R8 must fire independently of R5");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R9: the integration package must not import application internals", () => {
  const dir = fixture({
    // The Next.js path alias ShareFlow's app uses — what arrives with a copy-paste from web/src/lib.
    "shareflow/src/tools/posts.ts": `import { getConnector } from "@/lib/connectors";\n`,
    // A relative path escaping src/, which is what someone writes when the app is a sibling on disk.
    "shareflow/src/tools/publish.ts": `import { publish } from "../../../web/src/lib/queue.ts";\n`,
    // Depth matters: this one resolves to shareflow/src/services and is fine.
    "shareflow/src/tools/ok.ts": `import type { PublishingService } from "../services/index.js";\n`,
  });
  try {
    const v = scan([dir]).filter((x) => x.rule.startsWith("R9"));
    assert.equal(v.length, 2, `expected exactly two R9 violations, got ${JSON.stringify(v)}`);
    assert.ok(v.some((x) => x.file.endsWith("posts.ts")));
    assert.ok(v.some((x) => x.file.endsWith("publish.ts")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R5 exempts an integration package for the product it owns, and nothing else", () => {
  const dir = fixture({
    "shareflow/src/tools/ok.ts": `import { x } from "./shareflow-posts.js";\n`,
    "shareflow/src/tools/bad.ts": `import { Workspace } from "twenty-server";\n`,
  });
  try {
    const v = scan([dir]).filter((x) => x.rule.startsWith("R5"));
    assert.equal(v.length, 1, `expected only the Twenty import to fail R5, got ${JSON.stringify(v)}`);
    assert.ok(v[0].file.endsWith("bad.ts"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R10: an import must be declared in the package's own manifest", () => {
  const dir = fixture({
    "shareflow/package.json": JSON.stringify({ dependencies: { "@agentkit/backend": "*" } }),
    // Resolves fine in the monorepo, because npm hoists every workspace's dependencies into one
    // node_modules. Breaks the moment the package is installed on its own — which is precisely the
    // "builds without the application installed" claim docs/01 makes.
    "shareflow/src/tools/bad.ts": `import { createClient } from "@supabase/supabase-js";\n`,
    "shareflow/src/tools/ok.ts": `import { defineTool } from "@agentkit/backend";\nimport { join } from "node:path";\n`,
  });
  try {
    const v = scan([dir]).filter((x) => x.rule.startsWith("R10"));
    assert.equal(v.length, 1, `expected one R10 violation, got ${JSON.stringify(v)}`);
    assert.ok(v[0].rule.includes("@supabase/supabase-js"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R10 does not apply where there is no manifest to read", () => {
  // Deliberate: `scan` is also pointed at fixture trees with no package.json, and a rule that
  // invented a violation from a missing file would make every other test here unwritable.
  const dir = fixture({ "shareflow/src/x.ts": `import { z } from "some-package";\n` });
  try {
    assert.deepEqual(scan([dir]).filter((v) => v.rule.startsWith("R10")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Regression: the extractor used to read prose as code.
 *
 * It matches the *words* `import` and `from`, and it matched them inside comments and inside string
 * literals — so a doc comment saying "derived from tenant" was an import of `tenant`, and a message
 * string ending `"… a move from " +` was an import of whatever string came next. Six existed in the
 * tree and nothing had ever noticed, because every rule until R10 looked for something specific.
 */
test("prose in comments and strings is not read as an import", () => {
  const dir = fixture({
    "backend/src/x.ts": [
      `/**`,
      ` * The key is derived from tenant, run and tool-call identity.`,
      ` * We import the provider SDK only inside the models layer.`,
      ` */`,
      `// see: import { openai } from "@ai-sdk/openai";`,
      `const message = "these ports need a harness and a move from " +`,
      `  "PLACEHOLDER_PORTS to REGISTERED_PORTS";`,
      `export const url = "https://example.com/import/from/x";`,
      `import { real } from "./real.js";`,
      ``,
    ].join("\n"),
  });
  try {
    // The commented-out `@ai-sdk/openai` import must not fire R3, and none of the prose must produce
    // an R10 violation for a package that does not exist.
    assert.deepEqual(scan([dir]), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real imports are still found after sanitizing", () => {
  // The other half of the regression: stripping comments and blanking strings must not make the
  // checker blind. Every rule below fires on a file that also contains prose designed to confuse it.
  const dir = fixture({
    "frontend/src/bad.ts": [
      `// This file imports from the backend, which is fine as long as it is type-only.`,
      `const note = "we import from @agentkit/backend";`,
      `import { runtime } from "@agentkit/backend";`,
      ``,
    ].join("\n"),
  });
  try {
    const rules = new Set(scan([dir]).map((v) => v.rule.slice(0, 2)));
    assert.ok(rules.has("R2"), "the real value-import must still be caught");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
