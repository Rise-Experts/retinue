import { describe, expect, it } from 'vitest';
import { parseMediaRef, formatMediaRef, isMediaRef, fileNameOfRef } from '../mediaRef';

const WS = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

describe('parseMediaRef', () => {
  it('parses a complete image reference', () => {
    expect(parseMediaRef(`chorus-media:${WS}/photo.png`)).toBe(`${WS}/photo.png`);
  });

  it('ignores hrefs that are not references at all', () => {
    expect(parseMediaRef('https://example.com/a.png')).toBeNull();
    expect(parseMediaRef('/dashboard/posts')).toBeNull();
    expect(parseMediaRef(undefined)).toBeNull();
  });

  /**
   * The streaming case (AC-4). Each of these genuinely exists for a frame or two
   * while the href arrives token by token, and none may resolve — resolving means
   * firing a signing request for a path that does not exist yet.
   */
  it('refuses partially-streamed references', () => {
    expect(parseMediaRef('chorus-media:')).toBeNull();
    expect(parseMediaRef('chorus-media:1111')).toBeNull();
    expect(parseMediaRef(`chorus-media:${WS}`)).toBeNull();
    expect(parseMediaRef(`chorus-media:${WS}/`)).toBeNull();
    // No extension yet — the last thing to arrive, and the thing that tells us
    // the path is finished.
    expect(parseMediaRef(`chorus-media:${WS}/photo`)).toBeNull();
    expect(parseMediaRef(`chorus-media:${WS}/photo.`)).toBeNull();
  });

  it('refuses traversal, including encoded forms', () => {
    expect(parseMediaRef(`chorus-media:${WS}/../${OTHER}/secret.png`)).toBeNull();
    expect(parseMediaRef(`chorus-media:${WS}/%2e%2e/${OTHER}/secret.png`)).toBeNull();
    expect(parseMediaRef(`chorus-media:${WS}%2fsecret.png`)).toBeNull();
  });

  it('refuses a nested path masquerading as an extension', () => {
    // `.../a.png/evil` must not parse: the extension is matched at the end only.
    expect(parseMediaRef(`chorus-media:${WS}/a.png/evil`)).toBeNull();
  });

});

describe('formatMediaRef', () => {
  it('builds a reference from a storage path', () => {
    expect(formatMediaRef(`${WS}/deck.pdf`)).toBe(`chorus-media:${WS}/deck.pdf`);
  });

  it('refuses to dress up a signed URL as a workspace file', () => {
    // The whole point of the scheme is that signed URLs never enter message
    // text; this is the guard that keeps a caller from bypassing that.
    expect(formatMediaRef('https://x.supabase.co/storage/v1/object/sign/media/a.png?token=y')).toBeNull();
  });

  it('refuses a path with no workspace prefix', () => {
    expect(formatMediaRef('photo.png')).toBeNull();
  });

  it('round-trips with parseMediaRef', () => {
    const ref = formatMediaRef(`${WS}/chart.jpg`)!;
    expect(parseMediaRef(ref)).toBe(`${WS}/chart.jpg`);
  });
});

describe('isMediaRef', () => {
  it('is true for an incomplete reference, unlike parseMediaRef', () => {
    // The renderer needs this distinction: an incomplete reference should render
    // as nothing-yet, while a non-reference renders as an ordinary link.
    expect(isMediaRef(`chorus-media:${WS}`)).toBe(true);
    expect(parseMediaRef(`chorus-media:${WS}`)).toBeNull();
    expect(isMediaRef('https://example.com')).toBe(false);
  });
});

describe('fileNameOfRef', () => {
  it('reads the filename from a reference or a bare path', () => {
    expect(fileNameOfRef(`chorus-media:${WS}/Q3 deck.pdf`)).toBe('Q3 deck.pdf');
    expect(fileNameOfRef(`${WS}/Q3 deck.pdf`)).toBe('Q3 deck.pdf');
  });
});
