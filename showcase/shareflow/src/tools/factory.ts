/**
 * The capability seam: what a factory receives, what it must declare, and the helper that declares it.
 *
 * **Its own module, and that is not organisation — it is a cycle.** `tools/index.ts` re-exports every
 * factory file at the bottom, and each factory file needs `shareFlowTool`. While that was a *type* the
 * dependency was erased and the cycle was harmless; the moment it became a runtime value, ESM evaluated
 * `posts.ts` before `index.ts`'s body and every factory hit `shareFlowTool is not a function` at import
 * time. Importing from here instead breaks the cycle, and `index.ts` re-exports it so no caller notices.
 */
import { z } from "zod";

import type { DelegatingToolDeps, Tool } from "@retinue/agentkit";

import type { ShareFlowServices } from "../services/index.js";

/**
 * Everything a capability is built from.
 *
 * `deps` was missing from the first version of this type (#114), and writing the first capability
 * (#115) is what surfaced it: every ShareFlow tool is a `defineDelegatingTool`, and that needs the
 * authorization policy, the approval gate and the idempotency store. A factory that received only the
 * services could not build one — so each capability would have closed over its own copy of the deps,
 * which is precisely the "applied in one place, in one order" property the envelope exists to have.
 */
export type ShareFlowToolContext<R extends ShareFlowServiceName = ShareFlowServiceName> = {
  /**
   * **Only the services this capability declared.**
   *
   * `Pick`, not the whole interface, and that is the point: reading a service the factory did not
   * declare is a compile error rather than an `undefined` at execute time. Before this, every factory
   * received all ten and the declaration could not have been checked.
   */
  readonly services: Pick<ShareFlowServices, R>;
  readonly deps: DelegatingToolDeps;
};

/** A member of `ShareFlowServices`. Derived, so a new service is available here the moment it exists. */
export type ShareFlowServiceName = keyof ShareFlowServices;

/**
 * How a capability is registered: the services it needs, and a function from those to a tool.
 *
 * A factory rather than a constructed tool, so a capability is written against the seam and the
 * concrete services are supplied once at wiring time. It is also what keeps a capability testable —
 * pass a stub service, get a tool.
 *
 * ## Why `requires` exists
 *
 * A ShareFlow deployment does not necessarily have all ten services. Three of them have adapters in
 * this package; the rest are ports. Without a declaration, a partial deployment could only be served
 * by handing factories an object with seven holes in it, and the hole would surface as
 * `Cannot read properties of undefined` in the middle of somebody's conversation — or, worse, be
 * papered over with stubs that throw, which for a context provider takes the whole turn down (see
 * `adapters/index.ts` on `backend/src/context/assembler.ts:35`).
 *
 * With it, `createShareFlowToolProvider` refuses at construction. That is the property this file
 * already claimed to have and did not: *a wiring mistake should stop the process starting rather than
 * surface as a confusing catalog on someone's first conversation.*
 *
 * A declaration can go stale in two directions, and the type closes both: reading an undeclared
 * service does not compile, because `services` is a `Pick` of exactly `requires`; and declaring one
 * that is never read is caught by `noUnusedLocals` only if destructured, so the test asserts each
 * factory touches every service it asks for.
 */
export type ShareFlowToolFactory<R extends ShareFlowServiceName = ShareFlowServiceName> = {
  readonly requires: readonly R[];
  readonly build: (context: ShareFlowToolContext<R>) => Tool;
};

/**
 * Declares a capability and what it reads.
 *
 * The narrowing comes from the **constraint**, not from the `const` modifier: because `R extends
 * ShareFlowServiceName` is a union of string literals, `shareFlowTool(["content"], …)` infers
 * `R = "content"` and `Pick<ShareFlowServices, R>` is one member. I first wrote that `const` was what
 * prevented a widen to `string[]`, and a sabotage run disproved it — removing `const` changes nothing
 * here. It stays because it pins the argument as a readonly tuple, which is what it is.
 *
 * What *would* quietly undo this is anything that widens `R` to the whole union — a signature taking
 * `readonly ShareFlowServiceName[]`, or an explicit type argument at a call site. That degrades every
 * `Pick` back to the full interface with nothing else failing, so the narrowing is pinned by a
 * type-level equality in the tests rather than left to inference nobody checks.
 */
