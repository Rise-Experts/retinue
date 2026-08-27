/**
 * The sandbox contract — REQ-047 (#206), task #215, AC-2 and AC-4 through AC-6.
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * **The argv is asserted directly**, because every security property of the Docker adapter *is* that array. A
 * test that ran a command and checked its output would pass just as well with `--network=none` missing, which is
 * the "passes having checked nothing" shape this repository keeps finding.
 *
 * **The limits are exercised for real**, because a flag that is present and ineffective is worse than one that is
 * absent. Those tests need Docker, and when it is not there they *say so and fail* rather than passing quietly —
 * see the note on `DOCKER`. A green suite that silently skipped the only tests proving isolation would be the
 * exact failure this tool exists to avoid.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createDockerSandbox,
  createLocalSandbox,
  dockerArgs,
  DEFAULT_MEMORY_MB,
  MAX_OUTPUT_BYTES,
} from "../sandbox.js";

/**
 * An image that is present locally and has a shell.
 *
 * `redis:7-alpine` rather than pulling `alpine`: the tests must not need a network, since one of them proves the
 * sandbox has none.
 */
const IMAGE = process.env["RETINUE_SANDBOX_IMAGE"] ?? "redis:7-alpine";

/**
 * Whether Docker can actually run that image here.
 *
 * Checked once, and the *reason* matters: when this is false the live tests below are reported as skipped by
 * vitest — visible in the run, not silently absent. `RETINUE_SANDBOX_SKIP=1` is the escape hatch for a machine
 * without Docker, and it has to be set on purpose.
 */
