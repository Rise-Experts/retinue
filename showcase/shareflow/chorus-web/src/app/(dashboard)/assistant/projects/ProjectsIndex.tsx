"use client";

/**
 * Every project, as a table — #569, like chatgpt.com/projects: a title, a search box and Create, then
 * Name and Updated, newest first. Rows open the project's page.
 *
 * Reads the sidebar's store (`sidebarData.ts`), so the table and the sidebar can never disagree about
 * which projects exist, and opening the page costs no second request.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { matchesQuery, useSidebarData } from "@/lib/sidebar/sidebarData";
import styles from "./projectsIndex.module.css";

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 days ago", "last year" — the largest unit that fits, in the person's language. */
export const updatedAgo = (iso: string, now: number, locale: string): string => {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) return format.format(-Math.round(elapsed / ms), unit);
  }
  return format.format(0, "minute");
};

export default function ProjectsIndex({ canCreateShared, onNewProject }: { canCreateShared: boolean; onNewProject: () => void }) {
  const t = useTranslations("assistant.projects");
  const locale = useLocale();
  const data = useSidebarData();
  const [query, setQuery] = useState("");
  // A lazy initial value, not Date.now() in render: the React Compiler refuses an impure render.
  const [now] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      [...data.projects]
        .filter((p) => !p.archived && (query.trim() === "" || matchesQuery(p.name, query)))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [data.projects, query],
  );

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>{t("title")}</h1>
        <label className={styles.search}>
          <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-3.5-3.5" />
          </svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("indexSearch")} aria-label={t("indexSearch")} />
        </label>
        <button type="button" className={styles.create} onClick={onNewProject} title={canCreateShared ? undefined : t("viewerPersonal")}>
          <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t("create")}
        </button>
      </header>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t("name")}</th>
            <th scope="col" className={styles.updatedCol}>
              {t("indexUpdated")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((project) => (
            <tr key={project.id}>
              <td>
                <Link href={`/compose/p/${encodeURIComponent(project.id)}`} className={styles.nameCell}>
                  <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span className={styles.name}>{project.name}</span>
                  <span className={styles.tag}>{project.personal ? t("onlyMeTag") : t("workspaceTag")}</span>
                </Link>
              </td>
              <td className={styles.updatedCol}>{updatedAgo(project.updatedAt, now, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className={styles.empty}>{!data.loaded ? t("loading") : query.trim() === "" ? t("empty") : t("indexNoMatch", { query })}</p>
      ) : null}
    </div>
  );
}
