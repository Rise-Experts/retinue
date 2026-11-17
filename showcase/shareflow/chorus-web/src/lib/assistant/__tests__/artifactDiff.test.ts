/** The Compare view's line diff — #607 part 5. */
import { describe, expect, it } from 'vitest';
import { DIFF_CELL_LIMIT, diffLines, diffStats } from '../artifactDiff';

const apply = (lines: ReturnType<typeof diffLines>, side: 'before' | 'after') =>
  lines.filter((l) => l.type === 'same' || l.type === (side === 'before' ? 'del' : 'add')).map((l) => l.text).join('\n');

describe('diffLines', () => {
  it('reports nothing changed for equal text', () => {
    const lines = diffLines('a\nb', 'a\nb');
    expect(lines.every((l) => l.type === 'same')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('finds a changed line in the middle', () => {
    expect(diffLines('# Plan\nold line\nend', '# Plan\nnew line\nend')).toEqual([
      { type: 'same', text: '# Plan' },
      { type: 'del', text: 'old line' },
      { type: 'add', text: 'new line' },
      { type: 'same', text: 'end' },
    ]);
  });

  it('aligns an insertion and a deletion around unchanged lines', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nc\nd\ne');
    expect(lines).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
      { type: 'same', text: 'd' },
      { type: 'add', text: 'e' },
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('handles empty sides and CRLF', () => {
    expect(diffLines('', 'x\ny')).toEqual([{ type: 'add', text: 'x' }, { type: 'add', text: 'y' }]);
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }]);
    expect(diffLines('a\r\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true);
  });

  it('always reconstructs both sides', () => {
    const cases: [string, string][] = [
      ['1\n2\n3\n4\n5\n6', '0\n2\n3\n7\n5\n6\n8'],
      ['x\nx\nx\ny', 'y\nx\nx'],
      ['same', 'same\nmore'],
    ];
    for (const [a, b] of cases) {
      const lines = diffLines(a, b);
      expect(apply(lines, 'before')).toBe(a);
      expect(apply(lines, 'after')).toBe(b);
    }
  });

  it('falls back to remove-then-add for a middle too big to align, still correct', () => {
    const side = Math.ceil(Math.sqrt(DIFF_CELL_LIMIT)) + 1;
    const a = Array.from({ length: side }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: side }, (_, i) => `b${i}`).join('\n');
    const lines = diffLines(a, b);
    expect(diffStats(lines)).toEqual({ added: side, removed: side });
    expect(apply(lines, 'before')).toBe(a);
    expect(apply(lines, 'after')).toBe(b);
  });
});
