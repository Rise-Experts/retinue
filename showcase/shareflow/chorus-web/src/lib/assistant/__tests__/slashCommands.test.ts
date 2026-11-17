/**
 * The composer's slash commands — the matching rules, which are the part that can go wrong quietly.
 *
 * A menu that opens when it should not is worse than no menu: it takes the next Enter, so a person
 * writing "check the /docs page" and pressing Enter would send a command instead of their sentence.
 * Every assertion here is one of those cases.
 */
import { describe, expect, it } from 'vitest';

import de from '../../../../messages/de.json';
import en from '../../../../messages/en.json';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUICK_CHANGES, SLASH_COMMANDS, filterCommands, matchSlash, nextIndex, nowLabel, promptValues } from '../slashCommands';

/** The locale files, typed to the two fields these assertions read. */
const LOCALES: Readonly<Record<string, { assistant: { slash: Record<string, Record<string, string>> } }>> = {
  en: en as never,
  de: de as never,
};

describe('matchSlash', () => {
  it('opens on a bare slash', () => {
    expect(matchSlash('/')).toEqual({ query: '' });
  });

  it('reads the word after the slash as the query, lowercased', () => {
    expect(matchSlash('/dra')).toEqual({ query: 'dra' });
    expect(matchSlash('/DRA')).toEqual({ query: 'dra' });
  });

  it('does not open mid-sentence', () => {
    // The case that would steal someone's Enter.
    expect(matchSlash('check the /docs page')).toBeNull();
    expect(matchSlash('before/after')).toBeNull();
  });

  it('does not open once the slash word has a space after it', () => {
    // "/draft a post about coffee" is a message, not a command being typed.
    expect(matchSlash('/draft a post')).toBeNull();
    expect(matchSlash('/ ')).toBeNull();
  });

  it('is closed for ordinary text and for nothing at all', () => {
    expect(matchSlash('')).toBeNull();
    expect(matchSlash('draft a post')).toBeNull();
  });
});

describe('filterCommands', () => {
  it('offers everything for a bare slash — inside a project', () => {
    expect(filterCommands('', { inProject: true })).toEqual(SLASH_COMMANDS);
  });

  it('offers project commands only inside a project (#641)', () => {
    const outside = filterCommands('');
    expect(outside.some((command) => command.scope === 'project')).toBe(false);
    expect(outside.map((command) => command.name)).toContain('brand');
    expect(filterCommands('proj').map((command) => command.name)).toEqual([]);
    expect(filterCommands('proj', { inProject: true }).map((command) => command.name)).toEqual(['project']);
  });

  it('puts prefix matches before substring matches', () => {
    /**
     * `/co` must offer `comments` before `accounts`, even though both contain "co": the first
     * keystrokes of a name are how anyone expects to select it.
     */
    const names = filterCommands('co').map((command) => command.name);
    expect(names[0]).toBe('comments');
    expect(names).toContain('accounts');
    expect(names.indexOf('comments')).toBeLessThan(names.indexOf('accounts'));
  });

  it('is empty for a query nothing matches, so the menu can hide', () => {
    expect(filterCommands('zzz')).toEqual([]);
  });
});

describe('nextIndex', () => {
  it('wraps both ways, so the arrows never stop on an edge', () => {
    expect(nextIndex(0, 3, -1)).toBe(2);
    expect(nextIndex(2, 3, 1)).toBe(0);
    expect(nextIndex(1, 3, 1)).toBe(2);
  });

  it('is zero for an empty list rather than NaN', () => {
    expect(nextIndex(0, 0, 1)).toBe(0);
  });
});

describe('the command list itself', () => {
  it('has a unique lowercase name for every command', () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+$/);
  });

  it('marks a command complete only when its prompt is a whole question', () => {
    /**
     * The distinction is load-bearing: a `complete` command sends on accept, and sending "Draft a post
     * about " would ask the assistant to invent the half the user came here to type. Checked against
     * the English strings, since that is where the prompts live.
     */
    const slash = LOCALES['en']!.assistant.slash;
    for (const command of SLASH_COMMANDS) {
      const prompt = slash[command.key]?.['prompt'] ?? '';
      expect(prompt.length, command.name).toBeGreaterThan(0);
      if (command.kind === 'complete') expect(prompt.trimEnd(), command.name).toMatch(/[?.]$/);
      else expect(prompt, command.name).toMatch(/ $/);
    }
  });

  it('has a label, a hint and a prompt in every locale', () => {
    // A missing key renders as the key itself, which is how a half-translated menu ships unnoticed.
    for (const locale of ['en', 'de']) {
      const slash = LOCALES[locale]!.assistant.slash;
      for (const command of SLASH_COMMANDS) {
        for (const field of ['label', 'hint', 'prompt']) {
          expect(slash[command.key]?.[field], `${locale}.${command.key}.${field}`).toBeTruthy();
        }
      }
    }
  });
});