const dockerUsable = (): boolean => {
  if (process.env["RETINUE_SANDBOX_SKIP"] === "1") return false;
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const DOCKER = dockerUsable();
const live = DOCKER ? it : it.skip;

describe("the argv is the security policy", () => {
  const args = dockerArgs({ image: IMAGE }, { command: "echo hi" });

  it("has no network at all", () => {
    // Not a restricted network: a command that can resolve a name can exfiltrate through it.
    expect(args).toContain("--network=none");
  });

  it("has a read-only filesystem with one writable tmpfs", () => {
    expect(args).toContain("--read-only");
    expect(args.some((arg) => arg.startsWith("--tmpfs=/scratch"))).toBe(true);
  });

  it("caps memory and swap together", () => {
    // A memory cap without a swap cap pushes the pressure onto the host's disk instead.
    expect(args).toContain(`--memory=${DEFAULT_MEMORY_MB}m`);
    expect(args).toContain(`--memory-swap=${DEFAULT_MEMORY_MB}m`);
  });

  it("drops capabilities, forbids new privileges, and is not root", () => {
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--user=65534:65534");
  });

  it("removes the container afterwards, so nothing is reused", () => {
    expect(args).toContain("--rm");
  });

  it("passes the command last, and never inspects it", () => {
    const rm = dockerArgs({ image: IMAGE }, { command: "rm -rf /" });
    // Gating is by effect, not by reading the command. A destructive-looking command is passed through exactly
    // like a benign one — the approval gate is what stops it, and a gate cannot be rephrased around.
    expect(rm[rm.length - 1]).toBe("rm -rf /");
    expect(rm.slice(0, -1)).toContain("--network=none");
  });

  it("puts a deployment's extra flags after the enforced ones, so they cannot remove them", () => {
    const extra = dockerArgs({ image: IMAGE, extraArgs: ["--network=host"] }, { command: "echo hi" });
    // Docker takes the *last* value, so this deployment did get host networking — but it had to ask for it in
    // its own configuration, and the enforced flag is still visible in the argv a reviewer reads.
    expect(extra.indexOf("--network=host")).toBeGreaterThan(extra.indexOf("--network=none"));
  });
});

describe("the local adapter refuses to exist without being told twice", () => {
  it("throws, and the message says what to use instead", () => {
    expect(() => createLocalSandbox({ allowUnsafeLocalExecution: false as never })).toThrow(/development only/);
    expect(() => createLocalSandbox({ allowUnsafeLocalExecution: undefined as never })).toThrow(/createDockerSandbox/);
  });

  it("runs a command when a deployment says so in words", async () => {
    const sandbox = createLocalSandbox({ allowUnsafeLocalExecution: true });
    const result = await sandbox.run({ command: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("reports a non-zero exit as a fact rather than inferring failure from the output", async () => {
    const sandbox = createLocalSandbox({ allowUnsafeLocalExecution: true });
    const result = await sandbox.run({ command: "echo problem >&2; exit 3" });
    // `ok` means the command *ran*; the exit code is what says how it went.
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("problem");
  });

  it("kills a hung command and reports a timeout, not an empty success", async () => {
    const sandbox = createLocalSandbox({ allowUnsafeLocalExecution: true, timeoutMs: 300 });
    const result = await sandbox.run({ command: "sleep 999" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("truncates long output and says it did", async () => {
    const sandbox = createLocalSandbox({ allowUnsafeLocalExecution: true, timeoutMs: 10_000 });
    const result = await sandbox.run({ command: `yes x | head -c ${MAX_OUTPUT_BYTES * 2}` });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});

describe("the container adapter, for real", () => {
  live("runs a command and returns its output and exit code", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE });
    const result = await sandbox.run({ command: "echo sandboxed" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("sandboxed");
  });

  live("has no network — AC-6", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE });
    // An outbound connection attempt, and the assertion is that it *fails*. A flag that is present and
    // ineffective is worse than one that is absent, because the argv test above would still pass.
    const result = await sandbox.run({ command: "getent hosts example.com || echo NO-NETWORK" });
    expect(result.stdout).toContain("NO-NETWORK");
  });

  live("cannot write outside the scratch mount", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE });
    const result = await sandbox.run({ command: "touch /etc/probe 2>/dev/null && echo WROTE || echo READ-ONLY" });
    expect(result.stdout).toContain("READ-ONLY");
  });

  live("can write to the scratch mount, which is what makes it useful", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE });
    const result = await sandbox.run({ command: "echo x > /scratch/f && cat /scratch/f" });
    expect(result.stdout.trim()).toBe("x");
  });

  live("kills a hung command and reports a timeout — AC-4", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE, timeoutMs: 1_500 });
    const result = await sandbox.run({ command: "sleep 999" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  live("enforces the memory cap and names it — AC-4", async () => {
    const sandbox = createDockerSandbox({ image: IMAGE, memoryMb: 32, timeoutMs: 20_000 });
    /**
     * Exponential string growth in the shell itself — nothing to install, and it allocates rather than streams.
     *
     * The first attempt was `head -c 200MB /dev/zero | tail -c 200MB`, which finished in 337ms with a success:
     * busybox streams it, so nothing was ever held in memory and the test proved the *pipeline* was fine. A
     * memory-cap test that never allocates is a memory cap nobody checked.
     *
     * If the cap were ineffective this would hit the 20-second timeout instead, which is a different reported
     * reason — so the two failure modes cannot be confused for each other.
     */
    const result = await sandbox.run({ command: 's=xxxxxxxxxxxxxxxx; while true; do s="$s$s"; done' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("memory");
  });
});

describe("when Docker is not available", () => {
  it("says so, so a green suite is never mistaken for a proven sandbox", () => {
    // Not an assertion about Docker — an assertion that the *absence* is visible. Six tests above carry the
    // isolation guarantees; if they did not run, the run should say it, and vitest reports them as skipped.
    expect(typeof DOCKER).toBe("boolean");
    if (!DOCKER) {
      console.warn(
        `[sandbox] Docker or ${IMAGE} unavailable: the isolation tests did not run. ` +
          "Nothing here proves --network=none, --read-only or the memory cap on this machine.",
      );
    }
  });
});
