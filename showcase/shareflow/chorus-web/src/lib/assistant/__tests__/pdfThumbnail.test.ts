import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPdfPath, pdfKeyOf, pdfThumbnail, peekPdfThumbnail, resetPdfThumbnails } from '../pdfThumbnail';

/** #628 part 2: one render per file, one at a time, kept for the session; a broken file is not retried. */

beforeEach(() => resetPdfThumbnails());

describe('pdfThumbnail', () => {
  it('draws a file once and keeps it', async () => {
    const render = vi.fn(async () => 'data:image/jpeg;base64,AAA');
    expect(await pdfThumbnail('ws/generated/a.pdf', 'https://s/a.pdf?token=1', render)).toBe('data:image/jpeg;base64,AAA');
    expect(await pdfThumbnail('ws/generated/a.pdf', 'https://s/a.pdf?token=2', render)).toBe('data:image/jpeg;base64,AAA');
    expect(render).toHaveBeenCalledTimes(1);
    expect(peekPdfThumbnail('ws/generated/a.pdf')).toBe('data:image/jpeg;base64,AAA');
  });

  it('shares a render already in flight', async () => {
    const render = vi.fn(async () => 'img');
    await Promise.all([pdfThumbnail('k', 'u', render), pdfThumbnail('k', 'u', render)]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('renders one at a time', async () => {
    let active = 0;
    let peak = 0;
    const render = async (url: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return url;
    };
    await Promise.all(['a', 'b', 'c'].map((key) => pdfThumbnail(key, key, render)));
    expect(peak).toBe(1);
  });

  it('a file that cannot be drawn is null, remembered, and does not block the next', async () => {
    const broken = vi.fn(async () => {
      throw new Error('bad pdf');
    });
    expect(await pdfThumbnail('bad', 'u', broken)).toBeNull();
    expect(await pdfThumbnail('bad', 'u', broken)).toBeNull();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(await pdfThumbnail('good', 'u', async () => 'ok')).toBe('ok');
  });
});

describe('isPdfPath', () => {
  it('reads the extension, ignoring a signed URL query', () => {
    expect(isPdfPath('ws/generated/x.pdf')).toBe(true);
    expect(isPdfPath('https://x.supabase.co/storage/v1/object/sign/media/ws/x.PDF?token=abc')).toBe(true);
    expect(isPdfPath('ws/generated/x.png')).toBe(false);
    expect(pdfKeyOf('https://s/a.pdf?token=1')).toBe('https://s/a.pdf');
  });
});
