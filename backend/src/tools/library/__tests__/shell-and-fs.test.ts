/**
 * `shell_exec`'s two switches and its gate — REQ-047 (#206), task #215, AC-3 and AC-7.
 *
 * The interesting assertions here are all negative: the sandbox is **not** reached. A tool that refuses correctly
 * but has already run the command has refused nothing, and the difference is invisible in the returned value.
 */
import { describe, expect, it, vi } from "vitest";
import { asId } from "../../../core/ids.js";
import type { ExecutionContext } from "../../../core/context.js";
import type { TenantId } from "../../../core/ids.js";
import { createAuthorizationPolicy } from "../../../authorization/index.js";
import { createMemoryIdempotencyStore } from "../../../adapters/memory/index.js";
import { createStandardToolProvider } from "../index.js";
import { createToolRegistry } from "../../registry.js";
import type { Sandbox } from "../../../toolkit/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = asId<TenantId>("t1");
const context: ExecutionContext = {
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [asId("operator")],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
};

const authorization = createAuthorizationPolicy({
  roles: [
    {
      roleId: "operator",
      permissions: [
        { action: "execute", resourceType: "tool" },
        { action: "read", resourceType: "*" },
        { action: "write", resourceType: "*" },
      ],
      tools: ["shell_exec", "fs_read", "fs_list", "fs_search", "fs_write", "now", "calculate"],
    },
  ] as never,
});

const sandboxSpy = () => {
  const run = vi.fn(async () => ({ ok: true, exitCode: 0, stdout: "ran", stderr: "", truncated: false, durationMs: 1 }));
  return { sandbox: { id: "spy", run } as Sandbox, run };
};

/**
 * An approval gate that says yes.
 *
 * Needed for the tests that call the tool *directly*: `shell_exec` is `always` gated, and a gated tool with no
 * gate wired is refused rather than run — the fail-closed rule from #162. That refusal is correct and it is not
 * what these tests are about, so they supply a gate and the gate tests below supply one that refuses.
 */
const approving = { isAllowed: async () => true } as never;

const deps = () => ({ authorization, idempotency: createMemoryIdempotencyStore(), approvals: approving });

const provider = (over: Record<string, unknown> = {}) =>
  createStandardToolProvider({ deps: deps(), ...over } as never);

describe("wiring alone does not switch shell_exec on — AC-3", () => {
  it("is absent when no sandbox is wired", async () => {
    const tools = await provider().listTools(context);
    expect(tools.map((t) => t.descriptor.name)).not.toContain("shell_exec");
  });

  it("is present but refuses when the capability is not declared, and never reaches the sandbox", async () => {
    const { sandbox, run } = sandboxSpy();
    const tools = await provider({ sandbox, shellEnabled: () => false }).listTools(context);
    const shell = tools.find((t) => t.descriptor.name === "shell_exec");
    expect(shell).toBeDefined();

    const result = await shell!.execute({ context, input: { command: "echo hi" }, idempotencyKey: "k1" } as never);
    // The negative assertion is the one that matters: refusing after running is not refusing.
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as { refused?: string }).refused).toContain("capability");
  });

  it("runs only when both switches are on", async () => {
    const { sandbox, run } = sandboxSpy();
    const tools = await provider({ sandbox, shellEnabled: () => true }).listTools(context);
    const shell = tools.find((t) => t.descriptor.name === "shell_exec")!;
    const result = await shell.execute({ context, input: { command: "echo hi" }, idempotencyKey: "k2" } as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("reads the declaration at the call, so turning it off does not need a restart", async () => {
    const { sandbox, run } = sandboxSpy();
    let declared = true;
    const tools = await provider({ sandbox, shellEnabled: () => declared }).listTools(context);
    const shell = tools.find((t) => t.descriptor.name === "shell_exec")!;
    await shell.execute({ context, input: { command: "echo one" }, idempotencyKey: "k3" } as never);
    declared = false;
    await shell.execute({ context, input: { command: "echo two" }, idempotencyKey: "k4" } as never);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("the classification is what gates it — AC-7", () => {
  const registryWith = (sandbox: Sandbox) =>
    createToolRegistry({
      providers: [createStandardToolProvider({ deps: deps(), sandbox, shellEnabled: () => true })],
      authorization,
      idempotency: createMemoryIdempotencyStore(),
      // Nothing is approved here, which is the state a run is in when a model first asks.
      approval: { isAllowed: async () => false },
    });

  it("is destructive, always gated, and requires an idempotency key", async () => {
    const { sandbox } = sandboxSpy();
    const tools = await createStandardToolProvider({ deps: deps(), sandbox, shellEnabled: () => true }).listTools(context);
    expect(tools.find((t) => t.descriptor.name === "shell_exec")?.descriptor).toMatchObject({
      effect: "destructive",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
    });
  });

  it("refuses a command a document told the model to run, without running it", async () => {
    /**
     * The injection case. The command below is what a poisoned document asks for; how the model came to want it
     * is not something the platform can know, and that is the point of gating on the *classification* rather than
     * on the text. A benign `ls` is refused identically — see the next test.
     */
    const { sandbox, run } = sandboxSpy();
    const result = await registryWith(sandbox).execute(context, {
      name: "shell_exec",
      input: { command: "rm -rf / --no-preserve-root" },
      idempotencyKey: "k5",
      toolCallId: "call-injected",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_required");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a harmless command exactly as firmly, because the text is never read", async () => {
    // Any list of dangerous shapes is a list somebody gets around, and worse, it *feels* like protection.
    const { sandbox, run } = sandboxSpy();
    const result = await registryWith(sandbox).execute(context, {
      name: "shell_exec",
      input: { command: "ls" },
      idempotencyKey: "k6",
      toolCallId: "call-benign",
    });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the filesystem tools reach the model with the guarantees intact", () => {
  const root = mkdtempSync(join(tmpdir(), "retinue-fs-tools-"));

  it("appear only when a root is configured, and fs_write only with a writable one", async () => {
    const withoutRoot = (await provider().listTools(context)).map((t) => t.descriptor.name);
    expect(withoutRoot).not.toContain("fs_read");

    const readsOnly = (await provider({ filesystem: { root } }).listTools(context)).map((t) => t.descriptor.name);
    expect(readsOnly).toContain("fs_read");
    expect(readsOnly).toContain("fs_search");
    // The common case: reads without writes. A writable root is a separate decision.
    expect(readsOnly).not.toContain("fs_write");

    const both = (
      await provider({ filesystem: { root, writableRoot: mkdtempSync(join(tmpdir(), "retinue-fs-w-")) } }).listTools(context)
    ).map((t) => t.descriptor.name);
    expect(both).toContain("fs_write");
  });

  it("classifies the reads as reads and the write as an internal write", async () => {
    const tools = await provider({
      filesystem: { root, writableRoot: mkdtempSync(join(tmpdir(), "retinue-fs-w2-")) },
    }).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const name of ["fs_read", "fs_list", "fs_search"]) {
      expect(byName.get(name), name).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
    // `internal-write` and `policy`: it changes something the deployment owns, and whether a person confirms each
    // one is the deployment's call rather than this library's.
    expect(byName.get("fs_write")).toMatchObject({ effect: "internal-write", approvalPolicy: "policy" });
  });

  it("refuses an escape through the tool, not just through the toolkit", async () => {
    const tools = await provider({ filesystem: { root } }).listTools(context);
    const read = tools.find((t) => t.descriptor.name === "fs_read")!;
    const result = await read.execute({ context, input: { path: "../../etc/passwd" } } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as { ok: boolean; kind?: string }).kind).toBe("forbidden");
  });
});
