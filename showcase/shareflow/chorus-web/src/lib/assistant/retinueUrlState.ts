/**
 * The React chat's URL shape.
 *
 * THE CONTRACT:
 *
 *   /assistant                        a new conversation
 *   /assistant/c/<conversation-uuid>  a specific conversation
 *   /assistant/legacy                 the Agno chat, kept reachable while the cutover is verified
 *
 * Two segments rather than the old chat's three, because the thing that made the old shape three was
 * the *kind*: its run and continue endpoints differed by agent vs team (`/agents/...` vs
 * `/teams/...`), so the kind had to be in the path or the first message after a cold load would be
 * sent to the wrong place. This runtime has one endpoint for every turn — `/api/message` with a
 * conversation id — so a kind segment would encode a distinction that no longer exists.
 *
 * **The old shapes are not honoured, deliberately.** `/assistant/team/chorus-team/<uuid>` addresses an
 * Agno *session*, and Agno's tables are a different store from this platform's conversations — the id
 * in that URL names a row that this runtime cannot read and that the cutover removes. Resolving it to
 * a new conversation is the honest outcome, and it is also the rule this file inherits from
 * `urlState.ts`: a URL is user-editable and shareable, so a stale one should land you in a working new
 * chat rather than on a broken page.
 *
 * Pure, so the rules are unit-testable — the component using them cannot be, since this app's suite
 * has no jsdom.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The conversation the path names, or `null` for a new one.
 *
 * A uuid is required rather than accepting any string: the id goes into a request path and is used to
 * fetch a transcript, and `/assistant/c/../../etc` should be a new chat, not an attempt.
 */
export const conversationFromPath = (segments: readonly string[] | undefined): string | null => {
  const parts = (segments ?? []).filter((segment) => typeof segment === 'string' && segment.length > 0);
  if (parts.length !== 2) return null;
  const [prefix, id] = parts;
  if (prefix !== 'c' || id === undefined || !UUID.test(id)) return null;
  return id.toLowerCase();
};

/** The project a `/compose/p/<uuid>` path names (#521), or `null`. Same strictness as a conversation. */
export const projectFromPath = (segments: readonly string[] | undefined): string | null => {
  const parts = (segments ?? []).filter((segment) => typeof segment === 'string' && segment.length > 0);
  if (parts.length !== 2) return null;
  const [prefix, id] = parts;
  if (prefix !== 'p' || id === undefined || !UUID.test(id)) return null;
  return id.toLowerCase();
};

/** The canonical path for a conversation — under `/compose` since #516. Bare `/compose` has no id to carry yet. */
export const pathForConversation = (conversationId: string | null): string =>
  conversationId === null || !UUID.test(conversationId) ? '/compose' : `/compose/c/${conversationId.toLowerCase()}`;
