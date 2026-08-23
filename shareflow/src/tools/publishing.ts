/**
 * The Publishing capabilities — docs/07 Workflow 2, and the one criterion the spec states with no
 * tolerance: *"zero unauthorized or duplicate actions"* (#119).
 *
 * Everything else in this package is recoverable. A published post is not: it is public, it is
 * irreversible, and the only remedy is to delete something people may already have seen. So three
 * things here are done differently from every other category, and each is a decision rather than a
 * default.
 *
 * ## 1. The idempotency key is per destination, and not derived from the call
 *
 * `create_post_draft` threads the *envelope's* key, because two create calls are two drafts. Publishing
 * is the opposite: the key comes from the draft and the destination and **nothing else**.
 *
 * A retry of the same call is the easy half. The half that matters is a *second, distinct* call to
 * publish the same draft to the same account: derived from the call it would republish, and derived from
 * the destination it does not. `socialPostTargets` already holds one row per (post, platform), and
 * ShareFlow's documented way to publish the same content again is to **duplicate the draft** — which is
 * what `duplicate_post_draft` is for.
 *
 * ## 2. Validation runs before the approval gate, not inside the delegate
 *
 * Through the envelope's `preflight`, which exists for this. A human asked to approve a publish that
 * then fails validation learns that their approval does not mean much, which is a worse outcome than the
 * failed publish.
 *
 * ## 3. The overall outcome is derived, and "unconfirmed" outranks "published"
 *
 * `AWAITING_PLATFORM` is the normal path for video, not an edge case — `finish-pending-targets` exists
 * because otherwise those posts *"sit at 'Awaiting platform' forever, which is the single easiest way for
 * a scheduler to quietly lose a post."* An assistant that reported success while a destination was
 * mid-transcode would be claiming an outcome nobody confirmed.
 */
import { z } from "zod";
import { AgentPlatformError, asId, defineDelegatingTool, type ExecutionContext, type Tool } from "@agentkit/backend";
import {
  type PostDraftId,
  type PublishTarget,
  type PublishTargetId,
  type PublishTargetStatus,
  type SocialAccountId,
  type ValidationIssue,
  type ValidationReport,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

const idString = z.string().min(1);
const accountIds = z.array(idString).min(1).max(20);

/** `YYYY-MM-DDTHH:MM:SSZ`-ish. Rejected here so a malformed time never reaches an approval request. */
const instant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v), "expected an ISO 8601 instant");

/**
 * The key that makes one destination publish once.
 *
 * Deterministic in the draft and the account, and in nothing else — **not** the call, the run, or the
 * arguments. Exported and tested because the whole of AC-2 and AC-3 rests on it: change what goes in
 * here and a second publish call republishes.
 *
 * Escaped the way `runJobId` is, for the reason #105 found the hard way: `a:b` + `c` and `a` + `b:c`
 * produce the same string when a separator can appear inside a part, and two distinct destinations
 * sharing a key would mean one of them silently never publishes.
 */
export const publishTargetIdempotencyKey = (input: {
  readonly draftId: PostDraftId;
  readonly accountId: SocialAccountId;
}): string => {
  const escape = (v: string) => v.replace(/%/g, "%25").replace(/:/g, "%3A");
  return `publish:${escape(input.draftId)}:${escape(input.accountId)}`;
};

const targetsFor = (
  draftId: PostDraftId,
  accountIds: readonly string[],
  scheduledAt?: string,
): readonly PublishTarget[] =>
  accountIds.map((raw) => {
    const accountId = asId<SocialAccountId>(raw);
    return {
      accountId,
      idempotencyKey: publishTargetIdempotencyKey({ draftId, accountId }),
      ...(scheduledAt === undefined ? {} : { scheduledAt }),
    };
  });

// ---------------------------------------------------------------------------------------------------
// Outcome, derived
// ---------------------------------------------------------------------------------------------------

export const PUBLISH_OUTCOMES = ["published", "scheduled", "partial", "unconfirmed", "failed", "none"] as const;
export type PublishOutcome = (typeof PUBLISH_OUTCOMES)[number];

/**
 * One word for what happened, computed from the per-destination states.
 *
 * **`unconfirmed` outranks everything.** If any destination is still publishing or awaiting the platform,
 * the answer cannot be `published` or `partial` however well the others went — those are claims about a
 * finished action, and this action is not finished. That ordering is the substance of AC-5 and AC-6
 * together, and it is why this is a function with a test per combination rather than a `.every()` at the
 * call site.
 *
 * `none` is for an empty set, which should not happen and must not read as success if it does.
 */
