/**
 * Runtime validation for the core wire contracts — `docs/02-core-and-persistence.md`.
 *
 * Every message part is JSON-runtime validated and carries a `schemaVersion`. `providerMetadata`
 * is namespaced and **non-authoritative**: it is preserved on round-trip but never participates
 * in discrimination or any branching — a part's `type` is the only source of truth.
 */

import { z } from "zod";
import { AgentPlatformError, ERROR_CODES, type PlatformError } from "./errors.js";
import type { ExecutionContext } from "./context.js";
import type { Message, MessagePart } from "./content-parts.js";
import { RUN_EVENT_TYPES, type RunEvent } from "./events.js";

const idString = z.string().min(1);
const providerMetadata = z.record(z.string(), z.unknown()).optional();

/** Fields on every part. `providerMetadata` is optional and never authoritative. */
const base = {
  id: idString,
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  providerMetadata,
};

const platformErrorSchema: z.ZodType<PlatformError> = z.object({
  code: z.enum([...ERROR_CODES]),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryAfterMs: z.number().optional(),
});

const messagePartSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), text: z.string() }),
  z.object({ ...base, type: z.literal("reasoning"), text: z.string(), redacted: z.boolean().optional() }),
  z.object({ ...base, type: z.literal("tool-call"), toolCallId: idString, toolName: z.string(), input: z.unknown() }),
  z.object({
    ...base, type: z.literal("tool-result"), toolCallId: idString, toolName: z.string(),
    output: z.unknown().optional(), spilledOutputRef: idString.optional(), truncated: z.boolean(),
  }),
  z.object({
    ...base, type: z.literal("question"), interactionId: idString,
    questions: z.array(z.object({ key: z.string(), prompt: z.string(), options: z.array(z.string()).optional() })),
    answeredAt: z.string().optional(),
  }),
  z.object({
    ...base, type: z.literal("approval"), interactionId: idString, toolName: z.string(),
    summary: z.string(), riskCategory: z.string(), decidedAt: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("file"), fileId: idString, filename: z.string(), mediaType: z.string(), byteSize: z.number().int().nonnegative() }),
  z.object({ ...base, type: z.literal("image"), fileId: idString, mediaType: z.string(), width: z.number().optional(), height: z.number().optional(), altText: z.string().optional() }),
  z.object({ ...base, type: z.literal("citation"), sourceId: z.string(), quote: z.string(), locator: z.string().optional() }),
  z.object({ ...base, type: z.literal("source"), sourceId: z.string(), title: z.string(), url: z.string().optional() }),
  z.object({ ...base, type: z.literal("artifact"), artifactId: idString, versionId: idString, title: z.string() }),
  z.object({ ...base, type: z.literal("status"), status: z.string(), detail: z.string().optional() }),
  z.object({ ...base, type: z.literal("error"), error: platformErrorSchema }),
]);

const executionContextSchema = z.object({
  tenantId: idString,
  principalId: idString,
  membershipId: z.string().optional(),
  roleIds: z.array(z.string()),
  locale: z.string(),
  timezone: z.string(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  requestId: idString,
});

const runEventSchema = z.object({
  type: z.enum([...RUN_EVENT_TYPES]),
  runId: idString,
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().min(1),
}).passthrough();

const fail = (what: string, error: z.ZodError): never => {
  throw new AgentPlatformError({
    code: "invalid_input",
    message: `Invalid ${what}: ${error.issues.map((i: z.ZodIssue) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    retryable: false,
  });
};

/** Validate an unknown JSON value into a typed message part, or throw `invalid_input`. */
export const parseMessagePart = (value: unknown): MessagePart => {
  const r = messagePartSchema.safeParse(value);
  return r.success ? (r.data as MessagePart) : fail("message part", r.error);
};

/** JSON-safe wire form. `parseMessagePart(serializeMessagePart(x))` round-trips to `x`. */
export const serializeMessagePart = (part: MessagePart): unknown =>
  JSON.parse(JSON.stringify(part));

export const parseExecutionContext = (value: unknown): ExecutionContext => {
  const r = executionContextSchema.safeParse(value);
  return r.success ? (r.data as unknown as ExecutionContext) : fail("execution context", r.error);
};

export const parseRunEvent = (value: unknown): RunEvent => {
  const r = runEventSchema.safeParse(value);
  return r.success ? (r.data as unknown as RunEvent) : fail("run event", r.error);
};
