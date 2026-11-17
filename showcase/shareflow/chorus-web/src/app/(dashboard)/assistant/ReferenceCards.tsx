/**
 * The knowledge-reference group above an assistant reply. Port of immo's
 * `References` / `ReferenceItem` components.
 *
 * DORMANT: the `chorus-assistant` agent has no `knowledge=` base (see
 * ai_backend/app/assistant/agent.py), so AgentOS never populates
 * `extra_data.references` for it. This renders nothing today; attaching a
 * knowledge base lights it up with no frontend change.
 */

import type { ReferenceGroup } from "@/lib/assistant/chatMessage";
import { ReferencesIcon } from "./chatIcons";
import styles from "./messages.module.css";

export default function ReferenceCards({
  groups,
  label,
}: {
  groups: ReferenceGroup[];
  label: string;
}) {
  if (groups.length === 0) return null;

  return (
    <div className={styles.extraGroup}>
      <div className={styles.extraIcon} title={label} aria-hidden="true">
        <ReferencesIcon />
      </div>
      <div className={styles.extraBody}>
        <span className={styles.extraLabel}>{label}</span>
        {groups.map((group, groupIndex) => (
          <div key={`${group.query}-${groupIndex}`} className={styles.refGrid}>
            {group.references.map((reference, refIndex) => (
              <div key={`${reference.name}-${refIndex}`} className={styles.refCard}>
                <span className={styles.refName}>{reference.name}</span>
                <span className={styles.refContent}>{reference.content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
