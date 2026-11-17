"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateProject } from "@/lib/projects/client";
import styles from "./proposal.module.css";

export type ProjectProposal = {
  readonly projectId: string;
  readonly sources: readonly string[];
  readonly proposal: {
    readonly name?: string;
    readonly description?: string;
    readonly instructions?: string;
    readonly avatar?: { readonly name?: string; readonly persona?: string; readonly look?: string };
    readonly design?: { readonly colors?: readonly string[]; readonly fonts?: string; readonly imageStyle?: string; readonly aspectRatios?: readonly string[] };
    readonly defaults?: { readonly channels?: readonly string[]; readonly hashtags?: string; readonly cta?: string };
  };
};

/** A `propose_project_setup` result, if this is one — the card renders only what really came back. */
export const proposalOf = (output: unknown): ProjectProposal | null => {
  const o = output as { projectId?: unknown; proposal?: unknown; sources?: unknown } | null;
  if (o === null || typeof o !== "object" || typeof o.projectId !== "string" || o.proposal === null || typeof o.proposal !== "object") return null;
  return {
    projectId: o.projectId,
    sources: Array.isArray(o.sources) ? o.sources.filter((s): s is string => typeof s === "string") : [],
    proposal: o.proposal as ProjectProposal["proposal"],
  };
};

/**
 * The agent's proposal for a project, accepted with one click — #555 (D1 on the canvas).
 *
 * "Use this" saves it through the project API **as the person** (the same PATCH the project page uses,
 * with row-level security deciding who may), so accepting needs no second approval and no second model
 * turn. It then tells the chat, so the agent carries on with the next setup step. "Try another look" and
 * anything typed are ordinary messages the agent answers with a new proposal.
 */
export function ProjectProposalCard({ proposal, onSaid }: { proposal: ProjectProposal; onSaid: (text: string) => boolean }) {
  const t = useTranslations("assistant.proposal");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const p = proposal.proposal;
  const design = p.design ?? {};
  const defaults = p.defaults ?? {};

  const use = async () => {
    setState("saving");
    setError(null);
    try {
      await updateProject(proposal.projectId, p as Record<string, unknown>);
      setState("saved");
      onSaid(t("usedMessage"));
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : t("failed"));
    }
  };

  return (
    <section className={styles.card} aria-label={t("title")}>
      <header className={styles.head}>
        <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" />
        </svg>
        <span className={styles.title}>{p.name ? t("titleNamed", { name: p.name }) : t("title")}</span>
        {proposal.sources.length > 0 && <span className={styles.muted}>{t("sources", { count: proposal.sources.length })}</span>}
      </header>
      <div className={styles.grid}>
        {(p.instructions || p.description) && (
          <div className={styles.cell}>
            <span className={styles.label}>{t("instructions")}</span>
            <p className={styles.text}>{p.instructions ?? p.description}</p>
          </div>
        )}
        {p.avatar && (p.avatar.name || p.avatar.persona || p.avatar.look) && (
          <div className={styles.cell}>
            <span className={styles.label}>{t("avatar")}</span>
            <p className={styles.text}>
              {p.avatar.name ? <strong>{p.avatar.name}</strong> : null}
              {p.avatar.persona ? ` — ${p.avatar.persona}` : ""}
            </p>
            {p.avatar.look ? <p className={styles.muted}>{p.avatar.look}</p> : null}
          </div>
        )}
        {((design.colors?.length ?? 0) > 0 || design.imageStyle || design.fonts) && (
          <div className={styles.cell}>
            <span className={styles.label}>{t("style")}</span>
            {(design.colors?.length ?? 0) > 0 && (
              <div className={styles.swatches}>
                {design.colors!.map((c) => (
                  <span key={c} className={styles.swatch} style={{ background: c }} title={c} />
                ))}
              </div>
            )}
            <p className={styles.muted}>{[design.imageStyle, design.fonts, (design.aspectRatios ?? []).join(" · ")].filter(Boolean).join(" · ")}</p>
          </div>
        )}
        {(defaults.channels?.length || defaults.hashtags || defaults.cta) && (
          <div className={styles.cell}>
            <span className={styles.label}>{t("defaults")}</span>
            <p className={styles.text}>{[(defaults.channels ?? []).join(", "), defaults.hashtags, defaults.cta ? `“${defaults.cta}”` : null].filter(Boolean).join(" · ")}</p>
          </div>
        )}
      </div>
      <footer className={styles.foot}>
        {state === "saved" ? (
          <span className={styles.saved} role="status">
            {t("saved")}
          </span>
        ) : (
          <>
            <button type="button" className={styles.primary} disabled={state === "saving"} onClick={() => void use()}>
              {state === "saving" ? t("saving") : t("use")}
            </button>
            <button type="button" className={styles.secondary} onClick={() => onSaid(t("anotherMessage"))}>
              {t("another")}
            </button>
            <span className={styles.muted}>{t("orSay")}</span>
          </>
        )}
        {error !== null && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </footer>
    </section>
  );
}
