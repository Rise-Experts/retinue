/**
 * Tool registry runtime — `docs/03-intelligence-runtime.md` → Tool registry.
 *
 * Builds the permission-filtered compact catalog, resolves lazy schemas via `learn_tools`, and
 * executes tools with the guarantees the spec demands:
 *
 * - **Only task-relevant schemas enter context.** The catalog is compact (no schemas); only
 *   preloaded tools carry schemas up front, and everything else is fetched on demand.
 * - **Unauthorized tools are unlearnable and unexecutable.** Discovery, `learn_tools` and
 *   `execute_tool` all go through the same `AuthorizationPolicy`, so a tool the caller may not use
 *   is absent from the catalog, omitted from `learn`, and rejected if executed directly.
 * - **Re-auth + re-validate at execution**, even when the tool was discoverable earlier.
 * - **Shared success/error envelope**, and **large results are spilled** to blob storage and
 *   referenced, read back through `read_tool_output`.
 * - **External/destructive writes require an idempotency key**, so a retried call returns the first
 *   result instead of firing the side effect twice.
 */

import type { ExecutionContext } from "../core/context.js";
import type { PlatformError } from "../core/errors.js";
import type { BlobRef } from "../core/ids.js";
import { assertToolAuthorized, type AuthorizationPolicy } from "../authorization/index.js";
import { deriveIdempotencyKey, type IdempotencyStore } from "../idempotency/index.js";
import type { BlobStore } from "../persistence/index.js";
import { META_TOOL_DESCRIPTOR_LIST } from "./meta-tools.js";
import type {
  OneTimeApprovalRef,
  ShadowRecorder,
  Tool,
  ToolCatalogEntry,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from "./index.js";

/** Validates a tool input against its (opaque) `inputSchema`. Default duck-types a zod schema. */
export interface SchemaValidator {
  validate(schema: unknown, value: unknown): { ok: true; value: unknown } | { ok: false; message: string };
}

/** Default validator: run a zod-like schema's `safeParse`; pass through anything else (tool self-validates). */
export const zodishValidator: SchemaValidator = {
  validate(schema, value) {
    const parse = (schema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message?: string } } })
      ?.safeParse;
    if (typeof parse !== "function") return { ok: true, value };
    const result = parse(value);
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, message: result.error?.message ?? "input failed schema validation" };
  },
};

const compact = (d: ToolDescriptor): ToolCatalogEntry => ({
  name: d.name,
  label: d.label,
  description: d.description,
  category: d.category,
  effect: d.effect,
});

const invalidInput = (message: string): PlatformError => ({ code: "invalid_input", message, retryable: false });
const requiresKey = (effect: ToolDescriptor["effect"], requires: boolean): boolean =>
  requires || effect === "external-write" || effect === "destructive";

export type ToolPolicyView = {
  readonly preloaded: readonly string[];
  readonly categories: readonly string[];
  readonly excluded: readonly string[];
};

export type ToolCatalog = {
  /** Preloaded tools carry full schemas — commonly required, loaded up front. */
  readonly preloaded: readonly ToolDescriptor[];
  /** Everything else the caller may use — compact entries, schemas fetched via `learn_tools`. */
  readonly discoverable: readonly ToolCatalogEntry[];
  /** Always-present meta-tools. */
  readonly meta: readonly ToolCatalogEntry[];
};

/** Structural approval check (satisfied by the HITL `ApprovalGate`) — kept structural to avoid a
 * tools→hitl dependency. Returns false when the tool needs approval and the call carries neither a
 * standing grant nor a valid one-time approval. */
export interface ApprovalCheck {
  isAllowed(
    context: ExecutionContext,
    tool: { readonly name: string; readonly category: string; readonly approvalPolicy: ApprovalPolicyValue },
    /** The single approved execution this call is, when it is one. Verified by the implementation. */
    oneTime?: OneTimeApprovalRef,
  ): Promise<boolean>;
}
type ApprovalPolicyValue = "never" | "policy" | "always";

