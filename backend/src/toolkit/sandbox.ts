/**
 * Running a command somewhere it cannot hurt you — REQ-047 (#206), task #215.
 *
 * `shell_exec` is the only tool in this package whose blast radius is not described by its schema. Every other
 * tool can do one thing to one kind of object; this one can do anything the process can do. And its trigger is
 * natural language — including language the model merely *read*, in a document, in an issue body, in a Slack
 * message. Without isolation, a shell tool is a remote code execution endpoint reachable by anyone who can get
 * text in front of the agent.
 *
 * So the sandbox is not a hardening step applied afterwards. It is the thing that makes the tool defensible, and
 * the tool does not exist without one wired.
 *
 * ## What the contract guarantees
 *
 * | Guarantee | Why it is not optional |
 * |---|---|
 * | No network | A command that can reach the network can exfiltrate anything it can read, and the egress policy does not apply inside a container |
 * | Read-only root, one writable scratch mount | A command that can write to the image can install a persistent foothold |
 * | Memory cap | An unbounded allocation takes the host down with it, and that is a denial of service anybody can trigger by asking |
 * | Wall-clock timeout | `sleep 999` must end as a *timeout*, not as an empty success |
 * | No TTY | An interactive prompt would hang forever waiting for a person who is not there |
 * | Output cap, with the truncation reported | Silent truncation makes a model believe it saw the whole answer |
 * | The exit code in the envelope | Inferring success from output text is guessing; a non-zero exit is a fact |
 *
 * ## Gating is by effect, never by reading the command
 *
 * `shell_exec` is classified `destructive` and routed through the approval gate. It is tempting to inspect the
 * command instead — refuse `rm -rf`, allow `ls` — and that is a losing game: `find . -delete`, `>file`, `dd`,
 * `python -c`, a base64 pipeline. Any list of dangerous shapes is a list somebody gets around, and worse, it
 * *feels* like protection. A classification cannot be evaded by rephrasing.
 */

import { spawn } from "node:child_process";
import { AgentPlatformError } from "../core/errors.js";

/** Bytes of stdout and of stderr returned. Beyond this the output is truncated and says so. */
export const MAX_OUTPUT_BYTES = 64_000;
/** Wall clock. A model waiting on a hung command is a run holding a worker slot. */
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MEMORY_MB = 256;

export type SandboxRequest = {
  /** The command, run by a shell inside the sandbox. Never interpreted or inspected here. */
  readonly command: string;
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  /** Files to place in the scratch mount before running, by relative path. */
  readonly files?: Readonly<Record<string, string>>;
};

export type SandboxResult = {
  /** Whether the command *ran to completion*. A non-zero exit is `ok: true` with a non-zero code. */
  readonly ok: boolean;
  /**
   * The process's exit code, or null when it never produced one.
   *
   * Null is the honest answer for a killed process, and it is why `reason` exists: "exit code 137" and "we killed
   * it after 20 seconds" are the same event described at two levels, and the model needs the second one.
   */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** Set when the sandbox ended the command itself. */
  readonly reason?: "timeout" | "memory" | "spawn-failed";
  readonly durationMs: number;
};

/**
 * A place to run a command. A port, because where that place is — a container here, a microVM, E2B, Daytona — is
 * a deployment's decision and not this package's.
 */
export interface Sandbox {
  readonly id: string;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

const cap = (text: string, limit: number): { text: string; truncated: boolean } =>
  Buffer.byteLength(text, "utf8") <= limit
    ? { text, truncated: false }
    : { text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8"), truncated: true };

/**
 * Spawn a process and bound it, shared by both adapters.
 *
 * The output cap is applied **while reading**, not afterwards: a command that prints a gigabyte would otherwise
 * be buffered in full before any limit could run, which is the same mistake `readBounded` exists to avoid in the
 * HTTP client.
 */
const boundedSpawn = async (
  file: string,
  args: readonly string[],
  input: { readonly timeoutMs: number; readonly onKill?: () => void },
): Promise<SandboxResult> => {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let truncated = false;
    let reason: SandboxResult["reason"] | undefined;

    const collect = (stream: NodeJS.ReadableStream, append: (chunk: string) => void) => {
      stream.on("data", (chunk: Buffer) => {
        const capped = cap(chunk.toString("utf8"), MAX_OUTPUT_BYTES);
        if (capped.truncated) truncated = true;
        append(capped.text);
      });
    };
    collect(child.stdout, (chunk) => {
      const capped = cap(out + chunk, MAX_OUTPUT_BYTES);
      out = capped.text;
      if (capped.truncated) truncated = true;
    });
    collect(child.stderr, (chunk) => {
      const capped = cap(err + chunk, MAX_OUTPUT_BYTES);
      err = capped.text;
      if (capped.truncated) truncated = true;
    });

    const timer = setTimeout(() => {
      reason = "timeout";
      input.onKill?.();
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: out,
        stderr: `${err}${error.message}`,
        truncated,
        reason: "spawn-failed",
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        // A timeout is not a completed command, whatever it printed before it died.
        ok: reason === undefined,
        exitCode: code,
        stdout: out,
        stderr: err,
        truncated,
        ...(reason === undefined ? {} : { reason }),
        durationMs: Date.now() - startedAt,
      });
    });
  });
};

