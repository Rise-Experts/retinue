/**
 * Welcome panel shown when a chat has no messages yet. Port of immo's
 * `ChatBlankState`, whose framer-motion entrance is reproduced with the
 * `blankIn` keyframes in messages.module.css.
 */

import { useTranslations } from "next-intl";
import styles from "./messages.module.css";

export default function ChatBlankState() {
  const t = useTranslations("assistant");

  return (
    <section className={styles.blank} aria-label={t("blankTitle")}>
      <h2 className={styles.blankTitle}>{t("blankTitle")}</h2>
      <p className={styles.blankSubtitle}>{t("blankSubtitle")}</p>
    </section>
  );
}
