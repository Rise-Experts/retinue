import { describe, expect, it } from 'vitest';
import { formatPostCard, parsePostCard, isPostCardLang, POST_CARD_LANG } from '../postCard';

const ID = '8f14e45f-ceea-467a-9d5e-1b2c3d4e5f60';
const WS = '11111111-2222-3333-4444-555555555555';

describe('formatPostCard', () => {
  it('emits a fenced block the renderer can find', () => {
    const block = formatPostCard({ postId: ID, text: 'Hello', platforms: ['LinkedIn'], status: 'APPROVED' })!;

    expect(block.startsWith(`\`\`\`${POST_CARD_LANG}\n`)).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
  });

  it('refuses a non-uuid id, so an unresolvable block is never emitted', () => {
    expect(formatPostCard({ postId: 'post-1', text: 'x' })).toBeNull();
    expect(formatPostCard({ postId: '', text: 'x' })).toBeNull();
  });

  it('lower-cases platforms and defaults the optional fields', () => {
    const data = parsePostCard(inner(formatPostCard({ postId: ID, text: 'x', platforms: ['LinkedIn'] })!))!;
    expect(data.platforms).toEqual(['linkedin']);
    expect(data.status).toBe('DRAFT');
    expect(data.media).toEqual([]);
  });

  /**
   * The reason the text is carried in JSON rather than interpolated into prose:
   * a caption full of markdown must survive verbatim, or the card previews
   * something different from what the platform publishes.
   */
  it('round-trips a caption containing markdown, newlines and quotes', () => {
    const text = '**Not bold** _not italic_ #tag\n\n* not a bullet\n"quoted" \\ backslash';
    const data = parsePostCard(inner(formatPostCard({ postId: ID, text })!))!;
    expect(data.text).toBe(text);
  });

  it('round-trips media in order', () => {
    // Order is carousel order on the platform, so it must not be re-sorted.
    const media = [`chorus-media:${WS}/c.png`, `chorus-media:${WS}/a.png`, `chorus-media:${WS}/b.png`];
    const data = parsePostCard(inner(formatPostCard({ postId: ID, text: 'x', media })!))!;
    expect(data.media).toEqual(media);
  });

  it('does not break the fence when the caption contains backticks', () => {
    // A caption with ``` in it would otherwise close the block early. JSON
    // encoding leaves backticks alone, so this is really a regression guard.
    const text = 'see ```code``` here';
    const block = formatPostCard({ postId: ID, text })!;
    expect(parsePostCard(inner(block))?.text).toBe(text);
  });
});

describe('parsePostCard', () => {
  it('returns null for a block still being streamed', () => {
    // The JSON is incomplete until the closing brace arrives; a card must not
    // render — or fire a signing request — from a half-written payload.
    expect(parsePostCard('{"postId":"8f14e45f-ceea-467a-9d5e-1b2c')).toBeNull();
    expect(parsePostCard('{')).toBeNull();
    expect(parsePostCard('')).toBeNull();
  });

  it('returns null for malformed or wrongly-shaped payloads', () => {
    expect(parsePostCard('not json at all')).toBeNull();
    expect(parsePostCard('[]')).toBeNull();
    expect(parsePostCard('"a string"')).toBeNull();
    expect(parsePostCard('{"text":"no id"}')).toBeNull();
    expect(parsePostCard(`{"postId":"nope","text":"x"}`)).toBeNull();
  });

  it('drops non-string entries instead of trusting the array', () => {
    // This JSON came back through a language model. A stray null must not become
    // "null" on screen, or a signing request for a path that does not exist.
    const data = parsePostCard(`{"postId":"${ID}","text":"x","media":["a.png",null,7],"platforms":["x",null]}`)!;
    expect(data.media).toEqual(['a.png']);
    expect(data.platforms).toEqual(['x']);
  });

  it('tolerates a missing text field', () => {
    expect(parsePostCard(`{"postId":"${ID}"}`)).toMatchObject({ text: '', media: [] });
  });
});

describe('isPostCardLang', () => {
  it('matches react-markdown’s className shape', () => {
    expect(isPostCardLang(`language-${POST_CARD_LANG}`)).toBe(true);
    expect(isPostCardLang(`hljs language-${POST_CARD_LANG}`)).toBe(true);
  });

  it('does not match ordinary code fences', () => {
    expect(isPostCardLang('language-json')).toBe(false);
    expect(isPostCardLang('language-chorus-postx')).toBe(false);
    expect(isPostCardLang(undefined)).toBe(false);
  });
});

/** The fence body, as react-markdown would hand it to a `code` override. */
function inner(block: string): string {
  return block.replace(new RegExp(`^\`\`\`${POST_CARD_LANG}\\n`), '').replace(/\n```$/, '');
}