export const publishOutcomeFor = (statuses: readonly PublishTargetStatus[]): PublishOutcome => {
  if (statuses.length === 0) return "none";
  const has = (state: PublishTargetStatus["state"]) => statuses.some((s) => s.state === state);
  if (has("publishing") || has("awaiting-platform")) return "unconfirmed";
  if (statuses.every((s) => s.state === "published")) return "published";
  if (statuses.every((s) => s.state === "scheduled")) return "scheduled";
  if (has("published")) return "partial";
  return "failed";
};

const targetView = (status: PublishTargetStatus) => ({
  publishTargetId: status.id,
  accountId: status.accountId,
  state: status.state,
  // Per destination, always — never collapsed into one answer. A destination that failed while two
  // succeeded is the case AC-5 is about, and a caller reading only the overall outcome still gets
  // `partial`, not `published`.
  ...(status.scheduledAt === undefined ? {} : { scheduledAt: status.scheduledAt }),
  ...(status.publishedAt === undefined ? {} : { publishedAt: status.publishedAt }),
  ...(status.externalUrl === undefined ? {} : { externalUrl: status.externalUrl }),
  ...(status.attemptCount === undefined ? {} : { attemptCount: status.attemptCount }),
  ...(status.failure === undefined ? {} : { failure: status.failure }),
  ...(status.stuck === undefined ? {} : { stuck: status.stuck }),
});

const issueView = (issue: ValidationIssue) => ({
  code: issue.code,
  message: issue.message,
  repairable: issue.repairable,
  ...(issue.platformId === undefined ? {} : { platformId: issue.platformId }),
  ...(issue.accountId === undefined ? {} : { accountId: issue.accountId }),
});

/**
 * What a result says about destinations that are not finished.
 *
 * AC-6 asks for an unconfirmable outcome to carry remediation. The remediation is not an action for the
 * user: `finish-pending-targets` sweeps `AWAITING_PLATFORM` rows automatically. So the honest guidance is
 * *wait and re-read the status* — unless the destination has been unconfirmed past ShareFlow's 24-hour
 * ceiling, at which point it is stuck and a person has to look.
 */
const followUpFor = (statuses: readonly PublishTargetStatus[]) => {
  const unconfirmed = statuses.filter((s) => s.state === "publishing" || s.state === "awaiting-platform");
  if (unconfirmed.length === 0) return {};
  return {
    followUp: {
      action: unconfirmed.some((s) => s.stuck === true) ? ("needs-attention" as const) : ("recheck-later" as const),
      unconfirmedAccountIds: unconfirmed.map((s) => s.accountId),
    },
  };
};

const reportView = (statuses: readonly PublishTargetStatus[]) => ({
  // Derived here rather than asked of the service, so an adapter cannot report success on a partial
  // result — and so a caller cannot forget to check.
  outcome: publishOutcomeFor(statuses),
  targets: statuses.map(targetView),
  ...followUpFor(statuses),
});

// ---------------------------------------------------------------------------------------------------
// Validate — read
// ---------------------------------------------------------------------------------------------------

const validateSchema = z.object({ postDraftId: idString, accountIds }).strict();

const reportOf = (report: ValidationReport) => ({
  ok: report.ok,
  issues: report.issues.map(issueView),
});

export const validatePublishTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "validate_publish",
    label: "Check a post before publishing",
    description:
      "Check whether a post can be published to these destinations: role, account health, content and media. Read-only and sends nothing. Worth calling before proposing a publish, because the repair is cheap now and a partial publish afterwards is not.",
    category: "publishing",
    effect: "read",
    inputSchema: validateSchema,
    delegatesTo: "PublishingService.validate",
    delegate: async (input: z.infer<typeof validateSchema>, context) =>
      reportOf(
        await services.publishing.validate(context, {
          draftId: asId<PostDraftId>(input.postDraftId),
          accountIds: input.accountIds.map((id) => asId<SocialAccountId>(id)),
        }),
      ),
  });

// ---------------------------------------------------------------------------------------------------
// Publish and schedule — external-write, approval always
// ---------------------------------------------------------------------------------------------------

/**
 * The preflight shared by publish and schedule.
 *
 * Runs before the approval gate. Read-only, which the envelope requires and which matters here more than
 * anywhere: it runs on calls that are about to be refused for want of an approval, so a side effect in
 * it would be a side effect happening without approval.
 */
