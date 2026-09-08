/**
 * The two runnable halves of #128 — `scan-old-runtime.mjs` and `parity-report.mjs`.
 *
 * `evaluateParity` and `canRemoveOldRuntime` were tested library functions with nothing that ran them, and
 * `canRemoveOldRuntime` wanted a `remainingReferences` count that nothing produced. A gate only reachable by a
 * caller typing the number in is a gate that gets satisfied by assertion at the moment it matters most.
 *
 * Spawned as processes rather than imported, because the thing under test is the **contract an operator and a
 * checklist rely on**: the exit code. Exercising the module's internals would leave exactly the part a runbook
 * quotes untested.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OLD_RUNTIME_REFERENCE_SCOPE } from "../index.js";
import { CAPABILITY_INVENTORY, coverageOf } from "../../inventory/index.js";

const run = promisify(execFile);
const SCRIPTS = resolve(import.meta.dirname, "../../../scripts");

/** Exit codes are the interface, so a failure has to be inspected rather than thrown away. */
const exec = async (script: string, args: readonly string[]) => {
  try {
    const { stdout, stderr } = await run("node", [join(SCRIPTS, script), ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "agentkit-parity-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("scan-old-runtime.mjs", () => {
  it("exits 2 when the repository is not there, rather than reporting zero references", async () => {
    const { code, stderr } = await exec("scan-old-runtime.mjs", ["--root", join(work, "absent")]);
    // 2 and not 1: "could not scan" has to be distinguishable from "scanned and found things".
    expect(code).toBe(2);
    expect(stderr).toContain("not here");
  });

  it("exits 2 when a configured root is missing", async () => {
    /**
     * The case this script exists for: a scanner that walked a missing directory and reported 0 would hand
     * `canRemoveOldRuntime` a clean bill of health for a scan that looked at nothing — and the removal it then
     * permits deletes a live customer runtime.
     *
     * This docstring used to say `web/src` and `ai_backend/app` exist nowhere on this machine. They do. What
     * did not exist was the path the script defaulted to: one directory too far up, onto a decoy
     * `social_integgration` holding only `supabase/`. So the only outcome the script could produce was "could
     * not scan", and a lesson about the world was drawn from a wrong constant. It resolves the root by looking
     * for the configured directories now, and reports 71 referencing files against a baseline of 71.
     */
    const empty = join(work, "empty-repo");
    await mkdir(empty, { recursive: true });
    const { code, stderr } = await exec("scan-old-runtime.mjs", ["--root", empty]);
    expect(code).toBe(2);
    expect(stderr).toContain("did not look");
    for (const root of OLD_RUNTIME_REFERENCE_SCOPE.roots) expect(stderr).toContain(root);
  });

  it("counts referencing files, skips dependencies, and groups them for sequencing", async () => {
    const repo = join(work, "repo");
    await mkdir(join(repo, "web/src/lib/assistant"), { recursive: true });
    await mkdir(join(repo, "web/src/app"), { recursive: true });
    await mkdir(join(repo, "ai_backend/app/agents"), { recursive: true });
    await mkdir(join(repo, "web/src/node_modules/pkg"), { recursive: true });
    await writeFile(join(repo, "web/src/lib/assistant/client.ts"), 'import { Agno } from "agno";');
    await writeFile(join(repo, "web/src/lib/assistant/legacy.ts"), "// AgentOS lives here");
    await writeFile(join(repo, "web/src/app/page.tsx"), "nothing to see");
    await writeFile(join(repo, "ai_backend/app/agents/run.py"), "from agno import Agent");
    // A dependency mentioning the old runtime is not the old runtime's source, and counting it would make the
    // number never reach zero.
    await writeFile(join(repo, "web/src/node_modules/pkg/index.js"), "agno agno agno");

    const { code, stdout } = await exec("scan-old-runtime.mjs", ["--root", repo, "--json"]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      ok: boolean;
      remainingReferences: number;
      hotspots: { path: string; files: number }[];
      files: string[];
    };
    expect(result.ok).toBe(true);
    // Three: two under web/src, one under ai_backend. Not four — `node_modules` is skipped. Not one — the
    // case-insensitive match has to find `AgentOS` as well as `agno`.
    expect(result.remainingReferences).toBe(3);
    expect(result.files).not.toContain("web/src/node_modules/pkg/index.js");
    expect(result.hotspots[0]).toEqual({ path: "web/src/lib/assistant", files: 2 });
  });

  it("reports zero, and exits zero, for a checkout with no references left", async () => {
    // The state AC-5 is asking about. It must be reachable, or the check can never be satisfied honestly.
    const clean = join(work, "clean");
    await mkdir(join(clean, "web/src"), { recursive: true });
    await mkdir(join(clean, "ai_backend/app"), { recursive: true });
    await writeFile(join(clean, "web/src/index.ts"), "export const x = 1;");
    const { code, stdout } = await exec("scan-old-runtime.mjs", ["--root", clean, "--json"]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { remainingReferences: number }).remainingReferences).toBe(0);
  });
});

describe("scan-old-runtime-capabilities.mjs — REQ-041 AC-1", () => {
  it("exits 2 when the old runtime is not at any path tried, listing them", async () => {
    /**
     * The same refusal as the reference scan, for the same reason and one level higher: this script produces
     * the *inventory's* ground truth. A run that could not read `ai_backend` and emitted an empty manifest
     * would produce an inventory with nothing to cover — every capability accounted for, because there are
     * none.
     */
    const { code, stderr } = await exec("scan-old-runtime-capabilities.mjs", ["--root", join(work, "absent")]);
    expect(code).toBe(2);
    expect(stderr).toContain("not at any path tried");
    // The paths, so the fix is "point it at the right checkout" rather than "why".
    expect(stderr).toContain("tried:");
    expect(stderr).toContain("ai_backend/app/assistant/tools.py");
  });

  it("exits 2 when an extractor finds fewer than could possibly be true", async () => {
    /**
     * The failure that points the wrong way. A regex that stops matching after an upstream refactor reports
     * **zero** tools, and zero old capabilities means an inventory covering all of them — a passing gate
     * produced by a broken scan. Every extractor declares the smallest count that could be true.
     */
    const skeleton = join(work, "skeleton");
    await mkdir(join(skeleton, "ai_backend/app/assistant"), { recursive: true });
    await mkdir(join(skeleton, "ai_backend/skills"), { recursive: true });
    await mkdir(join(skeleton, "web/src/app/api"), { recursive: true });
    await mkdir(join(skeleton, "supabase/migrations"), { recursive: true });
    for (const file of ["tools.py", "agent.py", "studio.py", "specialists.py", "factory.py"]) {
      await writeFile(join(skeleton, "ai_backend/app/assistant", file), "# nothing here\n");
    }
    await writeFile(join(skeleton, "ai_backend/app/main.py"), "# no routes\n");

    const { code, stderr } = await exec("scan-old-runtime-capabilities.mjs", ["--root", skeleton]);
    expect(code).toBe(2);
    expect(stderr).toContain("fewer than could possibly be true");
    expect(stderr).toContain("tools=0");
  });

  it("agrees with the committed snapshot, when the old runtime is checked out", async () => {
    /**
     * The check that stops the inventory rotting. The snapshot is committed so these tests run without
     * `social_integgration`, and a committed snapshot is a claim that goes stale silently: a tool added to the
     * old runtime would widen the gap the inventory says it has measured, with nothing failing.
     *
     * Skipped rather than failed when the repository is absent, the same way the live-Postgres suite skips
     * without its URL — and the skip is visible in the run output rather than a silent pass.
     */
    const { code, stdout, stderr } = await exec("scan-old-runtime-capabilities.mjs", ["--check"]);
    if (code === 2) {
      expect(stderr).toContain("not at any path tried");
      return;
    }
    expect(`${stdout}${stderr}`, "regenerate with --write src/inventory/old-runtime.ts").toContain(
      "matches the source",
    );
    expect(code).toBe(0);
  });
});

describe("the report reads the inventory — REQ-041 AC-2", () => {
  it("passes the real inventory to evaluateParity, scanned from the source", async () => {
    /**
     * A source scan, because the behaviour is not visible in the output the day the inventory is complete.
     *
     * `evaluateParity(reportsByWorkflow, [])` typechecks, runs, and prints a full report — every workflow
     * measured against no capabilities, which is exactly the state this AC found the script in. Once every
     * capability is `implemented` the two calls produce identical output, so an assertion on `stdout` would
     * stop protecting anything at the moment it matters. The call itself is what has to be pinned.
     */
    const source = await readFile(resolve(SCRIPTS, "parity-report.mjs"), "utf8");
    expect(source).toContain("evaluateParity(reportsByWorkflow, CAPABILITY_INVENTORY)");
    expect(source).not.toMatch(/evaluateParity\(\s*reportsByWorkflow\s*\)/);
  });

  it("derives shadow coverage rather than accepting it — AC-3", () => {
    // `coverageOf` takes a run list and nothing per capability. Asserted structurally because the guarantee is
    // the absence of an input: an entry's author is the person most likely to believe it is covered.
    expect(Object.keys(coverageOf({ entries: [], shadowRuns: [] }))).toEqual([]);
    const coverage = coverageOf({
      entries: CAPABILITY_INVENTORY.filter((e) => e.replacement === "publish_post_now"),
      shadowRuns: [{ toolsCalled: ["publish_post_now"] }, { toolsCalled: ["create_post_draft"] }],
    });
    expect(coverage[0]?.shadowRuns).toBe(1);
  });
});

describe("parity-report.mjs", () => {
  const pair = (workflow: string, extraWriteOnNew = false) => {
    const write = {
      toolName: "create_post",
      delegatesTo: "shareflow.createPost",
      effect: "internal-write",
      input: { caption: "hello" },
      idempotencyKey: `k-${workflow}-${String(extraWriteOnNew)}`,
      requiredApproval: false,
    };
    const extra = {
      toolName: "publish_post",
      delegatesTo: "shareflow.publish",
      effect: "external-write",
      input: { destination: "instagram" },
      idempotencyKey: "extra",
      requiredApproval: true,
    };
    return {
      workflow,
      old: { workflow, runtime: "agno", writes: [write] },
      new: { workflow, runtime: "agentkit", writes: extraWriteOnNew ? [write, extra] : [write] },
    };
  };

  const withShadow = async (name: string, pairs: unknown) => {
    const path = join(work, name);
    await writeFile(path, JSON.stringify(pairs));
    return path;
  };

  it("exits 2 with no input rather than evaluating an empty set", async () => {
    // An empty set makes every measurable gate `insufficient-sample`, which reads like a result and is not one.
    const { code, stderr } = await exec("parity-report.mjs", []);
    expect(code).toBe(2);
    expect(stderr).toContain("nothing to evaluate");
  });

  it("exits 2 on an empty array", async () => {
    const path = await withShadow("empty.json", []);
    const { code } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(2);
  });

  it("refuses malformed pairs instead of dropping them", async () => {
    // Dropping them silently shrinks the sample the gate is measured against — towards the threshold, unseen.
    const path = await withShadow("bad.json", [{ workflow: "create-post" }, pair("create-post")]);
    const { code, stderr } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(2);
    expect(stderr).toContain("malformed");
  });

  it("reports a run with no old-runtime half rather than crashing on it", async () => {
    /**
     * **The input the migration actually has**, and the script threw an unhandled `TypeError` on it:
     * `Cannot read properties of null (reading 'workflow')`.
     *
     * The guard was `pair?.old === undefined`, and **JSON cannot express `undefined`** — a file's absent half
     * is `null`, which is not `undefined`, so it passed the check and reached `diffShadowRuns`. The one script
     * whose job is to refuse bad input crashed on the most likely bad input there is.
     *
     * It is also a distinct case from malformed, and conflating them misdirects a reader: the new runtime can
     * be recorded today and the Agno side cannot, so a file of new-only runs is the expected first artefact.
     */
    const one = pair("create-post");
    const path = await withShadow("unpaired.json", [{ workflow: "create-post", old: null, new: one.new }]);
    const { code, stderr } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(2);
    expect(stderr).toContain("no old-runtime half");
    // Not called malformed, because it is not.
    expect(stderr).not.toContain("malformed");
    // And it says what to do next, which is the whole point of distinguishing the two.
    expect(stderr).toContain("Agno");
  });

  it("refuses a pair naming a workflow no gate covers, instead of counting it and measuring nothing", async () => {
    /**
     * `evaluateParity` reports per gate, so a pair keyed `publish-post` where the gate is `publish` fed
     * nothing while still appearing in the "N shadow pairs" headline. The gate printed `0 run(s)` and the
     * header said one pair, and nothing connected the two — I misread that output as a counted run.
     *
     * Same reasoning the script already applies to malformed pairs, and the same hole.
     */
    const path = await withShadow("unknown-workflow.json", [pair("publish-post")]);
    const { code, stderr } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(2);
    expect(stderr).toContain("no gate covers");
    // The valid names, so the fix does not need a source dive.
    expect(stderr).toContain("create-post");
  });

  it("labels the gate-agreement column, which reads as a run count without one", async () => {
    /**
     * `1 run(s)  agreed` sat two spaces after a run count and means something else entirely: whether a person
     * has agreed the *gate*. A divergent run under an agreed gate prints exactly that string.
     */
    const path = await withShadow("labelled.json", [pair("create-post")]);
    const { stdout } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(stdout).toContain("gate agreed?");
    expect(stdout).toContain("shadow runs");
  });

  it("reports incomplete before it reports anything about the numbers — REQ-041 AC-2", async () => {
    /**
     * Two runs against gates needing 200 and 500, which used to print `insufficient-sample`. It now prints
     * `incomplete` for every measurable workflow, and the change is the AC rather than a regression.
     *
     * The report reads the inventory now. It did not: `evaluateParity` was called with no capabilities, so the
     * `incomplete` verdict #194 built — and the `○` glyph this script already had a symbol for — **could not be
     * produced by the script whose job is to produce it**. Every workflow was measured on runs where both
     * runtimes wrote nothing, and reported on the rate.
     *
     * `insufficient-sample` is unreachable through the real inventory today, and that is the intended
     * precedence: capabilities are checked before the numbers, because the numbers are the thing that lies. Its
     * own behaviour is asserted directly in `parity.test.ts`, against a gate given a complete capability set.
     *
     * Still exit 1, because `incomplete` is not a pass.
     */
    const path = await withShadow("good.json", [pair("create-post"), pair("publish")]);
    const { code, stdout } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(1);
    expect(stdout).toContain("incomplete");
    /**
     * Named, so the report says what to build rather than that something is wrong.
     *
     * This asserted on `repost a published post (missing)` until REQ-041 built it. `publish` has no unbuilt
     * capabilities at all now — the first workflow to get there — so the assertion moved to one that still
     * does. When `campaign-planning` is finished this line moves again, which is the point of naming them.
     */
    expect(stdout).toContain("plan a campaign agentically (missing)");
    expect(stdout).toContain("cannot be distinguished from one that agrees");
    expect(stdout).not.toContain("failed");
    /**
     * `gate-not-agreed` appears exactly once, on `documents`, and nowhere else — which is how both signings
     * are visible end to end rather than only in the gate file.
     *
     * It used to appear nowhere: every gate was signed on 2026-08-24. `documents` arrived with REQ-041's
     * artifact tools, *after* shadow data existed, so agreeing its threshold now would be the thing #128 AC-1
     * forbids. A blocking unsigned gate is the correct state and this pins that it is the only one.
     */
    const notAgreed = stdout
      .split("\n")
      .filter((line) => line.includes("gate-not-agreed"))
      .map((line) => line.trim().split(/\s+/)[1]);
    expect(notAgreed).toEqual(["documents"]);
    // Every gated workflow appears, including those with no data — a workflow missing from the report reads as
    // one with nothing to answer for.
    for (const workflow of ["create-post", "publish", "campaign-planning", "repurpose", "engagement-reply"])
      expect(stdout).toContain(workflow);
  });

  it("names who signed each drop, and does not report a drop as an untested replacement", async () => {
    /**
     * Two assertions, both about the same defect in the first version of this output: it filtered
     * `status !== "missing"`, so the eight signed drops were swept in beside the real replacements and printed
     * as "implemented and never exercised" — 18 where there are 12. A dropped capability has no replacement to
     * exercise, and reporting it as an untested one describes work that does not exist.
     *
     * The names are printed because a drop is the one status whose control is a *person* rather than a
     * measurement. "8 dropped" without them says eight customer-visible capabilities went away on somebody's
     * authority, without saying whose.
     */
    const path = await withShadow("drops.json", [pair("create-post")]);
    const { stdout } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(stdout).toContain("dropped by agreement: 8");
    expect(stdout).toContain("change the brand profile — Azeem Sarwar, 2026-09-07");
    expect(stdout).toContain("replaced and never exercised");
    for (const entry of CAPABILITY_INVENTORY.filter((e) => e.status === "dropped")) {
      expect(stdout).not.toContain(`○ ${entry.capability}`);
    }
  });

  it("prints a symbol for every verdict it can produce", async () => {
    // The script throws at startup if `VERDICTS` gains a value with no symbol. The first version spelled one key
    // `gate-unagreed`, which does not exist, so every unagreed gate rendered as `?` — the same glyph as
    // "unrecognised".
    const path = await withShadow("symbols.json", [pair("create-post")]);
    const { stdout, stderr } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(stderr).not.toContain("no symbol for verdict");
    expect(stdout).not.toContain("? create-post");
  });

  it("blocks the removal while a gate is unpassed, and lists every reason", async () => {
    // #128 test step 2: attempt the removal while a gate is unpassed, and assert the checklist blocks it.
    const path = await withShadow("removal.json", [pair("create-post"), pair("publish")]);
    const { code, stdout } = await exec("parity-report.mjs", [
      "--shadow",
      path,
      "--removal",
      "--signed-off-by",
      "Someone",
      "--references",
      "0",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("removal: BLOCKED");
    /**
     * Blocked on evidence, not on paperwork — and since REQ-041 the evidence it is short of is *capabilities*
     * rather than sample size. Nine of the old runtime's tools have no replacement at all, so five of the seven
     * gated workflows report `incomplete`; the sample would matter next, on a day the inventory is complete.
     */
    expect(stdout).toContain("incomplete");
    expect(stdout).toContain("inventory: incomplete");
    /**
     * And **not** on the data question any more.
     *
     * It blocked on that until 2026-08-24, when it was decided out-of-scope. Asserting its absence is what proves
     * the decision reached the check rather than only the record — the same class of gap as a limit configured
     * and never resolved.
     */
    expect(stdout).not.toContain("historical Agno conversation data");
  });

  it("does not pass a reference count the caller did not supply", async () => {
    // Omitting `--references` must not read as zero. "I did not look" and "there are none" cannot be the same
    // value, which is what `scan-old-runtime.mjs` produces the number for.
    const path = await withShadow("noref.json", [pair("create-post")]);
    const { stdout } = await exec("parity-report.mjs", ["--shadow", path, "--removal", "--signed-off-by", "Someone"]);
    expect(stdout).toContain("removal: BLOCKED");
    expect(stdout).toMatch(/scan|reference/i);
  });
});
