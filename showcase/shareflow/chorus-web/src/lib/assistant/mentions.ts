/**
 * The `@` picker's items — #548: this chat's posts, the workspace's recent ones, and the project's files,
 * filtered by what was typed after `@`. Pure, so the matching is tested without an editor.
 */
import { platformMap, type PlatformId } from '@/lib/platforms';
import type { ChatPost } from '@/lib/assistant/retinueClient';
import type { ProjectAssetRow } from '@/lib/projects/client';
import type { TurnReference } from '@/lib/assistant/turnBlocks';

/** What the `@` picker can offer. */
export type MentionSources = {
  readonly chatPosts: readonly ChatPost[];
  readonly recentPosts: readonly ChatPost[];
  readonly projectFiles: readonly ProjectAssetRow[];
};

export type MentionScope = "all" | "posts" | "files";
export type MentionItem = TurnReference & { readonly group: "chat" | "recent" | "files"; readonly sub: string; readonly badge: string };

const firstLine = (caption: string) => caption.split("\n")[0]!.trim().slice(0, 60) || "—";
const badgeFor = (platforms: readonly string[]) => {
  const first = platforms[0];
  if (first === undefined) return "·";
  const name = platformMap[first as PlatformId]?.name ?? first;
  return platforms.length > 1 ? `${name.slice(0, 2)}+${platforms.length - 1}` : name.slice(0, 2);
};

export const mentionItems = (sources: MentionSources, query: string, scope: MentionScope): MentionItem[] => {
  const q = query.trim().toLowerCase();
  const match = (label: string) => q === "" || label.toLowerCase().includes(q);
  const seen = new Set<string>();
  const posts = (list: readonly ChatPost[], group: "chat" | "recent"): MentionItem[] =>
    list
      .filter((post) => !seen.has(post.id) && match(firstLine(post.caption)))
      .map((post) => {
        seen.add(post.id);
        return { kind: "post", id: post.id, label: firstLine(post.caption), group, sub: post.status, badge: badgeFor(post.platforms) } as MentionItem;
      });
  const chat = scope === "files" ? [] : posts(sources.chatPosts, "chat").slice(0, 8);
  const recent = scope === "files" ? [] : posts(sources.recentPosts, "recent").slice(0, 6);
  const files =
    scope === "posts"
      ? []
      : sources.projectFiles
          .filter((file) => file.kind !== "link" && match(file.label || file.kind))
          .slice(0, 8)
          .map((file) => ({ kind: "project_asset", id: file.id, label: file.label || file.kind, group: "files", sub: file.kind, badge: file.kind.slice(0, 2).toUpperCase() }) as MentionItem);
  return [...chat, ...recent, ...files];
};

/** `@word` just before the cursor — the query and where it starts. */
export const mentionAt = (textBefore: string): { query: string; length: number } | null => {
  const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(textBefore);
  return m === null ? null : { query: m[1] ?? "", length: (m[1] ?? "").length + 1 };
};

