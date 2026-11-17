/** "Edit with Chorus" — the message the panel sends — #607 part 5. */
import { describe, expect, it } from 'vitest';
import { EDIT_SELECTION_MAX, buildEditRequest, quoteSelection } from '../artifactEditRequest';

const ID = '550e8400-e29b-41d4-a716-446655440000';

describe('buildEditRequest', () => {
  it('names the artifact by reference and quotes the selection', () => {
    expect(buildEditRequest({ title: 'Q3 plan', artifactId: ID, selected: '  Launch in May ', instruction: ' make it June ' })).toBe(
      `In "Q3 plan" (chorus-artifact:${ID}), change: "Launch in May" — make it June`,
    );
  });

  it('asks nothing without a selection or an instruction', () => {
    expect(buildEditRequest({ title: 'T', artifactId: ID, selected: '   ', instruction: 'x' })).toBeNull();
    expect(buildEditRequest({ title: 'T', artifactId: ID, selected: 'x', instruction: '  ' })).toBeNull();
  });

  it('cuts a long selection', () => {
    const long = 'word '.repeat(400);
    const quoted = quoteSelection(long);
    expect(quoted.length).toBeLessThanOrEqual(EDIT_SELECTION_MAX + 1);
    expect(quoted.endsWith('…')).toBe(true);
  });

  it('falls back to a generic name for an untitled artifact', () => {
    expect(buildEditRequest({ title: ' ', artifactId: ID, selected: 'a', instruction: 'b' })).toContain('In "the document"');
  });
});
