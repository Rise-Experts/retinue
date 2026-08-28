/**
 * An inbound MCP server — REQ-059 (#249), task #250.
 *
 * `backend/src/mcp/` is the **outbound** direction: a tenant registers their MCP server and this platform
 * consumes it. Its own header says so, and points at an inbound server that lives in the *old Chorus
 * repository* — not in this package. So `@retinue/agentkit` could consume an MCP server and could not be one,
 * and a deployment's tools were unreachable from Claude Code, Claude Desktop, Cursor and every other MCP client.
 *
 * Nothing here re-implements a capability. The registry already does authorization, the tenant's toolset, the
 * approval gate, validation, idempotency and audit attribution; this is a protocol surface in front of it, and
 * every call goes through `registry.execute` exactly as an agent's would.
 *
 * ## The trust direction inverts, and that is the thing to get right
 *
 * Outbound, `mcp/index.ts` establishes the rule: a remote server's `readOnlyHint`/`destructiveHint` are
 * *advisory and untrusted*, and "a remote server cannot talk its way down to" a weaker effect. Inbound, **this
 * package is the remote server**. Two consequences, and both are enforced rather than intended:
 *
 * 1. What it advertises must be what it enforces. The annotations are derived from `ToolEffect` by one
 *    function, so they cannot drift from the effect the registry acts on.
 * 2. Nothing the client sends is trusted — not an effect, not a hint, not a claim about a prior approval. The
 *    client supplies a tool name and arguments; everything else comes from the context the *host* built.
 *
 * ## Authentication is structural
 *
 * `createMcpToolServer` takes a resolved `ExecutionContext`. There is no `authenticate` callback to forget and
 * no default: a host that has not authenticated has nothing to pass, so it cannot construct a server. That is
 * the same decision `server/main.ts` makes — "a permissive default would serve an open API to anyone who forgot
 * to set it" — expressed in the type instead of in a runtime check, because this surface gets exposed to the
 * internet and a runtime check can be skipped.
 *
 * One server per authenticated session: a stdio server is launched per client and carries that client's
 * identity for its lifetime; an HTTP mount builds one per authenticated request.
 */

/**
 * `zod/v4`'s converter. A static import, and it costs nothing: `zod` is already a hard dependency of this
 * package, and the only path to this module is its own optional subpath.
 */
import { toJSONSchema } from "zod/v4/core";
import type { ExecutionContext } from "../core/context.js";
import type { ToolDescriptor, ToolEffect, ToolRegistry } from "../tools/index.js";

/**
 * The MCP SDK, imported for its types only where possible.
 *
 * An **optional peer dependency**, following `vitest` on `./testing`: a consumer who never mounts an MCP server
 * never installs it, and the only path to this module is its own subpath.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- see the note below; `unknown` is wrong here. */
export type McpServerLike = {
  /**
   * `any`, and it is the correct choice rather than a shortcut.
   *
   * The SDK's real signature is generic —
   * `<T extends AnyObjectSchema>(schema: T, handler: (request: SchemaOutput<T>, extra: RequestHandlerExtra) => …)`
   * — and this package cannot restate those generics without importing the SDK, which would stop it being an
   * optional peer. A structural type with `unknown`/`never` parameters looks stricter and is **not assignable
   * from** the SDK's `Server`, so the first version of this failed to typecheck at the only call site anybody
   * will write. `check:consumer` caught it by compiling the documented sample against the packed tarball:
   *
   *     Argument of type 'Server<…>' is not assignable to parameter of type 'McpServerLike'
   *       Type 'any' is not assignable to type 'never'
   *
   * A type nothing real satisfies is worse than a permissive one.
   */
  setRequestHandler(
    schema: any,
    /**
     * The result is an object, not `unknown` — the second half of the same lesson.
     *
     * The SDK's handler must return a `ServerResult`, and `Promise<unknown>` is *wider* than that, so a `Server`
     * was still not assignable even after the parameters were relaxed. A permissive object shape satisfies it
     * in both directions.
     */
    handler: (request: any, extra?: any) => Promise<Record<string, unknown>>,
  ): void;
  connect(transport: any): Promise<void>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type McpToolAnnotations = {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  /** True when the tool reaches something outside this deployment. */
  readonly openWorldHint: boolean;
};

/**
 * `ToolEffect` → MCP annotations, in **one** place — AC-7.
 *
 * One function, so the advertised hint and the enforced effect cannot drift: a test asserts this mapping over
 * every effect, and the exposed set is checked against it. Two tables would be two chances to disagree, and the
 * disagreement would be a client told a tool is read-only calling something that writes.
 *
 * `destructive` is the only `destructiveHint`, and `read` the only `readOnlyHint` — deliberately narrow.
 * Over-claiming read-only is the dangerous direction: a client may skip a confirmation on it.
 */
export const annotationsFor = (effect: ToolEffect): McpToolAnnotations => ({
  readOnlyHint: effect === "read",
  destructiveHint: effect === "destructive",
  // Only a read is safely repeatable without a key. Everything else declares itself non-idempotent, which is
  // what makes a client ask before retrying.
  idempotentHint: effect === "read",
  openWorldHint: effect === "external-write" || effect === "destructive",
});

/**
 * A tool's input schema, in the shape MCP requires — found by a real client.
 *
 * MCP's `tools/list` demands `inputSchema.type === "object"`, and the SDK's *client* validates it: a tool whose
 * descriptor holds a Zod schema made the whole listing fail with `expected "object"` at one index. So the
 * failure was not "one tool looks odd", it was **no tools at all**, from one non-conforming entry.
 *
 * Three cases, in order of fidelity:
 *
 * 1. Already a JSON-Schema object — pass it through unchanged. It is what execution validates against, so
 *    advertising anything else would advertise a contract nothing enforces.
 * 2. A Zod schema — convert it. `defineTool` documents `inputSchema` as "Zod schema or JSON-schema object", so
 *    both are legitimate and a client deserves the real one either way.
 * 3. Anything else — `{ type: "object" }`, permissive. Deliberately the *weaker* advertisement rather than a
 *    refusal to list: the registry still validates the real schema on execution, so the failure direction is a
 *    rejected call rather than an accepted bad one.
 */
export const toMcpInputSchema = (schema: unknown): Record<string, unknown> => {
  if (schema !== null && typeof schema === "object") {
    const asJson = schema as { type?: unknown };
    if (asJson.type === "object") return schema as Record<string, unknown>;
    const zodLike = schema as { safeParse?: unknown; "~standard"?: unknown };
    if (typeof zodLike.safeParse === "function" || zodLike["~standard"] !== undefined) {
      try {
        const converted = toJSONSchema(schema as never) as { type?: unknown };
        if (converted.type === "object") return converted as Record<string, unknown>;
      } catch {
        // A schema the converter cannot express — fall through to the permissive object rather than failing the
        // whole listing for one tool.
      }
    }
  }
  return { type: "object" };
};

/** What a client is shown for one tool. */
export const describeForMcp = (descriptor: ToolDescriptor) => ({
  name: descriptor.name,
  title: descriptor.label,
  description: descriptor.description,
  inputSchema: toMcpInputSchema(descriptor.inputSchema),
  annotations: annotationsFor(descriptor.effect),
});

export type McpToolServerDeps = {
  readonly registry: ToolRegistry;
  /**
   * The authenticated caller. **Required, and there is no default.**
   *
   * A host that has not authenticated cannot construct a server, which is the guarantee expressed in the type
   * rather than in a check somebody can skip.
   */
  readonly context: ExecutionContext;
  readonly serverInfo?: { readonly name: string; readonly version: string };
};

/**
 * The result of a `tools/call`, in MCP's shape.
 *
 * A refusal is `isError: true` with the reason as text — **not** a protocol error. That distinction matters: a
 * protocol error tells the client the server is broken, and a tool refusal is a normal outcome the model should
 * see and respond to. It is the same decision `streamModelTurn` makes for `tool-error`.
 */
export const toMcpResult = (
  outcome: { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
) =>
  outcome.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(outcome.data) }] }
    : {
        content: [{ type: "text" as const, text: `${outcome.error.code}: ${outcome.error.message}` }],
        isError: true as const,
      };

