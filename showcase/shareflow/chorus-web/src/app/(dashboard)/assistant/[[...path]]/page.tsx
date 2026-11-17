import { redirect } from 'next/navigation';
import { conversationFromPath, pathForConversation } from '@/lib/assistant/retinueUrlState';

/**
 * `/assistant…` — renamed to Compose (#516). Every link already sent keeps working: the conversation in
 * the path and the whole query (`?post=`, `&schedule=1`, `?new=post`) are carried to `/compose`.
 */
export const dynamic = 'force-dynamic';

export default async function AssistantRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ path }, query] = await Promise.all([params, searchParams]);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, one);
  }
  const qs = search.toString();
  redirect(`${pathForConversation(conversationFromPath(path))}${qs === '' ? '' : `?${qs}`}`);
}