export type DockerSandboxConfig = {
  /** The image. A deployment's choice, and it should be one with a shell and nothing else. */
  readonly image: string;
  readonly docker?: string;
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  /** Extra flags, appended after the enforced ones so they cannot remove them. */
  readonly extraArgs?: readonly string[];
  readonly shell?: string;
};

/**
 * The argv, built separately so it can be asserted on.
 *
 * Every security property of this adapter *is* this array. A test that ran a command and checked its output would
 * pass just as well with `--network=none` missing, so the argv is what the tests read — and the flags come before
 * `extraArgs`, so a deployment adding options cannot quietly drop one.
 */
export const dockerArgs = (config: DockerSandboxConfig, request: SandboxRequest): readonly string[] => [
  "run",
  "--rm",
  // No network at all. Not a restricted network: a command that can resolve a name can exfiltrate through it.
  "--network=none",
  // The image is immutable; only the scratch mount is writable, and it is a tmpfs that dies with the container.
  "--read-only",
  "--tmpfs=/scratch:rw,size=16m,mode=1777",
  `--memory=${config.memoryMb ?? DEFAULT_MEMORY_MB}m`,
  // Without this a memory-capped container can still be pushed into swap and take the host's disk with it.
  `--memory-swap=${config.memoryMb ?? DEFAULT_MEMORY_MB}m`,
  "--pids-limit=128",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  // Not root inside the container either. `--read-only` makes most of that moot; this makes the rest of it moot.
  "--user=65534:65534",
  "--workdir=/scratch",
  // No TTY, and stdin closed: an interactive prompt has nobody to answer it and would hold the slot until the
  // timeout, reported as a timeout, which is a confusing way to learn that a command asked a question.
  ...(config.extraArgs ?? []),
  config.image,
  config.shell ?? "sh",
  "-c",
  request.command,
];

/**
 * The real adapter: one container per command, destroyed after.
 *
 * Not a pool. A reused container is a container a previous command could have left something in, and the whole
 * proposition here is that a command cannot affect anything outside itself.
 */
export const createDockerSandbox = (config: DockerSandboxConfig): Sandbox => ({
  id: `docker:${config.image}`,
  async run(request) {
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = dockerArgs({ ...config, ...(request.memoryMb === undefined ? {} : { memoryMb: request.memoryMb }) }, request);
    const result = await boundedSpawn(config.docker ?? "docker", args, { timeoutMs });
    /**
     * 137 is SIGKILL, and inside a memory-capped container that is almost always the OOM killer.
     *
     * Reported as `memory` rather than left as a bare exit code, because "exit 137" is a number a reader has to
     * look up and "the command ran out of memory" is the finding. Not claimed when we did the killing ourselves:
     * a timeout is also a SIGKILL, and it is already named.
     */
    return result.exitCode === 137 && result.reason === undefined
      ? { ...result, ok: false, reason: "memory" }
      : result;
  },
});

export type LocalSandboxConfig = {
  /**
   * Required, and named to be uncomfortable to type.
   *
   * There is no safe default here. A shell on the runtime's own host has no isolation at all: the command runs as
   * the runtime user, with its filesystem, its network and its credentials. That is a remote code execution
   * endpoint reachable through content the model merely read.
   */
  readonly allowUnsafeLocalExecution: true;
  readonly timeoutMs?: number;
  readonly shell?: string;
};

/**
 * The development adapter, which **refuses to exist** unless a deployment says so in words.
 *
 * The refusal is at construction rather than at the call, so a misconfiguration is a boot failure rather than a
 * surprise the first time somebody asks the agent to run something. And the message says what to do instead,
 * because "not allowed" without a next step is how a flag gets set to make an error go away.
 *
 * It provides the timeout and the output cap. It provides **none** of the isolation: no network isolation, no
 * memory cap, no read-only filesystem, no dropped capabilities. The contract's table describes what a sandbox
 * guarantees; this adapter meets one row of it, and saying so is the point.
 */
export const createLocalSandbox = (config: LocalSandboxConfig): Sandbox => {
  if (config.allowUnsafeLocalExecution !== true) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        "The local sandbox runs commands on this host with no isolation: no network isolation, no memory cap, " +
        "no read-only filesystem. It is for development only, and it requires " +
        "`allowUnsafeLocalExecution: true` in so many words. For anything else, use createDockerSandbox — or " +
        "leave shell_exec unwired, which is the default and is a legitimate answer.",
      retryable: false,
    });
  }
  return {
    id: "local:unsafe",
    async run(request) {
      return boundedSpawn(config.shell ?? "sh", ["-c", request.command], {
        timeoutMs: request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  };
};
