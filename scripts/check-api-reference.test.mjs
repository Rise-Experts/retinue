/**
 * The published API reference documents the platform, not its consumers.
 *
 * `website/typedoc.json`'s `entryPoints` decide what gets rendered to `/api/**` and served from
 * `docs.retinue.riseexperts.de`. `../shareflow/src/index.ts` was one of them, and the result was **404 URLs in
 * the sitemap** under `/api/shareflow/src/` — every exported function and type of the ShareFlow integration,
 * with its docstrings attached. Those docstrings are where the integration's reasoning lives: ShareFlow's table
 * names, its schema quirks, which platform refuses to delete what. None of it is a credential; all of it is
 * Chorus's product design, and this repository is public so npm can generate release provenance.
 *
 * TypeDoc's config is JSON and takes no comments, so a rule written *in* it is a rule nobody sees. This is the
 * rule: an entry point may only be a package this repository ships. A second consumer added later — Twenty is
 * the one already named in the architecture — would publish its internals exactly the same way, and would do it
 * silently, because nothing about adding a path to a JSON array looks like publishing a customer's design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(HERE, "../website/typedoc.json");

/**
 * The packages this repository ships, and therefore the only legal entry points.
 *
 * Derived from `private: false` rather than listed: a package that is published is a package whose API is
 * already public by definition, so documenting it adds no exposure. An integration package is `private: true`
 * for exactly that reason, which makes the manifest the honest test rather than a name match on "shareflow".
 */
const shipped = () => {
  const names = [];
  for (const dir of ["backend", "frontend", "examples", "website", "services/api"]) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(HERE, "..", dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (manifest.private !== true) names.push(dir);
  }
  return names;
};

test("the API reference has no entry point in a package this repository does not publish", () => {
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const publishable = shipped();

  for (const entry of config.entryPoints) {
    // `../backend/src/index.ts` → `backend`
    const workspace = entry.replace(/^\.\.\//, "").split("/src/")[0];
    assert.ok(
      publishable.includes(workspace),
      `website/typedoc.json documents "${entry}", and ${workspace} is not a package this repository ` +
        `publishes — so its whole exported surface, docstrings included, would be served from the public ` +
        `docs site. Publishable: ${publishable.join(", ")}. See website/README.md.`,
    );
  }

  // The scan found the entry points rather than nothing: an empty array would satisfy the loop above.
  assert.ok(config.entryPoints.length >= 2, `expected entry points, found ${config.entryPoints.length}`);
});

test("a private workspace is not publishable, which is what makes it illegal as an entry point", () => {
  /**
   * The premise the test above rests on, asserted separately so a change to it fails here rather than
   * quietly widening what may be documented.
   *
   * `shareflow` used to be the subject: it was the package whose exported surface reached the public docs
   * site as 404 sitemap URLs, and it was `private: true`, which is what made documenting it illegal. It has
   * since moved to the product's own repository, so the premise is asserted against whatever private
   * workspace exists rather than against that one name — a name match would have quietly become vacuous
   * the moment the directory disappeared, and this file's whole argument is that the manifest is the honest
   * test rather than a name.
   */
  const candidates = ["backend", "frontend", "examples", "website", "services/api"];
  const privateOnes = candidates.filter((dir) => {
    try {
      return JSON.parse(readFileSync(resolve(HERE, "..", dir, "package.json"), "utf8")).private === true;
    } catch {
      return false;
    }
  });
  // At least one, or the rule is unexercised and this test proves nothing about it.
  assert.ok(privateOnes.length > 0, "no private workspace remains, so the publishable/private split is untested");
  for (const dir of privateOnes) assert.ok(!shipped().includes(dir), `${dir} is private but counted as shipped`);
});
