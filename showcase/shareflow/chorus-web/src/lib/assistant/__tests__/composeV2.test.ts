import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReferences, splitBlocks, withBlocks } from '../turnBlocks';
import { DEFAULT_CONVERSATION_SETTINGS, parseConversationSettings } from '../conversationSettings';
import { mentionAt, mentionItems } from '../mentions';
import { meterBreakdown } from '../meterBreakdown';

/** Compose v2 — #543's pure pieces, and the wiring that has no other test. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, '../../../', p), 'utf8');
const WS = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const POST = '9b2d1a4e-1111-4222-8333-944455556666';

describe('blocks inside the message (#548, #549)', () => {
  it('is the exact format shareflow reads (turn-settings.test.ts holds the other half)', () => {
    expect(withBlocks('Shorter', [{ kind: 'post', id: POST, label: 'Team   post' }], [`${WS}/a.png`])).toBe(
      `Shorter\n\n[referenced]\nchorus:post/${POST} Team post\n[/referenced]\n\n[attached-media]\n${WS}/a.png\n[/attached-media]`,
    );
  });

  it('round-trips, so the bubble shows exactly what was written', () => {
    const message = withBlocks('Use this', [{ kind: 'project_asset', id: WS, label: 'Logo' }], [`${WS}/b.png`]);
    expect(splitBlocks(message)).toEqual({ text: 'Use this', references: [{ kind: 'project_asset', id: WS, label: 'Logo' }], attachments: [`${WS}/b.png`] });
    expect(splitBlocks('plain')).toEqual({ text: 'plain', references: [], attachments: [] });
  });

  it('keeps only well-formed references from a client, deduplicated and capped', () => {
    expect(
      parseReferences([
        { kind: 'post', id: POST, label: 'A' },
        { kind: 'post', id: POST, label: 'again' },
        { kind: 'user', id: POST },
        { kind: 'post', id: 'not-a-uuid' },
      ]),
    ).toEqual([{ kind: 'post', id: POST, label: 'A' }]);
  });
});

describe('a chat’s settings (#550, #551)', () => {
  it('falls back field by field, never refusing', () => {
    expect(parseConversationSettings({ mode: 'plan', effort: 'high', model: 'chorus:gemini-2.5-pro' })).toEqual({ mode: 'plan', effort: 'high', model: 'chorus:gemini-2.5-pro' });
    expect(parseConversationSettings({ mode: 'root', model: '../x' })).toEqual(DEFAULT_CONVERSATION_SETTINGS);
  });
});

describe('the @ picker (#548)', () => {
  const post = (id: string, caption: string) => ({ id, caption, status: 'DRAFT', platforms: ['linkedin'], mediaCount: 0, updatedAt: '', scheduledAt: null, projectId: null });
  const sources = {
    chatPosts: [post(POST, 'Team post\nbody')],
    recentPosts: [post(POST, 'Team post'), post(WS, 'Autumn menu')],
    projectFiles: [{ id: 'f1', kind: 'image', url: null, label: 'Logo', previewUrl: null }, { id: 'f2', kind: 'link', url: 'https://x', label: 'Brief', previewUrl: null }],
  };

  it('opens on @word before the cursor, and not inside an address', () => {
    expect(mentionAt('make @te')).toEqual({ query: 'te', length: 3 });
    expect(mentionAt('@')).toEqual({ query: '', length: 1 });
    expect(mentionAt('mail me@example')).toBeNull();
  });

  it('lists this chat’s posts first, never twice, then others, then files that can be attached', () => {
    expect(mentionItems(sources, '', 'all').map((i) => `${i.group}:${i.label}`)).toEqual(['chat:Team post', 'recent:Autumn menu', 'files:Logo']);
    expect(mentionItems(sources, 'autumn', 'all').map((i) => i.label)).toEqual(['Autumn menu']);
    expect(mentionItems(sources, '', 'files').map((i) => i.kind)).toEqual(['project_asset']);
  });
});

describe('the meter (#552)', () => {
  it('splits the context by source, the conversation being what the sections do not cover', () => {
    const parts = meterBreakdown({
      used: 12_000, limit: 120_000, measured: true, turnTokens: 12_000, steps: 1, credits: 0, creditsScope: 'turn',
      sections: { instructionsTokens: 3_000, sections: [{ providerId: 'shareflow.project', tokens: 800 }, { providerId: 'shareflow.brand', tokens: 400 }, { providerId: 'shareflow.turn', tokens: 300 }, { providerId: 'skill-catalogue', tokens: 500 }] },
    });
    expect(parts).toEqual([
      { key: 'chat', tokens: 7_000 },
      { key: 'instructions', tokens: 3_000 },
      { key: 'project', tokens: 800 },
      { key: 'posts', tokens: 300 },
      { key: 'brand', tokens: 400 },
      { key: 'skills', tokens: 500 },
    ]);
  });
});

describe('the wiring', () => {
  const chat = read('app/(dashboard)/assistant/RetinueChat.tsx');

  it('sends the files, references and settings with the turn, and clears them (#549 — they were dropped)', () => {
    expect(chat).toContain('attachments,\n            references: sentReferences,\n            settings: sentSettings,');
    expect(chat).toContain('attach.clear();\n      setReferences([]);');
    const route = read('app/api/assistant/agentkit/turns/route.ts');
    expect(route).toContain("p.startsWith(`${workspaceId}/`) && !p.includes('..')");
    expect(route).toContain(".eq('workspace_id', workspaceId).in('id', postIds)");
    expect(route).toContain('settings: parseConversationSettings(settings)');
  });

  it('files a chat under its project before its first turn starts, so the agent sees the project (#555)', () => {
    expect(chat).toContain('await linkFirst;\n          const { runId } = await client.sendMessage({');
  });

  it('sends the conversation with an approval, so "allow for this chat" works', () => {
    expect(chat).toContain('decision: map[decision],\n          // "Allow for this chat"');
    expect(read('lib/assistant/retinueClient.ts')).toContain('...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })');
  });

  it('never opens a pane by itself: news is a dot (#546 AC-2)', () => {
    expect(chat).toContain("return new Set<PaneId>(['post', 'posts']);");
    expect(chat).not.toMatch(/useEffect\([^]*?setPane\('post'\)[^]*?\[turns/);
    expect(read('app/(dashboard)/assistant/panes/ChatBar.tsx')).toContain('aria-pressed={open === pane}');
  });

  it('has no full-screen panel takeover left (#546)', () => {
    expect(read('app/(dashboard)/assistant/messages.module.css')).not.toMatch(/\.artifactPanel \{\s*position: fixed;\s*inset: 0/);
  });

  it('keeps the top bar to one line with no page title, search, language or theme (#544)', () => {
    const topbar = read('components/Topbar.tsx');
    expect(topbar).toContain('<div className={styles.slot} ref={setTopbarSlot} />');
    for (const gone of ['searchPlaceholder', 'LOCALES', 'themeToggle', '>MR<']) expect(topbar).not.toContain(gone);
    expect(read('components/Topbar.module.css')).toMatch(/\.topbar \{\s*height: 40px;/);
  });

  it('puts the credits ring and quick settings on the account row (#545)', () => {
    expect(read('components/Sidebar.tsx')).toContain('<AccountMenu collapsed={collapsed} />');
    const menu = read('components/AccountMenu.tsx');
    expect(menu).toContain('onMouseEnter={() => { cancelClose(); setOpen(true); }}');
    expect(menu).toContain('aria-haspopup="dialog"');
    expect(menu).toContain('if (event.key !== "Escape") return;');
  });

  it('shows every chat box control as a real, named button (#549)', () => {
    const controls = read('app/(dashboard)/assistant/ComposerControls.tsx');
    expect(controls).toContain('aria-label={label}');
    expect(controls).toContain('aria-haspopup="menu"');
    // #596: each settings section has its own route; `?tab=` still redirects for old links.
    expect(controls).toContain('href="/settings/apps"');
    expect(controls).toContain('href="/settings/providers"');
  });
});
