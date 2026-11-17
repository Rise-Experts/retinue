"use client";

import { useTranslations } from "next-intl";
import styles from "./kitEditor.module.css";

/*
 * #595 part 2 — the templates the assistant's own tools offer, as small CSS mirrors in the kit's theme:
 * `render_code_snippet`'s frames (shareflow/src/adapters/web/code-snippet.ts), `render_diagram`'s presets
 * (diagram.ts) and `generate_pdf`'s document templates (document-templates.ts). Drawn inside `KitPreviews`,
 * so the same `--t-*` and `--code-*` properties colour them. A thumbnail to choose by, not the render.
 * `__tests__/templatePreviews.test.ts` fails if these lists drift from the agent's.
 */
export const CODE_FRAMES = ["mac", "minimal", "terminal", "none"] as const;
export const DIAGRAM_PRESETS = ["flow", "timeline", "org", "comparison"] as const;
export const DOCUMENT_TEMPLATES = ["one-pager", "report", "brief", "checklist", "campaign-plan"] as const;

type CodeFrame = (typeof CODE_FRAMES)[number];
type DiagramPreset = (typeof DIAGRAM_PRESETS)[number];
type DocumentTemplate = (typeof DOCUMENT_TEMPLATES)[number];

/** Three lines of "code" as coloured bars — enough to see the frame, not a snippet to read. */
function CodeLines() {
  return (
    <span className={styles.tplCodeLines}>
      <span className={styles.tplCodeLine}>
        <span className={styles.tplTokK} />
        <span className={styles.tplTokF} />
      </span>
      <span className={styles.tplCodeLine}>
        <span className={styles.tplTokIndent} />
        <span className={styles.tplTokS} />
      </span>
      <span className={styles.tplCodeLine}>
        <span className={styles.tplTokC} />
      </span>
    </span>
  );
}

function CodeFrameMini({ frame }: { frame: CodeFrame }) {
  if (frame === "none") {
    return (
      <span className={`${styles.tplCode} ${styles.tplCodeNone}`}>
        <CodeLines />
      </span>
    );
  }
  return (
    <span className={styles.tplCode}>
      <span className={`${styles.tplWindow} ${frame === "minimal" ? styles.tplWindowMinimal : ""}`}>
        {frame === "mac" ? (
          <span className={styles.tplBar}>
            <span className={styles.tplLight} />
            <span className={styles.tplLight} />
            <span className={styles.tplLight} />
          </span>
        ) : null}
        {frame === "terminal" ? (
          <span className={`${styles.tplBar} ${styles.tplBarTerm}`}>
            <span className={styles.tplPrompt}>&#10095;</span>
          </span>
        ) : null}
        <CodeLines />
      </span>
    </span>
  );
}

function DiagramMini({ preset }: { preset: DiagramPreset }) {
  switch (preset) {
    case "flow":
      return (
        <span className={styles.tplDiagram}>
          <span className={styles.tplRow}>
            <span className={styles.tplNode} />
            <span className={styles.tplEdge} />
            <span className={`${styles.tplNode} ${styles.tplNodeAccent}`} />
            <span className={styles.tplEdge} />
            <span className={styles.tplNode} />
          </span>
        </span>
      );
    case "timeline":
      return (
        <span className={styles.tplDiagram}>
          <span className={styles.tplRow}>
            <span className={styles.tplNode} />
            <span className={styles.tplEdge} />
            <span className={styles.tplNode} />
            <span className={styles.tplEdge} />
            <span className={`${styles.tplNode} ${styles.tplNodeAccent}`} />
            <span className={styles.tplEdge} />
            <span className={`${styles.tplNode} ${styles.tplNodePlain}`} />
          </span>
        </span>
      );
    case "org":
      return (
        <span className={`${styles.tplDiagram} ${styles.tplColumn}`}>
          <span className={styles.tplNode} />
          <span className={styles.tplOrgLines} />
          <span className={styles.tplRow}>
            <span className={`${styles.tplNode} ${styles.tplNodeTeam}`} />
            <span className={`${styles.tplNode} ${styles.tplNodeTeam}`} />
            <span className={`${styles.tplNode} ${styles.tplNodeTeam}`} />
          </span>
        </span>
      );
    case "comparison":
      return (
        <span className={`${styles.tplDiagram} ${styles.tplCompare}`}>
          {[0, 1].map((i) => (
            <span key={i} className={styles.tplOption}>
              <span className={styles.tplNode} />
              <span className={`${styles.tplNode} ${styles.tplNodePro}`} />
              <span className={`${styles.tplNode} ${styles.tplNodeCon}`} />
            </span>
          ))}
        </span>
      );
  }
}

