import { describe, it, expect } from 'vitest';
import {
  buildPool,
  exhaustiveChains,
  countChains,
  estimateHours,
  formatHours,
  sortByPrefix,
  exhaustiveChainsWithGap,
  countChainsWithGap,
  bandedChains,
  countBanded,
  parseBand,
  parseBands,
  SMALLEST_MEASURED_GAP,
  suggestBands,
  SUGGESTION_TARGET_RANGE,
  SUGGESTABLE_ASCENSIONS,
} from './exhaustive';

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

  it('stops the walk at limit instead of building the whole space', () => {
    const pool = [200, 220, 240, 260, 280];
    const full = exhaustiveChains(pool, 2, 6, 490, 100);
    const limited = exhaustiveChains(pool, 2, 6, 490, 100, 4);
    expect(limited).toHaveLength(4);
    // A prefix of the unbounded result, not a differently-ordered subset — a benchmark reading the
    // first K chains must see the same K chains a real (unbounded) run would price first.
    expect(limited).toEqual(full.slice(0, 4));
  });

  it('a limit at or past the true count changes nothing', () => {
    const pool = [200, 300, 400];
    const full = exhaustiveChains(pool, 2, 2, 490, 100);
    expect(exhaustiveChains(pool, 2, 2, 490, 100, 1000)).toEqual(full);
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

describe('exhaustiveChainsWithGap', () => {
  const pool = [185, 200, 215, 230, 245, 260];

  it('drops the chains that make step look like a spacing control', () => {
    // `185 200 215 230 490` is legal at step 15 and is three 15-TE rebuilds in a row.
    const loose = exhaustiveChains(pool, 5, 5, 490, 100);
    expect(loose).toContainEqual([185, 200, 215, 230, 490]);

    const tight = exhaustiveChainsWithGap(pool, 5, 5, 490, 100, 30);
    expect(tight).not.toContainEqual([185, 200, 215, 230, 490]);
    for (const chain of tight) {
      const interior = chain.slice(0, -1);
      for (let i = 1; i < interior.length; i++) expect(interior[i] - interior[i - 1]).toBeGreaterThanOrEqual(30);
    }
  });

  it('does not constrain the leap to the final target', () => {
    // The last leg is long by nature; `maxLast` is the knob for that end, not this one.
    const chains = exhaustiveChainsWithGap(pool, 2, 2, 490, 100, 30);
    expect(chains).toContainEqual([260, 490]);
  });

  it('is the unconstrained enumeration at gap 0', () => {
    expect(exhaustiveChainsWithGap(pool, 3, 4, 490, 100, 0)).toEqual(exhaustiveChains(pool, 3, 4, 490, 100));
  });

  it('would exclude the best 7-ascension chain measured on this account at any gap above 15', () => {
    // `185 200 215 230 290 380 490` scored 746.354 d with 15-TE interior gaps. This is the reason
    // minimum gap is opt-in and defaults to off.
    const wide = [185, 200, 215, 230, 290, 380];
    expect(exhaustiveChainsWithGap(wide, 7, 7, 490, 100, SMALLEST_MEASURED_GAP)).toContainEqual([
      185, 200, 215, 230, 290, 380, 490,
    ]);
    expect(exhaustiveChainsWithGap(wide, 7, 7, 490, 100, SMALLEST_MEASURED_GAP + 1)).toEqual([]);
  });

  it('stops the walk at limit instead of building the whole space', () => {
    const full = exhaustiveChainsWithGap(pool, 2, 6, 490, 100, 15);
    const limited = exhaustiveChainsWithGap(pool, 2, 6, 490, 100, 15, 3);
    expect(limited).toHaveLength(3);
    expect(limited).toEqual(full.slice(0, 3));
  });
});

describe('countChainsWithGap', () => {
  it('agrees with the enumeration it is predicting', () => {
    const pool = [185, 200, 215, 230, 245, 260, 275];
    for (const gap of [0, 15, 30, 45]) {
      for (const [lo, hi] of [
        [3, 3],
        [2, 4],
        [4, 6],
      ] as [number, number][]) {
        expect(countChainsWithGap(pool, lo, hi, gap)).toBe(exhaustiveChainsWithGap(pool, lo, hi, 490, 100, gap).length);
      }
    }
  });

  it('counts a large gapped space without building it', () => {
    const pool: number[] = [];
    for (let v = 185; v <= 390; v += 1) pool.push(v);
    // Would be ~10^11 chains unconstrained; the DP still answers immediately.
    const n = countChainsWithGap(pool, 6, 6, 25);
    expect(n).toBeGreaterThan(0);
  });
});

describe('bandedChains', () => {
  it('takes checkpoint N from band N, fixing the ascension count', () => {
    const bands = [
      [185, 190],
      [220, 230],
      [260, 270],
    ];
    const chains = bandedChains(bands, 490, 100);
    expect(chains).toHaveLength(8);
    expect(chains.every(c => c.length === 4)).toBe(true);
    expect(chains.every(c => c[c.length - 1] === 490)).toBe(true);
    expect(chains).toContainEqual([185, 220, 260, 490]);
  });

  it('keeps chains strictly increasing even when bands overlap', () => {
    const bands = [
      [200, 240],
      [220, 260],
    ];
    const chains = bandedChains(bands, 490, 100);
    // 240 -> 220 is not a chain; an overlap means "can be close", not "can go backwards".
    expect(chains).not.toContainEqual([240, 220, 490]);
    for (const c of chains) for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
  });

  it('applies the minimum gap across band boundaries', () => {
    const bands = [
      [200, 210],
      [215, 260],
    ];
    expect(bandedChains(bands, 490, 100, 30)).toEqual([
      [200, 260, 490],
      [210, 260, 490],
    ]);
  });

  it('is empty rather than wrong when a band has nothing in it', () => {
    expect(bandedChains([[200], []], 490, 100)).toEqual([]);
    expect(bandedChains([], 490, 100)).toEqual([]);
  });

  it('stops the walk at limit instead of building the whole space', () => {
    const bands = [
      [185, 190, 195],
      [220, 225, 230],
      [260, 265, 270],
    ];
    const full = bandedChains(bands, 490, 100);
    const limited = bandedChains(bands, 490, 100, 0, 5);
    expect(limited).toHaveLength(5);
    expect(limited).toEqual(full.slice(0, 5));
  });
});

describe('countBanded', () => {
  it('agrees with the banded enumeration', () => {
    const bands = [
      [185, 195, 205],
      [220, 235, 250],
      [260, 280, 300],
    ];
    for (const gap of [0, 20, 40]) {
      expect(countBanded(bands, 490, 100, gap)).toBe(bandedChains(bands, 490, 100, gap).length);
    }
  });
});

describe('parseBand / parseBands', () => {
  it('reads a range with an explicit step', () => {
    expect(parseBand('185-200:5')).toEqual([185, 190, 195, 200]);
  });

  it('falls back to the default step', () => {
    expect(parseBand('185-200', 15)).toEqual([185, 200]);
  });

  it('reads a single value as a one-value band', () => {
    expect(parseBand('195')).toEqual([195]);
  });

  it('accepts an en dash, because that is what a copied range often contains', () => {
    expect(parseBand('185–195:5')).toEqual([185, 190, 195]);
  });

  it('is empty for something it cannot read, rather than guessing', () => {
    expect(parseBand('')).toEqual([]);
    expect(parseBand('abc')).toEqual([]);
    expect(parseBand('300-200')).toEqual([]);
  });

  it('splits a multi-band string and drops blanks', () => {
    const bands = parseBands('185-200:5; 210-240:10; ; 250-290:20');
    expect(bands).toHaveLength(3);
    expect(bands[0]).toEqual([185, 190, 195, 200]);
    expect(bands[1]).toEqual([210, 220, 230, 240]);
    expect(bands[2]).toEqual([250, 270, 290]);
  });
});

describe('suggestBands', () => {
  it('suggests bands that scale with the account, not fixed TE values', () => {
    const a = suggestBands(179, 490, 6);
    const b = suggestBands(100, 490, 6);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Same fractions, different journeys, so the absolute bands must differ.
    expect(a!.text).not.toBe(b!.text);
    expect(a!.bands).toHaveLength(5);
    expect(b!.bands).toHaveLength(5);
  });

  it('produces one band per intermediate checkpoint, so N ascensions gives N-1 boxes', () => {
    expect(suggestBands(179, 490, 5)!.bands).toHaveLength(4);
    expect(suggestBands(179, 490, 6)!.bands).toHaveLength(5);
    expect(suggestBands(179, 490, 7)!.bands).toHaveLength(6);
  });

  it('keeps every band inside the reachable range', () => {
    const s = suggestBands(179, 490, 6)!;
    for (const band of s.bands) {
      for (const v of band) {
        expect(v).toBeGreaterThan(179);
        expect(v).toBeLessThan(490);
      }
    }
  });

  it('produces bands that ascend', () => {
    const s = suggestBands(179, 490, 6)!;
    for (let i = 1; i < s.bands.length; i++) {
      expect(s.bands[i][0]).toBeGreaterThan(s.bands[i - 1][0]);
    }
  });

  it('declines on a target the corpus never measured', () => {
    // On 300 the last checkpoint sits at 0.80-0.86 of the journey against 0.42-0.63 on 490.
    // Suggesting 490's shape there would be worse than suggesting nothing.
    expect(suggestBands(125, 300, 6)).toBeNull();
    expect(suggestBands(179, SUGGESTION_TARGET_RANGE[1] + 1, 6)).toBeNull();
  });

  it('declines on an ascension count the corpus cannot support', () => {
    expect(suggestBands(179, 490, 1)).toBeNull();
    expect(suggestBands(179, 490, 9)).toBeNull();
  });

  it('covers the short chains too, and keeps every table ordered and inside the journey', () => {
    // 2-4 came from single-account exhaustive sweeps; the shape rules are the same either way.
    for (const n of SUGGESTABLE_ASCENSIONS) {
      const s = suggestBands(180, 490, n);
      expect(s, `${n} ascensions`).not.toBeNull();
      expect(s!.bands).toHaveLength(n - 1);
      for (const values of s!.bands) {
        expect(values.length).toBeGreaterThan(0);
        expect(Math.min(...values)).toBeGreaterThan(180);
        expect(Math.max(...values)).toBeLessThan(490);
      }
    }
  });

  it('declines rather than inverting when the account has already passed the target', () => {
    expect(suggestBands(500, 490, 6)).toBeNull();
  });

  it('carries its own provenance, so the UI can say how thin the evidence is', () => {
    const s = suggestBands(179, 490, 7)!;
    expect(s.accounts).toBeGreaterThan(0);
    expect(s.runs).toBeGreaterThanOrEqual(s.accounts);
  });

  it('parses back into the bands it claims', () => {
    const s = suggestBands(179, 490, 6)!;
    expect(parseBands(s.text)).toEqual(s.bands);
  });
});
