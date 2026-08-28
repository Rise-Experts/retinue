import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { publishingProblems, scopeOf, tableUnder } from "../../../../scripts/check-tool-effects.mjs";

/**
 * #228 — the exact list of tools that publish to the public under the operator's brand.
 *
 * **Literal here, on purpose.** `check:effects` reads the same set out of `docs/23-tool-catalogue.md`, which
 * catches a tool landing in code without a row. It cannot catch a *specified but unbuilt* tool being deleted
 * from that table — nothing in code references `x_post` yet, so nothing notices it is gone. That was the one
 * mutation of six that the script survived, and this closes it: the two have to agree, so removing a row means
 * deliberately editing a test that says why the tool no longer publishes.
 *
 * The reasoning for each entry is in the document, not duplicated here. What lives here is the *set*.
 */
const PUBLISHES_PUBLICLY = [
  // Built.
  "publish_post_now",
  "reply_to_comment",
  "retry_publish_target",
  "schedule_post",
  // Specified — REQ-053, issues #229 to #231.
  "instagram_publish_media",
  "instagram_reply_comment",
  "reddit_comment",
  "reddit_submit_post",
  "x_delete_post",
  "x_post",
] as const;

// Resolved from this module, not the working directory. `vitest` runs the backend project with `cwd` at
// `backend/`, so the repo-relative literal read fine under a direct `vitest run` and threw ENOENT in `ci:local`.
const CATALOGUE = fileURLToPath(new URL("../../../../docs/23-tool-catalogue.md", import.meta.url));

describe("the publishing gate (#228)", () => {
  const catalogue = readFileSync(CATALOGUE, "utf8");

  it("names exactly the tools the catalogue lists as publishing", () => {
    const listed = tableUnder(catalogue, "The publishing tools").map((row) => row.name);
    expect([...listed].sort()).toEqual([...PUBLISHES_PUBLICLY].sort());
  });

  it("gives every one of them an effect that derives approval and an idempotency key", () => {
    // Not a restatement of the check: this asserts the *document* cannot list a publishing tool as a read.
    // `defineTool` derives `approvalPolicy: "always"` from these two effects and nothing else, so any other
    // value here would ship a public broadcast with no gate.
    const effects = tableUnder(catalogue, "The publishing tools").map((row) => row.cells[2]);
    expect(effects.length).toBe(PUBLISHES_PUBLICLY.length);
    for (const effect of effects) expect(["`external-write`", "`destructive`"]).toContain(effect);
  });

  it("reports a publishing tool that overrides the derived approval policy", () => {
    // The failure #228 exists to prevent, exercised against the real checker rather than described.
    const problems = publishingProblems(
      [{ name: "x_post", cells: ["`x_post`", "`tools-x`", "`external-write`"] }],
      [{ name: "shell_exec" }],
      [{ name: "x_post", effect: "external-write", approvalPolicy: "never", category: "publishing" }],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("overrides the derived approval policy");
  });

  it("reports an outward write that is in neither list", () => {
    const problems = publishingProblems(
      [{ name: "x_post", cells: ["`x_post`", "`tools-x`", "`external-write`"] }],
      [{ name: "shell_exec" }],
      [{ name: "untriaged_broadcast", effect: "external-write", category: "engagement" }],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("appears in neither list");
  });

  it("excuses a whole package once, and refuses to for a package that publishes", () => {
    // The floor is airtight and would otherwise be unreadable: `tools-github` alone contributes twenty outward
    // writes and none of them broadcast. One row, one reason — but only for a package with no publishing surface.
    const wildcarded = [{ name: "tools-github/*" }];
    expect(
      publishingProblems(
        [{ name: "x_post", cells: ["`x_post`", "`tools-x`", "`external-write`"] }],
        wildcarded,
        [{ name: "github_write_file", effect: "external-write", scope: "tools-github" }],
      ),
    ).toEqual([]);

    // The loophole that matters, closed: a package cannot both publish and be excused wholesale.
    const bothWays = publishingProblems(
      [{ name: "x_post", cells: ["`x_post`", "`tools-x`", "`external-write`"] }],
      [{ name: "tools-x/*" }],
      [],
    );
    expect(bothWays).toHaveLength(1);
    expect(bothWays[0]).toContain("must name its outward writes individually");
  });

  it("maps a source file to the package the floor excuses", () => {
    expect(scopeOf("tools/github/src/index.ts")).toBe("tools-github");
    expect(scopeOf("backend/src/tools/registry.ts")).toBe("agentkit");
    expect(scopeOf("shareflow/src/tools/publishing.ts")).toBe("shareflow");
  });

  it("passes an outward write that the catalogue explicitly excuses", () => {
    // `reply_to_comment` is a public reply whose category is `engagement`, and `check_media_storage` is an
    // external write that reaches nobody — which is why the gate is a list and not a category rule.
    expect(
      publishingProblems(
        [{ name: "x_post", cells: ["`x_post`", "`tools-x`", "`external-write`"] }],
        [{ name: "check_media_storage" }],
        [{ name: "check_media_storage", effect: "external-write", category: "media" }],
      ),
    ).toEqual([]);
  });
});
