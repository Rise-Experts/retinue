/**
 * Renders a ```mermaid block as an SVG diagram, in the browser.
 *
 * Server-side rendering would need a headless Chromium — the exact thing that
 * OOM-killed this product's API process mid-stream — so the cost here is zero
 * server memory and zero platform rate limit.
 *
 * mermaid is imported DYNAMICALLY. It is a large dependency (it carries its own
 * parsers and layout engines), and most chat turns contain no diagram at all, so
 * loading it eagerly would put that weight in the initial bundle for everybody.
 */

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  mermaidErrorMessage,
  mermaidInitConfig,
  repairMermaidLabels,
} from "@/lib/assistant/mermaid";
import styles from "./messages.module.css";

/**
 * One mermaid initialisation per page, not per diagram.
 *
 * `mermaid.initialize` is global and idempotent-ish, but calling it per diagram
 * would re-apply config on every render during streaming. Kept as a promise so
 * concurrent diagrams share a single import and init rather than racing.
 */
let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      // Config lives in lib/assistant/mermaid so the two settings that have each
      // caused a real bug — strict security, and suppressing mermaid's own error
      // graphic — are asserted by a test rather than only living here.
      mermaid.initialize(
        mermaidInitConfig(window.matchMedia("(prefers-color-scheme: dark)").matches),
      );
      return mermaid;
    });
  }
  return mermaidReady;
}

export default function MermaidDiagram({ source }: { source: string }) {
  const t = useTranslations("assistant");
  // useId gives a stable, collision-free id — mermaid requires one per render and
  // a counter would collide across remounts during streaming.
  const domId = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  // The real mermaid message ("Parse error on line 2: ..."), not just a boolean.
  // Shown under the source and logged, so a broken diagram is actually fixable
  // instead of only being reported as broken.
  const [error, setError] = useState<string | null>(null);
  const lastRendered = useRef<string | null>(null);

  // Repaired HERE rather than trusting the caller. Markdown.tsx already runs
  // `parseMermaid` (which repairs), but ArtifactPanel passed its content straight
  // through — so the same diagram rendered in chat and failed in the side panel. The
  // repair is idempotent, so doing it at the one place that renders is safe and
  // means no future caller can forget it.
  const prepared = repairMermaidLabels(source.trim());

  useEffect(() => {
    // Skip a re-render of identical source: a streaming message re-renders this
    // component on every token, and mermaid layout is not cheap.
    if (lastRendered.current === prepared) return;

    let active = true;
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        // VALIDATE BEFORE RENDERING. `parse` reports a syntax error without touching
        // the DOM, so an invalid diagram never reaches `render` at all — belt and
        // braces alongside suppressErrorRendering, and the only way to get mermaid's
        // actual message rather than a bare thrown object.
        await mermaid.parse(prepared);
        return mermaid.render(domId, prepared);
      })
      .then(({ svg: rendered }) => {
        if (!active) return;
        lastRendered.current = prepared;
        setSvg(rendered);
      })
      .catch((e: unknown) => {
        if (!active) return;
        const message = mermaidErrorMessage(e);
        // Console, as well as on screen: the on-screen copy is for the user, this is
        // for whoever has to debug a diagram the model keeps getting wrong.
        console.error("[mermaid] diagram failed to render:", message, { source: prepared });
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [prepared, domId]);

  if (error) {
    return (
      <div className={styles.diagramFallback}>
        <div className={styles.diagramFallbackNote}>{t("diagramUnrenderable")}</div>
        {/* The source stays readable and copyable, and the reason sits directly
            beneath it — in the message, where the diagram was, instead of as a
            banner appended to the bottom of the page. */}
        <pre className={styles.mdCode}>{source}</pre>
        <pre className={styles.diagramErrorDetail}>{error}</pre>
      </div>
    );
  }

  // Before the first render completes, show the source rather than an empty box,
  // so the message never collapses and then jumps.
  if (!svg) return <pre className={styles.mdCode}>{source}</pre>;

  return (
    <div
      className={styles.diagram}
      role="img"
      aria-label={t("diagram")}
      // mermaid's output is SVG it generated itself from the source, with
      // securityLevel 'strict' set above — which is what makes this safe rather
      // than the usual dangerouslySetInnerHTML smell.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
