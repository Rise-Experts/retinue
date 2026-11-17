/**
 * #652 — the chat loads, unasked, only images from hosts we serve. A reply's image URL is whatever the model wrote,
 * and a prompt injection can make it write one that carries private data to someone else's server.
 */
import { describe, expect, it } from 'vitest';

import { extractMessageMedia } from '../messageMedia';
import { isTrustedImageUrl } from '../trustedImages';

const STORAGE = 'https://abcdefghijklmnopqrst.supabase.co';

describe('isTrustedImageUrl', () => {
  it('trusts this project storage and the stock library, over https', () => {
    expect(isTrustedImageUrl(`${STORAGE}/storage/v1/object/sign/media/a.png?token=x`, STORAGE)).toBe(true);
    expect(isTrustedImageUrl('https://images.pexels.com/photos/6337/x.jpg', STORAGE)).toBe(true);
  });

  it('does not trust any other host, a look-alike, or plain http', () => {
    expect(isTrustedImageUrl('https://evil.test/?q=secret', STORAGE)).toBe(false);
    expect(isTrustedImageUrl('https://abcdefghijklmnopqrst.supabase.co.evil.test/a.png', STORAGE)).toBe(false);
    expect(isTrustedImageUrl('https://other-project.supabase.co/a.png', STORAGE)).toBe(false);
    expect(isTrustedImageUrl('http://images.pexels.com/a.jpg', STORAGE)).toBe(false);
    expect(isTrustedImageUrl('not a url', STORAGE)).toBe(false);
  });
});

describe('the reply gallery', () => {
  it('offers an outside image as a link, so nothing is requested from that host', () => {
    const items = extractMessageMedia('Look ![chart](https://evil.test/c.png?q=secret)');
    expect(items).toEqual([{ kind: 'link', url: 'https://evil.test/c.png?q=secret', label: 'chart' }]);
  });

  it('still shows stock photos and workspace files as images', () => {
    const items = extractMessageMedia('![cup](https://images.pexels.com/photos/6337/x.jpg) ![mine](chorus-media:ws-1/generated/abcd-1234.png)');
    expect(items.map((item) => item.kind)).toEqual(['image', 'image']);
  });
});
