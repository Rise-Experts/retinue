import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../../../../messages/en.json';
import de from '../../../../messages/de.json';

/** #518 — the composer no longer shows a turn's total as the context. Since #552 the meter is the ring in the chat box's row. */
const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(resolve(here, '../../../app/(dashboard)/assistant/ComposerControls.tsx'), 'utf8');
const chat = readFileSync(resolve(here, '../../../app/(dashboard)/assistant/RetinueChat.tsx'), 'utf8');

describe('the context meter', () => {
  it('draws the context bar only for a measured turn', () => {
    // An unmeasured turn (before per-call measurement) fills no ring and says it will be measured next time.
    expect(composer).toContain('meter !== undefined && meter.limit > 0 && meter.measured ? Math.min(1, meter.used / meter.limit) : 0');
    expect(composer).toContain('t("contextNone")');
  });

  it("shows the turn's tokens and steps beside it, and an old turn's figure only as a total", () => {
    expect(composer).toContain('t("turnTokens", { tokens: compactTokens(meter.turnTokens), steps: meter.steps })');
    expect(chat).toContain("measured: runContext.usage.contextMeasured === true");
  });

  it('has the words in both languages', () => {
    for (const locale of [en, de] as unknown as { assistant: { box: Record<string, string> } }[]) {
      expect(locale.assistant.box['turnTokens']).toContain('{steps, plural');
      expect(locale.assistant.box['contextNone']).toBeTruthy();
    }
  });
});
