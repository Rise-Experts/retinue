/**
 * Proves the script-import checker catches a planted broken import, passes a clean tree, does not
 * read import statements inside string literals as real, and refuses to report success when it found
 * nothing to check. Uses only node:test + node:fs.
 *
 * The third case is the one worth having: an unanchored match reads the boundary check's fixtures --
 * which are deliberately-broken import statements inside template literals -- as real code, and the
 * checker then reports a dozen violations that are other tests doing their job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKER = join(import.meta.dirname, "check-script-imports.mjs");

/** A tree with one hand-written package installed, so resolution is real but hermetic. */
function fixture(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "retinue-scripts-"));
  mkdirSync(join(dir, "node_modules", "fixture-pkg"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "fixture-pkg", "package.json"),
    JSON.stringify({ name: "fixture-pkg", version: "1.0.0", type: "module", main: "index.mjs" }),
  );
  writeFileSync(join(dir, "node_modules", "fixture-pkg", "index.mjs"), "export const alpha = 1;\n");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const [name, content] of Object.entries(scripts)) writeFileSync(join(dir, "scripts", name), content);
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("a clean tree passes", (t) => {
  const dir = fixture({ "ok.mjs": 'import { alpha } from "fixture-pkg";\nconsole.log(alpha);\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /1 package import sites resolve/);
});

test("a name the package does not export is caught", (t) => {
  const dir = fixture({ "bad.mjs": 'import { alpha, beta } from "fixture-pkg";\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /does not export beta/);
  assert.doesNotMatch(out, /does not export alpha/);
});

test("a package that is not installed at all is caught", (t) => {
  const dir = fixture({ "bad.mjs": 'import { anything } from "not-installed-pkg";\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /cannot load "not-installed-pkg"/);
});

test("an import statement inside a string is not read as an import", (t) => {
  const dir = fixture({
    // Exactly the shape of the boundary check's fixtures: real code, containing source text that
    // describes an import which must not exist.
    "ok.mjs": [
      'import { alpha } from "fixture-pkg";',
      "const fixtures = {",
      '  "src/bad.ts": `import { nope } from "no-such-package";`,',
      "};",
      "console.log(alpha, fixtures);",
    ].join("\n"),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
});

test("a default import is checked too", (t) => {
  const dir = fixture({ "bad.mjs": 'import whatever from "fixture-pkg";\nconsole.log(whatever);\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  // fixture-pkg has named exports only, so a default import of it resolves to undefined.
  assert.equal(code, 1);
  assert.match(out, /does not export default/);
});

test("finding nothing to check exits 2, not 0", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "retinue-scripts-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 2, out);
  assert.match(out, /checking nothing/);
});

test("relative and node: specifiers are left alone", (t) => {
  const dir = fixture({ "ok.mjs": 'import { readFileSync } from "node:fs";\nimport { x } from "./nowhere.mjs";\nconsole.log(readFileSync, x);\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /0 package import sites/);
});
