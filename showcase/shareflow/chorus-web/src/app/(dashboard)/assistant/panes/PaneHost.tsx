"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import styles from "./panes.module.css";

const WIDTH_KEY = "chorus.pane.width";
const MIN = 340;
const MAX = 820;

/**
 * The side pane's host — #546: beside the chat, resizable from its left edge, the width remembered per
 * browser. On a narrow window the CSS turns it into a slide-over from the right; Escape closes it there.
 */
export function PaneHost({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useTranslations("assistant.panes");
  const [width, setWidth] = useState<number | null>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(WIDTH_KEY));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-shot read of a browser preference after hydration
      if (Number.isFinite(stored) && stored >= MIN && stored <= MAX) setWidth(stored);
    } catch {
      // Not remembered in a private window; the default width stands.
    }
  }, []);

  const save = useCallback((next: number) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Not remembered; still applied.
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragging.current;
      if (drag === null) return;
      setWidth(Math.min(MAX, Math.max(MIN, drag.startWidth + (drag.startX - e.clientX))));
    };
    const onUp = () => {
      if (dragging.current === null) return;
      dragging.current = null;
      document.body.style.userSelect = "";
      if (host.current !== null) save(host.current.getBoundingClientRect().width);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [save]);

  // Escape closes the pane when it is a slide-over, where it covers part of the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && window.matchMedia("(max-width: 1100px)").matches) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.host} ref={host} style={width === null ? undefined : ({ "--pane-width": `${width}px` } as React.CSSProperties)}>
      <button
        type="button"
        className={styles.resize}
        aria-label={t("resize")}
        title={t("resize")}
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = { startX: e.clientX, startWidth: host.current?.getBoundingClientRect().width ?? 440 };
          document.body.style.userSelect = "none";
        }}
        onKeyDown={(e) => {
          const current = host.current?.getBoundingClientRect().width ?? 440;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const next = Math.min(MAX, Math.max(MIN, current + (e.key === "ArrowLeft" ? 24 : -24)));
            setWidth(next);
            save(next);
          }
        }}
      />
      {children}
    </div>
  );
}
