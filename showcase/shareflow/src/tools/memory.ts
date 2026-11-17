import { z } from "zod";
import type { Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";

import type { ShareFlowToolFactory } from "./factory.js";
import { shareFlowTool } from "./factory.js";
import { PERSONAL_MEMORY_MAX_CHARS } from "../adapters/personal-memory.js";

/**
 * Personal memory — #621. What the assistant keeps about **the person it is talking to**, across all their chats
 * in the workspace, beside the project's rules (`remember_project_rule`), which belong to everyone in a project.
 *
 * Neither tool takes a person: the principal is the turn's own, read from the context by the service. So the
 * model cannot remember something "for" a colleague, and cannot read or forget anybody else's memory.
 *
 * `internal-write`, ungated, exactly like `remember_project_rule`: it writes inside the workspace, the person
 * asked for it, and Settings → Memory lists, switches off and deletes every entry. An approval card for "call
 * me Sam" would be friction with nothing to protect.
 */
const rememberSchema = z.object({ memory: z.string().trim().min(3).max(PERSONAL_MEMORY_MAX_CHARS) }).strict();

export const rememberAboutMeTool = shareFlowTool(["personalMemory"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "remember_about_me",
    label: "Remember about you",
    description:
      "Remember a lasting personal preference or fact about the person you are talking to, for all their chats: how they write (\"Writes in British English.\"), what they like (\"Prefers captions without emoji.\"), what to call them (\"Is called Sam.\"). One short sentence in the third person. Only when they state a lasting preference about themselves or ask you to remember something about them — not a one-off request, and not a rule for the project (that is remember_project_rule). Never a password, key, card number or other secret, nor health, financial or other sensitive personal data — such text is refused. The same memory twice is stored once. They see and manage it in Settings → Memory. When they ask you to forget something about them, find the forget tool with find_tools.",
    category: "posts",
    effect: "internal-write",
    inputSchema: rememberSchema,
    delegatesTo: "PersonalMemoryService.remember",
    delegate: async (input: z.infer<typeof rememberSchema>, context) => {
      const { memory, duplicate } = await services.personalMemory.remember(context, { text: input.memory });
      return {
        memoryId: memory.id,
        text: memory.text,
        duplicate,
        note: duplicate
          ? memory.enabled
            ? "Already remembered — nothing new was stored."
            : "Already remembered, but switched off in Settings → Memory; it only applies once they switch it back on there."
          : "Remembered for all of their chats. They can see or delete it in Settings → Memory.",
      };
    },
  }));

const forgetSchema = z
  .object({
    memoryId: z.string().trim().min(1).max(100).optional(),
    text: z.string().trim().min(2).max(PERSONAL_MEMORY_MAX_CHARS).optional(),
  })
  .strict()
  .refine((v) => (v.memoryId === undefined) !== (v.text === undefined), { message: "pass memoryId or text, not both" });

export const forgetAboutMeTool = shareFlowTool(["personalMemory"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "forget_about_me",
    label: "Forget something about you",
    description:
      "Forget something you remember about the person you are talking to — when they ask you to forget it or say it no longer holds. Pass memoryId (the id shown in the About you section of your context) or text (part of what was remembered). If the text matches several memories nothing is forgotten and the matches come back: ask which one they mean.",
    category: "posts",
    effect: "internal-write",
    inputSchema: forgetSchema,
    delegatesTo: "PersonalMemoryService.forget",
    delegate: async (input: z.infer<typeof forgetSchema>, context) => {
      const result = await services.personalMemory.forget(context, {
        ...(input.memoryId === undefined ? {} : { id: input.memoryId }),
        ...(input.text === undefined ? {} : { text: input.text }),
      });
      if (result.matches !== undefined && result.matches.length > 0) {
        return {
          forgotten: [],
          matches: result.matches.map((m) => ({ memoryId: m.id, text: m.text })),
          note: "Several memories match, so none was forgotten. Ask the person which one they mean, then pass its memoryId.",
        };
      }
      return { forgotten: result.forgotten.map((m) => ({ memoryId: m.id, text: m.text })), note: "Forgotten for all of their chats." };
    },
  }));

export const MEMORY_TOOL_NAMES = ["remember_about_me", "forget_about_me"] as const;
export const MEMORY_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [rememberAboutMeTool, forgetAboutMeTool];
