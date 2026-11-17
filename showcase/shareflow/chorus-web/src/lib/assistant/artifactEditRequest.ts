/**
 * "Edit with Chorus" — #607 part 5. The person selects part of an artifact in the panel and says what should
 * change; this is the chat message that asks the agent to change just that part.
 *
 * The artifact is named by its `chorus-artifact:` reference so the agent can find the id, and the selection
 * is quoted so it can be used as the `find` of a patch edit. Long selections are cut: the agent reads the
 * document anyway, and a whole page pasted into the chat is what the panel exists to avoid.
 *
 * Pure, so it is tested (`__tests__/artifactEditRequest.test.ts`).
 */

/** The longest selection quoted in full. */
export const EDIT_SELECTION_MAX = 600;

/** The selection as quoted: trimmed, and cut at `EDIT_SELECTION_MAX` with an ellipsis. Empty when nothing usable is selected. */
export function quoteSelection(selected: string): string {
  const text = selected.replace(/ /g, ' ').trim();
  return text.length > EDIT_SELECTION_MAX ? `${text.slice(0, EDIT_SELECTION_MAX).trimEnd()}…` : text;
}

/**
 * `In "<title>" (chorus-artifact:<id>), change: "<selected text>" — <instruction>`, or null when the selection
 * or the instruction is empty (there is nothing to ask).
 */
export function buildEditRequest(input: { title: string; artifactId: string; selected: string; instruction: string }): string | null {
  const selected = quoteSelection(input.selected);
  const instruction = input.instruction.trim();
  if (selected === '' || instruction === '') return null;
  const title = input.title.trim() || 'the document';
  return `In "${title}" (chorus-artifact:${input.artifactId}), change: "${selected}" — ${instruction}`;
}
