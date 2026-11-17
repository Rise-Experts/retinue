"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { forgetProjectMemory, getProject, updateProject, type ProjectDetail } from "@/lib/projects/client";
import { setupSteps } from "@/lib/projects/setupSteps";
import { THEME_PRESETS, resolveTheme, type ThemeId } from "@/lib/projects/theme";
import { useApp } from "@/lib/store";
import { composePostHref } from "@/lib/assistant/postTarget";
import { ProjectAssets } from "./ProjectAssets";
import { ProjectAvatar } from "./ProjectAvatar";
import { ProjectDesign } from "./ProjectDesign";
import { ProjectTemplates } from "./ProjectTemplates";
import styles from "../assistant.module.css";
import page from "./projectPage.module.css";

const INSTRUCTIONS_MAX = 8000;

/** A new chat in the project, with a sentence in the box — sent at once when `send` is true. */
const askHref = (projectId: string, text: string, send = false) =>
  `/compose?project=${encodeURIComponent(projectId)}&ask=${encodeURIComponent(text)}${send ? "&send=1" : ""}`;

/**
 * A project's page — #556: a summary the agent keeps, not a stack of forms.
 *
 * Brief, avatar, style kit and files are cards, each with **Ask to change**, which opens a chat in the
 * project with the request in the box. **What Chorus has learned** lists the project's memory (#554), each
 * rule with Forget. A box at the bottom asks Chorus to change the project in words. The forms that used to
 * be the whole page (#521–#525) are behind **Edit by hand** — kept for the person who wants them, closed
 * by default.
 *
 * Changes are for whoever the database lets write (an editor for a workspace project, the owner for a
 * personal one); for anyone else the buttons that change things are not drawn.
 */
