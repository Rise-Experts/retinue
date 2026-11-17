"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useApp } from "@/lib/store";
import { MEDIA_MAX_FILES } from "@/lib/media";
import { PLATFORMS, platformMap, type PlatformId } from "@/lib/platforms";
import { usePlatformLimits } from "@/lib/data/usePlatformLimits";
import { fmtDate } from "@/lib/format";
import { FB_BACKGROUND_MAX_CHARS, backgroundCharCount, isOverBackgroundLimit } from "@/lib/facebook-text-format";
import { ChannelBoard, boardStatuses } from "../compose/ChannelBoard";
import { MediaAttachments } from "../compose/MediaAttachments";
import { BackgroundPicker } from "../compose/BackgroundPicker";
import { ComposeMediaModals } from "../compose/ComposeMediaModals";
import { useComposeMedia } from "../compose/useComposeMedia";
import { useChannelGeneration } from "../compose/useChannelGeneration";
import { blocksPublish, emptyDraft, outcomesFor, scheduleCaptions, timeHasPassed } from "../compose/sessionModel";
import type { MediaItem } from "../compose/mediaItem";
import { scheduleRequest, withWriting, withWritten, type Drafts } from "./postBoardModel";
import { QUICK_CHANGES, promptValues } from "@/lib/assistant/slashCommands";
import { usePostDraft, type PendingMedia } from "./usePostDraft";
import styles from "./messages.module.css";

/**
 * The post, beside the chat — #497.
 *
 * Compose's channel board, bound to the post draft a turn wrote (or the one a `chorus:post/` chip
 * names). The cards, limits, Same everywhere, 3 options, Facebook backgrounds and the media strip are
 * compose's own components; what is new is where the state comes from (`usePostDraft`: the saved post)
 * and where "Schedule" goes — to the agent, as a message, so the gated `schedule_post` puts the same
 * approval card in the thread that asking in words would.
 */
