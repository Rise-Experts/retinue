/**
 * A line diff for the artifact panel's "Compare" view — #607 part 5.
 *
 * Longest common subsequence over lines, after trimming the common head and tail (a revision usually touches
 * a small middle of a long document, so the table is small). When the middle is still too big for a table in
 * a browser tab, the middle is shown as removed-then-added rather than freezing the panel: a coarse diff is
 * still a correct one.
 *
 * Pure, so it is tested (`__tests__/artifactDiff.test.ts`).
 */

export type DiffLine = { readonly type: 'same' | 'add' | 'del'; readonly text: string };

/** Above this many table cells the middle is not aligned line by line (≈ 2000 × 2000 lines). */
export const DIFF_CELL_LIMIT = 4_000_000;

const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n'));

/** The lines that turn `before` into `after`, in order. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let middle: DiffLine[];
  if (midA.length === 0 || midB.length === 0 || (midA.length + 1) * (midB.length + 1) > DIFF_CELL_LIMIT) {
    middle = [...midA.map((text): DiffLine => ({ type: 'del', text })), ...midB.map((text): DiffLine => ({ type: 'add', text }))];
  } else {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], in one flat typed array.
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: 'same', text: midA[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        middle.push({ type: 'del', text: midA[i] });
        i++;
      } else {
        middle.push({ type: 'add', text: midB[j] });
        j++;
      }
    }
    while (i < n) middle.push({ type: 'del', text: midA[i++] });
    while (j < m) middle.push({ type: 'add', text: midB[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** How many lines were added and removed — the Compare view's summary. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}
