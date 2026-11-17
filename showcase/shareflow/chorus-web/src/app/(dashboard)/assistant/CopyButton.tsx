/**
 * Hover-revealed copy button on a chat message.
 *
 * immo copies rich HTML (`copyMarkdownAsHTML` / `copyElementWithStyles`) so a
 * reply can be pasted into an email client with formatting intact. That helper
 * depends on `marked`, which this app does not have — it renders markdown
 * through react-markdown/remark — and pulling in a second markdown parser for
 * the clipboard isn't worth it. This copies the markdown source as plain text,
 * which is what pasting into another editor generally wants anyway.
 */

"use client";

import { useTranslations } from "next-intl";
import { useApp } from "@/lib/store";
import { CopyIcon } from "./chatIcons";
import styles from "./messages.module.css";

export default function CopyButton({ text }: { text: string }) {
  const t = useTranslations("assistant");
  const { showToast } = useApp();

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("copied"));
    } catch {
      // Rejects when the page isn't a secure context or the permission is
      // denied — tell the user rather than failing silently.
      showToast(t("copyFailed"));
    }
  }

  return (
    <button
      type="button"
      className={styles.copyBtn}
      onClick={copy}
      aria-label={t("copy")}
      title={t("copy")}
    >
      <CopyIcon />
    </button>
  );
}
