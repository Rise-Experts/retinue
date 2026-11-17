import { z } from "zod";
import { AgentPlatformError, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";

import type { ShareFlowToolFactory } from "./factory.js";
import { shareFlowTool } from "./factory.js";
import type { BrandProfile, BrandProfilePatch } from "../services/index.js";

/**
 * `update_brand_profile` — #641. The workspace's brand settings (Settings → Brand), changed by asking: "make our
 * tone warmer", "our colours are #0E6C79 and #F5A623", "use the image I attached as our logo".
 *
 * Only the fields the person named are sent, and the store touches only those columns. Not approval-gated, like
 * `remember_project_rule`: the person asked for it in this message, the page shows and edits every field, and
 * an "Ask first" chat still gates it. Always loaded (the `workspace-brand` clause names it): reached through
 * find_tools, the model skipped the lookup on a second request and claimed a change it never made.
 */

/** The page's tone keys (`web/src/lib/brand/brandKit.ts`). The agent may say "Warm"; stored as `warm`. */
export const BRAND_TONES = ["friendly", "professional", "playful", "bold", "warm", "witty", "inspiring", "expert", "calm", "direct"] as const;
export const BRAND_LANGUAGES = ["auto", "en", "de", "en+de"] as const;
const IMAGE_PATH = /\.(png|jpe?g|webp|svg)$/i;

const text = (max: number) => z.string().trim().max(max).nullable().optional();

const brandSchema = z
  .object({
    brandName: text(120),
    company: text(200),
    website: text(300),
    industry: text(80),
    audience: text(300),
    voice: text(2_000),
    customInstructions: text(2_000),
    avoid: text(1_000),
    tone: z.array(z.string().trim().toLowerCase().pipe(z.enum(BRAND_TONES))).max(BRAND_TONES.length).nullable().optional(),
    colors: z
      .array(
        z
          .object({
            hex: z.string().trim().regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, "a hex colour like #0e6c79"),
            name: z.string().trim().max(40).optional(),
          })
          .strict(),
      )
      .max(4)
      .nullable()
      .optional(),
    emojiUse: z.enum(["none", "light", "lots"]).nullable().optional(),
    hashtagStyle: z.enum(["none", "few", "many"]).nullable().optional(),
    language: z.enum(BRAND_LANGUAGES).nullable().optional(),
    /** A path in this workspace's media: an image attached in the chat or from the media library. */
    logoPath: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** `#abc` / `abc` / `#AABBCC` → `#aabbcc`. The schema has already refused anything else. */
export const normalizeHex = (hex: string): string => {
  const raw = hex.trim().replace(/^#/, "").toLowerCase();
  return `#${raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw}`;
};

/** The input as a patch: blanks mean "clear", colours normalised, tones de-duplicated in the page's order. */
export const toBrandPatch = (input: z.infer<typeof brandSchema>): BrandProfilePatch => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null || value === "") out[key] = null;
    else if (key === "colors") out[key] = (value as { hex: string; name?: string }[]).map((c) => ({ hex: normalizeHex(c.hex), name: (c.name ?? "").trim() }));
    else if (key === "tone") out[key] = BRAND_TONES.filter((t) => (value as string[]).includes(t));
    else out[key] = value;
  }
  return out as BrandProfilePatch;
};

const LABEL: Record<keyof BrandProfile, string> = {
  brandName: "brand name", company: "company", website: "website", industry: "industry", audience: "audience",
  voice: "voice & guidelines", customInstructions: "custom instructions", avoid: "words to avoid", tone: "tone",
  colors: "colours", emojiUse: "emoji use", hashtagStyle: "hashtag style", language: "language", logoPath: "logo",
};

export const updateBrandProfileTool = shareFlowTool(["brand"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "update_brand_profile",
    label: "Change the brand settings",
    description:
      "Change the workspace's brand settings (Settings → Brand), which every post uses: brandName, company, website, industry, audience, voice (guidelines), customInstructions, avoid (words and claims not to use), tone (from: friendly, professional, playful, bold, warm, witty, inspiring, expert, calm, direct), colors (up to 4 {hex, name}; the first is the main colour), emojiUse (none | light | lots), hashtagStyle (none | few | many), language (auto | en | de | en+de) and logoPath. Send ONLY the fields the person asked to change; others stay as they are. A list you send (tone, colors) replaces the list, so include the current entries from the Brand section of your context plus the change. null or \"\" clears a field. logoPath must be an image in this workspace's media — one the person attached in this chat or picked from the media library (its path starts with the workspace id); never a web URL. Only when the person asks to change their brand. Call it every time they ask, even for a change made before, and say a setting changed only when this call's result says so. To set the brand up from their website, read it with extract_brand_kit first, then save what fits. Inside a project, a change to the project's own look goes to the project, not here.",
    category: "posts",
    effect: "internal-write",
    inputSchema: brandSchema,
    delegatesTo: "BrandService.updateBrandProfile",
    delegate: async (input: z.infer<typeof brandSchema>, context) => {
      const update = services.brand.updateBrandProfile;
      if (update === undefined) {
        throw new AgentPlatformError({ code: "capability_unavailable", message: "This deployment cannot save brand settings; the person can change them in Settings → Brand.", retryable: false });
      }
      const patch = toBrandPatch(input);
      if (typeof patch.logoPath === "string") {
        const path = patch.logoPath;
        if (!path.startsWith(`${String(context.tenantId)}/`) || path.includes("..") || !IMAGE_PATH.test(path)) {
          throw new AgentPlatformError({
            code: "invalid_input",
            message: "The logo must be a PNG, JPG, WebP or SVG in this workspace's media — ask the person to attach it in the chat, or to pick it from the media library.",
            retryable: false,
          });
        }
      }
      if (Object.keys(patch).length === 0) {
        throw new AgentPlatformError({ code: "invalid_input", message: "Nothing to change — name at least one brand setting.", retryable: false });
      }
      const { profile, changed } = await update(context, patch);
      return {
        changed: changed.map((key) => LABEL[key] ?? key),
        profile,
        note: "Saved to Settings → Brand; every new post uses it. Tell the person what changed, in a sentence.",
      };
    },
  }));

export const BRAND_TOOL_NAMES = ["update_brand_profile"] as const;
export const BRAND_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [updateBrandProfileTool];
