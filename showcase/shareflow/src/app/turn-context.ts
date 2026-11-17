/**
 * The turn's own context — #543: the agent mode's rule (#550), the posts and files the person pointed
 * at with `@` (#548), and the files they attached (#549).
 *
 * An app-level provider rather than one of `SHAREFLOW_CONTEXT_PROVIDER_IDS`: it needs the run (through
 * `turnInput`), which the service-level providers do not have, and it is about this turn rather than
 * about the workspace.
 */
import type { ContextProvider, ContextSection, ExecutionContext } from "@retinue/agentkit";
import { shareFlowSection, TURN_CONTEXT_PROVIDER_ID } from "../context/index.js";
import type { ShareFlowServices } from "../services/index.js";
import type { PostDraftId } from "../services/ids.js";
import { attachmentsIn, referencesIn, type AgentMode, type TurnInputReader } from "./turn-settings.js";
import { KNOWN_PLATFORMS } from "../tools/posts.js";

/** Above the project (95): the mode is a rule for this turn and must not be pruned before the brand. */
const PRIORITY = { date: 106, mode: 105, referenced: 94, attached: 93, media: 92, rules: 80 } as const;
/** A referenced caption is bounded; the model can call `get_post_draft` for the rest. */
const CAPTION_LIMIT = 1_200;
const MAX_REFERENCES = 6;

export const MODE_CLAUSES: Record<Exclude<AgentMode, "auto">, string> = {
  ask_first:
    "This chat is in **Ask first** mode. Every draft, edit and image or video you make needs the person's approval, so say in one line what you are about to do, then call the tool — an approval card appears for them.",
  /*
   * Steps, not an aside. Production, 2026-09-28: with "(plan the media with plan_visuals)" tucked into one
   * sentence, a "week of posts with visuals" in Plan mode got visuals the model wrote itself.
   */
  plan:
    "This chat is in **Plan** mode. Create or change nothing yet. Do this, in order:\n" +
    "1. If the posts will have images or video, FIRST call plan_visuals — images = the number of posts, the channel, and reelScenes if a Reel or video is wanted. Do not describe visuals yourself.\n" +
    "2. Then propose a short numbered plan: each post's date, channel and idea, with its visual taken from plan_visuals.\n" +
    "3. Ask the person to accept it. Call write tools only after they accept; each still shows them an approval card.",
  chat_only:
    "This chat is in **Chat only** mode. Answer, advise and suggest wording, but create or change nothing: no drafts, edits, media, schedules or replies. Write tools are not available. If the person wants you to act, tell them they can switch the mode under the chat box.",
};

const section = (id: string, title: string, body: string, priority: number, source: string): ContextSection =>
  shareFlowSection({ providerId: TURN_CONTEXT_PROVIDER_ID, origin: "platform", title, body, priority, provenance: `shareflow:turn.${source}` });

/**
 * The channel rules, before the first word is written — #573.
 *
 * Production, 2026-09-28: three saves for one post, each refused for a rule the model had never been
 * told — Instagram wants at least five hashtags, then LinkedIn at least three. `draft_post_for_channels`
 * already writes to these (#287); a caption the model writes itself deserves the same. Read from the
 * validator's own table (`platformRules`), so a workspace override is what the model sees.
 */
export const channelRulesText = (
  rules: readonly { platformId: string; charLimit: number | null; hashtagMin: number | null; hashtagMax: number | null }[],
): string | null => {
  const lines = rules.flatMap((rule) => {
    const parts: string[] = [];
    if (rule.charLimit !== null) parts.push(`at most ${rule.charLimit} characters`);
    if (rule.hashtagMin !== null && rule.hashtagMax !== null) parts.push(`${rule.hashtagMin}-${rule.hashtagMax} hashtags`);
    else if (rule.hashtagMin !== null) parts.push(`at least ${rule.hashtagMin} hashtags`);
    else if (rule.hashtagMax !== null) parts.push(`at most ${rule.hashtagMax} hashtags`);
    return parts.length === 0 ? [] : [`- ${rule.platformId}: ${parts.join(", ")}`];
  });
  if (lines.length === 0) return null;
  return [
    "Every caption must fit its channel. Saves are refused otherwise:",
    ...lines,
    "When one text cannot fit every channel (e.g. one needs more hashtags than another allows), save ONE post: `caption` for most channels and `platformCaptions` with the channel's own text for the others — every channel listed in `targetPlatforms`.",
  ].join("\n");
};

