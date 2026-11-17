/**
 * The agent mode, enforced where tools run — #550.
 *
 * Four modes, chosen per chat in the web and carried on each run (`turn-settings.ts`):
 *
 *  - `auto`       — today's assistant: drafts, edits and makes media on its own; anything public
 *                   (publish, schedule, reply, delete) already asks, by its effect.
 *  - `ask_first`  — every write asks first, `internal-write` included.
 *  - `plan`       — the same gate as `ask_first`, plus a prompt clause (see `turn-context.ts`) telling the
 *                   model to propose a plan before touching anything. The gate is what makes the promise
 *                   hold if the model forgets the clause.
 *  - `chat_only`  — no write tool is offered at all, and one reached anyway is refused.
 *
 * ## Why a wrapper around the registry and not the descriptors
 *
 * The registry consults its approval gate only for tools whose `approvalPolicy` is not `never`, and a
 * descriptor's policy is fixed when the tool is built — per deployment, not per chat. Rewriting
 * descriptors per turn would mean rebuilding the registry per turn, and the memory note on tool effects
 * is the warning: effect derives approval in several places, and a second derivation drifts. So the
 * mode is applied one layer out, in front of `execute`: a write the mode gates is refused with
 * `approval_required` unless the gate — the very same `createApprovalGate` instance, grants and
 * one-time tickets included — allows it as if its policy were `always`. `createRunApprovals` turns that
 * refusal into the ordinary permission card; the approved retry arrives with its ticket and passes.
 *
 * ## After outside content (#662)
 *
 * In every mode, once a run has read outside content (`outside-content.ts`), its internal writes ask the same way
 * Ask-first's do — except the document being edited in this chat. A web page that says "update the brand voice"
 * then produces a card, not a silent write. A run that read nothing outside asks for nothing new.
 *
 * Both the model's tools and the approval loop must use this registry, for the reason `engine.ts` gives
 * for `withLearnableSchemas`: the loop calls `execute` directly and would otherwise walk around it.
 */
import type { ExecutionContext } from "@retinue/agentkit";
import type { ToolRegistry } from "@retinue/agentkit";
import { FREE_AFTER_OUTSIDE_READ, OUTSIDE_CONTENT_TOOLS, type OutsideReads } from "./outside-content.js";
import type { AgentMode, TurnInputReader } from "./turn-settings.js";

type Gate = {
  isAllowed(
    context: ExecutionContext,
    tool: { readonly name: string; readonly category: string; readonly approvalPolicy: "never" | "policy" | "always" },
    oneTime?: unknown,
  ): Promise<boolean>;
};

type ExecuteInput = Parameters<ToolRegistry["execute"]>[1];

const META = new Set(["find_tools", "learn_tools", "load_skill"]);

/** Whether a mode puts a tool of this effect behind the person. `external-write`/`destructive` already are. */
export const modeGates = (mode: AgentMode, effect: string): "allow" | "ask" | "refuse" => {
  if (effect === "read") return "allow";
  if (mode === "chat_only") return "refuse";
  if ((mode === "ask_first" || mode === "plan") && effect === "internal-write") return "ask";
  return "allow";
};

const refusal = (code: string, message: string) => ({ ok: false as const, error: { code, message, retryable: false } });

/** #662: whether an outside read puts this write behind the person, on top of what the mode decided. */
export const outsideReadGates = (effect: string, tool: string): boolean => effect === "internal-write" && !FREE_AFTER_OUTSIDE_READ.includes(tool);

export const withAgentMode = (
  registry: ToolRegistry,
  deps: { readonly gate: Gate; readonly turnInput: TurnInputReader; readonly outsideReads?: OutsideReads },
): ToolRegistry => {
  const effectOf = async (context: ExecutionContext, name: string): Promise<{ effect: string; category: string } | null> => {
    const [descriptor] = await registry.learn(context, [name]);
    return descriptor === undefined ? null : { effect: descriptor.effect, category: descriptor.category };
  };

  return {
    ...registry,

    /** Chat only: the write tools are not offered, so the model is not tempted into a refusal. */
    async catalog(context, policy) {
      const catalog = await registry.catalog(context, policy);
      const { settings } = await deps.turnInput(context);
      if (settings.mode !== "chat_only") return catalog;
      return {
        ...catalog,
        preloaded: catalog.preloaded.filter((d) => d.effect === "read"),
        discoverable: catalog.discoverable.filter((d) => d.effect === "read"),
      };
    },

    async execute(context, input: ExecuteInput) {
      if (META.has(input.name)) return registry.execute(context, input);
      const { settings } = await deps.turnInput(context);
      const outsideReads = deps.outsideReads;
      if (settings.mode === "auto" && outsideReads === undefined) return registry.execute(context, input);

      // `execute_tool` is judged by what it would run; its approval is raised and checked under its own name.
      const target =
        input.name === "execute_tool"
          ? String(((input.input ?? {}) as { name?: unknown }).name ?? "")
          : input.name;
      const described = target === "" ? null : await effectOf(context, target);
      if (described === null) return registry.execute(context, input);

      let verdict = modeGates(settings.mode, described.effect);
      const afterOutsideRead =
        verdict === "allow" && outsideReads !== undefined && outsideReadGates(described.effect, target) && (await outsideReads.has(context));
      if (afterOutsideRead) verdict = "ask";
      if (verdict === "refuse") {
        return refusal(
          "forbidden",
          `This chat is in Chat only mode, so ${target} cannot run: nothing is created or changed. ` +
            "Answer or suggest instead, and tell the person they can switch the mode under the chat box to let you act.",
        ) as never;
      }
      if (verdict === "ask") {
        const allowed = await deps.gate.isAllowed(
          context,
          { name: input.name, category: described.category, approvalPolicy: "always" },
          (input as { approval?: unknown }).approval,
        );
        if (!allowed) {
          return refusal(
            "approval_required",
            afterOutsideRead
              ? `Tool ${input.name} requires approval: this turn read outside content (a web page, search result, document or comment), so saved data changes only once the person confirms.`
              : `Tool ${input.name} requires approval: this chat is in ${settings.mode === "plan" ? "Plan" : "Ask first"} mode.`,
          ) as never;
        }
      }
      const result = await registry.execute(context, input);
      if (outsideReads !== undefined && OUTSIDE_CONTENT_TOOLS.includes(target) && (result as { ok?: unknown }).ok === true) outsideReads.mark(context);
      return result;
    },
  };
};
