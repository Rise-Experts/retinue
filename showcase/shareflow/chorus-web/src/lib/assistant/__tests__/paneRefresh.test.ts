import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@retinue/react';
import { panesForResults, panesForTool, pendingMediaJobs } from '../paneRefresh';

const result = (id: string, toolName: string, output: unknown, ranToolName?: string): MessagePart =>
  ({
    id: `p-${id}`,
    type: 'tool-result',
    toolCallId: id,
    toolName,
    ...(ranToolName === undefined ? {} : { ranToolName }),
    output,
  }) as unknown as MessagePart;

describe('panesForTool', () => {
  it.each([
    ['draft_post_for_channels', ['post', 'posts']],
    ['create_post_draft', ['post', 'posts']],
    ['update_post_draft', ['post', 'posts']],
    ['revise_post_channels', ['post', 'posts']],
    ['generate_media', ['media']],
    ['import_stock_media', ['media']],
    ['render_diagram', ['media']],
    ['attach_media_to_post', ['media', 'post', 'posts']],
    ['create_artifact', ['documents']],
    ['update_artifact', ['documents']],
    ['generate_pdf', ['documents', 'media']],
    ['attach_artifact_to_post', ['documents', 'media', 'post', 'posts']],
    ['schedule_post', ['calendar', 'posts', 'post']],
    ['publish_post_now', ['calendar', 'posts', 'post']],
  ] as const)('%s → %j', (tool, panes) => {
    expect([...panesForTool(tool)].sort()).toEqual([...panes].sort());
  });

  it('a read-only tool changes no pane', () => {
    expect(panesForTool('search_web')).toEqual([]);
    expect(panesForTool('get_post_draft')).toEqual([]);
    expect(panesForTool('get_artifact')).toEqual([]);
  });
});

describe('panesForResults', () => {
  it('collects the panes of new successful results once', () => {
    const parts = [
      result('1', 'create_artifact', { id: 'a' }),
      result('2', 'generate_pdf', { reference: 'chorus-media:x.pdf' }),
      { id: 't', type: 'text', text: 'done' } as unknown as MessagePart,
    ];
    const first = panesForResults(parts, new Set());
    expect([...first.panes].sort()).toEqual(['documents', 'media']);
    expect(first.seen).toEqual(['1', '2']);
    // The same parts again, as every stream event re-delivers them: nothing new.
    expect(panesForResults(parts, new Set(first.seen)).panes).toEqual([]);
  });

  it('a failed result invalidates nothing but is still seen', () => {
    const outcome = panesForResults([result('3', 'create_post_draft', { ok: false, error: { message: 'no' } })], new Set());
    expect(outcome.panes).toEqual([]);
    expect(outcome.seen).toEqual(['3']);
  });

  it('reads the tool that ran through execute_tool', () => {
    const outcome = panesForResults([result('4', 'execute_tool', { postDraftId: 'x' }, 'schedule_post')], new Set());
    expect([...outcome.panes].sort()).toEqual(['calendar', 'post', 'posts']);
  });
});

describe('pendingMediaJobs', () => {
  it('a started job is pending until a check or the poll says it finished', () => {
    const started = [result('1', 'generate_media', { jobId: 'job-1', state: 'queued' })];
    expect(pendingMediaJobs(started, new Set())).toEqual(['job-1']);
    expect(pendingMediaJobs(started, new Set(['job-1']))).toEqual([]);
    const checked = [...started, result('2', 'check_media_job', { jobId: 'job-1', state: 'succeeded', assets: [] })];
    expect(pendingMediaJobs(checked, new Set())).toEqual([]);
  });

  it('a check that says running keeps it pending; a failed start is not a job', () => {
    const parts = [
      result('1', 'generate_media', { jobId: 'job-2', state: 'queued' }),
      result('2', 'check_media_job', { jobId: 'job-2', state: 'running', assets: [] }),
      result('3', 'generate_media', { ok: false, error: { message: 'no credits' } }),
    ];
    expect(pendingMediaJobs(parts, new Set())).toEqual(['job-2']);
  });
});