export function PostPanel({
  postId,
  revision,
  writing,
  written = {},
  canSend,
  onSend,
  onClose,
  pendingMedia,
  onAddToChat,
}: {
  /** Null while a new draft is still being written: the panel shows the channels being written. */
  postId: string | null;
  /** Bumped by every tool result that changed this post — the panel reloads the saved draft. */
  revision: number;
  /** Channels a running caption tool is writing right now. */
  writing: readonly string[] | "all";
  /** #497 AC-1: of those, the ones already finished — caption, or null when it could not be written. */
  written?: Readonly<Record<string, string | null>>;
  /** False while a turn is running or waiting on an approval: the agent cannot take a request. */
  canSend: boolean;
  onSend: (text: string) => boolean;
  onClose: () => void;
  /** #517: photos from the start screen, added to the post this panel opens on. */
  pendingMedia?: PendingMedia;
  /** #548: put this post in the chat box as a chip, so the next message is about it. */
  onAddToChat?: ((label: string) => void) | undefined;
}) {
  const t = useTranslations("assistant");
  const tc = useTranslations("Compose");
  const { connected, context, scheduledItems, refreshContext, showToast } = useApp();
  const board = usePostDraft(postId, revision, pendingMedia);
  const limits = usePlatformLimits(context?.workspace.id);

  const [when, setWhen] = useState<"schedule" | "now">("schedule");
  const [format, setFormat] = useState<"post" | "story">("post");
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [time, setTime] = useState("18:30");
  const [askError, setAskError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [altText, setAltText] = useState<Record<string, string>>({});
  const [mediaJobId, setMediaJobId] = useState<string | null>(null);
  const [editingImage, setEditingImage] = useState<MediaItem | null>(null);
  const [trimmingVideo, setTrimmingVideo] = useState<MediaItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const mediaRef = useRef<MediaItem[]>(board.media);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    mediaRef.current = board.media;
  }, [board.media]);

  // Before the post exists, the cards are the channels being written.
  const writingIds = writing === "all" ? [] : writing.filter((id): id is PlatformId => id in platformMap);
  const channelIds: PlatformId[] = postId === null ? writingIds : board.selectedIds;
  const sel = Object.fromEntries(channelIds.map((id) => [id, true])) as Record<PlatformId, boolean>;
  const selected = PLATFORMS.filter((p) => sel[p.id] && connected[p.id]);
  const selectedIds = selected.map((p) => p.id);
  const drafts: Drafts =
    postId === null ? withWritten(withWriting({}, selectedIds, writing), written) : withWriting(board.drafts, selectedIds, writing);
  const statuses = boardStatuses(selected, drafts, limits, board.media);
  const { caption } = scheduleCaptions(drafts, selectedIds);
  const facebookText = drafts.facebook?.text.trim() || caption;
  const creditsExhausted = context != null && (context.workspace.aiCreditsUsed ?? 0) >= (context.workspace.aiCreditsLimit ?? 0);

  /** Text from outside a card (an image described by vision) goes on every selected card. */
  const setEveryCaption = (text: string) => {
    board.setDrafts((prev) => ({ ...prev, ...Object.fromEntries(selectedIds.map((id) => [id, { ...(prev[id] ?? emptyDraft()), text }])) }));
    board.markChanged();
  };

  const { visionBusy, handleFilesSelected, removeMedia, runVision } = useComposeMedia({
    media: board.media, setMedia: board.setMedia, setAltText, setCaption: setEveryCaption, setStep: () => {}, setMediaJobId,
    prompt: caption, caption, genMediaKind: "image", mountedRef, mediaRef, context, showToast, t: tc,
  });

  const options = useChannelGeneration({
    selected: selectedIds, drafts: board.drafts, setDrafts: board.setDrafts, tone: "informative", creditsExhausted, refreshContext, mountedRef, t: tc,
  });
  // The options hook reports into compose's chat; here its newest line shows under the board.
  const optionsNote = options.messages.at(-1);

  const outcomes = postId === null ? [] : outcomesFor(scheduledItems.filter((i) => i.postId === postId).map((i) => i.id), scheduledItems);
  /**
   * Once the approved request has put the post in the queue, the board shows each destination's live
   * outcome (#481's view) instead of the editor. Keyed on the queue rather than `editable`: a scheduled
   * post stays editable until something has actually gone out.
   */
  const scheduledView =
    board.post !== null && outcomes.length > 0 ? { outcomes, whenLabel: fmtDate(outcomes[0]!.at), now: false } : null;

  const blockedNames = statuses.filter((s) => blocksPublish(s.status)).map((s) => platformMap[s.platformId]?.name ?? s.platformId);

  /**
   * "Schedule" / "Post now": save, then ask the agent — AC-3.
   *
   * Nothing is sent to a network here. The message reaches `schedule_post` or `publish_post_now`,
   * both gated, so the approval card appears in the thread and nothing goes out before it is approved.
   */
  async function requestPublish() {
    if (postId === null || asking) return;
    setAskError(null);
    if (!canSend) {
      setAskError(t("postPanel.busy"));
      return;
    }
    if (blockedNames.length > 0) {
      setAskError(tc("session.approval.blocked", { channels: blockedNames.join(", ") }));
      return;
    }
    // #500 parity: compose refused these two before publishing, and the panel had lost both.
    if (board.media.some((m) => m.uploading)) {
      setAskError(t("postPanel.mediaUploading"));
      return;
    }
    const background = board.media.length > 0 ? null : board.presetId;
    if (background !== null && selectedIds.includes("facebook") && isOverBackgroundLimit(facebookText)) {
      setAskError(t("postPanel.backgroundTooLong", { limit: FB_BACKGROUND_MAX_CHARS, count: backgroundCharCount(facebookText) }));
      return;
    }
    if (when === "schedule" && timeHasPassed(date, time)) {
      setAskError(tc("session.approval.pastTime", { when: `${fmtDate(date)}, ${time}` }));
      return;
    }
    setAsking(true);
    try {
      await board.flush();
      const sent = onSend(
        scheduleRequest({
          postId,
          channels: selected.map((p) => p.name),
          when,
          date,
          time,
          format,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
      if (!sent) setAskError(t("postPanel.busy"));
    } finally {
      setAsking(false);
    }
  }

  /**
   * A quick change — the same prompt as its slash command (#498 AC-3), read from the same catalogue
   * entry, so the chip and `/shorter` can never drift. Saved first, like Schedule, so the agent revises
   * what is on screen.
   */
  async function quickChange(key: (typeof QUICK_CHANGES)[number]) {
    if (postId === null) return;
    setAskError(null);
    if (!canSend) {
      setAskError(t("postPanel.busy"));
      return;
    }
    await board.flush();
    const prompt = t(`slash.${key}.prompt`, promptValues({ postId, channels: [], noPost: t("slashNoPost"), noChannels: t("slashNoChannels") }));
    if (!onSend(prompt)) setAskError(t("postPanel.busy"));
  }

  const saveLabel =
    board.saveState === "saving" ? t("postPanel.saving") : board.saveState === "saved" ? t("postPanel.saved") : board.saveState === "error" ? t("postPanel.saveFailed") : "";

  return (
    <aside className={`${styles.artifactPanel} ${styles.postPanel}`} aria-label={t("postPanel.label")}>
      <header className={styles.artifactHead}>
        <div className={styles.artifactHeadMain}>
          <span className={styles.artifactTitle}>{postId === null ? t("postPanel.writing") : t("postPanel.title")}</span>
          <span className={styles.artifactMeta} role="status">
            {saveLabel}
            {board.saveError !== null && board.saveState === "error" ? ` — ${board.saveError}` : ""}
          </span>
        </div>
        {postId !== null && onAddToChat !== undefined && (
          <button
            type="button"
            className={styles.artifactAction}
            onClick={() => {
              const first = Object.values(board.drafts).find((draft) => draft !== undefined && draft.text.trim() !== "")?.text ?? "";
              onAddToChat(first.split("\n")[0]!.trim().slice(0, 60) || t("postPanel.title"));
            }}
          >
            {t("panes.addToChat")}
          </button>
        )}
        {postId !== null && (
          <Link className={styles.artifactAction} href={`/posts/${postId}`}>
            {t("postPanel.openPost")}
          </Link>
        )}
        <button type="button" className={styles.artifactClose} onClick={onClose} aria-label={t("close")}>
          ×
        </button>
      </header>

      {postId !== null && board.post !== null && scheduledView === null && (
        <div className={styles.postQuick} role="group" aria-label={t("quickChanges")}>
          {QUICK_CHANGES.map((key) => (
            <button key={key} type="button" className={styles.artifactAction} disabled={!canSend} onClick={() => void quickChange(key)}>
              {t(`slash.${key}.label`)}
            </button>
          ))}
        </div>
      )}

      <div className={styles.postPanelBody}>
        {board.loadError !== null ? (
          <p className={styles.errorText}>{board.loadError}</p>
        ) : postId !== null && board.post === null ? (
          <p className={styles.artifactMeta}>{t("postPanel.loading")}</p>
        ) : (
          <ChannelBoard
            connected={connected}
            sel={sel}
            onToggle={board.toggle}
            selected={selected}
            drafts={drafts}
            statuses={statuses}
            onTextChange={board.changeText}
            sameEverywhere={board.sameEverywhere}
            onSameEverywhereChange={board.chooseSameEverywhere}
            lockSameEverywhere={postId === null}
            media={board.media}
            textFormatPresetId={board.media.length > 0 ? null : board.presetId}
            mediaSlot={
              postId === null ? null : (
                <MediaAttachments
                  media={board.media}
                  altText={altText}
                  visionBusy={visionBusy}
                  fileInputRef={fileInputRef}
                  workspaceReady={Boolean(context?.workspace.id)}
                  captionForGeneration={caption}
                  mediaJobId={mediaJobId}
                  onFilesSelected={(files) => void handleFilesSelected(files)}
                  onRemove={removeMedia}
                  onReorder={(from, to) =>
                    board.setMedia((prev) => {
                      const next = [...prev];
                      [next[to], next[from]] = [next[from]!, next[to]!];
                      return next;
                    })
                  }
                  onEditImage={setEditingImage}
                  onTrimVideo={setTrimmingVideo}
                  onRunVision={(item, kind) => void runVision(item, kind)}
                  onAltTextChange={(path, value) => setAltText((prev) => ({ ...prev, [path]: value }))}
                  onPickGenerated={({ path, url, isVideo }) =>
                    board.setMedia((prev) =>
                      prev.length >= MEDIA_MAX_FILES || prev.some((m) => m.path === path)
                        ? prev
                        : [...prev, { path, previewUrl: url, uploading: false, isVideo, ext: isVideo ? "MP4" : "IMG" }],
                    )
                  }
                />
              )
            }
            backgroundSlot={
              postId === null ? null : (
                <BackgroundPicker
                  selectedId={board.presetId}
                  text={facebookText}
                  facebookSelected={selected.some((p) => p.id === "facebook")}
                  mediaCount={board.media.length}
                  onSelect={board.choosePreset}
                />
              )
            }
            when={when}
            date={date}
            time={time}
            format={format}
            onWhenChange={setWhen}
            onDateChange={setDate}
            onTimeChange={setTime}
            onFormatChange={setFormat}
            publishing={asking}
            publishError={askError}
            onPublish={() => void requestPublish()}
            editing={false}
            onSaveDraft={null}
            savingDraft={false}
            scheduled={scheduledView}
            onNewPost={onClose}
            options={options.options}
            optionsBusy={options.busy || creditsExhausted || postId === null}
            onAskOptions={(id) => void options.askOptions(id)}
            onPickOption={(id, option) => {
              options.pickOption(id, option);
              board.markChanged();
            }}
          />
        )}
        {optionsNote !== undefined && (optionsNote.text || optionsNote.streamingError) && (
          <p className={optionsNote.streamingError ? styles.errorText : styles.artifactMeta} role="status">
            {optionsNote.streamingError || optionsNote.text}
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          void handleFilesSelected(e.target.files);
          e.target.value = "";
        }}
      />
      <ComposeMediaModals
        editingImage={editingImage}
        setEditingImage={setEditingImage}
        trimmingVideo={trimmingVideo}
        setTrimmingVideo={(item) => setTrimmingVideo(item)}
        setMedia={board.setMedia}
        context={context}
        showToast={showToast}
        t={tc}
      />
    </aside>
  );
}
