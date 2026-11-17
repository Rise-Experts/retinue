/**
 * What kind of artifact a chat card points at — #607, so a deck shows as a deck before it is opened.
 *
 * Reads `/api/artifacts/[id]?meta=1` (no content) once per id per page: a thread can hold many cards for the
 * same artifact, and a kind never changes after creation, so the answer is cached for the page's life.
 * A failure reads as unknown and the card looks as it always did.
 */

"use client";

import { useEffect, useState } from "react";
import { isArtifactKind, type ArtifactKind } from "@/lib/assistant/artifactRef";

const known = new Map<string, ArtifactKind>();
const pending = new Map<string, Promise<ArtifactKind | null>>();

function fetchKind(id: string): Promise<ArtifactKind | null> {
  const inFlight = pending.get(id);
  if (inFlight) return inFlight;
  const request = fetch(`/api/artifacts/${id}?meta=1`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((json: { kind?: unknown } | null) => {
      const kind = json && isArtifactKind(json.kind) ? json.kind : null;
      if (kind) known.set(id, kind);
      return kind;
    })
    .catch(() => null)
    .finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}

export function useArtifactKind(id: string | null): ArtifactKind | null {
  const [fetched, setFetched] = useState<{ id: string; kind: ArtifactKind | null } | null>(null);
  // Read the cache during render, as useSignedMedia does — a hit needs no state write.
  const cached = id ? (known.get(id) ?? null) : null;

  useEffect(() => {
    if (!id || known.has(id)) return;
    let active = true;
    void fetchKind(id).then((kind) => {
      if (active) setFetched({ id, kind });
    });
    return () => {
      active = false;
    };
  }, [id]);

  return cached ?? (fetched && fetched.id === id ? fetched.kind : null);
}