export const createTurnContextProvider = (deps: {
  readonly turnInput: TurnInputReader;
  readonly services: Pick<ShareFlowServices, "content">;
}): ContextProvider => ({
  id: TURN_CONTEXT_PROVIDER_ID,
  async provide(context: ExecutionContext) {
    const { settings, message } = await deps.turnInput(context);
    const sections: ContextSection[] = [];

    /*
     * Today's date — #587. Without it the model dated a Q4 strategy "2024" and tagged posts #Autumn2024.
     * The date only, in UTC: the person's time zone is unknown, and the scheduling rule still governs times.
     */
    sections.push(section("date", "Today", `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`, PRIORITY.date, "date"));

    if (settings.mode !== "auto") sections.push(section("mode", "Agent mode", MODE_CLAUSES[settings.mode], PRIORITY.mode, "mode"));

    // #575: the chat box's image/video settings. generate_media is also given them (`media-defaults.ts`).
    if (settings.media !== undefined) {
      const m = settings.media;
      const chosen = [m.kind === undefined ? null : m.kind === "video" ? "a video" : "an image", m.aspectRatio === undefined ? null : `shape ${m.aspectRatio}`, m.model === undefined ? null : `model ${m.model}`]
        .filter((part): part is string => part !== null)
        .join(", ");
      sections.push(
        section(
          "media",
          "Image and video settings",
          `The person set these under the chat box: ${chosen}. When they ask you to make media, call generate_media with exactly these — do not pick another shape or model unless they say so in this message.`,
          PRIORITY.media,
          "media",
        ),
      );
    }

    const rules = await deps.services.content.platformRules(context, KNOWN_PLATFORMS as never).catch(() => []);
    const rulesText = channelRulesText(rules);
    if (rulesText !== null) sections.push(section("rules", "Channel rules", rulesText, PRIORITY.rules, "rules"));

    const references = referencesIn(message).slice(0, MAX_REFERENCES);
    if (references.length > 0) {
      const lines: string[] = [
        "The person pointed at these with @. \"This post\", \"it\" or a name in their message means one of them — edit that post, not another.",
      ];
      for (const ref of references) {
        if (ref.kind === "project_asset") {
          lines.push("", `- Project file "${ref.label || ref.id}" (projectAssetId ${ref.id}). Put it on a draft with attach_project_asset.`);
          continue;
        }
        try {
          const draft = await deps.services.content.getDraft(context, { id: ref.id as PostDraftId });
          const caption = draft.caption.length > CAPTION_LIMIT ? `${draft.caption.slice(0, CAPTION_LIMIT)}…` : draft.caption;
          const own = Object.entries(draft.platformCaptions)
            .map(([platform, text]) => `  - ${platform}'s own caption: ${String(text).slice(0, 400)}`)
            .join("\n");
          lines.push(
            "",
            `- Post "${ref.label || caption.split("\n")[0]?.slice(0, 60) || ref.id}" (postDraftId ${draft.id}, ${draft.status}, ` +
              `channels: ${draft.targetPlatforms.join(", ") || "none yet"}, ${draft.mediaAssetIds.length} media)`,
            `  Caption: ${caption.replace(/\n/g, " ")}`,
            ...(own === "" ? [] : [own]),
          );
        } catch {
          // Deleted, or another workspace's id that slipped past the web: said, not silently dropped.
          lines.push("", `- Post ${ref.id}: not found in this workspace — tell the person it could not be opened.`);
        }
      }
      sections.push(section("referenced", "Posts and files in this message", lines.join("\n"), PRIORITY.referenced, "referenced"));
    }

    const attached = attachmentsIn(message);
    if (attached.length > 0) {
      sections.push(
        section(
          "attached",
          "Files attached to this message",
          [
            `The person attached ${attached.length} file${attached.length === 1 ? "" : "s"} (media-bucket paths, already checked):`,
            ...attached.map((path) => `- ${path}`),
            "Put them on a draft with attach_uploaded_media (postDraftId + these paths), or — when the person wants an image or video made from them — pass them to generate_media as referencePaths.",
          ].join("\n"),
          PRIORITY.attached,
          "attached",
        ),
      );
    }
    return sections;
  },
});
