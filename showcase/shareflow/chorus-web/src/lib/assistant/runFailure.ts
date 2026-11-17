/**
 * A failed run's reason, as a sentence a customer can act on — #628.
 *
 * The agent service classifies a model provider's refusal where it records `run.failed` and stores a safe
 * error: `details.reason` (`billing` | `quota` | `rate_limit` | `overloaded` | `auth`) and
 * `details.keySource` (`workspace` for the workspace's own key, else `platform`) —
 * `shareflow/src/app/run-errors.ts`. This maps that to a localized message key.
 *
 * It also classifies the **message** itself, as a fallback: a run recorded before that change, or by a
 * service that does not classify yet, still carries the provider's raw sentence — production's was
 * *"Your prepayment credits are depleted. Please go to AI Studio…"* — and that must never reach the screen.
 * The patterns are the service's, kept in step by the tests on both sides.
 *
 * Pure, so it is testable without a DOM.
 */

export type ProviderFailureReason = 'billing' | 'quota' | 'rate_limit' | 'overloaded' | 'auth';

export type RunFailure = {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

/** A key under `assistant.runErrors`, plus whether to add the admin's "connect your own key" hint. */
export type FriendlyRunFailure = {
  readonly key: 'platformUnavailable' | 'platformBusy' | 'byoBilling' | 'byoAuth' | 'byoRateLimit' | 'byoOverloaded';
  readonly adminHint: boolean;
};

const PATTERNS: readonly (readonly [ProviderFailureReason, RegExp])[] = [
  ['quota', /insufficient_quota|exceeded your current quota|quota (?:exceeded|has been exceeded)|resource[_ ]exhausted|check quota/i],
  [
    'billing',
    /prepayment credits? (?:are|is) depleted|credit balance is too low|insufficient[_ ](?:credits?|balance|funds)|billing (?:details|account|hard limit|issue)|payment required|\b402\b|plans? (?:and|&) billing/i,
  ],
  [
    'auth',
    /invalid[_ ]?(?:x-)?api[_ -]?key|incorrect api key|api key not valid|api_key_invalid|authentication_error|invalid authentication|permission[_ ]denied|(?:status(?: code)?|http)[: ]*(?:401|403)\b|\b401 unauthorized/i,
  ],
  ['rate_limit', /rate[_ -]?limit|too many requests|(?:status(?: code)?|http)[: ]*429\b|\b429 too many/i],
  ['overloaded', /overloaded|(?:status(?: code)?|http)[: ]*(?:503|529)\b|\b529\b|service unavailable|model is currently unavailable/i],
];

/** Codes that mean something specific already (a budget, an approval, a cancel) and are never re-described. */
const CLASSIFIABLE_CODES: ReadonlySet<string> = new Set([
  'internal',
  'provider_error',
  'provider_unavailable',
  'rate_limited',
  'unauthorized',
  'forbidden',
  'timeout',
]);

const REASONS: ReadonlySet<string> = new Set(['billing', 'quota', 'rate_limit', 'overloaded', 'auth']);

/** The provider's reason, from the service's classification or, failing that, the message. */
export const providerFailureReason = (error: RunFailure): ProviderFailureReason | undefined => {
  const stated = error.details?.reason;
  if (typeof stated === 'string' && REASONS.has(stated)) return stated as ProviderFailureReason;
  const code = error.code ?? 'internal';
  if (!CLASSIFIABLE_CODES.has(code)) return undefined;
  const message = error.message ?? '';
  for (const [reason, pattern] of PATTERNS) if (pattern.test(message)) return reason;
  return code === 'rate_limited' ? 'rate_limit' : undefined;
};

/**
 * What to say, or `undefined` to show the run's own message (it was not a provider refusal).
 *
 * The workspace's own key is its owner's to fix; the platform's is ours, so the customer is only told to
 * wait — and an admin, who can, is offered connecting their own key.
 */
export const friendlyRunFailure = (
  error: RunFailure | undefined,
  options: { readonly isAdmin: boolean },
): FriendlyRunFailure | undefined => {
  if (error === undefined) return undefined;
  const reason = providerFailureReason(error);
  if (reason === undefined) return undefined;
  const byo = error.details?.keySource === 'workspace';
  if (byo) {
    const key =
      reason === 'auth' ? 'byoAuth' : reason === 'rate_limit' ? 'byoRateLimit' : reason === 'overloaded' ? 'byoOverloaded' : 'byoBilling';
    return { key, adminHint: false };
  }
  const busy = reason === 'rate_limit' || reason === 'overloaded';
  return { key: busy ? 'platformBusy' : 'platformUnavailable', adminHint: options.isAdmin && !busy };
};

/** The sentence, through a translator scoped to `assistant`. */
export const runFailureText = (
  error: RunFailure | undefined,
  options: { readonly isAdmin: boolean },
  t: (key: string) => string,
): string | undefined => {
  if (error === undefined) return undefined;
  const friendly = friendlyRunFailure(error, options);
  if (friendly === undefined) return error.message;
  const text = t(`runErrors.${friendly.key}`);
  return friendly.adminHint ? `${text} ${t('runErrors.adminHint')}` : text;
};