export const shareFlowTool = <const R extends ShareFlowServiceName>(
  requires: readonly R[],
  build: (context: ShareFlowToolContext<R>) => Tool,
): ShareFlowToolFactory<R> => ({ requires, build: (context) => withJsonTextArguments(build(context)) });

/**
 * Object arguments the model sent **as JSON text** are read as the objects they are.
 *
 * Seen three times on production, each time refused before the tool ran and each time only recovered
 * by a detour through `execute_tool`: `page: "{\"kind\": \"first\"}"` (#508, fixed for `page` alone),
 * then `campaign: "{\"kind\": \"none\"}"` on `create_post_draft` four times in a row (#500's test). A
 * per-field fix leaves the next field broken, so this is every tool's, in the one factory they all pass
 * through.
 *
 * Conservative by construction: the input is used as sent whenever it already validates; only when it
 * does not are string values that parse as a JSON object or array replaced, and the result is used
 * only if **that** validates. A real string argument that happens to look like JSON is never touched
 * on a valid call, and an invalid call that coercion does not rescue fails with the original input's
 * error. Both paths are covered — the schema the SDK validates against and the input `execute` checks.
 */
export const coerceJsonTextArguments = (value: unknown, schema: { safeParse(v: unknown): { success: boolean } }): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  if (schema.safeParse(value).success) return value;
  let changed = false;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, field] of Object.entries(copy)) {
    if (typeof field !== "string") continue;
    const text = field.trim();
    if (!(text.startsWith("{") && text.endsWith("}")) && !(text.startsWith("[") && text.endsWith("]"))) continue;
    try {
      copy[key] = JSON.parse(text) as unknown;
      changed = true;
    } catch {
      // Not JSON after all; left as sent.
    }
  }
  return changed && schema.safeParse(copy).success ? copy : value;
};

const isZodLike = (schema: unknown): schema is z.ZodTypeAny =>
  typeof schema === "object" && schema !== null && typeof (schema as { safeParse?: unknown }).safeParse === "function";

export const withJsonTextArguments = (tool: Tool): Tool => {
  const schema = tool.descriptor.inputSchema;
  if (!isZodLike(schema)) return tool;
  const keys = argumentNames(schema);
  return {
    ...tool,
    descriptor: {
      ...tool.descriptor,
      inputSchema: z.preprocess((value, ctx) => {
        const coerced = keys === undefined ? coerceJsonTextArguments(value, schema) : repairGlitchedNames(coerceJsonTextArguments(value, schema), keys);
        const unknown = keys === undefined ? undefined : unknownArguments(coerced, keys);
        if (unknown === undefined) return coerced;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: unknown.message });
        return unknown.rest;
      }, schema),
    },
    execute: (input) => {
      const coerced = coerceJsonTextArguments(input.input, schema);
      return tool.execute({ ...input, input: keys === undefined ? coerced : repairGlitchedNames(coerced, keys) });
    },
  };
};

/**
 * An argument name with a stray digit in it, read as the name it plainly is — #746.
 *
 * Production, 2026-10-11: Gemini sent `read_source` the key `maxPas1sages` and, told "did you mean
 * `maxPassages`?", sent `maxPas1sages` again — twenty times, until the run hit its step limit. #689's
 * `as1pectRatio` was the same slip. It is a decoding glitch, not a choice: the model cannot correct a key it
 * keeps emitting, so refusing it (right for a real typo) turns one slip into a lost turn.
 *
 * Deliberately narrow: only a key that becomes a valid name **exactly** once its digits are removed, and only
 * when that name was not also sent. No valid name here contains a digit, so the reading is unambiguous; any
 * other unknown key is still refused with the suggestion, as #689 decided.
 */
export const repairGlitchedNames = (value: unknown, keys: readonly string[]): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = false;
  const repaired = entries.map(([key, field]): [string, unknown] => {
    if (keys.includes(key) || !/\d/.test(key)) return [key, field];
    const meant = key.replace(/\d+/g, "");
    if (!keys.includes(meant) || meant === key || entries.some(([other]) => other === meant)) return [key, field];
    changed = true;
    return [meant, field];
  });
  return changed ? Object.fromEntries(repaired) : value;
};

/**
 * The argument names a tool takes, or undefined when its input is not one object (a union, say) — #689.
 * Read through the wrappers a schema is commonly built with (`.refine`, `.transform`, `z.preprocess`).
 */
