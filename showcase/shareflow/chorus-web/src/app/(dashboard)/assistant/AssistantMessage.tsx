/**
 * An assistant turn. Port of immo's `AgentMessage` plus the extras stack in
 * its `AgentMessageWrapper`: reasoning group, references group, tool-call
 * group, then the reply text, then media.
 *
 * Three of those groups are dormant on Chorus today — see the header of each
 * component for why — so in practice this renders the tool chips and the text.
 */

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { extractMessageMedia } from "@/lib/assistant/messageMedia";
import type { AssistantChatMessage } from "@/lib/assistant/chatMessage";
import { formatClockTime } from "@/lib/assistant/chatMessage";
import { AgentAvatar } from "./Avatar";
import CopyButton from "./CopyButton";
import Markdown from "./Markdown";
import MediaModal from "./MediaModal";
import MessageGallery from "./MessageGallery";
import MediaBlocks from "./MediaBlocks";
import ReasoningSteps from "./ReasoningSteps";
import ReferenceCards from "./ReferenceCards";
import ThinkingLoader from "./ThinkingLoader";
import ToolChips from "./ToolChips";
import { ProjectProposalCard, proposalOf } from "./projects/ProjectProposalCard";
import styles from "./messages.module.css";

export default function AssistantMessage({
  message,
  isStreaming,
  retrying = false,
  onAttach,
  onOpenArtifact,
  onOpenPost,
  onSay,
}: {
  message: AssistantChatMessage;
  /** #555: a card's button answering in the chat ("Use this" on a project proposal). */
  onSay?: ((text: string) => boolean) | null;
  /** Offers an attach button on this reply's images and links. */
  onAttach?: (item: { url: string; label: string }) => void;
  /** Opens an artifact in the side panel. */
  onOpenArtifact?: ((artifactId: string) => void) | null;
  onOpenPost?: ((postId: string) => void) | null;
  /**
   * True while this message is the live target of an open stream. Drives the
   * thinking loader: an empty message with no stream behind it (a run that
   * produced nothing) should not spin forever.
   */
  isStreaming: boolean;
  /**
   * #651: the run hit the provider's per-minute limit and will try again by itself. Said, because a loader
   * that just keeps spinning for up to a minute reads as stuck.
   */
  retrying?: boolean;
}) {
  const t = useTranslations("assistant");
  const locale = useLocale();
  const time = formatClockTime(message.createdAt, locale);
  const [viewing, setViewing] = useState<{ url: string; label: string } | null>(null);

  // Recomputed only when the text changes, not on every streamed token's
  // re-render of the surrounding list.
  const media = useMemo(() => extractMessageMedia(message.text), [message.text]);

  const hasText = message.text.trim().length > 0;
  const hasExtras = Boolean(
    message.reasoningSteps?.length || message.references?.length || message.toolCalls?.length,
  );
  // While a tool runs, its chip is the progress indicator — showing the dots
  // as well would claim two things are happening at once.
  const showLoader = !retrying && !hasText && !message.streamingError && isStreaming && !hasExtras;

  return (
    <div className={styles.row}>
      <AgentAvatar />
      <div className={styles.body}>
        {hasExtras && (
          <div className={styles.extras}>
            {message.reasoningSteps && message.reasoningSteps.length > 0 && (
              <ReasoningSteps
                steps={message.reasoningSteps}
                label={t("reasoning")}
                stepLabel={t("reasoningStep")}
              />
            )}
            {message.references && message.references.length > 0 && (
              <ReferenceCards groups={message.references} label={t("references")} />
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ToolChips toolCalls={message.toolCalls} label={t("toolCalls")} />
            )}
          </div>
        )}

        {/* #555: a project proposal is a card with one decision, not a chip. */}
        {(message.toolCalls ?? [])
          .filter((call) => call.toolName === "propose_project_setup" && call.status === "done")
          .map((call) => {
            const proposal = proposalOf(call.output);
            return proposal === null ? null : <ProjectProposalCard key={call.toolCallId} proposal={proposal} onSaid={(text) => onSay?.(text) ?? false} />;
          })}

        {(hasText || showLoader || retrying || message.streamingError || message.pausedNotice) && (
          <div className={styles.content}>
            {hasText && (
              <div className={styles.bubbleAgent}>
                <Markdown onAttach={onAttach ?? null} onOpenMedia={setViewing} onOpenArtifact={onOpenArtifact ?? null} onOpenPost={onOpenPost ?? null} allowPostCards>
                  {message.text}
                </Markdown>
              </div>
            )}
            {showLoader && <ThinkingLoader label={t("thinking")} />}
            {retrying && <ThinkingLoader label={t("retrying")} />}
            {message.streamingError && (
              <p className={styles.errorText}>{message.streamingError}</p>
            )}
            {message.pausedNotice && <p className={styles.pausedNotice}>{t("needsConfirm")}</p>}
            {hasText && <CopyButton text={message.text} />}
          </div>
        )}

        {media.length > 0 && (
          <MessageGallery items={media} onAttach={onAttach} onOpen={setViewing} />
        )}

        <MediaBlocks
          images={message.images}
          videos={message.videos}
          audio={message.audio}
          imageAlt={t("generatedImage")}
        />

        {time && <span className={styles.meta}>{time}</span>}
      </div>

      {viewing && (
        <MediaModal url={viewing.url} label={viewing.label} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
