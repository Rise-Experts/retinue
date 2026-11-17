/**
 * Three bouncing dots shown while an assistant message is still empty.
 * Port of immo's `AgentThinkingLoader`, whose Tailwind `animate-bounce` with
 * staggered delays is reproduced by the `loaderBounce` keyframes.
 *
 * Replaces the literal "Thinking…" string the pane used to print.
 */

import styles from "./messages.module.css";

export default function ThinkingLoader({ label }: { label: string }) {
  return (
    <div className={styles.loader} role="status" aria-label={label}>
      <span className={styles.loaderDot} />
      <span className={styles.loaderDot} />
      <span className={styles.loaderDot} />
    </div>
  );
}
