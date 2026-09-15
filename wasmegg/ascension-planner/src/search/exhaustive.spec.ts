import { describe, it, expect } from 'vitest';
import { buildPool, exhaustiveChains, countChains, estimateHours, formatHours, sortByPrefix } from './exhaustive';

describe('buildPool', () => {
  it('walks the range by step', () => {
    expect(buildPool({ lo: 200, hi: 240, step: 10 }, 100, 490)).toEqual([200, 210, 220, 230, 240]);
  });

  it('drops values at or below current TE and at or above the target', () => {
    // "Ascend to 150" from 179 is not a thing, and the final target is appended to every chain.
    expect(buildPool({ lo: 150, hi: 500, step: 50 }, 179, 490)).toEqual([200, 250, 300, 350, 400, 450]);
  });

  it('treats a missing or nonsense step as 1', () => {
    expect(buildPool({ lo: 200, hi: 203, step: 0 }, 100, 490)).toEqual([200, 201, 202, 203]);
    expect(buildPool({ lo: 200, hi: 203, step: NaN }, 100, 490)).toEqual([200, 201, 202, 203]);
  });

  it('is empty rather than wrong when the range is inverted or unusable', () => {
    expect(buildPool({ lo: 400, hi: 200, step: 5 }, 100, 490)).toEqual([]);
    expect(buildPool({ lo: 500, hi: 600, step: 5 }, 100, 490)).toEqual([]);
  });
});

describe('exhaustiveChains', () => {
  it('enumerates every strictly-increasing chain and appends the target', () => {
    const chains = exhaustiveChains([200, 300, 400], 2, 2, 490, 100);
    expect(chains).toEqual([
      [200, 490],
      [300, 490],
      [400, 490],
    ]);
  });

  it('counts the final target in the ascension count', () => {
    // 3 ascensions means two values taken from the pool, plus the target.
    const chains = exhaustiveChains([200, 300, 400], 3, 3, 490, 100);
    expect(chains).toEqual([
      [200, 300, 490],
      [200, 400, 490],
      [300, 400, 490],
    ]);
  });

  it('spans a range of ascension counts', () => {
    const chains = exhaustiveChains([200, 300, 400], 2, 4, 490, 100);
    // C(3,1) + C(3,2) + C(3,3) = 3 + 3 + 1
    expect(chains).toHaveLength(7);
    expect(chains.every(c => c[c.length - 1] === 490)).toBe(true);
  });

  it('keeps every chain strictly increasing', () => {
    for (const chain of exhaustiveChains([200, 250, 300, 350], 2, 4, 490, 100)) {
      for (let i = 1; i < chain.length; i++) expect(chain[i]).toBeGreaterThan(chain[i - 1]);
    }
  });

  it('agrees with countChains', () => {
    const pool = [200, 220, 240, 260, 280];
    for (const [lo, hi] of [
      [2, 2],
      [3, 4],
      [2, 6],
    ] as [number, number][]) {
      expect(exhaustiveChains(pool, lo, hi, 490, 100)).toHaveLength(countChains(pool.length, lo, hi));
    }
  });
});

describe('countChains', () => {
  it('counts without building, so a huge space can be refused before it is allocated', () => {
    // The CLI's own worked example: 6 checkpoints from 185..390 at step 1 is C(206,5) chains once
    // the final target is accounted for. Counting it must not attempt to enumerate it.
    const huge = countChains(206, 6, 6);
    expect(huge).toBeGreaterThan(2e9);
    expect(Number.isFinite(huge)).toBe(true);
  });

  it('saturates to Infinity instead of returning a meaningless float', () => {
    expect(countChains(2000, 2, 400)).toBe(Infinity);
  });

  it('ignores ascension counts the pool cannot supply', () => {
    // 5 ascensions needs 4 pool values; a pool of 2 cannot do it.
    expect(countChains(2, 5, 5)).toBe(0);
    expect(countChains(2, 2, 5)).toBe(3); // C(2,1) + C(2,2)
  });
});

describe('estimateHours and formatHours', () => {
  it('divides by workers and errs high', () => {
    // 6006 chains at 15 s across 12 workers, the CLI's own "rough upper bound 2.1 h".
    expect(estimateHours(6006, 12)).toBeCloseTo(2.085, 2);
  });

  it('formats at a scale that matches the magnitude', () => {
    expect(formatHours(0.5)).toBe('30 min');
    expect(formatHours(2.085)).toBe('2.1 h');
    expect(formatHours(72)).toBe('3.0 days');
    expect(formatHours(24 * 365 * 2)).toBe('2.0 years');
    expect(formatHours(Infinity)).toBe('longer than you have');
  });
});

describe('sortByPrefix', () => {
  it('groups chains by their shared prefix', () => {
    // Chunking an unsorted list scatters siblings and throws away the prefix memo, which is where
    // nearly all of the saving comes from. Comparison is element-wise, so `200 490` sorts after
    // `200 300 490` (490 > 300 at index 1); what matters is that everything starting 200 is
    // contiguous, which is the group the memo is keyed on.
    const sorted = sortByPrefix([
      [300, 490],
      [200, 400, 490],
      [200, 300, 490],
      [200, 490],
    ]);
    expect(sorted).toEqual([
      [200, 300, 490],
      [200, 400, 490],
      [200, 490],
      [300, 490],
    ]);
    expect(sorted.filter(c => c[0] === 200)).toHaveLength(3);
  });
});
