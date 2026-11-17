/**
 * The composer's slash commands.
 *
 * A blank chat box is the worst part of any assistant: the tools exist, the skills exist, and the
 * person looking at it has to guess what to ask for. `/` turns that into a list — and because each
 * command inserts a *prompt* rather than firing an action, what happens next is still an ordinary turn
 * that the user can edit before sending. Nothing here is a second way to reach the runtime.
 *
 * Two kinds:
 *
 *  - **complete** — the prompt is a whole question ("Do I have any leads?"). Accepting it can send.
 *  - **partial** — the prompt is an opening ("Draft a post about "). Accepting it leaves the cursor at
 *    the end and sends nothing, because the interesting half is the half the user types.
 *
 * Pure, because the matching rules are the fiddly part — `/` only opens a menu at the very start of an
 * empty composer, `/dr` filters, `/ ` is a person typing a slash and not a command — and none of that
 * needs a DOM to test.
 */

export type SlashCommand = {
  /** Typed after the slash. Lowercase, no spaces. */
  readonly name: string;
  /** Translation key suffix under `assistant.slash`, so the label and hint stay localisable. */
  readonly key: string;
  /**
   * Whether the inserted prompt is a finished question.
   *
   * `complete` may be sent on accept; `partial` never is — it ends mid-sentence on purpose.
   */
  readonly kind: 'complete' | 'partial';
  /** #641: `project` commands are offered only in a project's chat, where they have something to act on. */
  readonly scope?: 'project';
};

/**
 * What a prompt may name, filled in when the command is taken — #498.
 *
 * `{post}` is the post open in the side panel, as a `chorus:post/<id>` token the agent resolves to the
 * draft, or the words "my most recent draft" when none is open. `{channels}` is the workspace's
 * connected channels. Filled by `promptValues`, so the composer's menu and the panel's quick-change
 * chips produce **the same text** (AC-3).
 */
export type PromptContext = {
  readonly postId: string | null;
  readonly channels: readonly string[];
  /** The localised words for "no post is open" and "no channels", from the same catalogue. */
  readonly noPost: string;
  readonly noChannels: string;
  /** The person's own clock, for `{now}`. Injected so a test can fix it. */
  readonly now?: Date;
  readonly timeZone?: string;
};

/**
 * `{now}`: the person's current date, time and zone, from their browser — `2026-09-27 14:32 Europe/Berlin`.
 *
 * /schedule carries it because the agent has no reliable clock and is told to ask rather than guess;
 * production showed "Schedule … for tomorrow at 18:30" refused with "I don't know today's date". The
 * person's own clock is also the right one: "tomorrow at 18:30" means their tomorrow, in their zone.
 */
export const nowLabel = (now: Date, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone}`;
};

export const promptValues = (context: PromptContext): { post: string; channels: string; now: string } => ({
  post: context.postId === null ? context.noPost : `chorus:post/${context.postId}`,
  channels: context.channels.length === 0 ? context.noChannels : context.channels.join(', '),
  now: nowLabel(context.now ?? new Date(), context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
});

/**
 * The compose quick changes, in the order compose showed them — the post panel's chips (AC-3). Each is
 * also a slash command below, and both read the prompt from `assistant.slash.<key>.prompt`.
 */
export const QUICK_CHANGES = ['shorter', 'playful', 'professional', 'translate'] as const;

/**
 * The list, in menu order.
 *
 * Ordered by how often the answer is the reason someone opened the assistant, not alphabetically: the
 * first two are the ones that produce something, and the rest are questions about the workspace.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // Making a post (#498: everything compose could do). `draft` stays; `post` names the channels.
  { name: 'post', key: 'post', kind: 'partial' },
  { name: 'draft', key: 'draft', kind: 'partial' },
  { name: 'image', key: 'image', kind: 'partial' },
  { name: 'video', key: 'video', kind: 'partial' },
  { name: 'options', key: 'options', kind: 'partial' },
  { name: 'shorter', key: 'shorter', kind: 'complete' },
  { name: 'playful', key: 'playful', kind: 'complete' },
  { name: 'professional', key: 'professional', kind: 'complete' },
  { name: 'translate', key: 'translate', kind: 'complete' },
  { name: 'link', key: 'link', kind: 'partial' },
  // Partial on purpose: the time is the half the person types, and the approval card follows.
  { name: 'schedule', key: 'schedule', kind: 'partial' },
  { name: 'drafts', key: 'drafts', kind: 'complete' },
  { name: 'campaign', key: 'campaign', kind: 'partial' },
  { name: 'diagram', key: 'diagram', kind: 'partial' },
  { name: 'performance', key: 'performance', kind: 'complete' },
  { name: 'comments', key: 'comments', kind: 'complete' },
  { name: 'leads', key: 'leads', kind: 'complete' },
  { name: 'accounts', key: 'accounts', kind: 'complete' },
  // #641: the workspace brand (Settings → Brand) and the person's memory, changed by asking.
  { name: 'brand', key: 'brand', kind: 'complete' },
  { name: 'brandsite', key: 'brandsite', kind: 'partial' },
  { name: 'tone', key: 'tone', kind: 'partial' },
  { name: 'colors', key: 'colors', kind: 'partial' },
  { name: 'logo', key: 'logo', kind: 'complete' },
  { name: 'voice', key: 'voice', kind: 'partial' },
  { name: 'avoid', key: 'avoid', kind: 'partial' },
  { name: 'memory', key: 'memory', kind: 'complete' },
  // #641: the chat's project — only offered inside one.
  { name: 'project', key: 'project', kind: 'complete', scope: 'project' },
  { name: 'setup', key: 'setup', kind: 'partial', scope: 'project' },
  { name: 'instructions', key: 'instructions', kind: 'partial', scope: 'project' },
  { name: 'style', key: 'style', kind: 'partial', scope: 'project' },
  { name: 'rule', key: 'rule', kind: 'partial', scope: 'project' },
  { name: 'files', key: 'files', kind: 'complete', scope: 'project' },
  { name: 'template', key: 'template', kind: 'partial', scope: 'project' },
];

/**
 * The query a slash prefix is asking for, or `null` when this text is not one.
 *
 * Deliberately strict: the menu opens only when the **whole** composer is a slash word. A person
 * writing "use the /docs page" is not opening a command menu, and a menu that appeared mid-sentence
 * would swallow their next Enter.
 */
export const matchSlash = (text: string): { readonly query: string } | null => {
  const match = /^\/([a-z]*)$/i.exec(text);
  return match === null ? null : { query: (match[1] ?? '').toLowerCase() };
};

/**
 * The commands a query matches, prefix first.
 *
 * Prefix matches before substring matches, because `/co` should offer `comments` before `accounts`
 * even though both contain "co" — the first keystrokes of a name are how anyone expects to select it.
 */
export const filterCommands = (query: string, options: { readonly inProject?: boolean } = {}): readonly SlashCommand[] => {
  // #641: a project command outside a project would only earn "this chat is not in a project".
  const offered = options.inProject === true ? SLASH_COMMANDS : SLASH_COMMANDS.filter((command) => command.scope !== 'project');
  if (query === '') return offered;
  const prefix = offered.filter((command) => command.name.startsWith(query));
  const rest = offered.filter(
    (command) => !command.name.startsWith(query) && command.name.includes(query),
  );
  return [...prefix, ...rest];
};

/** Wrap the highlighted index around the list, so the arrow keys never stop on a hidden edge. */
export const nextIndex = (current: number, length: number, delta: number): number => {
  if (length === 0) return 0;
  return (((current + delta) % length) + length) % length;
};
