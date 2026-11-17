/**
 * The reasoning-step group above an assistant reply. Port of immo's
 * `Reasoning` / `Reasonings` components.
 *
 * DORMANT: the `chorus-assistant` agent is not built with `reasoning=True`
 * (see ai_backend/app/assistant/agent.py), so AgentOS never emits
 * `ReasoningStep` / `ReasoningCompleted` for it and `reasoningSteps` is always
 * empty. This renders nothing today; enabling reasoning on the agent lights it
 * up with no frontend change.
 */

import type { ReasoningStep } from "@/lib/assistant/chatMessage";
import { ReasoningIcon } from "./chatIcons";
import styles from "./messages.module.css";

export default function ReasoningSteps({
  steps,
  label,
  stepLabel,
}: {
  steps: ReasoningStep[];
  label: string;
  /** Renders as e.g. "STEP 1" — `stepLabel` is the translated word "STEP". */
  stepLabel: string;
}) {
  if (steps.length === 0) return null;

  return (
    <div className={styles.extraGroup}>
      <div className={styles.extraIcon} title={label} aria-hidden="true">
        <ReasoningIcon />
      </div>
      <div className={styles.extraBody}>
        <span className={styles.extraLabel}>{label}</span>
        {steps.map((step, index) => (
          <div key={`${step.title}-${index}`} className={styles.reasonStep}>
            <span className={styles.reasonBadge}>
              {stepLabel} {index + 1}
            </span>
            <span className={styles.reasonTitle}>{step.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