export const argumentNames = (schema: unknown): readonly string[] | undefined => {
  type Node = { _def?: { typeName?: string; schema?: unknown; innerType?: unknown; unknownKeys?: string; catchall?: { _def?: { typeName?: string } } }; shape?: Record<string, unknown> };
  let current = schema as Node | undefined;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (current._def?.typeName === "ZodObject" && current.shape !== undefined) {
      // A schema built to take extra keys (`.passthrough()`, `.catchall()`) keeps them.
      const open = current._def.unknownKeys === "passthrough" || (current._def.catchall?._def?.typeName ?? "ZodNever") !== "ZodNever";
      return open ? undefined : Object.keys(current.shape);
    }
    current = (current._def?.schema ?? current._def?.innerType) as typeof current;
  }
  return undefined;
};

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length]!;
};

/** The valid name an unknown argument most likely meant, if one is close enough to be a typo. */
export const closestArgument = (name: string, keys: readonly string[]): string | undefined => {
  const lower = name.toLowerCase();
  let best: { key: string; d: number } | undefined;
  for (const key of keys) {
    const d = distance(lower, key.toLowerCase());
    if (best === undefined || d < best.d) best = { key, d };
  }
  return best !== undefined && best.d <= Math.max(2, Math.floor(best.key.length / 4)) ? best.key : undefined;
};

/**
 * Arguments the tool does not take, as a message the model can act on — #689.
 *
 * Production, 2026-10-04: `generate_media` got `as1pectRatio`. A strict schema refused it as "Unrecognized
 * key(s) in object: 'as1pectRatio'", the model did not retry, and the reply said the image was on its way. A
 * schema that is not strict is worse: it drops the key and runs with the default, so the person's choice is
 * silently lost. Either way the fix is the same — refuse, name the valid argument, and let the model retry.
 */
export const unknownArguments = (
  value: unknown,
  keys: readonly string[],
): { readonly message: string; readonly rest: Record<string, unknown> } | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length === 0) return undefined;
  const named = unknown.map((key) => {
    const meant = closestArgument(key, keys);
    return meant === undefined ? `"${key}"` : `"${key}" (did you mean "${meant}"?)`;
  });
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
  return {
    message: `Unknown argument${unknown.length === 1 ? "" : "s"} ${named.join(", ")}. This tool takes: ${keys.join(", ")}. Call it again with the right name — nothing was done.`,
    rest,
  };
};

/**
 * A store-issued id, as a tool argument.
 *
 * **A non-empty string, not a UUID — and that is a deliberate reversal.** I made it `.uuid()` after a real
 * gpt-4o turn passed `campaignId: "1"`, and then measured what that actually bought: the model simply
 * fabricated *well-formed* uuids instead (`00000000-…`, `12345678-1234-1234-1234-123456789abc`). It changed
 * which garbage arrived, not whether garbage arrived. The fabrication was fixed by making "no campaign"
 * sayable — see `createPostDraftSchema`.
 *
 * What it cost was worse than what it bought. `PostDraftId` and friends are **branded strings** in the port,
 * not uuids; uuid is how *this* ShareFlow schema happens to store them. Asserting it here pushes a storage
 * detail into the model-facing contract, so a deployment with opaque ids would have its valid ids refused by
 * a tool that has no business knowing the format.
 *
 * The format check belongs in the adapter, which does know — `asUuid` in `adapters/postgres/content.ts`
 * answers `invalid_input` naming the field, where the raw cast previously produced
 * `invalid input syntax for type uuid` under code `internal`.
 *
 * The description stays, because it is contract-level rather than storage-level: where ids come from is true
 * of every deployment.
 *
 * It was also defined **ten times**, once per tool file, which is why it lives here now. Ten copies of a
 * validation rule is ten places for it to be right in nine of them.
 */
/**
 * A URL a tool will fetch or render — **http(s) only**, and checked here rather than only in the adapter.
 *
 * `z.string().url()` accepts `file:///etc/passwd`: it checks that the string parses as a URL, not that
 * the scheme is one anybody wants. The adapters refuse it too — every fetch and every page load goes
 * through the platform's egress policy, which is https-only by default — but a schema refusal is *early
 * and precise*: the model is told the argument is wrong instead of being told the page could not be
 * loaded.
 *
 * Shared, because it is now needed by `read_pdf`, `describe_image`, `capture_website` and `read_source`,
 * and `idString`'s own note records what happens otherwise: *"it was defined ten times … ten copies of a
 * validation rule is ten places for it to be right in nine of them."*
 */
