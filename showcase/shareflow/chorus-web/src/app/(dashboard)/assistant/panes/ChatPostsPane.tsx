"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { readChatPosts, type ChatPost } from "@/lib/assistant/retinueClient";
import { paneKey, usePaneData } from "@/lib/assistant/paneCache";
import { platformMap, type PlatformId } from "@/lib/platforms";
import type { TurnReference } from "@/lib/assistant/turnBlocks";
import styles from "./panes.module.css";

const firstLine = (caption: string) => caption.split("\n")[0]!.trim() || "—";

/**
 * Every post this chat made — #547.
 *
 * A chat can hold any number of posts, each with its own channels. Newest first; **Open** shows one in
 * the current-post pane, **Add to chat** puts it in the chat box as a chip so the next message is about
 * that post (#548). Cached per chat and re-read in the background (#628): when it opens, when a post tool
 * result arrives, when the window regains focus.
 */
export function ChatPostsPane({
  conversationId,
  selectedPostId,
  references,
  onOpen,
  onAddToChat,
  onClose,
}: {
  conversationId: string;
  selectedPostId: string | null;
  references: readonly TurnReference[];
  onOpen: (postId: string) => void;
  onAddToChat: (reference: TurnReference) => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant.panes");
  const locale = useLocale();
  const read = useCallback((): Promise<ChatPost[]> => readChatPosts(conversationId, { throwOnError: true }), [conversationId]);
  const { data, loading } = usePaneData(paneKey("posts", conversationId), read);
  const posts = data ?? [];
  const inChat = new Set(references.map((r) => r.id));
  const when = (iso: string | null) =>
    iso === null ? null : new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <section className={styles.pane} aria-label={t("posts")}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t("posts")}</span>
        {posts.length > 0 && <span className={styles.count}>{posts.length}</span>}
        <span className={styles.grow} />
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("close")}>
          <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className={styles.body}>
        {posts.length === 0 ? (
          <div className={styles.empty}>{loading ? t("loading") : t("postsEmpty")}</div>
        ) : (
          posts.map((post) => {
            const label = firstLine(post.caption);
            return (
              <article key={post.id} className={`${styles.card} ${post.id === selectedPostId ? styles.cardOn : ""}`}>
                <div className={styles.cardHead}>
                  {post.platforms.slice(0, 3).map((p) => (
                    <span key={p} className={styles.badge} title={platformMap[p as PlatformId]?.name ?? p}>
                      {(platformMap[p as PlatformId]?.name ?? p).slice(0, 2)}
                    </span>
                  ))}
                  <span className={styles.cardTitle}>{label}</span>
                  <span className={styles.meta}>
                    {post.scheduledAt !== null ? t("scheduledFor", { when: when(post.scheduledAt) ?? "" }) : (t.has(`status.${post.status}`) ? t(`status.${post.status}`) : post.status)}
                  </span>
                </div>
                {post.caption.includes("\n") || post.caption.length > label.length ? <div className={styles.excerpt}>{post.caption.slice(label.length).trim()}</div> : null}
                <div className={styles.actions}>
                  <button type="button" className={styles.pill} onClick={() => onOpen(post.id)}>
                    {t("open")}
                  </button>
                  <button
                    type="button"
                    className={`${styles.pill} ${inChat.has(post.id) ? styles.pillOn : ""}`}
                    disabled={inChat.has(post.id)}
                    onClick={() => onAddToChat({ kind: "post", id: post.id, label: label.slice(0, 60) })}
                  >
                    {inChat.has(post.id) ? t("inChat") : t("addToChat")}
                  </button>
                  {post.mediaCount > 0 && <span className={styles.meta}>{t("mediaCount", { count: post.mediaCount })}</span>}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
