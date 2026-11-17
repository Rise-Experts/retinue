/**
 * Message avatars.
 *
 * immo has three (`AgentAvatar`, `UserAvatar`, `UserAvatarById`); the third
 * fetches a profile picture because immo supports shared multi-user chat
 * sessions. Chorus assistant chats are single-user, so there is no per-message
 * identity to resolve — the signed-in user's initials suffice.
 */

import { LogoIcon } from "@/components/icons";
import styles from "./messages.module.css";

export function AgentAvatar() {
  return (
    <div className={`${styles.avatar} ${styles.avatarAgent}`} aria-hidden="true">
      <LogoIcon />
    </div>
  );
}

/**
 * Derives up to two initials from a display name, falling back to a neutral
 * glyph when the name is missing or has no letters (the profile may not have
 * loaded yet, and an empty circle reads as broken).
 */
export function userInitials(name: string | null | undefined): string {
  const parts = (name ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return letters || "·";
}

export function UserAvatar({ name }: { name?: string | null }) {
  return (
    <div className={`${styles.avatar} ${styles.avatarUser}`} aria-hidden="true">
      {userInitials(name)}
    </div>
  );
}
