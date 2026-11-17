"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

/**
 * The channels a running `draft_post_for_channels` has finished — #497 AC-1.
 *
 * The tool writes every channel in parallel and saves the draft only when all are done, so without this the
 * panel filled every card at the same moment, however long the slowest took. The tool now records each
 * channel's caption on the turn's `assistant_turn_steps` row as it finishes; this reads that row about once a
 * second while the post is being written (members can read it under RLS). A caption of null means the
 * channel could not be written.
 */
export type WrittenChannels = Readonly<Record<string, string | null>>;

const EMPTY: WrittenChannels = {};
export const WRITTEN_POLL_MS = 1_000;

/** The row's `writing` column, read defensively. Pure, for tests. */
export const writtenChannelsOf = (writing: unknown): WrittenChannels => {
  if (writing === null || typeof writing !== "object") return EMPTY;
  const channels = (writing as { channels?: unknown }).channels;
  if (channels === null || typeof channels !== "object") return EMPTY;
  const out: Record<string, string | null> = {};
  for (const [id, caption] of Object.entries(channels as Record<string, unknown>)) {
    if (typeof caption === "string") out[id] = caption;
    else if (caption === null) out[id] = null;
  }
  return out;
};

export function useWrittenChannels(runId: string | undefined, active: boolean): WrittenChannels {
  const [written, setWritten] = useState<{ readonly runId: string; readonly channels: WrittenChannels } | null>(null);

  useEffect(() => {
    if (!active || runId === undefined) return;
    let stopped = false;
    const supabase = createClient();
    const read = async () => {
      const { data } = await supabase.from("assistant_turn_steps").select("writing").eq("run_id", runId).maybeSingle();
      if (!stopped) setWritten({ runId, channels: writtenChannelsOf((data as { writing?: unknown } | null)?.writing) });
    };
    void read();
    const timer = setInterval(() => void read().catch(() => undefined), WRITTEN_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, active]);

  // Another run's captions are never shown, even for the moment before the first read of this one lands.
  return active && written !== null && written.runId === runId ? written.channels : EMPTY;
}
