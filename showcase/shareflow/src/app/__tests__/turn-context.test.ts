import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import { createTurnContextProvider } from "../turn-context.js";
import type { AgentMode, TurnSettings } from "../turn-settings.js";

/** #543 — the turn's own context: the mode's rule, what was pointed at, what was attached. */
const WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const POST = "9b2d1a4e-1111-4222-8333-944455556666";
const GONE = "9b2d1a4e-1111-4222-8333-000000000000";
const context = { tenantId: WS, runId: "r1" } as unknown as ExecutionContext;

type Rule = { platformId: string; charLimit: number | null; hashtagMin: number | null; hashtagMax: number | null };

const provider = (mode: AgentMode, message: string, extra: { rules?: Rule[]; media?: TurnSettings["media"] } = {}) =>
  createTurnContextProvider({
    turnInput: async () => ({ settings: { mode, effort: "medium", ...(extra.media === undefined ? {} : { media: extra.media }) }, message }),
    services: {
      content: {
        async platformRules() {
          return extra.rules ?? [];
        },
        async getDraft(_c: unknown, { id }: { id: string }) {
          if (id !== POST) throw new Error("not found");
          return { id: POST, status: "DRAFT", caption: "Our kitchen spent six weeks on this menu.", platformCaptions: { linkedin: "Six weeks." }, targetPlatforms: ["linkedin"], mediaAssetIds: [], updatedAt: "" };
        },
      },
    } as never,
  });

/** #587: every turn opens with today's date; these cases are about what follows it. */
const withoutDate = (sections: readonly { title: string; body: string }[]) => sections.filter((section) => section.title !== "Today");

describe("the turn's context", () => {
  it("opens every turn with today's date", async () => {
    const [first] = await provider("auto", "hi").provide(context);
    expect(first!.body).toMatch(/^Today is \d{4}-\d{2}-\d{2} \(UTC\)\.$/);
  });

  it("says nothing in Auto with nothing attached", async () => {
    expect(await provider("auto", "hi").provide(context).then(withoutDate)).toEqual([]);
  });

  it("states the mode's rule", async () => {
    const [section] = await provider("plan", "hi").provide(context).then(withoutDate);
    expect(section!.body).toContain("Plan");
    expect(section!.body).toContain("propose a short numbered plan");
    // Production: as an aside, the model skipped it. A first step, it is the plan's source of visuals.
    expect(section!.body).toContain("FIRST call plan_visuals");
  });

  it("gives the referenced post's channels and captions, and names one it cannot open (#548 AC-2)", async () => {
    const sections = await provider("auto", `Shorter please\n\n[referenced]\nchorus:post/${POST} Team post\nchorus:post/${GONE} Old\n[/referenced]`).provide(context).then(withoutDate);
    const body = sections.map((s) => s.body).join("\n");
    expect(body).toContain(`postDraftId ${POST}`);
    expect(body).toContain("Our kitchen spent six weeks");
    expect(body).toContain("linkedin's own caption: Six weeks.");
    expect(body).toContain(`Post ${GONE}: not found`);
  });

  it("lists attached files with the tool that attaches them (#549)", async () => {
    const sections = await provider("auto", `Use this\n\n[attached-media]\n${WS}/a.png\n[/attached-media]`).provide(context).then(withoutDate);
    expect(sections[0]!.body).toContain(`${WS}/a.png`);
    expect(sections[0]!.body).toContain("attach_uploaded_media");
  });

  it("gives the channel rules before anything is written, and says to split rather than fail (#573)", async () => {
    const rules: Rule[] = [
      { platformId: "instagram", charLimit: 2200, hashtagMin: 5, hashtagMax: 30 },
      { platformId: "facebook", charLimit: null, hashtagMin: null, hashtagMax: 3 },
    ];
    const [section] = await provider("auto", "hi", { rules }).provide(context).then(withoutDate);
    expect(section!.body).toContain("- instagram: at most 2200 characters, 5-30 hashtags");
    expect(section!.body).toContain("- facebook: at most 3 hashtags");
    expect(section!.body).toContain("save ONE post");
  });

  it("states the chat box's image and video settings (#575)", async () => {
    const [section] = await provider("auto", "hi", { media: { kind: "video", aspectRatio: "9:16", model: "kling3_0" } }).provide(context).then(withoutDate);
    expect(section!.body).toContain("a video, shape 9:16, model kling3_0");
    expect(section!.body).toContain("generate_media");
  });
});
