/**
 * Proves the effect check can actually read a declaration — which it could not, at first.
 *
 * The original parser used one regex with a lazy window and a `(?=name:|$)` lookahead. That fails outright when
 * two declarations sit further apart than the window, so it found **zero** tools in a file containing five and
 * the check reported a clean scan of 27 files having examined nothing. Every test below exists because of that:
 * the interesting property of this check is not what it rejects but that it *sees* anything at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { declarationsIn, EXEMPT, READ_VERBS, WRITE_VERBS } from "./check-tool-effects.mjs";

/** The naming rule, mirrored so it can be asserted directly. Kept in step by the two tests below. */
const looksLikeAWrite = (name) => {
  const segments = name.split("_");
  if (segments[0] !== undefined && READ_VERBS.includes(segments[0])) return false;
  return segments.slice(0, 2).some((segment) => WRITE_VERBS.includes(segment));
};

test("finds declarations that are far apart", () => {
  // The regression. 900 characters between them — more than any fixed window.
  const source = [
    'defineTool({ name: "first_thing", effect: "read",', "  ".repeat(450), "});",
    'defineTool({ name: "create_thing", effect: "external-write" });',
  ].join("\n");
  const found = declarationsIn(source);
  assert.deepEqual(found.map((f) => f.name), ["first_thing", "create_thing"]);
  assert.equal(found[1]?.effect, "external-write");
});

test("an unstated effect is read, and says so", () => {
  const found = declarationsIn('defineTool({ name: "send_report", description: "x" });');
  assert.deepEqual(found, [{ name: "send_report", effect: "read", via: "default" }]);
});

test("a wrapper's classification comes from the wrapper, not from a field", () => {
  const source = 'confirms({ name: "create_issue", description: "x" });\ndestroys({ name: "delete_repo", description: "y" });';
  const found = declarationsIn(source);
  assert.deepEqual(found, [
    { name: "create_issue", effect: "external-write", via: "confirms" },
    { name: "delete_repo", effect: "destructive", via: "destroys" },
  ]);
});

test("a name is not counted twice when a wrapper already claimed it", () => {
  // `confirms` matches first; the generic pass must not then re-read the same declaration as a default read.
  const found = declarationsIn('confirms({ name: "post_message", description: "x" });');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.effect, "external-write");
});

test("the effect nearest a name belongs to that name", () => {
  // Two declarations, one effect each: a window that ran past the next `name:` would attribute the wrong one.
  const source = 'defineTool({ name: "read_thing", effect: "read" });\ndefineTool({ name: "update_thing", effect: "external-write" });';
  const found = declarationsIn(source);
  assert.equal(found.find((f) => f.name === "update_thing")?.effect, "external-write");
  assert.equal(found.find((f) => f.name === "read_thing")?.effect, "read");
});

test("a vendor-prefixed write is recognised — the bug that made this check do nothing", () => {
  /**
   * The first version matched only the *leading* segment, and the whole catalogue convention is
   * `<vendor>_<verb>_<object>`. So `github_create_issue` sailed past it and the check reported the same count
   * before and after the first toolkit package was added — doing nothing for the twenty-one packages it exists
   * to protect. That identical count is what exposed it.
   */
  assert.equal(looksLikeAWrite("github_create_issue"), true);
  assert.equal(looksLikeAWrite("slack_post_message"), true);
  assert.equal(looksLikeAWrite("github_merge_pull_request"), true);
  assert.equal(looksLikeAWrite("create_issue"), true);
});

test("a leading read verb wins over a noun that happens to be a verb", () => {
  // `get_post_metrics` and `propose_post_angles` both contain "post" as a *noun*. Without this rule the check
  // fires on correct code, which is the false-positive shape that gets a check deleted rather than fixed.
  assert.equal(looksLikeAWrite("get_post_metrics"), false);
  assert.equal(looksLikeAWrite("propose_post_angles"), false);
  assert.equal(looksLikeAWrite("validate_publish"), false);
  assert.equal(looksLikeAWrite("github_search_code"), false);
  assert.equal(looksLikeAWrite("github_list_issues"), false);
});

test("the verb list covers the imperative forms a tool name actually takes", () => {
  for (const verb of ["create", "delete", "send", "publish", "merge"]) assert.ok(WRITE_VERBS.includes(verb), verb);
});

test("every exemption carries a reason", () => {
  // The pattern check-boundaries and check-terminology use: an exemption is allowed and has to be argued for in
  // writing, so the decision survives whoever made it.
  for (const [name, reason] of EXEMPT) {
    assert.equal(typeof reason, "string", name);
    assert.ok(reason.length > 20, `${name}'s reason is too short to be a reason`);
  }
});
