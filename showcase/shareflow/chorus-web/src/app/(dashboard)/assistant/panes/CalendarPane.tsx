"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useApp } from "@/lib/store";
import { platformMap, type PlatformId } from "@/lib/platforms";
import { usePaneEpoch } from "@/lib/assistant/paneCache";
import styles from "./panes.module.css";

/**
 * What is coming up — #546: the next two weeks of scheduled posts, by day, beside the chat, so "is there
 * anything on Thursday?" is answered by looking. Opening one shows it in the current-post pane.
 */
export function CalendarPane({ onOpen, onClose }: { onOpen: (postId: string) => void; onClose: () => void }) {
  const t = useTranslations("assistant.panes");
  const locale = useLocale();
  const { scheduledItems, refreshScheduled } = useApp();
  /*
   * #628: the app's schedule shows at once, and is re-read when the pane opens, when a turn schedules or
   * publishes something, and on window focus — each of which bumps the calendar's epoch.
   */
  const epoch = usePaneEpoch("calendar");
  useEffect(() => {
    void refreshScheduled();
  }, [epoch, refreshScheduled]);
  // The pane's "now", fixed when it opens: a two-week agenda does not need to tick.
  const [now] = useState(() => Date.now());

  const days = useMemo(() => {
    const horizon = now + 14 * 86_400_000;
    const upcoming = scheduledItems
      .filter((item) => {
        const at = Date.parse(item.scheduledAt);
        return at >= now - 3_600_000 && at <= horizon && item.status !== "FAILED";
      })
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const byDay = new Map<string, typeof upcoming>();
    for (const item of upcoming) {
      const day = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" }).format(new Date(item.scheduledAt));
      byDay.set(day, [...(byDay.get(day) ?? []), item]);
    }
    return [...byDay.entries()];
  }, [scheduledItems, locale, now]);

  const time = (iso: string) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <section className={styles.pane} aria-label={t("calendar")}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t("calendar")}</span>
        <span className={styles.grow} />
        <Link className={styles.pill} href="/calendar">
          {t("openCalendar")}
        </Link>
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("close")}>
          <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className={styles.body}>
        {days.length === 0 ? (
          <p className={styles.empty}>{t("calendarEmpty")}</p>
        ) : (
          days.map(([day, items]) => (
            <div key={day} className={styles.section}>
              <span className={styles.day}>{day}</span>
              {items.map((item) => (
                <button key={item.id} type="button" className={`${styles.card} ${styles.pill}`} onClick={() => onOpen(item.postId)} style={{ textAlign: "left", borderRadius: 12 }}>
                  <span className={styles.cardHead}>
                    <span className={styles.badge}>{(platformMap[item.platform as PlatformId]?.name ?? item.platform).slice(0, 2)}</span>
                    <span className={styles.cardTitle}>{item.caption.split("\n")[0] || "—"}</span>
                    <span className={styles.meta}>{time(item.scheduledAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
