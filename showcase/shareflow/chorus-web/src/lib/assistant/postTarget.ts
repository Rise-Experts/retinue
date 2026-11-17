/**
 * Where "open this post" goes — #500, under `/compose` since #516. Compose, with the post panel open on it: in the
 * conversation that wrote it when there is one, in a new conversation otherwise.
 *
 * Pure, so the rules are tested without a request: the ids must be uuids (they go into a path and a
 * query), and a conversation is only ever one the server read from the post's own row, in the caller's
 * own workspace — never one named by the link.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `?post=` value as a post id, or null. */
export const postIdParam = (value: string | string[] | undefined): string | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : null;
};

/** The link every "edit this post" and "new post" entry point uses. */
export const composePostHref = (postId: string, options: { readonly schedule?: boolean } = {}): string =>
  `/compose?post=${encodeURIComponent(postId)}${options.schedule === true ? '&schedule=1' : ''}`;

export const NEW_POST_HREF = '/compose?new=post';

/**
 * The redirect for a post whose row names a conversation, or null to stay on a new one. A stored value
 * that is not a uuid is ignored rather than followed.
 */
export const conversationRedirect = (
  postId: string,
  storedConversationId: unknown,
  options: { readonly schedule?: boolean } = {},
): string | null => {
  if (typeof storedConversationId !== 'string' || !UUID.test(storedConversationId)) return null;
  return `/compose/c/${storedConversationId.toLowerCase()}?post=${postId}${options.schedule === true ? '&schedule=1' : ''}`;
};
