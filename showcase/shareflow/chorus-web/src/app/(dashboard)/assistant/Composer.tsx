/**
 * The chat box — #549 (Compose v2): one rounded box holding the attachments, the `@` chips and the text
 * with send at its corner, and a row of controls under it (`ComposerControls`): attach, voice, the agent
 * mode, the model, the effort and the circular context-and-credits meter.
 *
 * TipTap (ProseMirror) provides the editor. StarterKit is deliberately trimmed: a chat prompt is not a
 * document, so headings, blockquotes, horizontal rules and code blocks are switched off — bold, italic,
 * lists, inline code and links are kept, since those are what people actually type into a prompt.
 *
 * Three ways to attach, matching what people already expect from a chat: the + menu, pasting an image
 * from the clipboard, and dragging a file onto the box. The files **are sent** with the message now
 * (#549) — `RetinueChat.send` passes the ready paths with the turn, and the route checks them against the
 * workspace. Before, they were uploaded and then silently dropped.
 *
 * Two menus open from the text itself:
 *   - `/` — the commands (#498), when the whole box is one slash word;
 *   - `@` — posts and project files (#548), anywhere a word starts with `@`. A pick becomes a chip above
 *     the text and goes with the message as a checked reference.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { MEDIA_ALLOWED_MIME_TYPES } from "@/lib/media";
import AttachmentBar from "./AttachmentBar";
import { filterCommands, matchSlash, nextIndex, promptValues, type SlashCommand } from "@/lib/assistant/slashCommands";
import type { TurnReference } from "@/lib/assistant/turnBlocks";
import type { ConversationSettings } from "@/lib/assistant/conversationSettings";
import type { ChatModel } from "@/lib/assistant/retinueClient";
import { mentionAt, mentionItems, type MentionItem, type MentionScope, type MentionSources } from "@/lib/assistant/mentions";

export type { MentionSources } from "@/lib/assistant/mentions";
import type { useAttachments } from "./useAttachments";
import { ComposerControls, type MeterData, type MonthCredits } from "./ComposerControls";
import { useDictation } from "./useDictation";
import styles from "./assistant.module.css";
import box from "./composer.module.css";

type Attachments = ReturnType<typeof useAttachments>;

/** ProseMirror doc -> plain text, with a blank line between paragraphs so the agent sees what the person saw. */
function toPlainText(text: string): string {
  return text.replace(/ /g, " ").trim();
}

type MentionState = { readonly query: string; readonly index: number; readonly from: number; readonly to: number; readonly scope: MentionScope };