/**
 * Registers the two handlers on an SDK `Server`.
 *
 * Takes the server rather than constructing it, so the SDK stays an optional peer of this package: the host
 * imports `@modelcontextprotocol/sdk`, builds a `Server`, and hands it here. That also leaves the host in
 * charge of the transport, which is where the authentication story differs between stdio and HTTP.
 */
export const registerRetinueTools = (
  server: McpServerLike,
  schemas: { readonly listTools: unknown; readonly callTool: unknown },
  deps: McpToolServerDeps,
): void => {
  server.setRequestHandler(schemas.listTools, async (): Promise<Record<string, unknown>> => {
    /**
     * The caller's **authorized** tools — never the whole registry.
     *
     * `listAuthorized` applies the tenant's toolset and the agent policy before authorization, so a tool this
     * principal may not use is absent rather than present-and-refused. A client that cannot see a tool cannot
     * be tempted by it, and the list is also the only place this platform states what it can do.
     */
    const descriptors = await deps.registry.listAuthorized(deps.context);
    return { tools: descriptors.map(describeForMcp) };
  });

  server.setRequestHandler(schemas.callTool, async (request: {
    params?: { name?: unknown; arguments?: unknown };
  }): Promise<Record<string, unknown>> => {
    const params = request.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    /**
     * Straight through `registry.execute` — AC-3.
     *
     * Everything the registry does for an agent's call happens here for the same reason: authorization is
     * re-checked, the tenant's toolset applies, the approval gate refuses a gated tool, arguments are validated
     * against the advertised schema, idempotency is enforced and the audit row is written. A branch that called
     * a tool directly would be a way around all of it, reachable by name from a client.
     */
    try {
      const outcome = await deps.registry.execute(deps.context, { name, input: params.arguments ?? {} });
      return toMcpResult(outcome as never);
    } catch (thrown) {
      /**
       * A refusal that **throws** is still a tool refusal — found by a real client, not by a fake.
       *
       * `registry.execute` returns `{ ok: false }` for most failures and *throws* for an unauthorized tool
       * (`assertToolAuthorized`). Without this catch the SDK turned that into JSON-RPC `-32603`, so a client
       * asking for a tool it may not have was told **the server is broken** rather than that it was refused.
       * The distinction is the whole reason `isError` exists: a protocol error is not something a model can
       * respond to, and it invites a retry against a server that is working correctly.
       *
       * The message only, never the thrown object — a stack or a cause chain routinely carries a URL with a
       * token in it, and this crosses a process boundary to a client we do not control. Same rule as #143's
       * `recordError` and `streamModelTurn`'s `tool-error`.
       */
      const error = thrown as { code?: unknown; message?: unknown };
      return toMcpResult({
        ok: false,
        error: {
          code: typeof error.code === "string" ? error.code : "internal",
          message: typeof error.message === "string" ? error.message : "the call was refused",
        },
      });
    }
  });
};
