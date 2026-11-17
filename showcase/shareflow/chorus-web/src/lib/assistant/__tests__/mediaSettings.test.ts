import { describe, expect, it } from 'vitest';
import { parseConversationSettings, parseMediaSettings } from '../conversationSettings';

/** #575 — the chat box's image/video settings, as the turn carries them. */
describe('media settings', () => {
  it('keeps what is known and drops what is not, never refusing', () => {
    expect(parseMediaSettings({ kind: 'video', aspectRatio: '9:16', model: 'kling3_0' })).toEqual({ kind: 'video', aspectRatio: '9:16', model: 'kling3_0' });
    expect(parseMediaSettings({ kind: 'gif', aspectRatio: 'wide', model: 'a b' })).toBeUndefined();
    expect(parseMediaSettings(null)).toBeUndefined();
  });

  it('rides along with the chat settings, so the turns route forwards it', () => {
    expect(parseConversationSettings({ mode: 'auto', effort: 'low', media: { kind: 'image', aspectRatio: '4:5' } })).toEqual({
      mode: 'auto',
      effort: 'low',
      media: { kind: 'image', aspectRatio: '4:5' },
    });
  });
});
