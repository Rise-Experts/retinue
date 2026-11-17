import { describe, expect, it } from 'vitest';
import {
  parseArtifactRef,
  formatArtifactRef,
  isArtifactRef,
  isArtifactKind,
  artifactFilename,
} from '../artifactRef';

const ID = '8f14e45f-ceea-467a-9d5e-1b2c3d4e5f60';

describe('parseArtifactRef', () => {
  it('parses a complete reference', () => {
    expect(parseArtifactRef(`chorus-artifact:${ID}`)).toBe(ID);
  });

  it('leaves other schemes alone', () => {
    expect(parseArtifactRef(`chorus:post/${ID}`)).toBeNull();
    expect(parseArtifactRef('chorus-media:ws/a.png')).toBeNull();
    expect(parseArtifactRef('https://example.com')).toBeNull();
    expect(parseArtifactRef(undefined)).toBeNull();
  });

  it('refuses a partially-streamed reference', () => {
    // Rendering a card from half an id would fetch an artifact that cannot exist.
    expect(parseArtifactRef('chorus-artifact:')).toBeNull();
    expect(parseArtifactRef('chorus-artifact:8f14e45')).toBeNull();
    expect(parseArtifactRef(`chorus-artifact:${ID}extra`)).toBeNull();
  });

  it('normalises case so one artifact has one identity', () => {
    expect(parseArtifactRef(`chorus-artifact:${ID.toUpperCase()}`)).toBe(ID);
  });
});

describe('isArtifactRef', () => {
  it('is true for an incomplete reference, unlike parse', () => {
    // The renderer needs the distinction: an artifact-scheme link with a bad id
    // renders as text, a non-artifact link renders as a normal anchor.
    expect(isArtifactRef('chorus-artifact:nope')).toBe(true);
    expect(parseArtifactRef('chorus-artifact:nope')).toBeNull();
  });
});

describe('formatArtifactRef', () => {
  it('round-trips', () => {
    expect(parseArtifactRef(formatArtifactRef(ID)!)).toBe(ID);
  });

  it('refuses a non-uuid rather than emitting an unresolvable reference', () => {
    expect(formatArtifactRef('artifact-1')).toBeNull();
    expect(formatArtifactRef('')).toBeNull();
  });
});

describe('isArtifactKind', () => {
  it('accepts only the kinds the database allows', () => {
    // Must stay in step with the check constraint, or an insert fails at runtime.
    expect(isArtifactKind('markdown')).toBe(true);
    expect(isArtifactKind('html')).toBe(true);
    expect(isArtifactKind('mermaid')).toBe(true);
    expect(isArtifactKind('jsx')).toBe(false);
    expect(isArtifactKind(undefined)).toBe(false);
  });
});

describe('artifactFilename', () => {
  it('derives a readable name with the right extension', () => {
    expect(artifactFilename('Q3 launch plan', 'markdown')).toBe('Q3-launch-plan.md');
    expect(artifactFilename('Landing page', 'html')).toBe('Landing-page.html');
    expect(artifactFilename('Flow', 'mermaid')).toBe('Flow.mmd');
  });

  /**
   * A title is model-generated text and this string reaches a
   * Content-Disposition header and a filesystem — so path separators, quotes and
   * newlines must not survive.
   */
  it('strips anything dangerous in a filename', () => {
    expect(artifactFilename('../../etc/passwd', 'markdown')).toBe('etcpasswd.md');
    // The quote is removed and the newline becomes a hyphen (it is whitespace),
    // which is the desired outcome: neither character survives into the header.
    expect(artifactFilename('a"b\nc', 'markdown')).toBe('ab-c.md');
    expect(artifactFilename('/', 'markdown')).toBe('artifact.md');
  });

  it('falls back for an empty or symbol-only title', () => {
    expect(artifactFilename('', 'markdown')).toBe('artifact.md');
    expect(artifactFilename('!!!', 'html')).toBe('artifact.html');
  });

  it('caps the length', () => {
    expect(artifactFilename('x'.repeat(200), 'markdown').length).toBeLessThanOrEqual(64);
  });
});
