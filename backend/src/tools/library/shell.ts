/**
 * Running a command — REQ-047 (#206), task #215.
 *
 * An envelope over `toolkit/sandbox.ts`, and the most consequential tool in the package. Read the note at the top
 * of that module before wiring this: the tool is only defensible because of what the sandbox guarantees, and the
 * local adapter guarantees almost none of it.
 *
 * ## Three things this envelope does, and one it deliberately does not
 *
 * **`destructive`, so the approval gate always fires.** Not because every command is destructive — `ls` is not —
 * but because the classification is what the gate reads, and a tool whose worst case is "anything" has to be
 * classified by its worst case.
 *
 * **An idempotency key is required.** A retried `shell_exec` must not run twice: the first result is returned
 * instead. A command that appended a line to a file would otherwise append two on a network hiccup.
 *
 * **The capability must be declared.** Wiring a sandbox is not enough; `shell: "on"` has to be in the runtime's
 * capability declaration, and this is checked at the *call*. Two switches for one decision is usually a smell —
 * see `web_search`, where wiring alone is the toggle — and here it is deliberate: this is the one tool where
 * "somebody wired a sandbox for a test and forgot" must not silently mean the agent can run commands.
 *
 * **What it does not do is read the command.** No refusing `rm -rf`, no allow-list of binaries. That is a losing
 * game — `find . -delete`, `dd`, `python -c`, a base64 pipeline — and worse, it *feels* like protection while
 * being a list somebody gets around. The classification cannot be evaded by rephrasing.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import type { Sandbox, SandboxResult } from "../../toolkit/index.js";

const shellSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(4_000)
      .describe("A shell command. It runs in an isolated sandbox with no network and a writable /scratch only."),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .strict();

export type ShellToolConfig = {
  readonly sandbox: Sandbox;
  /**
   * Whether the runtime declared the `shell` capability.
   *
   * A function rather than a boolean, so the answer is read at the call. A capability map captured at
   * construction is a capability map that cannot be turned off without a restart, and this is the one tool where
   * that matters.
   */
  readonly enabled: () => boolean;
};

/** What a refused call returns. Shaped like a result, because the model can act on a reason and not on a throw. */
export const shellDisabled = (): SandboxResult & { readonly refused: string } => ({
  ok: false,
  exitCode: null,
  stdout: "",
  stderr: "",
  truncated: false,
  durationMs: 0,
  refused:
    "shell_exec is wired but the `shell` capability is not declared for this runtime, so no command will run. " +
    "This is a deliberate second switch on the one tool whose blast radius is the machine.",
});

export const createShellExecTool = (deps: DelegatingToolDeps, config: ShellToolConfig): Tool =>
  defineDelegatingTool(deps, {
    name: "shell_exec",
    label: "Run a command",
    description:
      "Run a shell command inside an isolated sandbox: no network, a read-only filesystem apart from /scratch, a " +
      "memory cap and a wall-clock timeout. Returns stdout, stderr and the exit code. This always requires a " +
      "human's approval before it runs, whatever the command is. Output is truncated when long, and says so.",
    category: "code",
    effect: "destructive",
    approvalPolicy: "always",
    requiresIdempotencyKey: true,
    inputSchema: shellSchema,
    delegatesTo: "toolkit/sandbox.run",
    delegate: async (input: z.infer<typeof shellSchema>) => {
      if (!config.enabled()) return shellDisabled();
      return config.sandbox.run({
        command: input.command,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
    },
  });
