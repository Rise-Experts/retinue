/** The react and svg kinds — #607 part 3. */
import { describe, expect, it } from 'vitest';
import { ARTIFACT_KINDS, artifactFilename, isArtifactKind } from '../artifactRef';

describe('the react and svg kinds', () => {
  it('are artifact kinds, downloaded with their own extension', () => {
    expect(ARTIFACT_KINDS).toEqual(['markdown', 'html', 'mermaid', 'slides', 'react', 'svg']);
    expect(isArtifactKind('react')).toBe(true);
    expect(isArtifactKind('svg')).toBe(true);
    expect(artifactFilename('Price calculator', 'react')).toBe('Price-calculator.jsx');
    expect(artifactFilename('Logo', 'svg')).toBe('Logo.svg');
  });
});