export type ToolRegistryConfig = {
  readonly providers: readonly ToolProvider[];
  readonly authorization: AuthorizationPolicy;
  readonly idempotency?: IdempotencyStore;
  readonly blobs?: BlobStore;
  /** Makes approval unbypassable: a policy-classified tool cannot execute directly without a grant. */
  readonly approval?: ApprovalCheck;
  /** Results whose JSON exceeds this are spilled to `blobs` and referenced. Default 8 KiB. */
  readonly maxInlineOutputBytes?: number;
  readonly validator?: SchemaValidator;
  /**
   * Where a shadow run's suppressed writes go (#126).
   *
   * Here as well as on the delegating envelope, and the registry's is the one that matters. #126 put
   * suppression only in the envelope, which covers **delegating tools only** — so a gated tool that is not
   * one, every MCP-imported external write included, reached its own `execute` and performed a real write
   * in a shadow run. That is a bigger hole than the missing parity record the approval-loop work found.
   *
   * Required when the run says it is shadow: `context.shadow === true` with no recorder is refused rather
   * than performed, the same fail-closed rule as the envelope's.
   */
  readonly shadow?: ShadowRecorder;
};

export interface ToolRegistry {
  catalog(context: ExecutionContext, policy: ToolPolicyView): Promise<ToolCatalog>;
  learn(context: ExecutionContext, names: readonly string[]): Promise<readonly ToolDescriptor[]>;
  execute(
    context: ExecutionContext,
    input: {
      name: string;
      input: unknown;
      idempotencyKey?: string;
      toolCallId?: string;
      /** Present when this call is the execution a human approved; see `OneTimeApprovalRef`. */
      approval?: OneTimeApprovalRef;
    },
  ): Promise<ToolResult>;
  readOutput(context: ExecutionContext, ref: BlobRef): Promise<ToolResult>;
}

