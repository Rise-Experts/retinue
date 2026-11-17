/**
 * The first message of a new Compose chat, from its start screen — #517.
 *
 * Compose's start screen (`ComposeStart`) collects what a post needs besides the idea: which channels,
 * whether to make an image, and photos to use. The agent reads plain language, so those choices are
 * said after the person's own words rather than hidden in a field it would have to be told about —
 * and the person sees exactly what was asked in the transcript. The words are the caller's, localised.
 *
 * #621: the channels are **context, not a command**. This appended "Write it for Instagram, Facebook,
 * LinkedIn." — so a plain question typed on the start screen was answered once per channel, as three
 * posts. They now go last, on a line of their own that says what they are ("Channels selected in the
 * composer (for any post you write): …"), and the prompt's `composer-channels` clause tells the agent
 * to use them only when it actually writes a post.
 */
export type StartWords = {
  /** The selected channels as context — "Channels selected in the composer (for any post you write): …". */
  readonly forChannels: (channels: string) => string;
  readonly image: string;
  readonly photos: (count: number) => string;
};

export const startRequest = (
  input: { readonly prompt: string; readonly channels: readonly string[]; readonly image: boolean; readonly photos: number },
  words: StartWords,
): string => {
  const extras = [
    input.image ? words.image : null,
    input.photos > 0 ? words.photos(input.photos) : null,
  ].filter((part): part is string => part !== null);
  const blocks = [
    input.prompt.trim(),
    extras.length === 0 ? null : extras.join(' '),
    input.channels.length > 0 ? words.forChannels(input.channels.join(', ')) : null,
  ].filter((part): part is string => part !== null && part !== '');
  return blocks.join('\n\n');
};
