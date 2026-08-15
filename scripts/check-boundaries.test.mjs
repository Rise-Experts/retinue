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
  });
  try {
    const rules = new Set(scan([dir]).map((v) => v.rule.slice(0, 2)));
    for (const r of ["R2", "R3", "R4", "R5", "R6"]) assert.ok(rules.has(r), `expected ${r} violation`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