const publishPreflight =
  (services: ShareFlowToolContext["services"]) =>
  async (input: { postDraftId: string; accountIds: readonly string[] }, context: ExecutionContext) => {
    const report = await services.publishing.validate(context, {
      draftId: asId<PostDraftId>(input.postDraftId),
      accountIds: input.accountIds.map((id) => asId<SocialAccountId>(id)),
    });
    if (report.ok) return;
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "this post cannot be published to those destinations yet",
      retryable: false,
      // The findings travel structured, so a repair step can branch on a code rather than parse a
      // sentence — and so the assistant can say which destination and why.
      details: { issues: report.issues.map(issueView) },
    });
  };

const publishNowSchema = z.object({ postDraftId: idString, accountIds }).strict();

export const publishPostNowTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "publish_post_now",
    label: "Publish now",
    description:
      "Publish a post to the given destinations immediately. This is public and cannot be undone, so it requires the user's approval. Report only what the result confirms: a destination that is still processing is not published, and a partial result is not a success.",
    category: "publishing",
    effect: "external-write",
    inputSchema: publishNowSchema,
    delegatesTo: "PublishingService.schedule",
    preflight: publishPreflight(services),
    delegate: async (input: z.infer<typeof publishNowSchema>, context, { idempotencyKey }) => {
      const draftId = asId<PostDraftId>(input.postDraftId);
      return reportView(
        await services.publishing.schedule(context, {
          idempotencyKey,
          draftId,
          targets: targetsFor(draftId, input.accountIds),
        }),
      );
    },
  });

const scheduleSchema = z.object({ postDraftId: idString, accountIds, scheduledAt: instant }).strict();

export const schedulePostTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "schedule_post",
    label: "Schedule a post",
    description:
      "Schedule a post to publish at a given time. Requires the user's approval, because it will publish without asking again. Scheduling is not publishing — the result says `scheduled`, and the outcome is only known once it runs.",
    category: "publishing",
    effect: "external-write",
    inputSchema: scheduleSchema,
    delegatesTo: "PublishingService.schedule",
    preflight: publishPreflight(services),
    delegate: async (input: z.infer<typeof scheduleSchema>, context, { idempotencyKey }) => {
      const draftId = asId<PostDraftId>(input.postDraftId);
      return reportView(
        await services.publishing.schedule(context, {
          idempotencyKey,
          draftId,
          targets: targetsFor(draftId, input.accountIds, input.scheduledAt),
        }),
      );
    },
  });

// ---------------------------------------------------------------------------------------------------
// Status and retry
// ---------------------------------------------------------------------------------------------------

const statusSchema = z.object({ postDraftId: idString }).strict();

export const getPublishStatusTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_publish_status",
    label: "Check what was published",
    description:
      "What actually happened to a post, per destination. The only source for whether something published — do not infer it from an earlier publish call, which may have returned before the platforms finished.",
    category: "publishing",
    effect: "read",
    inputSchema: statusSchema,
    delegatesTo: "PublishingService.getStatus",
    delegate: async (input: z.infer<typeof statusSchema>, context) =>
      reportView(
        await services.publishing.getStatus(context, { draftId: asId<PostDraftId>(input.postDraftId) }),
      ),
  });

const retrySchema = z.object({ publishTargetId: idString }).strict();

export const retryPublishTargetTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "retry_publish_target",
    label: "Retry one destination",
    description:
      "Retry a single destination that failed. One destination at a time, by its own id — a post that reached three of four channels must not be re-sent to the three that worked. Requires approval, because it is still a public action.",
    category: "publishing",
    effect: "external-write",
    inputSchema: retrySchema,
    delegatesTo: "PublishingService.retry",
    delegate: async (input: z.infer<typeof retrySchema>, context, { idempotencyKey }) =>
      targetView(
        await services.publishing.retry(context, {
          idempotencyKey,
          targetId: asId<PublishTargetId>(input.publishTargetId),
        }),
      ),
  });

/** The complete Publishing catalog, pinned by a test. */
export const PUBLISHING_TOOL_NAMES = [
  "validate_publish",
  "publish_post_now",
  "schedule_post",
  "get_publish_status",
  "retry_publish_target",
] as const;

export const PUBLISHING_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  validatePublishTool,
  publishPostNowTool,
  schedulePostTool,
  getPublishStatusTool,
  retryPublishTargetTool,
];
