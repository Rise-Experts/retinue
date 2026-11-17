"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createSaver, type Saver } from "@/lib/assistant/debouncedSaver";
import type { PlatformId } from "@/lib/platforms";
import type { MediaItem } from "../compose/mediaItem";
import { emptyDraft } from "../compose/sessionModel";
import { draftsFromPost, mediaFromPost, patchBodyFor, platformsOf, type Drafts, type LoadedPost } from "./postBoardModel";

/**
 * One saved post, on the board — #497.
 *
 * Compose held its board in the page and read the post id from the URL once (`useEditPostLoader`), so
 * it could not be pointed at the post a chat turn just wrote. This is the same board state, bound to
 * an id, with the post row as the only source of truth:
 *
 * - **Hand edits save themselves**, debounced, through `PATCH /api/posts/:id`. The agent reads the
 *   saved draft on its next turn, so what the person typed is what a chat revision starts from (AC-2).
 * - **A chat revision reloads the board.** `revision` counts the post tool results that changed this
 *   post; when it goes up the pending edit is saved first and then the post is read back, so neither
 *   side overwrites the other.
 * - `flush()` is for anything that must see the saved text — scheduling asks the agent, which reads
 *   the row.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_AFTER_MS = 800;

/**
 * Files chosen on the start screen (#517), waiting for the post the first turn writes. Added to that
 * post the first time it loads, then reported used — compose attached its uploads the same way.
 */
export type PendingMedia = {
  readonly items: readonly MediaItem[];
  readonly onApplied: () => void;
};

export function usePostDraft(postId: string | null, revision: number, pending?: PendingMedia) {
  const [post, setPost] = useState<LoadedPost | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [sel, setSel] = useState<Partial<Record<PlatformId, boolean>>>({});
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [sameEverywhere, setSameEverywhere] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  /** The board as of the latest render — what a debounced save sends, however long it waited. */
  const latest = useRef({ drafts, sel, media, presetId });
  useEffect(() => {
    latest.current = { drafts, sel, media, presetId };
  }, [drafts, sel, media, presetId]);

  /**
   * One PATCH of the board as it is now. True when stored; false keeps the edit pending for the next
   * try (`createSaver`). Nothing savable yet (an emptied card, no channel) counts as done: it is kept
   * on screen until there is something to store.
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (postId === null) return true;
    const board = latest.current;
    const selected = (Object.keys(board.sel) as PlatformId[]).filter((id) => board.sel[id]);
    const body = patchBodyFor({ drafts: board.drafts, selected, media: board.media, presetId: board.presetId });
    if (body === null) return true;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/posts/${postId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setSaveError(payload?.error ?? `Saving failed (${res.status})`);
        setSaveState("error");
        return false;
      }
      setSaveError(null);
      setSaveState("saved");
      return true;
    } catch {
      setSaveError("Saving failed — check your connection");
      setSaveState("error");
      return false;
    }
  }, [postId]);

  /**
   * The saver for this post, made in an effect: it closes over refs, which may not be read during
   * render. Replaced when the post changes, and the old one saves what it still holds first — so
   * unsaved text is stored when the panel closes or switches post, not dropped.
   */
  const saver = useRef<Saver | null>(null);
  useEffect(() => {
    const current = createSaver(saveNow, SAVE_AFTER_MS);
    saver.current = current;
    return () => {
      void current.flush();
      if (saver.current === current) saver.current = null;
    };
  }, [saveNow]);
  const flush = useCallback(async () => {
    await saver.current?.flush();
  }, []);
  const scheduleSave = useCallback(() => saver.current?.touch(), []);

  // Load, and reload when the chat changed the post: the pending edit is saved first.
  useEffect(() => {
    if (postId === null) return;
    let cancelled = false;
    void (async () => {
      await flush();
      try {
        const res = await fetch(`/api/posts/${postId}`, { cache: "no-store" });
        const payload = (await res.json().catch(() => null)) as (LoadedPost & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || payload === null) {
          setLoadError(payload?.error ?? "This post could not be opened");
          return;
        }
        setLoadError(null);
        setPost(payload);
        setDrafts(draftsFromPost(payload));
        setSel(Object.fromEntries(platformsOf(payload).map((id) => [id, true])));
        const stored = mediaFromPost(payload);
        const waiting = pendingRef.current;
        if (waiting !== undefined && waiting.items.length > 0) {
          const known = new Set(stored.map((m) => m.path));
          setMedia([...stored, ...waiting.items.filter((m) => !known.has(m.path))]);
          pendingRef.current = undefined;
          waiting.onApplied();
          // Saved like any edit, so the agent's next turn and the post itself both have the photos.
          saver.current?.touch();
        } else {
          setMedia(stored);
        }
        setPresetId(payload.textFormatPresetId ?? null);
      } catch {
        if (!cancelled) setLoadError("This post could not be opened — check your connection");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postId, revision, flush]);

  const selectedIds = (Object.keys(sel) as PlatformId[]).filter((id) => sel[id]);

  function changeText(id: PlatformId, text: string) {
    setDrafts((prev) => {
      if (!sameEverywhere) return { ...prev, [id]: { ...(prev[id] ?? emptyDraft()), text, justUpdated: false } };
      const next: Drafts = { ...prev };
      for (const pid of selectedIds) next[pid] = { ...(prev[pid] ?? emptyDraft()), text, justUpdated: false };
      return next;
    });
    scheduleSave();
  }

  function chooseSameEverywhere(on: boolean) {
    setSameEverywhere(on);
    if (!on) return;
    const first = selectedIds.map((id) => drafts[id]?.text.trim() ?? "").find((text) => text !== "");
    if (first === undefined) return;
    setDrafts((prev) => ({ ...prev, ...Object.fromEntries(selectedIds.map((id) => [id, { ...(prev[id] ?? emptyDraft()), text: first }])) }));
    scheduleSave();
  }

  /**
   * A channel switched on starts from the shared caption, so it is never an empty card that blocks
   * saving; switched off, it leaves the post's targets on the next save.
   */
  function toggle(id: PlatformId) {
    setSel((prev) => ({ ...prev, [id]: !prev[id] }));
    setDrafts((prev) => {
      if (prev[id]?.text) return prev;
      const shared = selectedIds.map((pid) => prev[pid]?.text ?? "").find((text) => text.trim() !== "") ?? "";
      return { ...prev, [id]: { ...emptyDraft(), text: shared } };
    });
    scheduleSave();
  }

  /** Media and background changes save like text does. */
  const updateMedia: React.Dispatch<React.SetStateAction<MediaItem[]>> = (action) => {
    setMedia(action);
    scheduleSave();
  };
  function choosePreset(id: string | null) {
    setPresetId(id);
    scheduleSave();
  }

  return {
    post,
    loadError,
    drafts,
    setDrafts,
    sel,
    selectedIds,
    media,
    setMedia: updateMedia,
    presetId,
    choosePreset,
    sameEverywhere,
    chooseSameEverywhere,
    changeText,
    toggle,
    saveState,
    saveError,
    flush,
    markChanged: scheduleSave,
  };
}
