/**
 * The post-reference hover card.
 *
 * A `chorus:post/<uuid>` token renders as an ordinary link in the reply, and the card appears only
 * while the pointer is on it. That replaces an inline chip that expanded *into* the message: a reply
 * mentioning three posts became three cards stacked in the prose, and expanding one shoved the rest
 * of the conversation down the screen.
 *
 * Three things that look like detail and are not:
 *
 *  - **It is a portal.** The card is positioned against the viewport, not the paragraph, so no
 *    `overflow: hidden` ancestor in the message list can clip it and nothing in the message reflows
 *    when it opens.
 *  - **Hover is not the only way in.** Focus opens it too and the trigger is keyboard-reachable,
 *    because a hover-only affordance does not exist for anyone on a touch screen or a keyboard. The
 *    request was that it not sit in the message; that is satisfied by the popover, not by making it
 *    unreachable.
 *  - **Leaving is delayed.** Without a grace period the card closes the moment the pointer leaves
 *    the link, which is exactly when it is travelling towards the card. The card keeps itself open
 *    while hovered for the same reason.
 */

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import PostPreview from "@/components/PostPreview";
import { Skeleton } from "@/components/Skeleton";
import type { PlatformId } from "@/lib/platforms";
import styles from "./messages.module.css";

interface CardMedia {
  url: string;
  kind: "image" | "video" | "document";
  name: string;
}

interface CardData {
  postId: string;
  text: string;
  platforms: string[];
  status: string;
  media: CardMedia[];
}

/**
 * Session cache, module-scoped.
 *
 * The same post is often referenced more than once in a conversation, and a card unmounts and
 * remounts as its message re-renders while streaming. Without this, every hover is a request.
 */
const cache = new Map<string, CardData>();

/** How long the pointer may be outside both the link and the card before it closes. */
const LEAVE_GRACE_MS = 140;

const CARD_WIDTH = 320;
const GAP = 10;
const MARGIN = 8;

export default function PostHoverCard({
  postId,
  label,
  onOpen,
}: {
  postId: string;
  label: string;
  /**
   * #497: in the Assistant, a click opens the post panel beside the chat instead of leaving it. A
   * modified click (new tab, new window) still follows the link, and so does every other surface.
   */
  onOpen?: (postId: string) => void;
}) {
  const t = useTranslations("assistant");
  const describedBy = useId();

  const anchor = useRef<HTMLAnchorElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [data, setData] = useState<CardData | null>(() => cache.get(postId) ?? null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "missing">("idle");
  const [at, setAt] = useState<{ top: number; left: number; above: boolean } | null>(null);

  const load = useCallback(async () => {
    if (cache.has(postId)) {
      setData(cache.get(postId)!);
      return;
    }
    setState("loading");
    try {
      const res = await fetch(`/api/posts/${postId}/card`, { cache: "no-store" });
      if (res.status === 404) {
        // Deleted, or another workspace's — the endpoint deliberately does not distinguish.
        setState("missing");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as CardData;
      cache.set(postId, json);
      setData(json);
      setState("idle");
    } catch {
      setState("error");
    }
  }, [postId]);

  /** Below the link when there is room, above it when there is not, clamped to the viewport. */
  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const roomBelow = window.innerHeight - rect.bottom;
    const above = roomBelow < 260 && rect.top > roomBelow;
    const left = Math.min(
      Math.max(MARGIN, rect.left),
      Math.max(MARGIN, window.innerWidth - CARD_WIDTH - MARGIN),
    );
    setAt({ top: above ? rect.top - GAP : rect.bottom + GAP, left, above });
  }, []);

  const open = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    place();
    void load();
  }, [place, load]);

  const close = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setAt(null), LEAVE_GRACE_MS);
  }, []);

  // A card anchored to a viewport position is wrong the instant anything scrolls, and the message
  // list scrolls constantly while a reply streams.
  useEffect(() => {
    if (at === null) return;
    const onScroll = () => setAt(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  if (state === "missing") {
    return <span className={styles.postCardUnavailable}>{t("postUnavailable")}</span>;
  }

  const platform = (data?.platforms[0] ?? "instagram") as PlatformId;
  const shown = label || t("openPost");

  return (
    <>
      <a
        ref={anchor}
        href={`/posts/${postId}`}
        className={styles.postLink}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={(event) => {
          if (onOpen === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(postId);
        }}
        aria-describedby={at ? describedBy : undefined}
      >
        {shown}
      </a>

      {at !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={describedBy}
            role="tooltip"
            className={`${styles.postHoverCard} ${at.above ? styles.postHoverCardAbove : ""}`}
            style={{ top: at.top, left: at.left, width: CARD_WIDTH }}
            onMouseEnter={open}
            onMouseLeave={close}
          >
            {state === "loading" && !data ? (
              <Skeleton height={240} />
            ) : state === "error" ? (
              <span className={styles.postCardUnavailable}>{t("previewFailed")}</span>
            ) : data ? (
              <>
                <div className={styles.postHoverHead}>
                  <span className={styles.postCardStatus}>{data.status}</span>
                  {data.platforms.length > 1 && (
                    <span className={styles.postHoverPlatforms}>
                      {data.platforms.join(" · ")}
                    </span>
                  )}
                </div>
                <PostPreview
                  platform={platform}
                  text={data.text}
                  media={data.media
                    .filter((m) => m.kind !== "document")
                    .map((m) => ({ url: m.url, isVideo: m.kind === "video" }))}
                />
                <PostCardAttachments media={data.media} countLabel={t("mediaCount", { count: data.media.length })} />
              </>
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Everything attached, not just the one the platform preview shows.
 *
 * `PostPreview` renders `media[0]` because that is what the platform displays, and the card used to
 * stop there — so a post with five images looked like a post with one, and a post with a PDF looked
 * like a post with nothing, because documents were filtered out before they ever reached it.
 */
function PostCardAttachments({ media, countLabel }: { media: CardMedia[]; countLabel: string }) {
  const extra = media.filter((m) => m.kind !== "document").slice(1);
  const documents = media.filter((m) => m.kind === "document");
  if (extra.length === 0 && documents.length === 0) return null;

  return (
    <div className={styles.postHoverMedia}>
      <span className={styles.postHoverMediaCount}>{countLabel}</span>
      <div className={styles.postHoverThumbs}>
        {extra.map((m) => (
          <span key={m.url} className={styles.postHoverThumb} title={m.name}>
            {m.kind === "video" ? (
              <video src={m.url} muted playsInline className={styles.postHoverThumbMedia} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, not optimizable
              <img src={m.url} alt="" className={styles.postHoverThumbMedia} />
            )}
          </span>
        ))}
        {documents.map((m) => (
          <span key={m.url} className={styles.postHoverDoc} title={m.name}>
            <span aria-hidden="true">📄</span>
            <span className={styles.postHoverDocName}>{m.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
