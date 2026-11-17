import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import en from '../../../../messages/en.json';
import de from '../../../../messages/de.json';
import { ChatBar } from '../../../app/(dashboard)/assistant/panes/ChatBar';
import { ComposerControls } from '../../../app/(dashboard)/assistant/ComposerControls';
import { ProjectProposalCard } from '../../../app/(dashboard)/assistant/projects/ProjectProposalCard';
import { ChatPostsPane } from '../../../app/(dashboard)/assistant/panes/ChatPostsPane';
import { ProjectPane } from '../../../app/(dashboard)/assistant/panes/ProjectPane';
import { MediaPane } from '../../../app/(dashboard)/assistant/panes/MediaPane';
import { DocumentsPane } from '../../../app/(dashboard)/assistant/panes/DocumentsPane';
import Composer from '../../../app/(dashboard)/assistant/Composer';

/**
 * Compose v2's new parts, rendered with the real messages in both languages — #543. A missing string
 * or a crash on first render fails here rather than on production.
 */
const render = (locale: 'en' | 'de', element: ReactElement) => {
  const missing: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} onError={(e) => missing.push(e.message)} timeZone="Europe/Berlin">
      {element}
    </NextIntlClientProvider>,
  );
  return { html, missing };
};

const dictation = { supported: false, listening: false, lang: 'en-US' as const, setLang: () => {}, start: () => {}, stop: () => {} };

describe.each(['en', 'de'] as const)('in %s', (locale) => {
  it('renders the chat bar with every pane toggle named, and a dot for news', () => {
    const { html, missing } = render(locale, <ChatBar title="Autumn menu" project={{ id: 'p1', name: 'Café Luna' }} streaming open="posts" onToggle={() => {}} news={new Set(['post'])} />);
    expect(missing).toEqual([]);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    // #628: six panes — Documents joined the five.
    expect(html.match(/<button/g)?.length).toBe(6);
    expect(html).toContain('Café Luna');
  });

  it('renders the controls row', () => {
    const { html, missing } = render(
      locale,
      <ComposerControls
        disabled={false}
        canAttach
        onAddFiles={() => {}}
        onProjectFiles={() => {}}
        onMediaLibrary={() => {}}
        onSlash={() => {}}
        hasProject
        dictation={dictation}
        settings={{ mode: 'plan', effort: 'high' }}
        onSettingsChange={() => {}}
        models={[{ id: 'chorus:gemini-2.5-flash', label: 'Gemini 2.5 Flash', source: 'chorus', provider: 'google', modelId: 'gemini-2.5-flash' }]}
        defaultModelId="chorus:gemini-2.5-flash"
        meter={{ used: 12_000, limit: 120_000, measured: true, turnTokens: 12_000, steps: 2, credits: 3, creditsScope: 'conversation' }}
        month={{ used: 620, limit: 1000, plan: 'Pro' }}
      />,
    );
    expect(missing).toEqual([]);
    expect(html).toContain('Gemini 2.5 Flash');
    expect(html).toContain(locale === 'en' ? 'Plan' : 'Plan');
    expect(html).toContain(locale === 'en' ? 'Smarter' : 'Klüger');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('renders a project proposal with its decision', () => {
    const { html, missing } = render(
      locale,
      <ProjectProposalCard
        proposal={{ projectId: 'p1', sources: ['https://cafeluna.de'], proposal: { name: 'Café Luna', instructions: 'Warm.', avatar: { name: 'Luna', persona: 'short lines' }, design: { colors: ['#3B2416'], imageStyle: 'film' }, defaults: { channels: ['instagram'], cta: 'Book a table' } } }}
        onSaid={() => true}
      />,
    );
    expect(missing).toEqual([]);
    expect(html).toContain('#3B2416');
    expect(html).toContain(locale === 'en' ? 'Use this' : 'Übernehmen');
  });

  it('renders the panes before their data arrives', () => {
    for (const element of [
      <ChatPostsPane key="a" conversationId="c1" selectedPostId={null} references={[]} onOpen={() => {}} onAddToChat={() => {}} onClose={() => {}} />,
      <ProjectPane key="b" conversationId="c1" project={null} refreshKey="r" onProjectChange={() => {}} onAsk={() => {}} onNewProject={() => {}} onClose={() => {}} />,
      <ProjectPane key="c" conversationId="c1" project={{ id: 'p1', name: 'Café Luna' }} refreshKey="r" onProjectChange={() => {}} onAsk={() => {}} onNewProject={() => {}} onClose={() => {}} />,
      <DocumentsPane key="e" conversationId="c1" openArtifactId={null} onOpen={() => {}} onClose={() => {}} />,
      <MediaPane key="d" project={{ id: 'p1', name: 'Café Luna' }} references={[]} onAddToChat={() => {}} onClose={() => {}} />,
    ]) {
      const { html, missing } = render(locale, element);
      expect(missing).toEqual([]);
      expect(html).toContain('aria-label');
    }
  });

  it('renders the whole chat box with chips', () => {
    const attach = { attachments: [], addFiles: async () => {}, addRemote: async () => {}, remove: () => {}, clear: () => {}, uploading: false, readyPaths: [], canAddMore: true } as never;
    const { html, missing } = render(
      locale,
      <Composer
        attach={attach}
        disabled={false}
        onSend={() => true}
        month={{ used: 1, limit: 10 }}
        references={[{ kind: 'post', id: '9b2d1a4e-1111-4222-8333-944455556666', label: 'Team post' }]}
        onReferencesChange={() => {}}
        settings={{ mode: 'auto', effort: 'medium' }}
        onSettingsChange={() => {}}
        models={[]}
        defaultModelId={null}
        mentionSources={{ chatPosts: [], recentPosts: [], projectFiles: [] }}
        hasProject={false}
      />,
    );
    expect(missing).toEqual([]);
    expect(html).toContain('Team post');
  });

  it('shows a stop button instead of send while a turn runs, and says when it is stopping (#747)', () => {
    const attach = { attachments: [], addFiles: async () => {}, addRemote: async () => {}, remove: () => {}, clear: () => {}, uploading: false, readyPaths: [], canAddMore: true } as never;
    const box = (extra: { onStop?: () => void; stopping?: boolean }) =>
      render(
        locale,
        <Composer
          attach={attach}
          disabled
          onSend={() => true}
          month={{ used: 1, limit: 10 }}
          references={[]}
          onReferencesChange={() => {}}
          settings={{ mode: 'auto', effort: 'medium' }}
          onSettingsChange={() => {}}
          models={[]}
          defaultModelId={null}
          mentionSources={{ chatPosts: [], recentPosts: [], projectFiles: [] }}
          hasProject={false}
          {...extra}
        />,
      );
    const messages = (locale === 'en' ? en : de).assistant;
    const idle = box({});
    expect(idle.html).toContain(`aria-label="${messages.send}"`);
    expect(idle.html).not.toContain(`aria-label="${messages.stop}"`);

    const running = box({ onStop: () => {} });
    expect(running.missing).toEqual([]);
    expect(running.html).toMatch(new RegExp(`<button[^>]*aria-label="${messages.stop}"`));
    expect(running.html).not.toContain(`aria-label="${messages.send}"`);
    // Enabled while the composer itself is disabled — the whole point is to reach it mid-run.
    expect(running.html).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-label="${messages.stop}"`));

    const stopping = box({ onStop: () => {}, stopping: true });
    expect(stopping.html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-label="${messages.stopping}"`));
  });
});
