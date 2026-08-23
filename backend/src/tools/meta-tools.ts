/**
 * Built-in meta-tools — `docs/03-intelligence-runtime.md` → Tool registry.
 *
 * These are always present and never provider-supplied. They are the model's interface to the
 * two-tier tool system: a compact catalog sits in context, and the model uses `learn_tools` to pull
 * a schema, `execute_tool` to run one, and `read_tool_output` to fetch a result that was spilled to
 * blob storage. `load_skill` and `ask_questions` are handled by their own subsystems (skills / HITL);
 * their descriptors live here so the catalog advertises them uniformly.
 *
 * `request_approval` is the odd one out, and its description says so. The model does not have to call
 * it: the run path raises the approval itself when the gate refuses a call
 * (`../hitl/approved-execution.ts`), which is the safer arrangement — a model that *forgot* to ask
 * would otherwise be a model that published without asking. It stays in the catalog because the doc
 * names it and because a model that announces the ask reads better than one that silently stalls.
 */

import type { MetaToolName, ToolDescriptor } from "./index.js";

const meta = (
  name: MetaToolName,
  label: string,
  description: string,
): ToolDescriptor => ({
  name,
  label,
  description,
  category: "meta",
  inputSchema: {},
  outputSchema: {},
  effect: "read",
  approvalPolicy: "never",
  requiresIdempotencyKey: false,
});

export const META_TOOL_DESCRIPTORS: Readonly<Record<MetaToolName, ToolDescriptor>> = {
  learn_tools: meta("learn_tools", "Learn tools", "Fetch the full input/output schemas for named tools before using them."),
  execute_tool: meta("execute_tool", "Execute tool", "Run a tool by name with validated input; authorization is rechecked at execution."),
  load_skill: meta("load_skill", "Load skill", "Load a named skill's instructions into context on demand."),
  ask_questions: meta("ask_questions", "Ask questions", "Ask the user consequential questions that cannot be resolved from context or tools."),
  request_approval: meta("request_approval", "Request approval", "Request human approval before a policy-classified action such as publishing or sending. The platform also raises this automatically when a gated tool is called without approval, so a call is never performed unapproved because this was not used."),
  read_tool_output: meta("read_tool_output", "Read tool output", "Read back a large tool result that was spilled to storage and referenced."),
};

export const META_TOOL_DESCRIPTOR_LIST: readonly ToolDescriptor[] = Object.values(META_TOOL_DESCRIPTORS);
