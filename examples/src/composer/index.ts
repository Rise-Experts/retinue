/**
 * The composer — a Tiptap editor with a `/` command menu — #179.
 *
 * **This is the one bundled thing on the page**, and the page's opening comment used to promise there was no
 * build step at all. That promise was worth keeping for as long as the page was the platform's behaviour and
 * nothing else; a composer with a suggestion menu, a placeholder that is not a `placeholder` attribute, and
 * paste handling is not platform behaviour, and hand-rolling it over `contenteditable` would have put ~200 lines
 * of caret arithmetic in the same file as the streaming client. So: everything about *the platform* is still
 * plain, readable, unbundled script in `index.html`, and only the text-entry widget is built.
 *
 * The split is deliberate and load-bearing:
 *
 * - This module owns **editing** — text, placeholder, history, Enter/Shift+Enter, the menu's presentation.
 * - `index.html` owns **behaviour** — what a command does, what sending does, modes, streaming.
 *
 * So `mount` takes callbacks and returns a handle. It never fetches, never knows a conversation id, and cannot
 * send. A command selected here is reported by name; the page decides what that means, using the same code path
 * as when the name was typed as text. Two ways in, one implementation.
 */

import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { COMPOSER_COMMANDS, commandQueryAt, filterCommands, type ComposerCommand } from "./commands.js";

export type ComposerHandle = {
  /** The message as plain text, trimmed. Empty when there is nothing to send. */
  text(): string;
  clear(): void;
  focus(): void;
  /**
   * Insert text at the caret. The editor's own command, not `document.execCommand("insertText")` — that reaches
   * ProseMirror through a DOM mutation it then has to interpret, and it is deprecated besides. Used by dictation
   * and by the `+` button.
   */
  insert(text: string): void;
  destroy(): void;
};

export type MountOptions = {
  readonly element: HTMLElement;
  /** Where the menu is rendered. Separate from `element` so it can escape the input's overflow. */
  readonly menuElement: HTMLElement;
  readonly placeholder?: string;
  /** Enter with no modifier. The page decides whether the text is a command or a message. */
  onSubmit(text: string): void;
  /** A command chosen from the menu, by name and without its slash. */
  onCommand(name: string): void;
  /** Fires on every change, so the page can enable/disable its send button. */
  onChange?(text: string): void;
  readonly commands?: readonly ComposerCommand[];
};

/** A single paragraph of plain text — no marks, no lists. A chat message is not a document. */
const plainText = (editor: Editor): string =>
  editor.getText({ blockSeparator: "\n" }).replace(/ /g, " ").trim();

export const mount = (options: MountOptions): ComposerHandle => {
  const commands = options.commands ?? COMPOSER_COMMANDS;
  const menu = options.menuElement;
  let items: readonly ComposerCommand[] = [];
  let active = 0;

  const closeMenu = () => {
    items = [];
    active = 0;
    menu.hidden = true;
    menu.replaceChildren();
  };

  const choose = (index: number) => {
    const chosen = items[index];
    if (chosen === undefined) return;
    closeMenu();
    // Cleared before the callback, not after: the page may open a dialog or start a run, and a composer still
    // holding `/compact` when it returns would send it again on the next Enter.
    editor.commands.clearContent(true);
    options.onCommand(chosen.name);
  };

  const paintMenu = () => {
    menu.replaceChildren();
    items.forEach((command, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = index === active ? "cmd-row on" : "cmd-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      const name = document.createElement("span");
      name.className = "cmd-name";
      name.textContent = `/${command.name}`;
      const summary = document.createElement("span");
      summary.className = "cmd-summary";
      summary.textContent = command.summary;
      row.append(name, summary);
      // `mousedown` rather than `click`: a click would first move focus out of the editor, and the blur handler
      // closes the menu — so the click landed on an element that had already been removed.
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(index);
      });
      menu.append(row);
    });
    menu.hidden = items.length === 0;
  };

  const syncMenu = (text: string) => {
    const query = commandQueryAt(text);
    if (query === null) return closeMenu();
    const next = filterCommands(query, commands);
    // A query that matches nothing closes the menu rather than showing an empty box — and leaves the text alone,
    // because someone typing an unknown slash-word is writing a message, not failing to autocomplete.
    if (next.length === 0) return closeMenu();
    // Keep the highlight on the same command across keystrokes where it survives the filter; otherwise the
    // selection silently drifts to whatever is now first and Enter runs something else.
    const previous = items[active];
    items = next;
    const kept = previous === undefined ? -1 : next.findIndex((c) => c.id === previous.id);
    active = kept === -1 ? 0 : kept;
    paintMenu();
  };

  const editor = new Editor({
    element: options.element,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: options.placeholder ?? "Message the assistant…" }),
    ],
    editorProps: {
      attributes: { class: "tt", "aria-label": "Message", role: "textbox", "aria-multiline": "true" },
      handleKeyDown: (_view, event) => {
        if (menu.hidden === false) {
          if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
            event.preventDefault();
            active = (active + 1) % items.length;
            paintMenu();
            return true;
          }
          if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
            event.preventDefault();
            active = (active - 1 + items.length) % items.length;
            paintMenu();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            choose(active);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeMenu();
            return true;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const text = plainText(editor);
          if (text !== "") options.onSubmit(text);
          return true;
        }
        return false;
      },
      // Paste as text. A composer that accepts rich HTML shows the person formatting the model will never see,
      // and `getText` would discard it silently on send.
      transformPastedHTML: (html) => html.replace(/<[^>]*>/g, " "),
    },
    onUpdate: () => {
      const text = plainText(editor);
      syncMenu(text);
      options.onChange?.(text);
    },
    onBlur: () => {
      // Deferred: a mousedown on a menu row blurs the editor before the row's own handler runs.
      window.setTimeout(closeMenu, 120);
    },
  });

  closeMenu();

  return {
    text: () => plainText(editor),
    clear: () => {
      closeMenu();
      editor.commands.clearContent(true);
    },
    focus: () => editor.commands.focus("end"),
    insert: (text) => {
      editor.commands.focus("end");
      editor.commands.insertContent(text);
    },
    destroy: () => editor.destroy(),
  };
};

export { COMPOSER_COMMANDS, commandQueryAt, filterCommands };
export type { ComposerCommand };
