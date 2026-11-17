/**
 * The human-in-the-loop confirmation card, shown when the relay pauses a run
 * on a gated tool (`publish_now` / `schedule_post`) and hands the decision
 * back to the user.
 *
 * Presentation only — extracted verbatim from the page so the message pane
 * could take it as a footer. Every decision still routes through the page's
 * `resolvePermission`, which owns the resume request and the generation guard.
 */

import { useTranslations } from "next-intl";
import {
  permissionDetails,
  permissionPlatforms,
  permissionWhen,
  type PendingPermission,
  type PermissionDecision,
} from "@/lib/assistant/permissionCard";
import styles from "./assistant.module.css";

export default function PermissionCard({
  pending,
  busy,
  onDecide,
}: {
  pending: PendingPermission;
  busy: boolean;
  onDecide: (decision: PermissionDecision) => void;
}) {
  const t = useTranslations("assistant");

  /**
   * The runtime's own summary first, then the two product phrasings, then the generic one.
   *
   * The category checks below are the old runtime's vocabulary — exactly `publish` or `schedule` — and
   * the new runtime's categories are its own (`publishing`, `engagement`, …), so every card fell
   * through to "Run reply_to_comment? This needs your confirmation.": the tool's identifier, and
   * nothing about what it was going to do. The platform writes a real sentence for each pending
   * approval; when there is one it wins.
   */
  const headline =
    pending.summary !== undefined && pending.summary.trim() !== ''
      ? pending.summary
      : pending.category === "publish"
        ? t("confirmPublish", { platforms: permissionPlatforms(pending.toolArgs) })
        : pending.category === "schedule"
          ? t("confirmSchedule", {
              platforms: permissionPlatforms(pending.toolArgs),
              when: permissionWhen(pending.toolArgs),
            })
          : t("confirmGeneric", { tool: pending.toolName });

  const details = permissionDetails(pending.toolArgs);

  return (
    <div className={styles.permissionCard}>
      <div className={styles.permissionText}>
        <span aria-hidden="true">⚠️</span> {headline}
      </div>

      {/*
        What is actually being approved. An approval with the arguments hidden is a button that says
        "trust me" — and the reason a human is in this loop is that the human sees the thing.
      */}
      {details.length > 0 ? (
        <dl className={styles.permissionDetails}>
          {details.map((detail) => (
            <div key={detail.label} className={styles.permissionDetail}>
              <dt className={styles.permissionDetailLabel}>{detail.label}</dt>
              <dd className={styles.permissionDetailValue}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className={styles.permissionActions}>
        <button
          className={styles.permissionAllow}
          onClick={() => onDecide("once")}
          disabled={busy}
        >
          {t("allowOnce")}
        </button>
        <button
          className={styles.permissionAllow}
          onClick={() => onDecide("always")}
          disabled={busy}
        >
          {t("allowAlways")}
        </button>
        <button
          className={styles.permissionDeny}
          onClick={() => onDecide("deny")}
          disabled={busy}
        >
          {t("deny")}
        </button>
      </div>
      <button
        className={styles.permissionSessionLink}
        onClick={() => onDecide("session")}
        disabled={busy}
      >
        {t("allowSession")}
      </button>
    </div>
  );
}