export default function Composer({
  attach,
  disabled,
  onSend,
  meter,
  month,
  postId = null,
  channels = [],
  references,
  onReferencesChange,
  settings,
  onSettingsChange,
  models,
  defaultModelId,
  mentionSources,
  hasProject,
  seed = null,
  onStop,
  stopping = false,
}: {
  attach: Attachments;
  disabled: boolean;
  /** Returns true when the message was accepted, so the box can clear. */
  onSend: (text: string) => boolean;
  /** #552: how full the context was on the last turn, what it was made of, and what it cost. */
  meter?: MeterData | undefined;
  month: MonthCredits;
  /** #498: the post open in the side pane, which commands such as /shorter name as `{post}`. */
  postId?: string | null;
  /** #498: the connected channels' names, for /post's `{channels}`. */
  channels?: readonly string[];
  /** #548: the posts and files this message points at — held by the chat so panes can add to it too. */
  references: readonly TurnReference[];
  onReferencesChange: (next: readonly TurnReference[]) => void;
  settings: ConversationSettings;
  onSettingsChange: (next: ConversationSettings) => void;
  models: readonly ChatModel[];
  defaultModelId: string | null;
  mentionSources: MentionSources;
  hasProject: boolean;
  /** #556/#555: text put in the box for the person to finish; taken each time `n` moves. */
  seed?: { readonly text: string; readonly n: number } | null;
  /**
   * #747: given while a turn is running, the send button becomes a stop button. A run that loops — the
   * 2026-10-11 read_source run went 27 steps — otherwise has to be waited out.
   */
  onStop?: (() => void) | undefined;
  /** The stop was asked for and the run has not ended yet. */
  stopping?: boolean;
}) {
  const t = useTranslations("assistant");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Whether there is anything to send — state, because the editor's own content does not re-render this. */
  const [hasText, setHasText] = useState(false);

  // The editor's keymap is created once; everything it reads goes through a ref.
  const sendRef = useRef(onSend);
  useEffect(() => {
    sendRef.current = onSend;
  }, [onSend]);
  const blockedRef = useRef(false);
  useEffect(() => {
    blockedRef.current = disabled || attach.uploading;
  }, [disabled, attach.uploading]);

  /* ---- the slash menu ---- */
  const [menu, setMenu] = useState<{ readonly query: string; readonly index: number } | null>(null);
  const menuRef = useRef<{ readonly query: string; readonly index: number } | null>(null);
  useEffect(() => {
    menuRef.current = menu;
  }, [menu]);
  const commands = useMemo(() => (menu === null ? [] : filterCommands(menu.query, { inProject: hasProject })), [menu, hasProject]);
  const commandsRef = useRef<readonly SlashCommand[]>([]);
  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
  const menuListRef = useRef<HTMLDivElement>(null);
  const menuIndex = menu?.index ?? null;
  useEffect(() => {
    if (menuIndex === null) return;
    menuListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [menuIndex]);

  /* ---- the @ picker ---- */
  const [mention, setMention] = useState<MentionState | null>(null);
  const mentionRef = useRef<MentionState | null>(null);
  useEffect(() => {
    mentionRef.current = mention;
  }, [mention]);
  const items = useMemo(() => (mention === null ? [] : mentionItems(mentionSources, mention.query, mention.scope)), [mention, mentionSources]);
  const itemsRef = useRef<readonly MentionItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const referencesRef = useRef(references);
  useEffect(() => {
    referencesRef.current = references;
  }, [references]);
  const scopeRef = useRef<MentionScope>("all");

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, blockquote: false, horizontalRule: false, codeBlock: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: t("box.placeholder") }),
    ],
    editorProps: {
      attributes: { class: styles.editorContent, "aria-label": t("box.placeholder") },
      handleKeyDown: (_view, event) => {
        const pick = mentionRef.current;
        const options = itemsRef.current;
        if (pick !== null && options.length > 0) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setMention({ ...pick, index: nextIndex(pick.index, options.length, event.key === "ArrowDown" ? 1 : -1) });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            takeRef.current(options[pick.index] ?? options[0]!);
            return true;
          }
        }
        if (pick !== null && event.key === "Escape") {
          event.preventDefault();
          setMention(null);
          return true;
        }
        const open = menuRef.current;
        const cmds = commandsRef.current;
        if (open !== null && cmds.length > 0) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setMenu({ query: open.query, index: nextIndex(open.index, cmds.length, event.key === "ArrowDown" ? 1 : -1) });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            acceptRef.current(cmds[open.index] ?? cmds[0]!);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setMenu(null);
            return true;
          }
        }
        // Enter sends; Shift+Enter is a newline.
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        // Backspace in an empty box takes the last chip back off.
        if (event.key === "Backspace" && referencesRef.current.length > 0 && _view.state.doc.textContent === "") {
          onReferencesRef.current(referencesRef.current.slice(0, -1));
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        void attach.addFiles(toFileList(files));
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        void attach.addFiles(toFileList(files));
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      setHasText(current.state.doc.textContent.trim() !== "");
      const found = matchSlash(toPlainText(current.getText({ blockSeparator: "\n\n" })));
      setMenu((previous) => {
        if (found === null) return null;
        return previous !== null && previous.query === found.query ? previous : { query: found.query, index: 0 };
      });
      const { from } = current.state.selection;
      const before = current.state.doc.textBetween(Math.max(0, from - 40), from, "\n", " ");
      const at = mentionAt(before);
      setMention((previous) =>
        at === null
          ? null
          : { query: at.query, index: previous !== null && previous.query === at.query ? previous.index : 0, from: from - at.length, to: from, scope: previous?.scope ?? scopeRef.current },
      );
      if (at === null) scopeRef.current = "all";
    },
  });

  const onReferencesRef = useRef(onReferencesChange);
  useEffect(() => {
    onReferencesRef.current = onReferencesChange;
  }, [onReferencesChange]);

  /** Take an `@` pick: the typed `@word` goes, and the post or file becomes a chip. */
  const take = useCallback(
    (item: MentionItem) => {
      const at = mentionRef.current;
      if (editor && at !== null) editor.chain().focus().deleteRange({ from: at.from, to: at.to }).run();
      setMention(null);
      scopeRef.current = "all";
      if (referencesRef.current.some((r) => r.id === item.id)) return;
      onReferencesRef.current([...referencesRef.current, { kind: item.kind, id: item.id, label: item.label }]);
    },
    [editor],
  );
  const takeRef = useRef(take);
  useEffect(() => {
    takeRef.current = take;
  }, [take]);

  const submit = useCallback(() => {
    if (!editor || blockedRef.current) return;
    const text = toPlainText(editor.getText({ blockSeparator: "\n\n" }));
    if (!text) return;
    if (sendRef.current(text)) editor.commands.clearContent(true);
  }, [editor]);
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  /** Take a command: its prompt into the box; a complete one is sent at once. */
  const accept = useCallback(
    (command: SlashCommand) => {
      if (!editor) return;
      const prompt = t(`slash.${command.key}.prompt`, promptValues({ postId, channels, noPost: t("slashNoPost"), noChannels: t("slashNoChannels") }));
      setMenu(null);
      if (command.kind === "complete") {
        if (blockedRef.current) return;
        if (sendRef.current(prompt)) editor.commands.clearContent(true);
        return;
      }
      // The trailing space inserted as text: parsing collapses whitespace at the end of a paragraph.
      editor.commands.setContent(prompt.trimEnd());
      editor.commands.focus("end");
      if (prompt !== prompt.trimEnd()) editor.commands.insertContent(" ");
    },
    [editor, t, postId, channels],
  );
  const acceptRef = useRef(accept);
  useEffect(() => {
    acceptRef.current = accept;
  }, [accept]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // #556: "Ask to change" arrives with its text in the box, not sent — the person finishes the sentence.
  const seededN = useRef(0);
  useEffect(() => {
    if (!editor || seed === null || seed.n === seededN.current || seed.text === "") return;
    seededN.current = seed.n;
    editor.commands.setContent(seed.text);
    editor.commands.focus("end");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setContent does not emit an update, so the send button is told here
    setHasText(seed.text.trim() !== "");
  }, [editor, seed]);

  /** Open the `@` picker from the + menu, scoped to what was asked for. */
  const openMention = (scope: MentionScope) => {
    if (!editor) return;
    scopeRef.current = scope;
    const text = editor.state.doc.textContent;
    editor.chain().focus("end").insertContent(text === "" || text.endsWith(" ") ? "@" : " @").run();
  };

  const dictation = useDictation(
    useCallback(
      (spoken: string) => {
        if (!editor || spoken === "") return;
        const text = editor.state.doc.textContent;
        editor.chain().focus("end").insertContent(text === "" || text.endsWith(" ") ? spoken : ` ${spoken}`).run();
      },
      [editor],
    ),
    "en-US",
  );

  const canAttach = !disabled && attach.canAddMore;

  return (
    <div
      className={box.wrap}
      onDragOver={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={() => setDragging(false)}
    >
      {menu !== null && commands.length > 0 ? (
        <div ref={menuListRef} className={styles.slashMenu} role="listbox" aria-label={t("slashHint")}>
          {commands.map((command, position) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={position === menu.index}
              className={position === menu.index ? `${styles.slashItem} ${styles.slashItemActive}` : styles.slashItem}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(command);
              }}
              onMouseEnter={() => setMenu({ query: menu.query, index: position })}
            >
              <span className={styles.slashName}>/{command.name}</span>
              <span className={styles.slashLabel}>{t(`slash.${command.key}.label`)}</span>
              <span className={styles.slashItemHint}>{t(`slash.${command.key}.hint`)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {mention !== null ? (
        <div className={box.mention} role="listbox" aria-label={t("box.mentionLabel")}>
          {items.length === 0 ? (
            <div className={box.mentionHint}>{t("box.mentionEmpty")}</div>
          ) : (
            items.map((item, position) => (
              <div key={`${item.group}:${item.id}`}>
                {(position === 0 || items[position - 1]!.group !== item.group) && <div className={box.mentionGroup}>{t(`box.mentionGroups.${item.group}`)}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={position === mention.index}
                  className={`${box.mi} ${position === mention.index ? box.miActive : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    take(item);
                  }}
                  onMouseEnter={() => setMention({ ...mention, index: position })}
                >
                  <span className={box.channelDot} aria-hidden="true">{item.badge}</span>
                  <span className={box.miText}>{item.label}</span>
                  <span className={box.miSub}>{item.sub}</span>
                </button>
              </div>
            ))
          )}
          <div className={box.mentionHint}>{t("box.mentionKeys")}</div>
        </div>
      ) : null}

      <div className={`${box.box} ${dragging ? box.boxDragging : ""}`}>
        <AttachmentBar attachments={attach.attachments} onRemove={attach.remove} />
        {references.length > 0 && (
          <div className={box.chips} aria-label={t("box.inChat")}>
            {references.map((ref) => (
              <span key={ref.id} className={box.chip}>
                <span className={box.chipKind}>{ref.kind === "post" ? t("box.chipPost") : t("box.chipFile")}</span>
                <span className={box.chipLabel}>{ref.label || ref.id.slice(0, 8)}</span>
                <button type="button" className={box.chipRemove} aria-label={t("box.chipRemove", { name: ref.label })} onClick={() => onReferencesChange(references.filter((r) => r.id !== ref.id))}>
                  <svg className={box.ic} viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={box.inputRow}>
          <div className={box.editor}>
            <EditorContent editor={editor} />
          </div>
          {onStop !== undefined ? (
          <button
            type="button"
            className={`${box.send} ${box.stop}`}
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? t("stopping") : t("stop")}
            title={stopping ? t("stopping") : t("stop")}
          >
            <svg className={box.ic} viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
          ) : (
          <button
            type="button"
            className={box.send}
            onClick={submit}
            // Blocked while an upload is in flight: only completed paths are sent.
            disabled={disabled || attach.uploading || !hasText}
            aria-label={t("send")}
            title={t("sendHint")}
          >
            <svg className={box.ic} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M4 7l4-4 4 4" />
            </svg>
          </button>
          )}
        </div>
        {dragging && <div className={box.dropHint}>{t("attachDrop")}</div>}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={MEDIA_ALLOWED_MIME_TYPES.join(",")}
        className={styles.fileInput}
        onChange={(e) => {
          void attach.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <ComposerControls
        disabled={disabled}
        canAttach={canAttach}
        onAddFiles={() => fileInputRef.current?.click()}
        onProjectFiles={() => openMention("files")}
        onMediaLibrary={() => openMention("posts")}
        onSlash={() => {
          if (!editor) return;
          editor.commands.setContent("/");
          editor.commands.focus("end");
        }}
        hasProject={hasProject}
        dictation={dictation}
        settings={settings}
        onSettingsChange={onSettingsChange}
        models={models}
        defaultModelId={defaultModelId}
        meter={meter}
        month={month}
      />
    </div>
  );
}

/** `addFiles` takes a FileList; paste and drop give a File[]. */
function toFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  for (const file of files) dt.items.add(file);
  return dt.files;
}