export const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//i.test(value), { message: "must be an http(s) URL" });

export const idString = z
  .string()
  .min(1)
  .describe("An id this workspace's own tools returned. Never invent one — read it from a previous result.");

/**
 * An *optional* id, where the model's placeholder for "none" means none — #577.
 *
 * The third measured instance of the rule above ("an optional scalar is an invitation to fabricate a
 * sentinel"), production 2026-09-28: `list_post_drafts` got `campaignId: "none"` and `"first"`, and
 * `generate_media` got `postDraftId: "/"` twice. Each was refused, and the model gave up and asked the
 * person for an id instead of listing or generating. For a *filter* or an *optional link*, a sentinel
 * has exactly one sane reading — not given — so it is read that way. A well-formed but fabricated id is
 * still refused by the store; this only stops a placeholder from sinking the whole call.
 */
const SENTINELS = new Set(["none", "null", "undefined", "any", "all", "first", "latest", "n/a", "na", "-", "dummy", "fake", "test", "sample", "example", "placeholder", "tbd", "tmp", "temp"]);
export const optionalIdString = z.preprocess(
  (value) =>
    typeof value === "string" &&
    (value.trim() === "" ||
      !/[a-z0-9]/i.test(value) ||
      SENTINELS.has(value.trim().toLowerCase()))
      ? undefined
      : value,
  idString.optional(),
);

/**
 * Which page to read: **a choice, not an optional cursor**.
 *
 * The second measured instance of the same model behaviour, and the reason this is a union rather than a
 * string. `campaignId: idString.optional()` was defeated by gpt-4o inventing ids; `cursor` was defeated the
 * same way, in one real turn, five times:
 *
 *     cursor: "/begin"   "/current"   "/start-over"   "/start-at-beginning"
 *
 * The model was trying to say *"the first page"* — including in direct response to a refusal message that
 * said "or omit it to start from the beginning". It cannot omit; it can only say things. So "first" is now a
 * thing it can say.
 *
 * The generalisation is worth stating because it will come up again: **an optional scalar in a tool schema is
 * an invitation to fabricate a sentinel.** Where omitting carries meaning, give the meaning a name.
 *
 * The cursor itself stays a plain string — `Page.nextCursor` is opaque in the port, and that this adapter
 * makes it an ISO instant is the adapter's business. `asCursor` refuses a malformed one there, by name.
 */
/**
 * The page choice, also accepted **as JSON text**.
 *
 * Production (#498's /drafts, Gemini): the model sent `page: "{\"kind\": \"first\"}"` — the object,
 * serialised — four times in a row, and the SDK refused each before the tool ran; only a detour through
 * `execute_tool` listed the drafts. A string that parses to a valid choice is that choice. Anything else
 * still fails validation with the schema's own message, and the declared schema is unchanged (an object).
 */
const parsedIfJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const pageChoice = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("first") }).strict(),
    z
      .object({
        kind: z.literal("after"),
        cursor: z.string().min(1).describe("The `nextCursor` from a previous page of this same tool."),
      })
      .strict(),
  ])
  .describe('Use {"kind":"first"} to start. Only use "after" with a `nextCursor` a previous page returned.');

export const pageInput = z.preprocess(parsedIfJson, pageChoice);

/** The cursor a `pageInput` names, or `undefined` for the first page. */
export const cursorOf = (page: { readonly kind: "first" } | { readonly kind: "after"; readonly cursor: string }):
  | string
  | undefined => (page.kind === "after" ? page.cursor : undefined);

/**
 * Whether a draft id could have come from a store — not a UUID check (ids are opaque, see `idString`), only
 * what none would ever issue: a path, spaces, placeholder words. Production sent "/tmp/temp_post_id",
 * "/create_post_draft_result_id_placeholder" and "dummy". The media tools use it to make the file anyway,
 * unattached, and say how to attach it — rather than fail the whole call over a link it can do without.
 */
export const plausibleDraftId = (id: string): boolean => !/[/\s]|placeholder|example|dummy|fake|tmp|temp_|result_id|draft_id/i.test(id);

export const unattachedNote = (id: string): string =>
  `"${id.slice(0, 60)}" is not a draft id, so the result is not attached. Attach it with attach_media_to_post (or pass the postDraftId a save tool returned) once the post exists.`;

