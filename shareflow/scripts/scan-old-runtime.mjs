/**
 * Count what still references the old runtime — #128 AC-5.
 *
 * `canRemoveOldRuntime` takes a `remainingReferences` count and refuses to treat an absent one as zero. Nothing
 * produced that number: the check could be satisfied only by a caller typing one in, which is the same as no
 * check. This produces it.
 *
 * **A missing root is an error, never zero.** That distinction is the whole point of this script existing, and it
 * is not hypothetical — `OLD_RUNTIME_REFERENCE_SCOPE.roots` are `web/src` and `ai_backend/app`, and neither path
 * exists in the `social_integgration` directory on the machine this was written on. A scanner that walked a
 * missing directory and reported "0 references" would hand `canRemoveOldRuntime` a clean bill of health for a
 * scan that looked at nothing — and the removal it would then permit deletes a live customer runtime.
 *
 * So: the repository must exist, every configured root must exist, and only then is a count meaningful. Exit 2
 * for "could not scan", exit 0 for "scanned", whatever the count. A non-zero count is not this script's failure;
 * it is information the gate decides on.
 *
 * Read-only by construction. It opens files and prints numbers; it does not edit the old repository, which is a
 * different repository and, per the runbook, a separate reviewed change.
 *
 * Usage:
 *   node scripts/scan-old-runtime.mjs [--root <path>] [--json]
 *   RETINUE_OLD_RUNTIME_ROOT=/path/to/social_integgration node scripts/scan-old-runtime.mjs
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { OLD_RUNTIME_REFERENCE_SCOPE } from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");

/**
 * Where to look.
 *
 * Explicit beats inferred, but a default that is written down beats making everyone pass a path. The default is
 * a sibling of the working tree, which is where it sits in the layout this was written against — and if it is
 * wrong, the error says which path was tried rather than reporting an empty result.
 */
const DEFAULT_ROOT = resolve(import.meta.dirname, "../../../..", OLD_RUNTIME_REFERENCE_SCOPE.repository);
const root = resolve(flag("root") ?? process.env.RETINUE_OLD_RUNTIME_ROOT ?? DEFAULT_ROOT);

/** Directories never worth scanning: build output and dependencies are not the old runtime's source. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "coverage"]);

const die = (message, detail) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message, ...detail }, null, 2));
  else {
    console.error(`✗ ${message}`);
    for (const [k, v] of Object.entries(detail ?? {})) console.error(`  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  // 2, not 1: "could not scan" has to be distinguishable from "scanned and found things" by a caller that only
  // looks at the exit code.
  process.exit(2);
};

const isDirectory = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

if (!(await isDirectory(root)))
  die(`the old runtime repository is not here, so nothing can be counted`, {
    looked: root,
    fix: "pass --root <path> or set RETINUE_OLD_RUNTIME_ROOT",
  });

const missing = [];
for (const dir of OLD_RUNTIME_REFERENCE_SCOPE.roots) if (!(await isDirectory(join(root, dir)))) missing.push(dir);
if (missing.length > 0)
  die(`configured roots do not exist, so a count of 0 would mean "did not look" rather than "clean"`, {
    repository: root,
    missing,
    present: OLD_RUNTIME_REFERENCE_SCOPE.roots.filter((r) => !missing.includes(r)),
    fix: "point --root at the right checkout, or correct OLD_RUNTIME_REFERENCE_SCOPE.roots",
  });

const pattern = new RegExp(OLD_RUNTIME_REFERENCE_SCOPE.terms.join("|"), "i");
const hits = [];

const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      // Unreadable or binary: skipped, and *counted* as skipped rather than as clean — see `unreadable` below.
      hits.push({ path: relative(root, path), unreadable: true });
      continue;
    }
    if (pattern.test(text)) hits.push({ path: relative(root, path), unreadable: false });
  }
};

for (const dir of OLD_RUNTIME_REFERENCE_SCOPE.roots) await walk(join(root, dir));

const referencing = hits.filter((h) => !h.unreadable);
const unreadable = hits.filter((h) => h.unreadable);

/** Grouped by the directory the runbook sequences on, so a removal can be ordered rather than attempted at once. */
const byDirectory = new Map();
for (const hit of referencing) {
  const dir = hit.path.split("/").slice(0, -1).join("/");
  byDirectory.set(dir, (byDirectory.get(dir) ?? 0) + 1);
}
const hotspots = [...byDirectory.entries()]
  .map(([path, files]) => ({ path, files }))
  .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
  .slice(0, 10);

const result = {
  ok: true,
  repository: root,
  roots: OLD_RUNTIME_REFERENCE_SCOPE.roots,
  terms: OLD_RUNTIME_REFERENCE_SCOPE.terms,
  /** The number `canRemoveOldRuntime` takes as `remainingReferences`. */
  remainingReferences: referencing.length,
  baselineFileCount: OLD_RUNTIME_REFERENCE_SCOPE.baselineFileCount,
  /** Files that could not be read. Reported, because "I could not look at these" is not "these are clean". */
  unreadable: unreadable.map((h) => h.path),
  hotspots,
  files: referencing.map((h) => h.path).sort(),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`scanned ${root}`);
  console.log(`  roots      ${result.roots.join(", ")}`);
  console.log(`  terms      ${result.terms.join(", ")}`);
  console.log(`  references ${result.remainingReferences} file(s) (baseline ${result.baselineFileCount})`);
  if (result.unreadable.length > 0) console.log(`  unreadable ${result.unreadable.length} file(s) — not counted as clean`);
  for (const h of result.hotspots) console.log(`    ${String(h.files).padStart(4)}  ${h.path}`);
  console.log(
    result.remainingReferences === 0
      ? "\n✓ no references — AC-5 satisfied for these roots"
      : `\n${result.remainingReferences} reference(s) remain; removal is not complete`,
  );
}
