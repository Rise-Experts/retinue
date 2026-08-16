/**
 * Loads and validates every evaluation case (SPEC #13).
 *
 * Cases live in `evals/cases/*.json`, one array per dimension. `loadCases()` reads them all,
 * validates each against the schema, and fails loudly on the first invalid case or duplicate id
 * — a broken dataset must never pass silently.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCase } from "./schema.mjs";

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), "cases");

export function loadCases() {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
  const cases = [];
  const seen = new Set();
  const errors = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
    } catch (e) {
      errors.push(`${file}: invalid JSON — ${e.message}`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push(`${file}: expected an array of cases`);
      continue;
    }
    for (const c of parsed) {
      errors.push(...validateCase(c).map((m) => `${file}: ${m}`));
      if (c && c.id) {
        if (seen.has(c.id)) errors.push(`${file}: duplicate id "${c.id}"`);
        seen.add(c.id);
      }
      cases.push(c);
    }
  }
  return { cases, errors };
}
