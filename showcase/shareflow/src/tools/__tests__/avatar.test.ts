import { describe, expect, it } from "vitest";
import { withAvatarLook } from "../media.js";
import { projectSectionBody } from "../../context/providers.js";
import { withProjectBrief } from "../project-brief.js";

/** #524 — a project's AI avatar: a voice for captions, a consistent look in media. */
const AVATAR = { name: "Nova", persona: "curious, precise, a little dry", look: "woman in her thirties, short silver hair, round glasses, navy blazer" };

describe("the avatar's look in a media prompt", () => {
  it("is added in a project chat, naming the character", () => {
    expect(withAvatarLook("presenting at a meetup", AVATAR)).toBe(
      "presenting at a meetup\n\nCharacter (Nova), keep consistent: woman in her thirties, short silver hair, round glasses, navy blazer",
    );
  });

  it("is not added twice, and nothing is added without a look or outside a project", () => {
    const already = `a portrait, ${AVATAR.look}`;
    expect(withAvatarLook(already, AVATAR)).toBe(already);
    expect(withAvatarLook("a latte", { name: "Nova" })).toBe("a latte");
    expect(withAvatarLook("a latte", undefined)).toBe("a latte");
  });
});

describe("the avatar in the project section and caption brief", () => {
  const project = { id: "p1", name: "AI", instructions: "", defaults: {}, avatar: AVATAR };

  it("gives captions the persona's voice and media the look", () => {
    const body = projectSectionBody(project);
    expect(body).toContain("AI avatar: Nova.");
    expect(body).toContain("Write in Nova's voice: curious, precise, a little dry");
    expect(body).toContain("When an image or video shows Nova, it looks like this: woman in her thirties");
  });

  it("reaches the caption writer even when the project has no instructions", () => {
    expect(withProjectBrief("a post about meetups", project)).toContain("Write in Nova's voice");
  });
});

describe("the avatar's reference photos (#524 part 2)", () => {
  it("tells the agent they exist and which model uses them", () => {
    const body = projectSectionBody({ name: "AI", instructions: "", defaults: {}, avatar: { ...AVATAR, referenceCount: 2 } });
    expect(body).toContain("Nova has 2 reference photos.");
    expect(body).toContain('pass model "soul_2"');
    expect(projectSectionBody({ name: "AI", instructions: "", defaults: {}, avatar: AVATAR })).not.toContain("reference photo");
  });
});
