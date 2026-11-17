import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../../../../messages/en.json';
import de from '../../../../messages/de.json';
import { startRequest, type StartWords } from '../startRequest';

/** Compose's start screen in a new Compose chat — #517. */
const here = dirname(fileURLToPath(import.meta.url));
const words: StartWords = {
  forChannels: (c) => `Channels selected in the composer (for any post you write): ${c}.`,
  image: 'Also make an image for it.',
  photos: (n) => `Use the ${n} photos I uploaded.`,
};

describe('startRequest', () => {
  it('says the image and the photos after the idea, and the channels last as context (AC-1, AC-2)', () => {
    expect(startRequest({ prompt: '  Autumn menu launches Thursday ', channels: ['Instagram', 'LinkedIn'], image: true, photos: 2 }, words)).toBe(
      'Autumn menu launches Thursday\n\nAlso make an image for it. Use the 2 photos I uploaded.\n\nChannels selected in the composer (for any post you write): Instagram, LinkedIn.',
    );
  });

  it('frames the channels as context, never as a command to write (#621)', () => {
    // "Write it for Instagram, Facebook, LinkedIn." made a plain question come back once per channel.
    const message = startRequest({ prompt: 'What time is best to post?', channels: ['Instagram', 'Facebook', 'LinkedIn'], image: false, photos: 0 }, words);
    expect(message).toBe('What time is best to post?\n\nChannels selected in the composer (for any post you write): Instagram, Facebook, LinkedIn.');
    for (const locale of [en, de] as unknown as { assistant: { start: Record<string, string> } }[]) {
      const text = locale.assistant.start['forChannels']!;
      expect(text).not.toMatch(/^(Write|Schreib)/);
      expect(text).toMatch(/Composer/i);
    }
  });

  it('adds nothing the person did not choose', () => {
    expect(startRequest({ prompt: 'Hello', channels: [], image: false, photos: 0 }, words)).toBe('Hello');
    expect(startRequest({ prompt: 'Hello', channels: ['X'], image: false, photos: 0 }, words)).toBe(
      'Hello\n\nChannels selected in the composer (for any post you write): X.',
    );
  });

  it('has the words in both languages, with their placeholders', () => {
    for (const locale of [en, de] as unknown as { assistant: { start: Record<string, string> } }[]) {
      expect(locale.assistant.start['forChannels']).toContain('{channels}');
      expect(locale.assistant.start['image']).toBeTruthy();
      expect(locale.assistant.start['photos']).toContain('{count, plural');
    }
  });
});

describe('the wiring', () => {
  const chat = readFileSync(resolve(here, '../../../app/(dashboard)/assistant/RetinueChat.tsx'), 'utf8');
  const draft = readFileSync(resolve(here, '../../../app/(dashboard)/assistant/usePostDraft.ts'), 'utf8');

  it('shows the start screen only in a new, empty conversation', () => {
    expect(chat).toContain('const isStart = messages.length === 0 && turns.length === 0 && !stored.loading && pendingPermission === null;');
    expect(chat).toMatch(/isStart \? \(\s*<>[\s\S]*<ComposeStart/);
  });

  it('sends the choices as the first turn, with the photos on it (AC-3)', () => {
    /*
     * Since #549 the photos go with the message and the agent attaches them to the draft it writes. They
     * used to wait for the post panel to open by itself (#546: nothing opens by itself any more).
     */
    expect(chat).toContain('    send(message);\n  };');
    expect(chat).toContain('const attachments = [...attach.readyPaths];');
    expect(chat).not.toContain('setPendingMedia(');
    // The panel's own path for photos it is handed is unchanged, for any caller that still hands them.
    expect(draft).toContain('setMedia([...stored, ...waiting.items.filter((m) => !known.has(m.path))]);');
  });

  it('keeps compose\'s "write it myself" out of a chat, where the panel is the hand-written path', () => {
    expect(chat).not.toMatch(/<ComposeStart[\s\S]*onWriteMyself=/);
  });
});
