/**
 * The Leads capabilities — docs/07 Workflow 6's tail (#120).
 *
 * ## AC-4 is about honest reporting, not about calling the right function
 *
 * `leadSuppression` is described in its own object definition as *"checked before every insert, so a
 * re-run of the same search cannot resurrect someone who opted out."* Suppression is enforced **inside**
 * the insert path. So the risk is not that a tool bypasses it — a tool cannot — it is that a tool
 * **misreports** it.
 *
 * The failure that matters: `create_lead` returning success for a lead the service refused. The assistant
 * would tell the user a lead was captured, for someone who had opted out or complained. Nobody would
 * find out until the lead was missing from a report, or worse, until someone was contacted.
 *
 * So `LeadCreateResult` is a discriminated union and this file has **no success shape to put a suppressed
 * lead in**. `existing` is there for the same reason: a dedupe match reported as `created` is the same
 * class of untruth, and ShareFlow normalises domain and email precisely so those matches happen.
 *
 * Normalisation stays in the service. Suppression matching depends on it, and a second normaliser here
 * would eventually disagree about what matches — which for an opt-out means contacting someone who asked
 * not to be.
 *
 * ## `suppress_lead` is not exposed
 *
 * It is the right function for an opt-out, and it does more than add a row: it retires up to 200 already
 * collected leads, because *"the opt-out only stops future runs and leaves existing rows contactable"*
 * otherwise. That breadth is the reason it is a decision rather than a capability, and this SPEC asks for
 * create and update.
 */
import { z } from "zod";
import { asId, defineDelegatingTool, type Tool } from "@agentkit/backend";
import {
  LEAD_STATUSES,
  type CampaignId,
  type InboxCommentId,
  type Lead,
  type LeadAttribution,
  type LeadCreateResult,
  type LeadId,
  type PostDraftId,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

const idString = z.string().min(1);

/**
 * Where the lead came from, structured.
 *
 * At least one field is required. An unattributed lead is a lead the analytics step cannot connect to
 * anything, and AC-5's purpose is *"so the analytics attribution has real linkage"* — accepting an empty
 * attribution would make the field optional in practice while looking mandatory in the type.
 */
const attributionSchema = z
  .object({
    postDraftId: idString.optional(),
    campaignId: idString.optional(),
    commentId: idString.optional(),
    platformId: z.string().trim().min(1).max(64).toLowerCase().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.postDraftId !== undefined ||
      v.campaignId !== undefined ||
      v.commentId !== undefined ||
      v.platformId !== undefined,
    { message: "attribution needs at least one of postDraftId, campaignId, commentId or platformId" },
  );

const toAttribution = (input: z.infer<typeof attributionSchema>): LeadAttribution => ({
  ...(input.postDraftId === undefined ? {} : { postDraftId: asId<PostDraftId>(input.postDraftId) }),
  ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
  ...(input.commentId === undefined ? {} : { commentId: asId<InboxCommentId>(input.commentId) }),
  ...(input.platformId === undefined ? {} : { platformId: input.platformId }),
});

const leadView = (lead: Lead) => ({
  leadId: lead.id,
  name: lead.name,
  status: lead.status,
  attribution: lead.attribution,
  createdAt: lead.createdAt,
  ...(lead.email === undefined ? {} : { email: lead.email }),
  ...(lead.valueMinorUnits === undefined ? {} : { valueMinorUnits: lead.valueMinorUnits }),
});

/**
 * The result, mapped so the outcome cannot be mistaken for success.
 *
 * `outcome` is always present and is the first thing in the object. A caller reading only `leadId` gets
 * `undefined` for a suppressed lead rather than a plausible-looking id, which is the failure mode this
 * shape exists to make impossible.
 */
const createResultView = (result: LeadCreateResult) =>
  result.outcome === "suppressed"
    ? {
        outcome: result.outcome,
        // No lead, and the reason. `existing-customer` and `opt-out` mean different things to a person,
        // so the code travels rather than one flattened "refused".
        suppressionReason: result.reason,
      }
    : { outcome: result.outcome, ...leadView(result.lead) };

const listLeadsSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listLeadsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_leads",
    label: "List leads",
    description:
      "List the workspace's leads with their status, value and where each came from. Use it to find the lead the user means before updating one.",
    category: "leads",
    effect: "read",
    inputSchema: listLeadsSchema,
    delegatesTo: "LeadService.listLeads",
    delegate: async (input: z.infer<typeof listLeadsSchema>, context) => {
      const page = await services.leads.listLeads(context, {
        limit: input.limit,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        leads: page.items.map(leadView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

const createLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).optional(),
    valueMinorUnits: z.number().int().min(0).optional(),
    attribution: attributionSchema,
  })
  .strict();

export const createLeadTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "create_lead",
    label: "Capture a lead",
    description:
      "Record a lead, attributed to the post, campaign or comment it came from. Check `outcome` before telling the user anything: `created` means it was recorded, `existing` means this person was already a lead, and `suppressed` means they must not be contacted — they opted out, complained, or are already a customer. A suppressed lead was not created, and saying otherwise is worse than saying nothing.",
    category: "leads",
    effect: "internal-write",
    inputSchema: createLeadSchema,
    delegatesTo: "LeadService.createLead",
    delegate: async (input: z.infer<typeof createLeadSchema>, context, { idempotencyKey }) =>
      createResultView(
        await services.leads.createLead(context, {
          idempotencyKey,
          name: input.name,
          attribution: toAttribution(input.attribution),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.valueMinorUnits === undefined ? {} : { valueMinorUnits: input.valueMinorUnits }),
        }),
      ),
  });

const LEAD_PATCH_FIELDS = ["name", "email", "status", "valueMinorUnits"] as const;

const updateLeadSchema = z
  .object({
    leadId: idString,
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(320).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    valueMinorUnits: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => LEAD_PATCH_FIELDS.some((f) => v[f] !== undefined), {
    message: `supply at least one of: ${LEAD_PATCH_FIELDS.join(", ")}`,
  });

export const updateLeadTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "update_lead",
    label: "Update a lead",
    description:
      "Change a lead's name, email, status or value. Only the fields you supply are touched. Where a lead came from cannot be changed — attribution is a fact about its origin, not a property to edit.",
    category: "leads",
    effect: "internal-write",
    inputSchema: updateLeadSchema,
    delegatesTo: "LeadService.updateLead",
    delegate: async (input: z.infer<typeof updateLeadSchema>, context, { idempotencyKey }) => {
      // Walked rather than spread, so `leadId` cannot arrive as a column to write and `attribution`
      // cannot be added to the patch by a future schema field.
      const patch: Record<string, unknown> = {};
      for (const field of LEAD_PATCH_FIELDS) {
        const value = input[field];
        if (value !== undefined) patch[field] = value;
      }
      return leadView(
        await services.leads.updateLead(context, {
          idempotencyKey,
          id: asId<LeadId>(input.leadId),
          patch,
        }),
      );
    },
  });

/** The complete Leads catalog, pinned by a test — `suppress_lead` is absent on purpose. */
export const LEAD_TOOL_NAMES = ["list_leads", "create_lead", "update_lead"] as const;

export const LEAD_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listLeadsTool,
  createLeadTool,
  updateLeadTool,
];
