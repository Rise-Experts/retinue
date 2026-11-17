/**
 * The tool-call group that sits above an assistant reply.
 *
 * Port of immo's `ToolComponent` plus the hammer-icon group wrapper in
 * `Messages.tsx`. immo's chip is a static name pill; this one also carries the
 * call's lifecycle, because a Chorus tool call can publish or schedule a real
 * post and "did that actually go through?" is the first thing a user asks.
 */

import type { ToolCallView } from "@/lib/assistant/chatMessage";
import { toolCallKey } from "@/lib/assistant/chatMessage";
import { CheckIcon, CrossIcon, HammerIcon } from "./chatIcons";
import styles from "./messages.module.css";

/**
 * Builds the chip's native tooltip: the tool's arguments, and the failure
 * reason when it has one. Values are stringified compactly — a chip tooltip
 * showing `{"platforms":["linkedin"]}` is more use than one showing nothing.
 */
function describeTool(tool: ToolCallView): string {
  const parts: string[] = [tool.toolName || "tool"];
  if (tool.toolArgs && Object.keys(tool.toolArgs).length > 0) {
    try {
      parts.push(JSON.stringify(tool.toolArgs));
    } catch {
      /* circular or otherwise unserializable args — omit rather than throw */
    }
  }
  if (tool.errorText) parts.push(tool.errorText);
  return parts.join(" · ");
}

export default function ToolChips({
  toolCalls,
  label,
}: {
  toolCalls: ToolCallView[];
  label: string;
}) {
  if (toolCalls.length === 0) return null;

  return (
    <div className={styles.extraGroup}>
      <div className={styles.extraIcon} title={label} aria-hidden="true">
        <HammerIcon />
      </div>
      <div className={styles.extraBody}>
        <span className={styles.extraLabel}>{label}</span>
        <div className={styles.toolChips}>
          {toolCalls.map((tool, index) => {
            const statusClass =
              tool.status === "done"
                ? styles.toolChipDone
                : tool.status === "error"
                  ? styles.toolChipError
                  : "";
            return (
              <span
                key={toolCallKey(tool, index)}
                className={`${styles.toolChip} ${statusClass}`.trim()}
                title={describeTool(tool)}
              >
                {tool.status === "running" && <span className={styles.toolDot} />}
                {tool.status === "done" && (
                  <span className={styles.toolGlyph}>
                    <CheckIcon />
                  </span>
                )}
                {tool.status === "error" && (
                  <span className={styles.toolGlyph}>
                    <CrossIcon />
                  </span>
                )}
                {tool.toolName}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
