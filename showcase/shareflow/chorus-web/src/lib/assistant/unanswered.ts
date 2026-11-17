/**
 * A question the chat never answered — shown after a reload, when the run that should have answered it failed.
 *
 * Production, 2026-10-01: a turn that failed (the provider was busy) left the person's question with nothing under
 * it once the page was reloaded — no answer, no error, no way to tell it had failed. The failure is only known to
 * the session that watched the run, so after a reload it is inferred: the last message is the person's, nothing is
 * running in this session, and it is old enough that a reply still in progress would have arrived.
 */
import type { AssistantChatMessage } from './chatMessage';

/** How long a question may wait before it counts as unanswered, in seconds. */
export const UNANSWERED_AFTER_SECONDS = 120;

/** The unanswered question's text, or null. Pure, for tests. */
export function unansweredQuestion(input: {
  readonly messages: readonly AssistantChatMessage[];
  readonly liveTurns: number;
  readonly loading: boolean;
  readonly nowSeconds: number;
}): string | null {
  if (input.loading || input.liveTurns > 0) return null;
  const last = input.messages[input.messages.length - 1];
  if (last === undefined || last.role !== 'user' || last.createdAt === undefined) return null;
  if (input.nowSeconds - last.createdAt < UNANSWERED_AFTER_SECONDS) return null;
  return last.text.trim() === '' ? null : last.text;
}
