/**
 * No process connects to Postgres on a *narrowed* config -- REQ-041 (#190).
 *
 * A source scan, because the offence is invisible to every other kind of test. `openPostgres` takes the
 * loaded config and reads `databaseSchema` off it, so a call site that passes
 * `{ databaseUrl: loaded.databaseUrl }` instead of `loaded` typechecks, boots, answers, migrates, and
 * puts its tables in the wrong schema. Sabotaging exactly that in `cli.ts` and `cli-worker.ts` broke
 * nothing in the suite: the pool tests call `openPostgres` directly and never see who calls it.
 *
 * The worker is the one that matters most. It is the process nobody watches, and a worker in `public`
 * while the host is in `retinue` does not error -- it produces runs that vanish.
 *
 * Scanning source rather than asserting behaviour is deliberate and narrow: the rule is "hand it the
 * whole config", which is a property of the text and of nothing else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Comments removed, because this repo's prose quotes the very code these tests refuse.
 *
 * `doctor.ts` explains a past bug with the words "`new Pool()` does not connect", and the first version
 * of the last test reported it as an offence -- a checker firing on a correct file, which is the false
 * alarm that gets a check deleted rather than fixed. Replaced with spaces rather than removed so line
 * numbers still point where a reader expects.
 */
export const withoutComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));

const sources = () =>
  readdirSync(SERVER_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: withoutComments(readFileSync(join(SERVER_DIR, name), "utf8")) }));

describe("openPostgres call sites", () => {
  it("are found at all, so a rename cannot make this test vacuous", () => {
    /**
     * The guard on the guard. If `openPostgres` were renamed or the files moved, every assertion below
     * would pass by finding nothing -- a test that proves nothing while reading as though it proves
     * everything. There are three callers today: the CLI host, the worker, and `bin.ts` for
     * `migrate`/`doctor`.
     */
    const callers = sources().filter(({ text }) => text.includes("openPostgres("));
    expect(callers.map(({ name }) => name).sort()).toEqual(["bin.ts", "cli-worker.ts", "cli.ts"]);
  });

  it("pass the whole config, never an object literal that rebuilds part of it", () => {
    /**
     * `openPostgres({ databaseUrl: ... })` is the shape to refuse. It is not a type error -- every other
     * field is optional, which is correct, because `databaseSchema` genuinely is optional for a
     * deployment that does not use one. That is exactly why the text has to be checked: the type system
     * cannot tell "this deployment has no schema" from "this call site forgot to pass it".
     */
    const offences: string[] = [];
    for (const { name, text } of sources()) {
      // A leading spread is the allowed form: `openPostgres({ ...config, connectionTimeoutMillis: 5_000 })`
      // keeps every field, including the one this test exists for, while still adding a timeout. `bin.ts`
      // does exactly that, and the first version of this pattern reported it.
      // The whitespace lives INSIDE the lookahead. With `\s*` outside it the regex simply backtracks to
      // zero spaces and matches anyway, which reported `bin.ts`'s correct spread as an offence.
      for (const match of text.matchAll(/openPostgres\(\s*\{(?!\s*\.\.\.)/g)) {
        const line = text.slice(0, match.index).split("\n").length;
        offences.push(`${name}:${line}`);
      }
    }
    expect(
      offences,
      "pass the loaded config itself (spread it if a timeout is needed) so databaseSchema cannot be dropped",
    ).toEqual([]);
  });

  it("build no pg.Pool of their own, which would bypass the search path entirely", () => {
    /**
     * The other way back to the bug. `pool.ts` exists because there were four `new Pool` sites and the
     * schema had to reach all of them; a fifth would be a connection with the default `search_path` and
     * no listener, which is the original defect with a new address.
     *
     * `pool.ts` itself is excluded -- it is where the one `new Pool` lives.
     */
    const offences = sources()
      .filter(({ name }) => name !== "pool.ts")
      .filter(({ text }) => /new Pool\s*\(/.test(text))
      .map(({ name }) => name);
    expect(offences, "connect through openPostgres in pool.ts instead").toEqual([]);
  });
});
