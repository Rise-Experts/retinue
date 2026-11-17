/**
 * Where ShareFlow's agent manifests live (AC-5).
 *
 * docs/07: *"Initial user-facing experience exposes one primary Social Assistant."* docs/01 puts the
 * product's branding in the display name and keeps the id neutral and stable — so the id is
 * `social-assistant` and the name is `Social Assistant`.
 *
 * **Instructions are a required argument, not a default.** A manifest builder that supplied
 * placeholder prose would eventually ship it: a manifest is stored, versioned and executed, and
 * "TODO: write the system prompt" reads exactly like a working assistant until someone uses it. The
 * policy fields — which tool categories, which context providers, which skills — are filled in here,
 * because those are #114's decisions and getting them consistent is the point of the closed sets they
 * come from.
 */
import type { AgentManifest, ExecutionLimits, ModelPolicy, ResponseFormat } from "@retinue/agentkit";
import { AgentPlatformError } from "@retinue/agentkit";
import { SKILL_CATALOGUE_PROVIDER_ID } from "@retinue/agentkit/context";

import { DOCUMENTS_PROVIDER_ID, PERSONAL_MEMORY_PROVIDER_ID, SHAREFLOW_BASE_CONTEXT_PROVIDER_IDS, TURN_CONTEXT_PROVIDER_ID } from "../context/index.js";
import { SHAREFLOW_ASSIGNED_SKILLS } from "../skills/index.js";
import type { ShareFlowToolCategory } from "../tools/index.js";

/** Neutral and stable, per docs/01's naming rules. Referenced by runs; never renamed. */
export const SOCIAL_ASSISTANT_ID = "social-assistant";

/**
 * Preloaded tools: the set declared to the model up front, without a discovery round trip.
 *
 * Everything else is found through `find_tools`, read with `learn_tools` and run with `execute_tool`.
 * Kept as short as it can be — every preloaded tool's schema sits in context for the whole run, which
 * is the cost the lazy catalogue exists to avoid.
 *
 * ## Why it is no longer just two
 *
 * **Because the prompt names tools, and a tool the prompt names must be callable.** This was
 * `["list_accounts", "list_post_drafts"]` while `instructions.ts` named nine others — including
 * *"CALL the publish_post_now or schedule_post tool directly with the post ID"*. Those nine were
 * registered, authorised and discoverable, and **not declared to the model**. So the model did as it
 * was told, emitted a call by name, the AI SDK dropped a call for a function it had never declared,
 * and the run completed with no text, no tool call and no error. The assistant answered nothing.
 *
 * Deterministic per prompt, which is what made it look like flakiness: "which platforms am I connected
 * to?" routes to `list_accounts` and works, "show me my post drafts" routes to a named-but-undeclared
 * tool and returns silence.
 *
 * A clause's `requires` did not catch it because it asks whether a tool is **registered**, not whether
 * it is **declared**. `instructions.test.ts` now closes that gap: every tool the prompt names must
 * appear here.
 *
 * The alternative was to stop naming tools in the prompt and route everything through `execute_tool`.
 * That is worse for the two the prompt exists to make direct — publishing and scheduling are the
 * actions whose approval gate the prompt is explaining — and it would trade a small context cost for a
 * vaguer instruction.
 */
