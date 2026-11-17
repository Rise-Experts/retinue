import { describe, expect, it } from 'vitest';

import { UNANSWERED_AFTER_SECONDS, unansweredQuestion } from '../unanswered';

const user = (text: string, createdAt: number) => ({ role: 'user' as const, text, createdAt });
const reply = (createdAt: number) => ({ role: 'assistant' as const, text: 'Sure.', createdAt });

describe('unansweredQuestion', () => {
  const now = 10_000;

  it('is the question when the last message is an old unanswered one', () => {
    expect(unansweredQuestion({ messages: [user('hi', 1), reply(2), user('make a deck', now - UNANSWERED_AFTER_SECONDS)], liveTurns: 0, loading: false, nowSeconds: now })).toBe('make a deck');
  });

  it('is null when answered, recent, loading or running in this session', () => {
    expect(unansweredQuestion({ messages: [user('hi', 1), reply(2)], liveTurns: 0, loading: false, nowSeconds: now })).toBeNull();
    expect(unansweredQuestion({ messages: [user('hi', now - 10)], liveTurns: 0, loading: false, nowSeconds: now })).toBeNull();
    expect(unansweredQuestion({ messages: [user('hi', 1)], liveTurns: 0, loading: true, nowSeconds: now })).toBeNull();
    expect(unansweredQuestion({ messages: [user('hi', 1)], liveTurns: 1, loading: false, nowSeconds: now })).toBeNull();
    expect(unansweredQuestion({ messages: [], liveTurns: 0, loading: false, nowSeconds: now })).toBeNull();
  });
});
