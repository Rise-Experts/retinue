import { describe, expect, it } from 'vitest';

import { nearCondense } from '../meterBreakdown';

describe('nearCondense (#657)', () => {
  it('is true from three quarters of the way to condensing, and not once condensed', () => {
    expect(nearCondense({ used: 210_000, compactAt: 268_000 })).toBe(true);
    expect(nearCondense({ used: 100_000, compactAt: 268_000 })).toBe(false);
    expect(nearCondense({ used: 260_000, compactAt: 268_000, condensed: true })).toBe(false);
    expect(nearCondense({ used: 260_000 })).toBe(false);
  });
});
