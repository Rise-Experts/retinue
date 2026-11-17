/**
 * Generated image / video / audio artifacts attached to an assistant reply.
 * Port of immo's `Multimedia/Images`, `Multimedia/Videos`, `Multimedia/Audios`.
 *
 * DORMANT: the `chorus-assistant` agent's four tools (`generate_content`,
 * `create_draft`, `publish_now`, `schedule_post`) all return plain text dicts
 * — none produce an ImageArtifact/VideoArtifact/AudioArtifact — so AgentOS
 * never populates these fields for it. This renders nothing today; a
 * media-producing tool lights it up with no frontend change.
 *
 * `next/image` is deliberately not used: these URLs come from whatever host
 * the generating tool used, which cannot be enumerated in
 * `next.config` remotePatterns ahead of time.
 */

import type { AudioItem, ImageItem, VideoItem } from "@/lib/assistant/chatMessage";
import styles from "./messages.module.css";

export default function MediaBlocks({
  images,
  videos,
  audio,
  imageAlt,
}: {
  images?: ImageItem[];
  videos?: VideoItem[];
  audio?: AudioItem[];
  /** Fallback alt text for an image whose tool sent no prompt. */
  imageAlt: string;
}) {
  const hasMedia = Boolean(images?.length || videos?.length || audio?.length);
  if (!hasMedia) return null;

  return (
    <div className={styles.media}>
      {images?.map((image, index) => (
        <div key={`${image.url}-${index}`} className={styles.mediaItem}>
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary tool-supplied host, see file header */}
          <img
            className={styles.mediaImage}
            src={image.url}
            alt={image.revisedPrompt || imageAlt}
            loading="lazy"
          />
          {image.revisedPrompt && <p className={styles.mediaCaption}>{image.revisedPrompt}</p>}
        </div>
      ))}

      {videos?.map((video, index) => (
        <div key={`${video.url}-${index}`} className={styles.mediaItem}>
          <video className={styles.mediaVideo} src={video.url} controls preload="metadata" />
        </div>
      ))}

      {audio?.map((item, index) => {
        const src = item.url
          ? item.url
          : item.base64Audio
            ? `data:${item.mimeType || "audio/mpeg"};base64,${item.base64Audio}`
            : null;
        if (!src) return null;
        return (
          <div key={`${src.slice(0, 32)}-${index}`} className={styles.mediaItem}>
            <audio className={styles.mediaAudio} src={src} controls preload="metadata" />
          </div>
        );
      })}
    </div>
  );
}