export const SOCIAL_ASSISTANT_PRELOADED_TOOLS = [
  /*
   * An account list starts almost every task. Its old partner `list_post_drafts` left in #630, named by no
   * clause or skill — the repo's own rule — to make room for `recall_tool_result` under the half-catalogue
   * cap; history now carries every draft id a reply produced, and find_tools still reaches the list.
   */
  "list_accounts",
  // Named by the `role` clause, which tells the model to call them directly rather than ask.
  "publish_post_now",
  "schedule_post",
  /*
   * Named by the drafting clauses.
   *
   * `get_post_draft` left this list when the `post-cards` clause was deleted (#450). That clause was
   * the only text naming it, and the rule here is the repo's own: a tool preloaded but never named is
   * a schema sitting in context on every turn for nothing. Discovery still finds it — `find_tools`
   * and `learn_tools` are exactly for the tools the prompt does not talk about.
   */
  "create_post_draft",
  /*
   * Named by `post-composition` since the Assistant took over compose (#496): one draft for every
   * channel, a change to the channels the user named, and the image or video for it.
   * `attach_media_to_post` is how a generated asset reaches the draft.
   */
  "draft_post_for_channels",
  "revise_post_channels",
  "generate_media",
  "check_media_job",
  "attach_media_to_post",
  // #574, named by the `code-images`: production showed a code tip illustrated by generate_media instead.
  "render_code_snippet",
  /*
   * #587, each named by a clause and each the cause of a production failure while it was hidden: an edit
   * saved as a new draft (update_post_draft), "a PNG of the flowchart" answered with a mermaid block
   * (render_diagram), "attach my latest image" answered "your library is empty" (list_media), and a
   * request to plan visuals answered in prose (plan_video_scenes, enhance_media_prompt).
   */
  "update_post_draft",
  "render_diagram",
  "list_media",
  // plan_visuals replaced plan_video_scenes and enhance_media_prompt here: one tool that matches how a
  // person asks ("plan the visuals"), and the two stay discoverable.
  "plan_visuals",
  // #589, named by the `artifacts` clause: a document or diagram onto a post.
  "attach_artifact_to_post",
  /*
   * Back since #497, because `post-composition` names it again: the person edits the draft in the post
   * panel between turns, and production showed the agent describing a channel the person had already
   * removed. Reading the saved draft first is the fix, and a named tool must be declared.
   */
  "get_post_draft",
  // #498: /options — the scored quality loop compose used; production showed the agent writing
  // unscored options itself when this was reachable only through discovery.
  "generate_alternatives",
  // #523: named by post-composition — a project's saved files, reused without an upload.
  "list_project_assets",
  "attach_project_asset",
  "render_post_template",
  // #553/#554: the agent keeps the project itself, and remembers what it is taught.
  "update_project",
  "propose_project_setup",
  "extract_brand_kit",
  "remember_project_rule",
  /*
   * #621, named by the `personal-memory` clause: a person's own lasting preference, across their chats.
   * Its partner `forget_about_me` is deliberately NOT preloaded — this list must stay under half the catalogue
   * (manifests.test.ts) — so the clause sends the model to find_tools for it rather than naming it.
   */
  "remember_about_me",
  // #549: files attached in the chat box.
  "attach_uploaded_media",
  // #630, named by the `earlier-results` clause: history carries earlier tool results as previews and refs.
  "recall_tool_result",
  /*
   * #641, named by the `workspace-brand` clause: the workspace brand, changed by asking. Preloaded because through
   * find_tools the model skipped the lookup on the second request and said "Brand colours updated" with no call
   * (production, 2026-09-29). It took the slot of `set_long_context`, which is rare and switches itself off after
   * eight messages if a call is ever skipped; that one is now reached through find_tools.
   */
  "update_brand_profile",
  // Named by the research clauses.
  "search_web",
  "read_source",
  "read_pdf",
  // #615, named by the `stock-media` clause and the `document-generation` skill: pictures for decks, PDFs and posts.
  "search_stock_media",
  "import_stock_media",
  // Named by the document clauses.
  "create_artifact",
  "generate_pdf",
  // Named by the `artifacts` clause: production asked to rename a heading and the model, not seeing it, read the PDF.
  "update_artifact",
  /**
   * Named by the **skills**, which are the other text the model is given.
   *
   * Seven skills ship active — 14,191 characters, about 3,500 tokens — and their instructions name
   * tools the same way the system prompt does: "run `validate_publish` first", "convert it with
   * `convert_media`". A tool named in a skill and not declared has exactly the same failure as one
   * named in the prompt: the model calls it, the AI SDK drops a call for a function it never declared,
   * and the run completes silently.
   *
   * This is the channel the first version of the guard missed. It scanned
   * `socialAssistantInstructions()` and stopped there, so nine tools were fixed and six stayed broken.
   */
  "check_media_for_platforms",
  "convert_media",
  "duplicate_post_draft",
  "validate_publish",
  "retry_publish_target",
  "reply_to_comment",
  /*
   * The two recurring-schedule writes (#425). Preloaded because they are gated, not because the
   * prompt names them: a gated tool reached through discovery takes the raw-runner branch, where the
   * registry still refuses it but `approval_required` comes back as an ordinary result and nothing
   * pending is ever created — the user sees a failed run with no card to approve.
   */
  "create_recurring_schedule",
  "cancel_recurring_schedule",
  /**
   * Named by nothing — here because **a gated tool reached through `execute_tool` can never be
   * approved.**
   *
   * `runTool` in the platform's approval wrapper resolves the descriptor with
   * `deps.tools.learn(ctx, [call.name])` and, finding none, hands the call to the raw runner:
   * `if (!descriptor) return { outcome: "result", result: await deps.tools.execute(ctx, call) }`
   * (`hitl/approved-execution.js`). `execute_tool` is a meta-tool and is absent from `learn`'s
   * corpus, so every call routed through it takes that branch. The registry's own `approval` check
   * still fires — correctly, it is unbypassable — but its `approval_required` comes back as an
   * ordinary tool result rather than an approval, and the engine turns that into a thrown error. The
   * user sees "Tool delete_post requires approval" as a failed run, with no card to approve and
   * nothing pending: the approval is unreachable, not merely awkward.
   *
   * Narrowing `toolPolicy.categories` to `[]` is what exposed this. It was the right fix for the
   * empty-answer bug — passing every category preloaded all 58 tools — but it moved these three from
   * preloaded to discovery-only, and for a gated tool that is the difference between an approval card
   * and a dead run. The other four gated tools were already named by the prompt or a skill and so
   * kept the direct path by accident.
   *
   * `manifests.test.ts` asserts the general rule these three satisfy: **every tool whose effect
   * derives an approval must be preloaded.** That is the durable guard — a fifth gated tool added
   * later fails the test rather than shipping an unapprovable action.
   */
  "repost_post",
  "delete_post",
  "check_media_storage",
] as const;

