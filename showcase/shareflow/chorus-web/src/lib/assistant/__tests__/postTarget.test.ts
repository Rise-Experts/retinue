import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_ITEMS } from '@/lib/routeMeta';
import { NEW_POST_HREF, composePostHref, conversationRedirect, postIdParam } from '../postTarget';
import { pathForConversation } from '../retinueUrlState';

/** One chat for posts — #500, named Compose and served at /compose since #516. */
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../..');
const POST = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONV = '9b2d1a4e-1111-4222-8333-944455556666';

describe('where "open this post" goes', () => {
  it('takes only a uuid as the post', () => {
    expect(postIdParam(POST.toUpperCase())).toBe(POST);
    expect(postIdParam([POST, 'x'])).toBe(POST);
    for (const bad of [undefined, '', '../etc', 'post-1']) expect(postIdParam(bad), String(bad)).toBeNull();
  });

  it('links every edit to Compose, carrying schedule', () => {
    expect(composePostHref(POST)).toBe(`/compose?post=${POST}`);
    expect(composePostHref(POST, { schedule: true })).toBe(`/compose?post=${POST}&schedule=1`);
    expect(NEW_POST_HREF).toBe('/compose?new=post');
  });

  it('reopens the conversation the post came from (AC-5), and a new one without it (AC-6)', () => {
    expect(conversationRedirect(POST, CONV)).toBe(`/compose/c/${CONV}?post=${POST}`);
    expect(conversationRedirect(POST, CONV, { schedule: true })).toBe(`/compose/c/${CONV}?post=${POST}&schedule=1`);
    expect(conversationRedirect(POST, null)).toBeNull();
    expect(conversationRedirect(POST, 'not-a-uuid')).toBeNull();
  });
});

describe('the resolver (AC-7)', () => {
  const page = readFileSync(resolve(src, 'app/(dashboard)/compose/[[...path]]/page.tsx'), 'utf8');

  it("reads the conversation from the post's own row, in the caller's workspace — never from the link", () => {
    expect(page).toMatch(/\.from\('posts'\)[\s\S]*\.select\('conversation_id'\)[\s\S]*\.eq\('id', postId\)[\s\S]*\.eq\('workspace_id', workspaceId\)/);
    expect(page).toContain('resolveWorkspaceId(supabase, user.id');
    expect(page).not.toMatch(/query\['conversation/);
  });

  it('opens the panel on the post either way', () => {
    expect(page).toMatch(/<RetinueChat\s+initialConversationId=\{conversationId\}\s+initialPostId=\{postId\}/);
  });
});

describe('Compose is the one chat (#516 AC-1, AC-2)', () => {
  it('has one chat entry in the sidebar, named Compose', () => {
    const ids = NAV_ITEMS.map((item) => item.id);
    expect(ids).toContain('compose');
    expect(ids).not.toContain('assistant');
    expect(NAV_ITEMS.find((item) => item.id === 'compose')?.label).toBe('Compose');
  });

  it('serves the chat at /compose and still reads the old ?editPostId= link as the post', () => {
    const page = readFileSync(resolve(src, 'app/(dashboard)/compose/[[...path]]/page.tsx'), 'utf8');
    expect(page).toContain("postIdParam(query['post']) ?? postIdParam(query['editPostId'])");
    expect(page).toContain("import RetinueChat from '../../assistant/RetinueChat'");
  });

  it('redirects every /assistant link to the same conversation and query under /compose', () => {
    const assistant = readFileSync(resolve(src, 'app/(dashboard)/assistant/[[...path]]/page.tsx'), 'utf8');
    expect(assistant).toContain('redirect(`${pathForConversation(conversationFromPath(path))}');
    expect(assistant).toContain('search.append(key, one)');
    expect(pathForConversation(CONV)).toBe(`/compose/c/${CONV}`);
    expect(pathForConversation(null)).toBe('/compose');
  });

  it('leaves no page link to /assistant outside its redirect', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules' || name === 'api' || path.endsWith('(dashboard)/assistant/[[...path]]')) continue;
          walk(path);
        } else if (/\.(tsx?|mjs)$/.test(name)) {
          const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (/['"`]\/assistant(?!\/api)/.test(code) && !/['"`]\/api\/assistant/.test(code.match(/['"`]\/assistant[^'"`]*/)?.[0] ?? '')) offenders.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
