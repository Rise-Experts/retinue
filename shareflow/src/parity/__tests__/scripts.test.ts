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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OLD_RUNTIME_REFERENCE_SCOPE } from "../index.js";

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
     * The case this script exists for.
     *
     * `OLD_RUNTIME_REFERENCE_SCOPE.roots` are `web/src` and `ai_backend/app`, and **neither exists** in the
     * `social_integgration` directory on the machine this was written on. A scanner that walked a missing
     * directory and reported 0 would hand `canRemoveOldRuntime` a clean bill of health for a scan that looked at
     * nothing — and the removal it then permits deletes a live customer runtime.
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

  it("exits 1 on too little data, and calls it insufficient rather than failed", async () => {
    /**
     * Two runs against gates needing 200 and 500.
     *
     * This asserted `gate-not-agreed` until the gates were signed on 2026-08-24. Now the same input produces
     * `insufficient-sample`, and the distinction is the point: "not enough data to say" and "the new runtime
     * diverges" are different findings, and reporting the first as the second would stop a cutover that nothing
     * is wrong with.
     *
     * Still exit 1, because neither is a pass.
     */
    const path = await withShadow("good.json", [pair("create-post"), pair("publish")]);
    const { code, stdout } = await exec("parity-report.mjs", ["--shadow", path]);
    expect(code).toBe(1);
    expect(stdout).toContain("insufficient-sample");
    expect(stdout).not.toContain("failed");
    // And no longer this, which is how the signing is visible end to end rather than only in the gate file.
    expect(stdout).not.toContain("gate-not-agreed");
    // Every gated workflow appears, including those with no data — a workflow missing from the report reads as
    // one with nothing to answer for.
    for (const workflow of ["create-post", "publish", "campaign-planning", "repurpose", "engagement-reply"])
      expect(stdout).toContain(workflow);
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
    // Blocked on evidence now, not on paperwork: every measurable gate is short of its sample.
    expect(stdout).toContain("insufficient-sample");
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