export function ProjectPage({
  projectId,
  canEditShared,
  threads,
  onOpenThread,
}: {
  projectId: string;
  canEditShared: boolean;
  threads: readonly { id: string; title?: string | undefined }[];
  onOpenThread: (conversationId: string) => void;
}) {
  const t = useTranslations("assistant.projects");
  const locale = useLocale();
  const router = useRouter();
  const { context } = useApp();
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");

  useEffect(() => {
    let live = true;
    getProject(projectId)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setName(d.project.name);
        setDescription(d.project.description);
        setInstructions(d.project.instructions);
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : t("notFound")));
    return () => {
      live = false;
    };
  }, [projectId, t, reload]);

  if (loadError !== null) return <div className={styles.projectPage}><p className={styles.errorText}>{loadError}</p></div>;
  if (detail === null) return <div className={styles.projectPage}><p className={styles.threadEmpty}>{t("loading")}</p></div>;

  const project = detail.project;
  const canEdit = (project.personal ? project.mine : canEditShared) && !project.archived;
  const dirty = name !== project.name || description !== project.description || instructions !== project.instructions;
  const titled = new Map(threads.map((thread) => [thread.id, thread.title]));
  const steps = setupSteps(detail);
  const setupDone = steps.every((step) => step.done);
  const design = project.design ?? {};
  const avatar = project.avatar ?? {};
  const memories = detail.memories ?? [];
  const images = detail.assets.filter((a) => a.kind === "image" && a.previewUrl);
  const lastChange = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(project.updatedAt));

  const save = async () => {
    if (!canEdit || saving || name.trim() === "") return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateProject(project.id, { name: name.trim(), description, instructions });
      setDetail({ ...detail, project: updated });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!(project.personal ? project.mine : canEditShared)) return;
    try {
      await updateProject(project.id, { archived: !project.archived });
      router.push(project.archived ? `/compose/p/${project.id}` : "/compose");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  };

  const forget = async (memoryId: string) => {
    try {
      await forgetProjectMemory(project.id, memoryId);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  };

  const askLink = (text: string) =>
    canEdit ? (
      <a className={page.ask} href={askHref(project.id, text)}>
        {t("askToChange")}
      </a>
    ) : null;

  return (
    <div className={`${styles.projectPage} ${page.page}`}>
      <header className={page.head}>
        <div className={page.headText}>
          <h2 className={page.name}>{project.name}</h2>
          <span className={page.sub}>
            {t("keptBy", { when: lastChange })}
            {" · "}
            {project.personal ? t("onlyMeTag") : t("workspaceTag")}
            {project.archived ? ` · ${t("archivedTag")}` : ""}
          </span>
        </div>
        <div className={page.headActions}>
          <a className={page.chipLink} href={`/posts?project=${encodeURIComponent(project.id)}`}>
            {t("postsCount", { count: detail.posts?.length ?? 0 })}
          </a>
          <a className={page.chipLink} href={`/calendar?project=${encodeURIComponent(project.id)}`}>
            {t("calendar")}
          </a>
          <button type="button" className={page.primary} onClick={() => router.push(`/compose?project=${project.id}`)} disabled={project.archived}>
            {t("newChat")}
          </button>
        </div>
      </header>

      {!setupDone && canEdit && (
        <section className={`${page.card} ${page.setup}`} aria-label={t("setupTitle")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("setupTitle")}</span>
            <a className={page.ask} href={`/compose?project=${encodeURIComponent(project.id)}&setup=1`}>
              {t("setupWithChorus")}
            </a>
          </div>
          <ol className={page.steps}>
            {steps.map((step) => (
              <li key={step.key} className={step.done ? page.stepDone : step.next ? page.stepNext : undefined}>
                {t(`steps.${step.key}`)}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className={page.grid}>
        <section className={page.card} aria-label={t("brief")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("brief")}</span>
            {askLink(t("askBrief"))}
          </div>
          {project.instructions.trim() !== "" ? <p className={page.text}>{project.instructions.length > 420 ? `${project.instructions.slice(0, 420)}…` : project.instructions}</p> : <p className={page.muted}>{t("briefEmpty")}</p>}
        </section>

        <section className={page.card} aria-label={t("avatar")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("avatar")}</span>
            {askLink(t("askAvatar"))}
          </div>
          {avatar.name || avatar.persona || avatar.look ? (
            <>
              <p className={page.text}>
                <strong>{avatar.name || t("avatarUnnamed")}</strong>
                {avatar.persona ? ` — ${avatar.persona}` : ""}
              </p>
              {avatar.look ? <p className={page.muted}>{avatar.look}</p> : null}
              {(avatar.referenceAssetIds?.length ?? 0) > 0 && <p className={page.muted}>{t("referencePhotos", { count: avatar.referenceAssetIds!.length })}</p>}
            </>
          ) : (
            <p className={page.muted}>{t("avatarEmpty")}</p>
          )}
        </section>

        <section className={page.card} aria-label={t("design")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("design")}</span>
            {askLink(t("askStyle"))}
          </div>
          {typeof design.themeId === "string" && design.themeId in THEME_PRESETS ? (
            // #595: a themed kit is summarised as its theme — its name, role colours, fonts and picture look.
            (() => {
              const theme = resolveTheme(design);
              const colors = [theme.palette.background, theme.palette.primary, theme.palette.accent, theme.palette.text];
              return (
                <>
                  <div className={page.swatches}>
                    {colors.map((color, i) => (
                      <span key={`${i}-${color}`} className={page.swatch} style={{ background: color }} title={color} />
                    ))}
                  </div>
                  <p className={page.muted}>
                    {[THEME_PRESETS[design.themeId as ThemeId].name, theme.fonts.heading === theme.fonts.body ? theme.fonts.heading : `${theme.fonts.heading} / ${theme.fonts.body}`, theme.picture.style, (design.aspectRatios ?? []).join(" · ")].filter(Boolean).join(" · ")}
                  </p>
                </>
              );
            })()
          ) : (design.colors?.length ?? 0) > 0 || design.imageStyle ? (
            <>
              <div className={page.swatches}>
                {[...new Set(design.colors ?? [])].map((color) => (
                  <span key={color} className={page.swatch} style={{ background: color }} title={color} />
                ))}
              </div>
              <p className={page.muted}>{[design.imageStyle, design.fonts, (design.aspectRatios ?? []).join(" · ")].filter(Boolean).join(" · ")}</p>
            </>
          ) : (
            <p className={page.muted}>{t("styleEmpty")}</p>
          )}
        </section>
      </div>

      <div className={page.grid2}>
        <section className={page.card} aria-label={t("learnedTitle")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("learnedTitle")}</span>
            {memories.length > 0 && <span className={page.muted}>{t("learnedCount", { count: memories.length })}</span>}
          </div>
          {memories.length === 0 ? (
            <p className={page.muted}>{t("learnedEmpty")}</p>
          ) : (
            <ul className={page.memories}>
              {memories.map((memory) => (
                <li key={memory.id}>
                  <span className={page.text}>{memory.text}</span>
                  {canEdit && (
                    <button type="button" className={page.forget} onClick={() => void forget(memory.id)} aria-label={t("forgetLabel", { rule: memory.text })}>
                      {t("forget")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={page.card} aria-label={t("files")}>
          <div className={page.cardHead}>
            <span className={page.label}>{t("files")}</span>
            <span className={page.muted}>{t("filesCount", { count: detail.assets.length })}</span>
          </div>
          {images.length > 0 ? (
            <div className={page.thumbs}>
              {images.slice(0, 6).map((file) => (
                // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                <img key={file.id} src={file.previewUrl!} alt={file.label} className={page.thumb} />
              ))}
            </div>
          ) : (
            <p className={page.muted}>{t("filesEmpty")}</p>
          )}
        </section>
      </div>

      <div className={page.grid2}>
        <section className={page.card} aria-label={t("chats")}>
          <span className={page.label}>{t("chats")}</span>
          {detail.conversations.length === 0 ? (
            <span className={page.muted}>{t("noChats")}</span>
          ) : (
            detail.conversations.slice(0, 8).map((id) => (
              <button key={id} type="button" className={styles.projectItem} onClick={() => onOpenThread(id)}>
                <span className={styles.threadTitle}>{titled.get(id) || t("untitledChat")}</span>
              </button>
            ))
          )}
        </section>
        {/* #526: the posts written in this project. Plain links: the post pane reads the URL on load. */}
        <section className={page.card} aria-label={t("posts")}>
          <span className={page.label}>{t("posts")}</span>
          {(detail.posts ?? []).length === 0 ? (
            <span className={page.muted}>{t("noPosts")}</span>
          ) : (
            (detail.posts ?? []).slice(0, 8).map((post) => (
              <a key={post.id} href={composePostHref(post.id)} className={styles.projectItem}>
                <span className={styles.threadTitle}>{post.caption.split("\n")[0] || t("untitledPost")}</span>
                <span className={styles.threadEmpty}>{post.status}</span>
              </a>
            ))
          )}
          <div className={styles.projectActions}>
            <a className={styles.projectsAdd} href={`/posts?project=${encodeURIComponent(project.id)}`}>{t("allPosts")}</a>
          </div>
        </section>
      </div>

      {canEdit && (
        <form
          className={page.askBox}
          onSubmit={(event) => {
            event.preventDefault();
            if (ask.trim() === "") return;
            router.push(askHref(project.id, ask.trim(), true));
          }}
        >
          <svg className={page.spark} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" />
          </svg>
          <input className={page.askInput} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={t("askPlaceholder")} aria-label={t("askPlaceholder")} maxLength={2000} />
          <button type="submit" className={page.primary} disabled={ask.trim() === ""}>
            {t("askSend")}
          </button>
        </form>
      )}

      <details className={page.byHand}>
        <summary>{t("editByHand")}</summary>
        <div className={page.byHandBody}>
          <label className={styles.projectField}>
            <span className={styles.threadListLabel}>{t("name")}</span>
            <input className={styles.threadFilter} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} readOnly={!canEdit} maxLength={120} />
          </label>
          <label className={styles.projectField}>
            <span className={styles.threadListLabel}>{t("description")}</span>
            <input className={styles.threadFilter} value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} readOnly={!canEdit} placeholder={t("descriptionPlaceholder")} maxLength={1000} />
          </label>
          <label className={styles.projectField}>
            <span className={styles.threadListLabel}>{t("instructions")}</span>
            <span className={styles.threadEmpty}>{t("instructionsHint")}</span>
            <textarea className={styles.projectInstructions} value={instructions} onChange={(e) => { setInstructions(e.target.value); setSaved(false); }} readOnly={!canEdit} placeholder={t("instructionsPlaceholder")} maxLength={INSTRUCTIONS_MAX} rows={10} />
            <span className={styles.threadEmpty}>{t("count", { used: instructions.length, max: INSTRUCTIONS_MAX })}</span>
          </label>
          <div className={styles.projectActions}>
            {canEdit && (
              <button type="button" className={styles.newChat} onClick={() => void save()} disabled={!dirty || saving || name.trim() === ""}>
                {saving ? t("saving") : t("save")}
              </button>
            )}
            {saved && !dirty && <span className={styles.threadEmpty} role="status">{t("saved")}</span>}
            {(project.personal ? project.mine : canEditShared) && (
              <button type="button" className={styles.projectsAdd} onClick={() => void archive()}>
                {project.archived ? t("restore") : t("archive")}
              </button>
            )}
            {!canEdit && <span className={styles.threadEmpty}>{t("readOnly")}</span>}
          </div>
          <ProjectAvatar
            key={`avatar:${project.id}:${JSON.stringify(project.avatar ?? {})}`}
            projectId={project.id}
            avatar={project.avatar ?? {}}
            images={detail.assets.filter((a) => a.kind === "image")}
            canEdit={canEdit}
            onSaved={() => setReload((n) => n + 1)}
          />
          <ProjectDesign
            key={`design:${project.id}:${JSON.stringify(project.design ?? {})}`}
            projectId={project.id}
            design={project.design ?? {}}
            images={detail.assets.filter((a) => a.kind === "image")}
            canEdit={canEdit}
            onSaved={() => setReload((n) => n + 1)}
          />
          <ProjectTemplates projectId={project.id} images={detail.assets.filter((a) => a.kind === "image")} canEdit={canEdit} onRendered={() => setReload((n) => n + 1)} />
          <ProjectAssets projectId={project.id} workspaceId={context?.workspace.id ?? null} assets={detail.assets} canEdit={canEdit} onChanged={() => setReload((n) => n + 1)} />
        </div>
      </details>

      {error !== null && <p className={styles.errorText} role="alert">{error}</p>}
    </div>
  );
}
