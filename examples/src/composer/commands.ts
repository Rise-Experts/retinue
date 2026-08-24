/**
 * The `/` command catalogue, and the matching the menu does — #179.
 *
 * Separated from the editor because it is the part with rules, and the editor is the part with a DOM. Every
 * command here is a real one the page already implements: a menu that lists something unimplemented is worse
 * than no menu, since the person now believes the app can do it.
 *
 * `run` is not here either. The catalogue names commands; the page owns what they do, and it already did before
 * this menu existed — `/compact` was typed as text and intercepted in `send()`. Keeping the effects there means
 * the menu is a *way to reach* behaviour rather than a second copy of it.
 */

export type ComposerCommand = {
  readonly id: string;
  /** What the person types, without the slash. */
  readonly name: string;
  readonly summary: string;
  /**
   * Extra words that should match this command without appearing in its name — the vocabulary someone reaches
   * for before they have learnt yours. Typing `/summarise` has to find `/compact`.
   */
  readonly aliases?: readonly string[];
};

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  {
    id: "compact",
    name: "compact",
    summary: "Condense the history now, keeping the facts",
    aliases: ["summarise", "summarize", "summary", "condense", "shrink"],
  },
  { id: "mode-auto", name: "auto", summary: "Auto mode — act without pausing for approval", aliases: ["mode"] },
  { id: "mode-ask", name: "ask", summary: "Ask mode — pause before anything irreversible", aliases: ["mode", "approve"] },
  { id: "mode-plan", name: "plan", summary: "Plan mode — read and think, change nothing", aliases: ["mode", "readonly"] },
];

/**
 * The commands matching a query, best first.
 *
 * Ranked rather than merely filtered, because an alias match must never outrank a name match: typing `a` has to
 * put `/auto` and `/ask` above `/compact`, which only matches through its `summarise`-family aliases. Prefix
 * beats contained for the same reason — `/plan` before nothing else, not after whatever happens to contain
 * "plan" earlier in the array.
 *
 * An empty query lists everything in declared order, which is what an unfiltered menu should show.
 */
export const filterCommands = (
  query: string,
  commands: readonly ComposerCommand[] = COMPOSER_COMMANDS,
): readonly ComposerCommand[] => {
  const q = query.trim().toLowerCase();
  if (q === "") return commands;

  const rank = (c: ComposerCommand): number => {
    const name = c.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
    if (aliases.some((a) => a.startsWith(q))) return 3;
    if (aliases.some((a) => a.includes(q))) return 4;
    // The summary is matched last and only as whole words, so a query cannot pull in a command because some
    // letter sequence happens to appear mid-word in its prose.
    if (c.summary.toLowerCase().split(/\W+/).some((w) => w.startsWith(q))) return 5;
    return -1;
  };

  return commands
    .map((c, index) => ({ c, index, score: rank(c) }))
    .filter((r) => r.score >= 0)
    // Declared order breaks ties, so the list never reorders itself between two keystrokes that rank equally.
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((r) => r.c);
};

/**
 * Where the caret sits relative to a `/` command being typed, or `null` when no menu should open.
 *
 * The rule is deliberately strict: the slash must open the message. A `/` mid-sentence is a date, a path or a
 * fraction, and an autocomplete menu that appears while someone types `and/or` is a menu that gets in the way
 * four times a day. It also keeps the interception in `send()` honest — that only ever matched a whole message
 * equal to `/compact`, so those are the only messages the menu should claim.
 */
export const commandQueryAt = (text: string): string | null => {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  // A space ends the command and starts its arguments; no command here takes any, so the menu closes.
  if (/\s/.test(rest)) return null;
  return rest;
};