export type SocialAssistantInput = {
  /** Bumped on every change to any field. A run records the version it executed. */
  readonly version: number;
  /** The system prompt. Required — see the note above. */
  readonly instructions: string;
  readonly modelPolicy: ModelPolicy;
  readonly authorizationPolicyId: string;
  readonly limits: ExecutionLimits;
  /** Defaults to text. A structured format is a deliberate choice, not a default. */
  readonly responseFormat?: ResponseFormat;
  /**
   * Narrow the tool surface. Defaults to every ShareFlow category.
   *
   * Present because docs/07's Workflow 5 and 6 are read-only and analytical: an analytics-only
   * deployment should not carry the publishing tools, and the way to express that is here rather than
   * by adding a second hard-coded manifest.
   */
  readonly categories?: readonly ShareFlowToolCategory[];
  /** Whether tenant-authored skills may layer over the built-in set. Defaults to allowed. */
  readonly allowTenantSkills?: boolean;
  /**
   * Which skills this agent may see and load. Defaults to every **active** built-in.
   *
   * Overridable because a narrowed deployment narrows its skills with its tools, and because a test
   * needs to be able to assign none. A name with no skill behind it is simply never listed.
   */
  readonly assignedSkills?: readonly string[];
  /**
   * Which context providers a turn assembles. Defaults to the base set the deployment wires.
   *
   * Every id must be one the host actually supplies: `contextForTurn` throws on one that is not, for
   * the reason the platform's own selection does — an agent silently running without the context it
   * declared is indistinguishable from a model choosing not to use it.
   */
  readonly contextProviderIds?: readonly string[];
};

/** Build the Social Assistant manifest. */
export const socialAssistantManifest = (input: SocialAssistantInput): AgentManifest => {
  if (input.instructions.trim() === "")
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "the Social Assistant manifest requires instructions",
      retryable: false,
    });
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new AgentPlatformError({
      code: "invalid_input",
      message: "agent manifest version must be a positive integer",
      retryable: false,
    });

  return {
    id: SOCIAL_ASSISTANT_ID,
    version: input.version,
    name: "Social Assistant",
    description:
      "Plans, drafts, validates and publishes social content across connected destinations, and explains measured performance.",
    instructions: input.instructions,
    modelPolicy: input.modelPolicy,
    responseFormat: input.responseFormat ?? { kind: "text" },
    toolPolicy: {
      preloaded: [...SOCIAL_ASSISTANT_PRELOADED_TOOLS],
      /**
       * **Empty unless a deployment narrows the surface, and that is not the same field it looks like.**
       *
       * The registry preloads a tool when its *name* is in `preloaded` **or** its *category* is in here.
       * So a policy naming every category preloads every tool — which is what this used to do, sending
       * 61 function declarations and a 12,162-token prompt on every turn, and making `find_tools` a
       * search over nothing. `tools-for-turn.ts` carries the measurement.
       *
       * `input.categories` is honoured because that is what the field is for — a deployment that wants
       * only the analytics tools preloaded says so. It is not a list of the categories that *exist*.
       */
      categories: [...(input.categories ?? [])],
      excluded: [],
    },
    skillPolicy: {
      /**
       * The active built-in skills, **not** an empty list.
       *
       * `createSkillResolver` gates both halves of skills on this: `listCatalog` keeps a built-in only
       * when `assigned` contains its name, and `loadBody` is re-derived from the same policy. So with
       * `[]` here the seven active skills were invisible and unloadable — while the prompt said *"ALWAYS
       * load the `mermaid-diagrams` skill before turning a diagram into a file"*, and
       * `createShareFlowApp` returned an `assignedSkills` field holding the very list this one omitted.
       * Two lists, one live and one empty, and the empty one was the one the runtime read.
       */
      assigned: [...(input.assignedSkills ?? SHAREFLOW_ASSIGNED_SKILLS)],
      allowTenantSkills: input.allowTenantSkills ?? true,
    },
    authorizationPolicyId: input.authorizationPolicyId,
    /**
     * The providers a turn actually assembles — not the whole vocabulary.
     *
     * `SHAREFLOW_CONTEXT_PROVIDER_IDS` is the closed set of ids that *may* be named; three of them
     * (`campaign`, `current-post`, `performance`) need an id the caller supplies or are off by default,
     * so no deployment wires them for every turn. Declaring them here made the manifest describe a
     * prompt nobody assembled — and `contextForTurn` refuses a declared id with nothing behind it, which
     * is the check that turned this from a comment into an error.
     */
    contextProviderIds: [
      // #621: "About you", after the workspace's own context and before the turn's.
      ...(input.contextProviderIds ?? [
        ...SHAREFLOW_BASE_CONTEXT_PROVIDER_IDS,
        PERSONAL_MEMORY_PROVIDER_ID,
        // #644: the current text of this chat's documents.
        DOCUMENTS_PROVIDER_ID,
        TURN_CONTEXT_PROVIDER_ID,
        SKILL_CATALOGUE_PROVIDER_ID,
      ]),
    ],
    limits: input.limits,
  };
};
