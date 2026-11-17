import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Only an assistant turn may render a post card — SPEC #317 AC-2.
 *
 * The spec calls this out by name: *"user-typed text must never be able to inject a preview card —
 * that is a trivial spoofing vector"*. A user who types `[Invoice](chorus:post/<someone's uuid>)`
 * into the composer must get a link, not a card that fetches and renders a post.
 *
 * `UserMessage` and `AssistantMessage` render through the *same* `Markdown` component, so nothing
 * about the file layout enforces this — it holds only because `Markdown` reads a context that
 * defaults to off and one caller opts in. A refactor that moved `allowPostCards` up a level, or a
 * new surface rendering assistant-shaped markdown, would quietly break it.
 *
 * This is a source scan because this repo has no jsdom: no component behaviour is testable here, so
 * the check has to be structural. It is the same shape as the shareflow wiring guard, and for the
 * same reason — the property is "which call site opts in", not "what the pixels do".
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const sources = (): { name: string; text: string }[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));

/** Strip comments: several files *describe* the flag in prose, and prose is not a call site. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("post cards are an assistant-only affordance", () => {
  it("is enabled by exactly one component, and that component is AssistantMessage", () => {
    const enabling = sources()
      .filter(({ text }) => /allowPostCards(?!\?)/.test(code(text)))
      .map(({ name }) => name)
      .filter((name) => name !== "Markdown.tsx");

    expect(enabling, "only the assistant's own message may turn post cards on").toEqual([
      "AssistantMessage.tsx",
    ]);
  });

  it("is not enabled where the user's own text is rendered", () => {
    const user = code(readFileSync(join(DIR, "UserMessage.tsx"), "utf8"));
    expect(user).toContain("<Markdown");
    // The same renderer, deliberately without the flag — that is the entire guard.
    expect(user, "a user-typed token must render as a link, never a card").not.toMatch(/allowPostCards/);
  });

  /**
   * Off unless asked for. A context defaulting to `true` would make every surface that renders
   * markdown — now or later — a place a pasted token becomes a card.
   */
  it("defaults to off in the renderer", () => {
    const markdown = readFileSync(join(DIR, "Markdown.tsx"), "utf8");
    expect(markdown).toMatch(/createContext<boolean>\(false\)/);
  });

  it("gates the card on that context rather than on the token alone", () => {
    const markdown = code(readFileSync(join(DIR, "Markdown.tsx"), "utf8"));
    // The refusal must come before the card: parse, then check, then render.
    const fn = /function PostTokenLink[\s\S]*?\n}/.exec(markdown)?.[0] ?? "";
    expect(fn, "PostTokenLink not found — this guard is checking nothing").not.toBe("");
    expect(fn).toMatch(/useContext\(PostCardsContext\)/);
    expect(fn).toMatch(/if \(!allowed/);
  });
});
