"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getProject, listProjects, putChatInProject, type ProjectDetail, type ProjectSummary } from "@/lib/projects/client";
import { setupSteps } from "@/lib/projects/setupSteps";
import styles from "./panes.module.css";

/**
 * The chat's project, beside the chat — #546, #555.
 *
 * In a project: what the agent works from (brief, avatar, style kit, learned rules) and how far setup has
 * got, as a checklist rather than a form — every step is done by asking. Not in one: pick a project to put
 * this chat in, or start a new one that the agent sets up.
 */
export function ProjectPane({
  conversationId,
  project,
  refreshKey,
  onProjectChange,
  onAsk,
  onNewProject,
  onClose,
}: {
  conversationId: string;
  project: { readonly id: string; readonly name: string } | null;
  refreshKey: string;
  onProjectChange: (project: { id: string; name: string }) => void;
  onAsk: (text: string) => void;
  onNewProject: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant.panes");
  const tp = useTranslations("assistant.projects");
  const [detail, setDetail] = useState<{ key: string; value: ProjectDetail | null } | null>(null);
  const [choices, setChoices] = useState<readonly ProjectSummary[]>([]);
  const [picked, setPicked] = useState("");
  const key = `${project?.id ?? "none"}|${refreshKey}`;

  useEffect(() => {
    let live = true;
    if (project === null) {
      void listProjects()
        .then((list) => live && setChoices(list.filter((p) => !p.archived)))
        .catch(() => live && setChoices([]));
    } else {
      void getProject(project.id)
        .then((value) => live && setDetail({ key, value }))
        .catch(() => live && setDetail({ key, value: null }));
    }
    return () => {
      live = false;
    };
  }, [project, key]);

  const header = (
    <header className={styles.head}>
      <span className={styles.headTitle}>{project?.name ?? t("project")}</span>
      <span className={styles.grow} />
      {project !== null && (
        <Link className={styles.pill} href={`/compose/p/${project.id}`}>
          {t("openProject")}
        </Link>
      )}
      <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("close")}>
        <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>
  );

  if (project === null) {
    return (
      <section className={styles.pane} aria-label={t("project")}>
        {header}
        <div className={styles.body}>
          <p className={styles.empty}>{t("noProject")}</p>
          {choices.length > 0 && (
            <div className={styles.section}>
              <label className={styles.label} htmlFor="pane-project-pick">
                {t("putInProject")}
              </label>
              <select id="pane-project-pick" className={styles.select} value={picked} onChange={(e) => setPicked(e.target.value)}>
                <option value="">{t("chooseProject")}</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.pill}
                disabled={picked === ""}
                onClick={() => {
                  const chosen = choices.find((p) => p.id === picked);
                  if (chosen === undefined) return;
                  void putChatInProject(chosen.id, conversationId).then(() => onProjectChange({ id: chosen.id, name: chosen.name }));
                }}
              >
                {t("putIn")}
              </button>
            </div>
          )}
          <button type="button" className={styles.pill} onClick={onNewProject}>
            {t("newProject")}
          </button>
        </div>
      </section>
    );
  }

  const value = detail !== null && detail.key === key ? detail.value : null;
  const p = value?.project;
  const steps = value === null ? [] : setupSteps(value);
  const design = p?.design ?? {};
  const memories = value?.memories ?? [];

  return (
    <section className={styles.pane} aria-label={t("project")}>
      {header}
      <div className={styles.body}>
        {value === null ? (
          <div className={styles.empty}>{t("loading")}</div>
        ) : (
          <>
            <div className={styles.section}>
              <span className={styles.label}>{t("setup")}</span>
              {steps.map((step) => (
                <div key={step.key} className={`${styles.step} ${step.done ? styles.stepDone : step.next ? styles.stepNext : ""}`}>
                  <span className={`${styles.stepMark} ${step.done ? styles.stepMarkDone : ""}`} aria-hidden="true">
                    {step.done ? (
                      <svg className={styles.ic} viewBox="0 0 16 16">
                        <path d="M3 8.5l3 3 7-7" />
                      </svg>
                    ) : null}
                  </span>
                  <span className={styles.grow}>{t(`steps.${step.key}`)}</span>
                  {!step.done && (
                    <button type="button" className={styles.pill} onClick={() => onAsk(t(`stepAsk.${step.key}`))}>
                      {t("ask")}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {p?.instructions ? (
              <div className={styles.section}>
                <span className={styles.label}>{tp("instructions")}</span>
                <p className={styles.text}>{p.instructions.length > 400 ? `${p.instructions.slice(0, 400)}…` : p.instructions}</p>
              </div>
            ) : null}

            {p?.avatar?.name || p?.avatar?.persona ? (
              <div className={styles.section}>
                <span className={styles.label}>{tp("avatar")}</span>
                <p className={styles.text}>
                  <strong>{p.avatar?.name}</strong>
                  {p.avatar?.persona ? ` — ${p.avatar.persona}` : ""}
                </p>
              </div>
            ) : null}

            {(design.colors?.length ?? 0) > 0 || design.imageStyle ? (
              <div className={styles.section}>
                <span className={styles.label}>{tp("design")}</span>
                <div className={styles.swatches}>
                  {(design.colors ?? []).map((color) => (
                    <span key={color} className={styles.swatch} style={{ background: color }} title={color} />
                  ))}
                </div>
                {design.imageStyle ? <p className={styles.text}>{design.imageStyle}</p> : null}
              </div>
            ) : null}

            {memories.length > 0 && (
              <div className={styles.section}>
                <span className={styles.label}>{t("learned", { count: memories.length })}</span>
                {memories.slice(0, 4).map((m) => (
                  <p key={m.id} className={styles.text}>
                    • {m.text}
                  </p>
                ))}
              </div>
            )}

            <button type="button" className={styles.pill} onClick={() => onAsk(t("askChange"))}>
              {t("askChangeButton")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
