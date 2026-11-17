/**
 * The scrolling message pane. Port of immo's `Messages` list inside the
 * `flex flex-col-reverse` scroll container from its `AgnoChatContainer`.
 *
 * Owns the scroll container because the chat-sticks-to-bottom behaviour is a
 * property of that element (see the `.thread` comment in messages.module.css —
 * `column-reverse` does it in CSS, so there is no scroll-position effect here).
 *
 * DOM ORDER IS NEWEST-FIRST. `column-reverse` puts the first child at the
 * visual bottom, so the array is reversed for render. immo achieves the same
 * thing by storing its messages newest-first in the store (hence the "index 0
 * is the most recent" comments throughout its stream handler); this app keeps
 * the array chronological — the reducer appends and targets the last element —
 * and reverses here instead, which keeps the pure layer readable.
 */

import type { ReactNode } from "react";
import type { AssistantChatMessage } from "@/lib/assistant/chatMessage";
import { shouldShowDateSeparator } from "@/lib/assistant/chatMessage";
import AssistantMessage from "./AssistantMessage";
import ChatBlankState from "./ChatBlankState";
import DateSeparator from "./DateSeparator";
import UserMessage from "./UserMessage";
import styles from "./messages.module.css";

export default function MessageList({
  messages,
  isStreaming,
  retrying = false,
  userName,
  footer,
  onAttach,
  onOpenArtifact,
  onOpenPost,
  onSay,
}: {
  messages: AssistantChatMessage[];
  /** True while a run is streaming into the trailing assistant message. */
  isStreaming: boolean;
  /** #651: the run is waiting out a provider's "slow down" before trying again. */
  retrying?: boolean;
  userName?: string | null;
  /** Rendered below the messages, inside the scroll area (the permission card). */
  footer?: ReactNode;
  /** Opens an artifact in the side panel. */
  onOpenArtifact?: ((artifactId: string) => void) | null;
  /** #497: a post chip opens the post panel. */
  onOpenPost?: ((postId: string) => void) | null;
  /** #555: a card in the transcript answering in the chat. */
  onSay?: ((text: string) => boolean) | null;
  /** Offers an attach button on assistant replies' images and links. */
  onAttach?: (item: { url: string; label: string }) => void;
}) {
  // Date separators are decided in chronological order — "does this message
  // start a new day compared with the one before it?" — and only then is the
  // list flipped for the column-reverse container. Deciding it after the flip
  // would compare each message against the NEWER one and put separators in the
  // wrong places.
  const slots = messages.map((message, index) => ({
    key: `${message.role}-${index}`,
    message,
    showSeparator: shouldShowDateSeparator(message.createdAt, messages[index - 1]?.createdAt),
    isLast: index === messages.length - 1,
  }));
  slots.reverse();

  return (
    <div className={styles.thread}>
      {/*
        First child = visual bottom under column-reverse, so the permission
        card sits below the newest message where the user is already looking.
      */}
      {footer}
      {messages.length === 0 && !footer ? (
        <ChatBlankState />
      ) : (
        slots.map(({ key, message, showSeparator, isLast }) => (
          <div key={key} className={styles.messageSlot}>
            {showSeparator && message.createdAt !== undefined && (
              <DateSeparator seconds={message.createdAt} />
            )}
            {message.role === "user" ? (
              <UserMessage message={message} userName={userName} onOpenPost={onOpenPost ?? null} />
            ) : (
              <AssistantMessage
                message={message}
                isStreaming={isStreaming && isLast}
                retrying={retrying && isLast}
                onAttach={onAttach}
                onOpenArtifact={onOpenArtifact}
                onOpenPost={onOpenPost}
                onSay={onSay ?? null}
              />
            )}
          </div>
        ))
      )}
    </div>
  );
}
