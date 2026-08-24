/**
 * Conversation modes — plan, ask, auto (#155).
 *
 * Three levels of autonomy, and **every one is built on a platform primitive that already existed**. That is the
 * interesting part: "modes" sounds like a feature but it is really a naming of three configurations the approval
 * machinery already supported.
 *
 * | Mode | What it is, mechanically |
 * |---|---|
 * | `plan` | Write and external-write tools are **excluded from the catalogue**, so the model cannot call them and does not offer to. It describes what it would do. |
 * | `ask` | The default. Gated tools raise an approval and the run suspends. |
 * | `auto` | A **conversation-scoped standing grant**, so the gate is satisfied without asking. |
 *
 * `plan` is deliberately *not* "ask and always deny". Excluding the tool from the catalogue means the model plans
 * with an accurate picture of what it can do; leaving it visible and refusing every call teaches it to keep
 * trying, and produces plans that assume actions it will not be allowed to take.
 *
 * `auto` is a real grant with a real scope, not a bypass. The approval is still recorded, still auditable, and
 * still expires with the conversation — so "the assistant did this on its own" remains answerable afterwards.
 * A boolean that skipped the gate would leave no trace of *why* something was allowed.
 */

export const CONVERSATION_MODES = ["plan", "ask", "auto"] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/**
 * The default.
 *
 * `ask`, not `auto`. An assistant that acts irreversibly without being asked is the failure this platform's whole
 * HITL layer exists to prevent, and a default is what most conversations will run under.
 */
export const DEFAULT_MODE: ConversationMode = "ask";

export const isConversationMode = (value: unknown): value is ConversationMode =>
  typeof value === "string" && (CONVERSATION_MODES as readonly string[]).includes(value);

/**
 * Tool categories and effects each mode may reach.
 *
 * Keyed on **effect**, not on tool name. A list of names is a list that goes stale the moment someone adds a
 * tool — and the new tool would silently be available in plan mode, which is the one place it must not be.
 */
export const EXCLUDED_EFFECTS: Readonly<Record<ConversationMode, readonly string[]>> = {
  // Reads only. Anything that changes state, inside or outside the workspace, is out of reach.
  plan: ["internal-write", "external-write", "destructive"],
  ask: [],
  auto: [],
};

export type ModeDescription = {
  readonly mode: ConversationMode;
  readonly label: string;
  /** Shown to the person choosing. Says what changes, not how it feels. */
  readonly summary: string;
  /** Appended to the system prompt, so the model knows what it can actually do this turn. */
  readonly instruction: string;
};

export const MODE_DESCRIPTIONS: Readonly<Record<ConversationMode, ModeDescription>> = {
  plan: {
    mode: "plan",
    label: "Plan",
    summary: "Read and think only. Cannot change or share anything.",
    instruction: [
      "## Mode: plan",
      "",
      "You are in planning mode. Tools that change or share anything are not available to you this turn — you",
      "will not find them in your tool list, and that is deliberate.",
      "",
      "Read what you need, then describe what you *would* do, concretely: which tools, in which order, with which",
      "arguments, and what could go wrong. Do not pretend to have done it, and do not ask for permission — the",
      "person has an **Execute plan** button under your reply, and pressing it will send you back here with the",
      "tools available and an instruction to carry the plan out. So write the plan for that moment: numbered",
      "steps you can follow literally, not a summary of your intentions.",
    ].join("\n"),
  },
  ask: {
    mode: "ask",
    label: "Ask first",
    summary: "Acts freely, but pauses for your approval before anything irreversible.",
    instruction: [
      "## Mode: ask first",
      "",
      "Call tools as you need them. Anything irreversible pauses for the person's approval automatically — call",
      "the tool and the platform will handle it. Do not ask for permission in text.",
    ].join("\n"),
  },
  auto: {
    mode: "auto",
    label: "Auto",
    summary: "Acts without asking, including irreversible actions. Everything is still recorded.",
    instruction: [
      "## Mode: auto",
      "",
      "The person has granted standing approval for this conversation, so irreversible actions will not pause.",
      "That makes you responsible for judgement rather than the approval prompt: say what you are about to do",
      "before you do it, prefer the smaller action when two would work, and stop and ask a question if the",
      "request is ambiguous. Everything you do is recorded and attributable.",
    ].join("\n"),
  },
};

/** The category standing grants are issued against in `auto`. Must match the tools' declared category. */
export const AUTO_GRANT_CATEGORY = "assistant";

/**
 * Where "execute this plan" lands — **`ask`, not `auto`**.
 *
 * Approving a plan is not the same as granting standing approval for everything that follows. The plan the
 * person read is a description; what the model actually does with a tool is decided a turn later, with
 * arguments they have not seen. So the irreversible steps still pause individually, and the person who wants
 * them not to can choose `auto` themselves — one click away, and their choice rather than a consequence of
 * clicking "execute".
 *
 * This is the same reasoning `DEFAULT_MODE` uses, applied at the moment it would be most tempting to skip.
 */
export const PLAN_EXECUTION_MODE: ConversationMode = "ask";

/**
 * The turn sent on the person's behalf when they execute a plan.
 *
 * A real user message, recorded in `messages` like any other, because that is what it is: the person did
 * instruct this. Synthesising it into the system prompt instead would make the transcript claim the model
 * decided to act on its own.
 */
export const PLAN_EXECUTION_PROMPT = "Execute the plan you just described. Carry out the steps in order.";
