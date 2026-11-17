import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POST_TOKEN_SCHEME,
  formatPostToken,
  isPostToken,
  parsePostToken,
} from "../postToken";

/**
 * The post-reference token contract — SPEC #315 AC-8.
 *
 * The parser had no test at all. It was consumed by `Markdown.tsx`, which this repo cannot render
 * (there is no jsdom), so every rule in it was unverified — which is precisely why the module puts
 * the rules in a pure function instead of inside the component, and precisely the half that was
 * missing.
 *
 * The cases that matter are the ones where the answer must be "this is NOT a post reference",
 * because the failure there is visible to a user: a card that renders and then 404s.
 */
const UUID = "8f14e45f-ceea-467a-9b2c-4c11a10e0000";

describe("parsePostToken", () => {
  it("accepts the documented form", () => {
    expect(parsePostToken(`${POST_TOKEN_SCHEME}${UUID}`)).toBe(UUID);
  });

  it("lower-cases the id so two spellings are one post", () => {
    expect(parsePostToken(`${POST_TOKEN_SCHEME}${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it("tolerates the whitespace a markdown renderer can leave around an href", () => {
    expect(parsePostToken(`  ${POST_TOKEN_SCHEME}${UUID}  `)).toBe(UUID);
  });

  /**
   * The streaming case, and the reason this returns null rather than throwing: a reply arrives token
   * by token, so `chorus:post/8f14e45` genuinely exists for a frame. Rendering a card for it would
   * fetch a preview for a post that does not exist, on every single message.
   */
  it("returns null for a half-streamed id rather than fetching a preview for it", () => {
    for (const partial of ["", "8f14e45", "8f14e45f-ceea", `${UUID.slice(0, -1)}`]) {
      expect(parsePostToken(`${POST_TOKEN_SCHEME}${partial}`), partial).toBeNull();
    }
  });

  it("refuses an id that is not a UUID", () => {
    for (const bad of ["not-a-uuid", "../../etc/passwd", "8f14e45f_ceea_467a_9b2c_4c11a10e0000", `${UUID}extra`]) {
      expect(parsePostToken(`${POST_TOKEN_SCHEME}${bad}`), bad).toBeNull();
    }
  });

  /** Ordinary links must stay ordinary links — the card override must not swallow them. */
  it("returns null for links that are not post references", () => {
    for (const href of [
      "https://example.com/post/8f14e45f-ceea-467a-9b2c-4c11a10e0000",
      "/dashboard/posts/8f14e45f-ceea-467a-9b2c-4c11a10e0000",
      "mailto:hello@northwind.studio",
      "chorus-media:abc",
      "chorus:media/8f14e45f-ceea-467a-9b2c-4c11a10e0000",
      "javascript:alert(1)",
      "",
    ]) {
      expect(parsePostToken(href), href).toBeNull();
    }
  });

  it("returns null rather than throwing for absent hrefs", () => {
    expect(parsePostToken(undefined)).toBeNull();
    expect(parsePostToken(null)).toBeNull();
  });
});

describe("isPostToken", () => {
  /**
   * Deliberately broader than `parsePostToken`: it answers "was this *meant* to be a post link",
   * which is what decides whether the renderer shows link text rather than an external-link
   * treatment. A malformed token is still ours.
   */
  it("is true for the scheme even when the id is malformed", () => {
    expect(isPostToken(`${POST_TOKEN_SCHEME}nonsense`)).toBe(true);
    expect(parsePostToken(`${POST_TOKEN_SCHEME}nonsense`)).toBeNull();
  });

  it("is case-insensitive about the scheme", () => {
    expect(isPostToken(`CHORUS:POST/${UUID}`)).toBe(true);
  });

  it("is false for other schemes and for nothing", () => {
    for (const href of ["https://example.com", "chorus-media:abc", "", undefined, null]) {
      expect(isPostToken(href), String(href)).toBe(false);
    }
  });
});

describe("formatPostToken", () => {
  it("round-trips with the parser, which is what keeps the two sides honest", () => {
    const href = formatPostToken(UUID);
    expect(href).toBe(`${POST_TOKEN_SCHEME}${UUID}`);
    expect(parsePostToken(href)).toBe(UUID);
  });

  it("refuses to build a token for something that is not a post id", () => {
    for (const bad of ["", "not-a-uuid", `${UUID} `.repeat(2)]) {
      expect(formatPostToken(bad), bad).toBeNull();
    }
  });

  it("produces a token the agent instruction can be checked against", () => {
    // The instruction tells the model to emit `[label](chorus:post/<id>)`; this is that href.
    expect(`[Your LinkedIn post](${formatPostToken(UUID)})`).toBe(
      `[Your LinkedIn post](chorus:post/${UUID})`,
    );
  });
});


/**
 * The other half of AC-1, and the half the spec actually worried about: *"put it in a shared doc
 * comment … so the FE and the instruction text cannot drift"*.
 *
 * They cannot share a module — the parser is in `web` and the instruction is in `shareflow`, two
 * packages with no import path between them — so the scheme is written out twice. This is what
 * stops the two copies diverging: change `POST_TOKEN_SCHEME` here and the agent keeps emitting the
 * old scheme, every card silently stops rendering, and nothing else in either package notices.
 *
 * Skipped rather than failed when shareflow is absent, following `parity/scripts.test.ts`: a
 * checkout of one package alone is a legitimate way to work on it.
 */
const INSTRUCTIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "..", "shareflow", "src", "app", "instructions.ts",
);

describe.skipIf(!existsSync(INSTRUCTIONS))("the agent instruction and the parser agree (AC-2)", () => {
  const instructions = () => readFileSync(INSTRUCTIONS, "utf8");

  /*
   * The rule's own `text`, not the whole file — and that distinction is the test.
   *
   * Asserting the scheme appeared anywhere in `instructions.ts` passed while the instruction was
   * broken, because the doc comment above the rule quotes the scheme too. The comment is not what
   * is sent to the model.
   */
  const ruleText = (): string => {
    const file = instructions();
    const at = file.indexOf('id: "references"');
    if (at === -1) return "";
    const body = file.slice(at, at + 1200);
    const textAt = body.indexOf("text:");
    return textAt === -1 ? "" : body.slice(textAt, body.indexOf("\n  },", textAt));
  };

  it("tells the agent to emit exactly the scheme this parser accepts", () => {
    expect(ruleText(), "the instruction sent to the model, not its doc comment").toContain(
      POST_TOKEN_SCHEME,
    );
  });

  it("reads the instruction rather than the comment above it", () => {
    // Guards the guard: if `ruleText` ever returns the whole file again, this fails.
    expect(ruleText()).not.toContain("The frontend renders");
    expect(ruleText().length).toBeGreaterThan(80);
  });

  it("has a rule about post references at all", () => {
    expect(instructions()).toMatch(/id:\s*"references"/);
  });

  /**
   * AC-2's own words: the token goes *alongside* a plain-language sentence, never instead of one.
   * A reply that is only a link reads as broken whenever the card fails to render, and a model will
   * happily reply with just the link if the instruction does not forbid it.
   */
  it("requires the token alongside a sentence, never instead of one", () => {
    expect(ruleText()).toMatch(/ALONGSIDE|alongside/);
    expect(ruleText()).toMatch(/never instead/i);
  });

  /** And that it must use the id a tool returned rather than inventing one. */
  it("forbids inventing an id", () => {
    expect(ruleText()).toMatch(/never invent/i);
  });
});
