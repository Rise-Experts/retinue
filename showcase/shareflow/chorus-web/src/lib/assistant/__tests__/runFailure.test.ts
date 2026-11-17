import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import de from '../../../../messages/de.json';
import { friendlyRunFailure, providerFailureReason, runFailureText } from '../runFailure';

const GOOGLE =
  'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';

const translator = (messages: typeof en) => (key: string) => {
  const [group, name] = key.split('.') as [string, string];
  const table = (messages.assistant as unknown as Record<string, Record<string, string>>)[group];
  const value = table?.[name];
  if (value === undefined) throw new Error(`missing ${key}`);
  return value;
};

describe('providerFailureReason', () => {
  it('prefers the agent service classification', () => {
    expect(providerFailureReason({ code: 'provider_unavailable', message: 'x', details: { reason: 'auth' } })).toBe('auth');
  });

  it.each([
    [GOOGLE, 'billing'],
    ['Your credit balance is too low to access the Anthropic API.', 'billing'],
    ['You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Rate limit reached for gpt-4o', 'rate_limit'],
    ['Overloaded', 'overloaded'],
    ['Incorrect API key provided: sk-***', 'auth'],
  ] as const)('classifies a raw provider message: %s', (message, reason) => {
    expect(providerFailureReason({ code: 'internal', message })).toBe(reason);
  });

  it('leaves unrelated failures and app-specific codes alone', () => {
    expect(providerFailureReason({ code: 'internal', message: 'run failed: worker lost the lease' })).toBeUndefined();
    expect(providerFailureReason({ code: 'budget_exceeded', message: 'insufficient credits' })).toBeUndefined();
  });
});

describe('friendlyRunFailure', () => {
  it('platform billing: unavailable, with the own-key hint for an admin only', () => {
    expect(friendlyRunFailure({ code: 'internal', message: GOOGLE }, { isAdmin: true })).toEqual({ key: 'platformUnavailable', adminHint: true });
    expect(friendlyRunFailure({ code: 'internal', message: GOOGLE }, { isAdmin: false })).toEqual({ key: 'platformUnavailable', adminHint: false });
  });

  it('platform rate limit: busy, no hint', () => {
    expect(friendlyRunFailure({ code: 'rate_limited', message: 'Too Many Requests' }, { isAdmin: true })).toEqual({ key: 'platformBusy', adminHint: false });
  });

  it("the workspace's own key: names the provider settings", () => {
    const byo = (reason: string) => friendlyRunFailure({ code: 'provider_unavailable', message: '', details: { reason, keySource: 'workspace' } }, { isAdmin: true });
    expect(byo('billing')?.key).toBe('byoBilling');
    expect(byo('quota')?.key).toBe('byoBilling');
    expect(byo('auth')?.key).toBe('byoAuth');
    expect(byo('rate_limit')?.key).toBe('byoRateLimit');
    expect(byo('overloaded')?.key).toBe('byoOverloaded');
  });
});

describe('runFailureText', () => {
  it('never shows the provider sentence, in either language', () => {
    for (const messages of [en, de]) {
      const text = runFailureText({ code: 'internal', message: GOOGLE }, { isAdmin: true }, translator(messages as typeof en));
      expect(text).toBeDefined();
      expect(text).not.toMatch(/prepayment|ai\.studio/i);
    }
    expect(runFailureText({ code: 'internal', message: GOOGLE }, { isAdmin: true }, translator(en))).toBe(
      `${en.assistant.runErrors.platformUnavailable} ${en.assistant.runErrors.adminHint}`,
    );
  });

  it("passes any other failure's own message through", () => {
    expect(runFailureText({ code: 'internal', message: 'The model returned no answer.' }, { isAdmin: false }, translator(en))).toBe('The model returned no answer.');
    expect(runFailureText(undefined, { isAdmin: false }, translator(en))).toBeUndefined();
  });

  it('has every key in German too', () => {
    for (const key of Object.keys(en.assistant.runErrors)) {
      expect((de.assistant.runErrors as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
