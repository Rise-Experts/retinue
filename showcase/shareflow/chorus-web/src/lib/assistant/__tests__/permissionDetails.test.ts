/**
 * What the permission card shows about the thing it is asking permission for.
 *
 * The card used to show a tool name and nothing else — "Run reply_to_comment? This needs your
 * confirmation." — because its three phrasings key on `category` being exactly `publish` or `schedule`
 * and the runtime's categories are its own (`publishing`, `engagement`, …). Every card fell through to
 * the generic one, and the arguments were hardcoded to `{}` all the way up the stack.
 *
 * An approval with the arguments hidden is a button that says "trust me", and the reason there is a
 * human in this loop is that the human sees the thing.
 */
import { describe, expect, it } from 'vitest';

import { permissionDetails } from '../permissionCard';

describe('permissionDetails', () => {
  it('puts the text a person is signing their name to first', () => {
    /**
     * Not object order: `normalizedInput` comes from the model and its key order is arbitrary, so the
     * reply itself could land last. The reply is the decision.
     */
    const details = permissionDetails({
      commentId: 'c-1',
      accountId: 'a-1',
      text: 'Thanks — sending it now.',
    });
    expect(details[0]).toEqual({ label: 'Text', value: 'Thanks — sending it now.' });
  });

  it('orders destinations and timing after the content', () => {
    const details = permissionDetails({ when: '2026-09-12T09:00:00Z', platforms: ['instagram', 'linkedin'], caption: 'Guji is here' });
    expect(details.map((detail) => detail.label)).toEqual(['Caption', 'When', 'Platforms']);
  });

  it('joins a list rather than printing JSON at a person', () => {
    const details = permissionDetails({ platforms: ['instagram', 'linkedin'] });
    expect(details[0]?.value).toBe('instagram, linkedin');
  });

  it('turns a field name into words', () => {
    // Field names are the API's. A card that reads like a payload is a card nobody reads.
    expect(permissionDetails({ postDraftId: 'p-1' })[0]?.label).toBe('Post draft id');
    expect(permissionDetails({ account_ids: 'a-1' })[0]?.label).toBe('Account ids');
  });

  it('drops empty values instead of showing a blank row', () => {
    expect(permissionDetails({ text: '', tags: [], meta: {}, note: null, ok: undefined })).toEqual([]);
  });

  it('clips a very long value, because the card is a few lines wide', () => {
    const details = permissionDetails({ text: 'x'.repeat(400) });
    expect(details[0]?.value).toHaveLength(240);
    expect(details[0]?.value.endsWith('…')).toBe(true);
  });

  it('caps how many fields it shows', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, `v${index}`]));
    expect(permissionDetails(many)).toHaveLength(6);
    expect(permissionDetails(many, 2)).toHaveLength(2);
  });

  it('keeps a false or zero value, which is information', () => {
    // `{ notify: false }` is a real instruction about what will happen, not an absent field.
    const details = permissionDetails({ notify: false, count: 0 });
    expect(details.map((detail) => detail.value)).toEqual(['false', '0']);
  });
});
