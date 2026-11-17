/**
 * A user turn: tinted bubble on the right, avatar beside it, hover-copy, and a clock time underneath.
 *
 * #548/#549: a message carries its `@` references and attached files as blocks the agent reads
 * (`turnBlocks.ts`). The bubble shows what the person wrote, with the references as chips — a post's
 * chip opens it beside the chat — and the attachments as images, never the raw block lines.
 */

import { useLocale, useTranslations } from "next-intl";
import type { AssistantChatMessage } from "@/lib/assistant/chatMessage";
import { formatClockTime } from "@/lib/assistant/chatMessage";
import { splitBlocks } from "@/lib/assistant/turnBlocks";
import { UserAvatar } from "./Avatar";
import CopyButton from "./CopyButton";
import Markdown from "./Markdown";
import styles from "./messages.module.css";

export default function UserMessage({
  message,
  userName,
  onOpenPost = null,
}: {
  message: AssistantChatMessage;
  userName?: string | null;
  onOpenPost?: ((postId: string) => void) | null;
}) {
  const locale = useLocale();
  const t = useTranslations("assistant.box");
  const time = formatClockTime(message.createdAt, locale);
  const { text, references, attachments } = splitBlocks(message.text);
  const images = attachments.map((path) => `![](chorus-media:${path})`).join(" ");

  return (
    <div className={`${styles.row} ${styles.rowUser}`}>
      <div className={`${styles.body} ${styles.bodyUser}`}>
        <div className={styles.content}>
          <div className={styles.bubbleUser}>
            {references.length > 0 && (
              <div className={styles.sentAttachments} aria-label={t("inChat")}>
                {references.map((ref) =>
                  ref.kind === "post" && onOpenPost !== null ? (
                    <button key={ref.id} type="button" className={styles.sentAttachment} onClick={() => onOpenPost(ref.id)} title={t("openPost")}>
                      @{ref.label || t("chipPost")}
                    </button>
                  ) : (
                    <span key={ref.id} className={styles.sentAttachment}>
                      @{ref.label || t("chipFile")}
                    </span>
                  ),
                )}
              </div>
            )}
            <Markdown>{text}</Markdown>
            {images !== "" && <Markdown>{images}</Markdown>}
          </div>
          <CopyButton text={text} />
        </div>
        {message.attachmentNames && message.attachmentNames.length > 0 && (
          <div className={styles.sentAttachments}>
            {message.attachmentNames.map((name, index) => (
              <span key={`${name}-${index}`} className={styles.sentAttachment} title={name}>
                {name}
              </span>
            ))}
          </div>
        )}
        {time && <span className={styles.meta}>{time}</span>}
      </div>
      <UserAvatar name={userName} />
    </div>
  );
}
