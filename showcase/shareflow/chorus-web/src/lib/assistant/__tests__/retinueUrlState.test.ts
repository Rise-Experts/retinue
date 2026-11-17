/**
 * The React chat's URL rules.
 *
 * The clause worth the most is that an **old-shaped** URL resolves to a new conversation rather than
 * to something that looks like it worked. `/assistant/team/chorus-team/<uuid>` names an Agno session,
 * which lives in a different store from this platform's conversations — so treating that uuid as a
 * conversation id would fetch a transcript that does not exist and render an empty thread as though it
 * were the one somebody bookmarked.
 */
import { describe, expect, it } from 'vitest';

import { conversationFromPath, pathForConversation } from '../retinueUrlState';

const ID = '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607';

describe('conversationFromPath', () => {
  it('reads the conversation out of /assistant/c/<uuid>', () => {
    expect(conversationFromPath(['c', ID])).toBe(ID);
  });

  it('lowercases the id, so one conversation has one identity', () => {
    expect(conversationFromPath(['c', ID.toUpperCase()])).toBe(ID);
  });

  it('is a new conversation for a bare /assistant', () => {
    expect(conversationFromPath([])).toBeNull();
    expect(conversationFromPath(undefined)).toBeNull();
  });

  it('is a new conversation for the old agent and team shapes', () => {
    // The uuid in an old URL names an Agno session — a row this runtime cannot read.
    expect(conversationFromPath(['team', 'chorus-team', ID])).toBeNull();
    expect(conversationFromPath(['agent', 'chorus-writer'])).toBeNull();
  });

  it('refuses anything that is not a uuid under /c', () => {
    for (const bad of ['..', 'not-a-uuid', '', '../../etc/passwd']) {
      expect(conversationFromPath(['c', bad])).toBeNull();
    }
  });

  it('refuses a longer path that merely starts the right way', () => {
    expect(conversationFromPath(['c', ID, 'extra'])).toBeNull();
  });
});

describe('pathForConversation', () => {
  it('collapses a new conversation to a clean /compose (#516)', () => {
    expect(pathForConversation(null)).toBe('/compose');
  });

  it('round-trips a conversation id', () => {
    expect(conversationFromPath(pathForConversation(ID).split('/').slice(2))).toBe(ID);
  });

  it('refuses to build a path from something that is not an id', () => {
    // Better a clean `/compose` than a URL that looks addressable and resolves to nothing.
    expect(pathForConversation('nonsense')).toBe('/compose');
  });
});