/**
 * Every Compose capability as a command — #498.
 */
describe('the compose commands', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const POST = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('offers every capability compose had, and keeps the seven that were there', () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    for (const name of ['post', 'image', 'video', 'options', 'shorter', 'playful', 'professional', 'translate', 'link', 'schedule', 'drafts']) {
      expect(names, name).toContain(name);
    }
    for (const name of ['draft', 'campaign', 'diagram', 'performance', 'comments', 'leads', 'accounts']) {
      expect(names, name).toContain(name);
    }
  });

  it('uses the same placeholders in both languages, so a translation cannot drop the post', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const command of SLASH_COMMANDS) {
      const en = LOCALES['en']!.assistant.slash[command.key]!['prompt']!;
      const de = LOCALES['de']!.assistant.slash[command.key]!['prompt']!;
      expect(placeholders(de), command.name).toEqual(placeholders(en));
      for (const name of placeholders(en)) expect(['post', 'channels', 'now'], command.name).toContain(name);
    }
  });

  it('names the open post as a token the agent resolves, or says there is none', () => {
    const base = { channels: [], noPost: 'my most recent draft', noChannels: 'my channels' };
    expect(promptValues({ ...base, postId: POST }).post).toBe(`chorus:post/${POST}`);
    expect(promptValues({ ...base, postId: null }).post).toBe('my most recent draft');
    expect(promptValues({ ...base, postId: null, channels: ['Instagram', 'LinkedIn'] }).channels).toBe('Instagram, LinkedIn');
    expect(promptValues({ ...base, postId: null }).channels).toBe('my channels');
  });

  it('makes the quick changes complete commands, so a chip and its command send at once', () => {
    for (const key of QUICK_CHANGES) {
      expect(SLASH_COMMANDS.find((command) => command.key === key)?.kind, key).toBe('complete');
    }
  });

  it('has the panel chips read the very prompt the command reads (AC-3)', () => {
    const panel = readFileSync(resolve(here, '../../../app/(dashboard)/assistant/PostPanel.tsx'), 'utf8');
    expect(panel).toContain('QUICK_CHANGES.map');
    expect(panel).toContain('t(`slash.${key}.prompt`, promptValues(');
  });

  it('never acts on its own: every command is a prompt, and /schedule waits for a time (AC-4)', () => {
    // No command carries anything but a name, a key, a kind and (#641) where it is offered — nothing that could
    // call a tool. A publish or schedule therefore only ever happens through the agent's gated tools and their card.
    for (const command of SLASH_COMMANDS) {
      expect(Object.keys(command).filter((key) => key !== 'scope').sort(), command.name).toEqual(['key', 'kind', 'name']);
      expect([undefined, 'project'], command.name).toContain(command.scope);
    }
    expect(SLASH_COMMANDS.find((command) => command.name === 'schedule')?.kind).toBe('partial');
    for (const locale of ['en', 'de']) {
      const prompt = LOCALES[locale]!.assistant.slash['schedule']!['prompt']!;
      expect(prompt, locale).not.toMatch(/approve|genehmig|without asking|ohne/i);
    }
  });
});

describe('/schedule carries the person\'s clock', () => {
  it('states the date, time and zone, so "tomorrow at 18:30" can be resolved without guessing', () => {
    // 12:32 UTC is 14:32 in Berlin on 27 September 2026 (summer time).
    expect(nowLabel(new Date('2026-09-27T12:32:00Z'), 'Europe/Berlin')).toBe('Sun 2026-09-27 14:32 Europe/Berlin');
    expect(nowLabel(new Date('2026-09-27T23:30:00Z'), 'Asia/Karachi')).toBe('Mon 2026-09-28 04:30 Asia/Karachi');
  });

  it('puts {now} in the schedule prompt in both languages', () => {
    for (const locale of ['en', 'de']) {
      expect(LOCALES[locale]!.assistant.slash['schedule']!['prompt'], locale).toContain('{now}');
    }
  });
});