/** A page with a few text lines; `short` ones end a paragraph. */
const Lines = ({ n }: { n: number }) => (
  <>
    {Array.from({ length: n }, (_, i) => (
      <span key={i} className={`${styles.tplText} ${i === n - 1 ? styles.tplTextShort : ""}`} />
    ))}
  </>
);

function DocumentMini({ template }: { template: DocumentTemplate }) {
  const header = (
    <span className={styles.tplHead}>
      <span className={styles.tplLogo} />
      <span className={styles.tplTitle} />
    </span>
  );
  const footer = (
    <span className={styles.tplFoot}>
      <span className={styles.tplFootText} />
      <span className={styles.tplFootNum}>1</span>
    </span>
  );
  switch (template) {
    case "one-pager":
      return (
        <span className={styles.tplPage}>
          {header}
          <span className={styles.tplLabel} />
          <Lines n={2} />
          <span className={styles.tplLabel} />
          <Lines n={3} />
          {footer}
        </span>
      );
    case "report":
      return (
        <span className={`${styles.tplPage} ${styles.tplCover}`}>
          <span className={styles.tplLogo} />
          <span className={styles.tplCoverTitle} />
          <span className={styles.tplCoverBar} />
        </span>
      );
    case "brief":
      return (
        <span className={styles.tplPage}>
          {header}
          <span className={styles.tplSummary} />
          <span className={styles.tplLabel} />
          <Lines n={2} />
          {footer}
        </span>
      );
    case "checklist":
      return (
        <span className={styles.tplPage}>
          {header}
          {[true, true, false, false].map((done, i) => (
            <span key={i} className={styles.tplCheck}>
              <span className={`${styles.tplBox} ${done ? styles.tplBoxDone : ""}`} />
              <span className={styles.tplText} />
            </span>
          ))}
          {footer}
        </span>
      );
    case "campaign-plan":
      return (
        <span className={`${styles.tplPage} ${styles.tplLandscape}`}>
          {header}
          <span className={styles.tplTable}>
            <span className={styles.tplTh} />
            <span className={styles.tplTr} />
            <span className={`${styles.tplTr} ${styles.tplTrBand}`} />
            <span className={styles.tplTr} />
          </span>
          {footer}
        </span>
      );
  }
}

export function TemplatePreviews() {
  const t = useTranslations("assistant.projects.kit");
  return (
    <div className={styles.tplSection}>
      <div className={styles.sectionHead}>
        <span className={styles.fieldLabel}>{t("templates.title")}</span>
      </div>
      <p className={styles.hint}>{t("templates.hint")}</p>

      <div className={styles.tplGroup}>
        <span className={styles.previewLabel}>{t("templates.code")}</span>
        <div className={styles.tplStrip}>
          {CODE_FRAMES.map((frame) => (
            <figure key={frame} className={styles.tplCard}>
              <CodeFrameMini frame={frame} />
              <figcaption className={styles.tplCaption}>{t(`templates.frame.${frame}`)}</figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className={styles.tplGroup}>
        <span className={styles.previewLabel}>{t("templates.diagram")}</span>
        <div className={styles.tplStrip}>
          {DIAGRAM_PRESETS.map((preset) => (
            <figure key={preset} className={styles.tplCard}>
              <DiagramMini preset={preset} />
              <figcaption className={styles.tplCaption}>{t(`templates.preset.${preset}`)}</figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className={styles.tplGroup}>
        <span className={styles.previewLabel}>{t("templates.document")}</span>
        <div className={`${styles.tplStrip} ${styles.tplStripDocs}`}>
          {DOCUMENT_TEMPLATES.map((template) => (
            <figure key={template} className={styles.tplCard}>
              <DocumentMini template={template} />
              <figcaption className={styles.tplCaption}>{t(`templates.doc.${template}`)}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