export const createToolRegistry = (config: ToolRegistryConfig): ToolRegistry => {
  const maxInline = config.maxInlineOutputBytes ?? 8 * 1024;
  const validator = config.validator ?? zodishValidator;

  /** Resolve every tool the caller could use, then keep only the authorized ones. */
  const authorizedTools = async (context: ExecutionContext): Promise<Tool[]> => {
    const all: Tool[] = [];
    for (const provider of config.providers) all.push(...(await provider.listTools(context)));
    const descriptors = all.map((t) => t.descriptor);
    const permitted = new Set((await config.authorization.filterTools(context, descriptors)).map((d) => d.name));
    return all.filter((t) => permitted.has(t.descriptor.name));
  };

  const findAuthorized = async (context: ExecutionContext, name: string): Promise<Tool | null> =>
    (await authorizedTools(context)).find((t) => t.descriptor.name === name) ?? null;

  return {
    async catalog(context, policy) {
      const excluded = new Set(policy.excluded);
      const preloadNames = new Set(policy.preloaded);
      const preloadCategories = new Set(policy.categories);
      const tools = (await authorizedTools(context)).filter((t) => !excluded.has(t.descriptor.name));
      const preloaded: ToolDescriptor[] = [];
      const discoverable: ToolCatalogEntry[] = [];
      for (const tool of tools) {
        const d = tool.descriptor;
        if (preloadNames.has(d.name) || preloadCategories.has(d.category)) preloaded.push(d);
        else discoverable.push(compact(d));
      }
      return { preloaded, discoverable, meta: META_TOOL_DESCRIPTOR_LIST.map(compact) };
    },

    async learn(context, names) {
      // Only authorized tools are returned — an unauthorized name is silently unlearnable.
      const wanted = new Set(names);
      return (await authorizedTools(context)).map((t) => t.descriptor).filter((d) => wanted.has(d.name));
    },

    async execute(context, input) {
      const tool = await findAuthorized(context, input.name);
      // Not found OR not authorized → both reject; execution is never a way around discovery filtering.
      if (!tool) {
        await assertToolAuthorized(config.authorization, context, { name: input.name, category: "unknown" });
        return { ok: false, error: invalidInput(`Unknown tool ${input.name}`) };
      }
      const d = tool.descriptor;
      // Re-authorize at execution even though it was discoverable earlier.
      await assertToolAuthorized(config.authorization, context, { name: d.name, category: d.category });

      // Shadow mode, and **before** the approval gate (#126).
      //
      // Before it for the reason #126 gave: a shadow run must not ask a human to approve something that
      // will not happen, because that teaches people approving is meaningless. And *here* rather than only
      // in the envelope, because the envelope covers delegating tools and this covers every tool — an
      // MCP-imported external write is gated, is not a delegating tool, and would otherwise execute for
      // real in a shadow run.
      //
      // Suppressed on the effect, not on the approval policy: a `destructive` tool whose policy someone
      // set to `never` is still something a shadow run must not do.
      if (context.shadow === true && (d.effect === "external-write" || d.effect === "destructive")) {
        if (!config.shadow)
          return {
            ok: false,
            error: {
              code: "capability_unavailable",
              message: `Tool ${d.name} is a ${d.effect} and this run is in shadow mode with no recorder configured`,
              retryable: false,
            },
          };
        // Validated first, so what is recorded is what would have been sent rather than what the model
        // typed. The gate has not run, so this is the earliest point the input is trustworthy.
        const shadowValidated = validator.validate(d.inputSchema, input.input);
        if (!shadowValidated.ok)
          return { ok: false, error: invalidInput(`Invalid input for ${d.name}: ${shadowValidated.message}`) };
        await config.shadow.record(context, {
          ...(context.runId === undefined ? {} : { runId: context.runId }),
          toolName: d.name,
          // A non-delegating tool wraps nothing, and saying so is more useful than an empty string.
          delegatesTo: d.delegatesTo ?? `${d.name} (not a delegating tool)`,
          effect: d.effect,
          input: shadowValidated.value,
          idempotencyKey: (input.idempotencyKey ?? `shadow:${d.name}`) as never,
          wouldRequireApproval: d.approvalPolicy !== "never",
        });
        // Not stored under the idempotency key: a suppressed call must not become the cached answer for a
        // later real one.
        return { ok: true, data: { suppressed: true, reason: "shadow-mode", wouldHaveCalled: d.name } };
      }

      // Approval gate: a policy-classified tool cannot be executed directly without a standing grant.
      // Fail CLOSED — if no approval check is wired, a policy/always tool (e.g. every MCP external
      // write) is refused rather than silently executed unapproved.
      if (d.approvalPolicy !== "never") {
        const allowed = config.approval
          ? await config.approval.isAllowed(
              context,
              { name: d.name, category: d.category, approvalPolicy: d.approvalPolicy },
              input.approval,
            )
          : false;
        if (!allowed)
          return { ok: false, error: { code: "approval_required", message: `Tool ${d.name} requires approval`, retryable: false } };
      }

      // Re-validate input against the descriptor's schema.
      const validated = validator.validate(d.inputSchema, input.input);
      if (!validated.ok) return { ok: false, error: invalidInput(`Invalid input for ${d.name}: ${validated.message}`) };

      // External/destructive writes must carry an idempotency key.
      let idempotencyKey = input.idempotencyKey;
      if (idempotencyKey === undefined && input.toolCallId !== undefined && context.runId !== undefined) {
        idempotencyKey = deriveIdempotencyKey({
          tenantId: context.tenantId,
          runId: context.runId,
          toolCallId: input.toolCallId as never,
        });
      }
      if (requiresKey(d.effect, d.requiresIdempotencyKey) && idempotencyKey === undefined) {
        return { ok: false, error: invalidInput(`Tool ${d.name} (${d.effect}) requires an idempotency key`) };
      }

      // Replay: a retried idempotent call returns the stored result instead of re-firing.
      if (idempotencyKey !== undefined && config.idempotency) {
        const prior = await config.idempotency.get<ToolResult>({ tenantId: context.tenantId, key: idempotencyKey as never });
        if (prior && !prior.firstSeen) return prior.result;
      }

      const result = await tool.execute({
        context,
        input: validated.value,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(input.approval ? { approval: input.approval } : {}),
      });
      const spilled = await maybeSpill(context, result);

      if (idempotencyKey !== undefined && config.idempotency) {
        await config.idempotency.put({ tenantId: context.tenantId, key: idempotencyKey as never, result: spilled });
      }
      return spilled;
    },

    async readOutput(context, ref) {
      if (!config.blobs) return { ok: false, error: invalidInput("blob storage is not configured") };
      const value = await config.blobs.get({ tenantId: context.tenantId, ref });
      if (value === null) return { ok: false, error: { code: "not_found", message: `No spilled output ${ref}`, retryable: false } };
      return { ok: true, data: value };
    },
  };

  /** Spill an oversize success payload to blob storage and reference it. */
  async function maybeSpill(context: ExecutionContext, result: ToolResult): Promise<ToolResult> {
    if (!result.ok || result.spilledOutputRef !== undefined) return result;
    const bytes = Buffer.byteLength(JSON.stringify(result.data ?? null), "utf8");
    if (bytes <= maxInline || !config.blobs) return result;
    const ref = await config.blobs.put({ tenantId: context.tenantId, value: result.data });
    return {
      ok: true,
      data: { truncated: true, byteSize: bytes, note: "Result spilled; read it with read_tool_output." },
      spilledOutputRef: ref,
      truncated: true,
    };
  }
};
