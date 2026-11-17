/**
 * The "Today" / "Yesterday" / full-date pill between messages from different
 * days. Port of immo's `DateSeparator`.
 *
 * immo hardcodes German labels and uses date-fns; this app ships both en and
 * de and has no date-fns, so the label *kind* is decided by the pure helper in
 * lib/assistant/chatMessage.ts and translated here, with `Intl` formatting the
 * full date.
 */

import { useLocale, useTranslations } from "next-intl";
import { dateSeparatorLabel } from "@/lib/assistant/chatMessage";
import styles from "./messages.module.css";

export default function DateSeparator({ seconds }: { seconds: number }) {
  const t = useTranslations("assistant");
  const locale = useLocale();

  const label = dateSeparatorLabel(seconds);
  if (!label) return null;

  let text: string;
  if (label.kind === "today") {
    text = t("today");
  } else if (label.kind === "yesterday") {
    text = t("yesterday");
  } else {
    try {
      text = new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(label.seconds * 1000));
    } catch {
      return null;
    }
  }

  return (
    <div className={styles.dateSeparator}>
      <span className={styles.dateSeparatorLabel}>{text}</span>
    </div>
  );
}
