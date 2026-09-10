/**
 * The runners-up picker.
 *
 * The one that matters is near-duplicate suppression: without it the list is the winning plan with
 * one checkpoint nudged by one TE, eight times over, which is worse than showing nothing.
 */
import { describe, expect, it } from 'vitest';
import { pickShortlist } from './shortlist';
import type { CacheEntry } from './driver';
import type { LegSummary } from './types';

function e(chain: string, days: number, legs: LegSummary[] = []): CacheEntry {
  return { key: chain.split(' ').join(','), seconds: days * 86400, legs };
}

function leg(over: Partial<LegSummary> = {}): LegSummary {
  return {
    key: '2-sale-tier13',
    endTE: 219,
    durationSeconds: 86400,
    maxELR: 1e12,
    endTime: 0,
    tier13Unlocked: true,
    ...over,
  };
}

describe('pickShortlist', () => {
  it('suppresses the same plan nudged by one TE', () => {
    // Exactly what a descent sweep leaves in the cache. All four are one plan.
    const rows = pickShortlist([
      e('195 219 248 286 327 490', 741.965),
      e('195 219 248 286 328 490', 741.970),
      e('195 219 248 287 327 490', 741.980),
      e('195 219 249 286 327 490', 741.990),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].chain).toEqual([195, 219, 248, 286, 327, 490]);
    expect(rows[0].reason).toBe('best');
  });

  it('keeps a chain that moved far enough to be a different plan', () => {
    const rows = pickShortlist([
      e('195 219 248 286 327 490', 741.965),
      e('195 219 260 286 327 490', 742.400), // X3 moved 12
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].reason).toBe('different-shape');
  });

  it('always surfaces the best chain at each prestige count', () => {
    // The trade the player alone can make: one fewer rebuild for half a day. It must never be
    // crowded out by same-length alternatives, which is why counts are filled first.
    const rows = pickShortlist(
      [
        e('195 219 240 262 286 323 490', 738.968),
        e('195 219 241 262 286 323 490', 738.970),
        e('195 219 242 262 286 323 490', 738.980),
        e('195 219 243 262 286 323 490', 738.990),
        e('195 219 244 262 286 323 490', 739.000),
        e('195 219 245 262 286 323 490', 739.010),
        e('195 219 246 262 286 323 490', 739.020),
        e('195 219 248 286 327 490', 741.965), // the only 6-prestige chain, and slowest
      ],
      { maxRows: 3 }
    );
    expect(rows.map(r => r.prestiges)).toContain(6);
    expect(rows.find(r => r.prestiges === 6)!.reason).toBe('prestige-count');
  });

  it('reports the gap against the leader, not against zero', () => {
    const rows = pickShortlist([
      e('195 219 248 286 327 490', 741.965),
      e('195 219 260 286 327 490', 744.965),
    ]);
    expect(rows[0].gapSeconds).toBe(0);
    expect(rows[1].gapSeconds / 86400).toBeCloseTo(3, 6);
  });

  it('drops anything past the gap window', () => {
    const rows = pickShortlist(
      [e('195 219 248 286 327 490', 741.965), e('300 350 400 490', 800)],
      { maxGapSeconds: 5 * 86400 }
    );
    expect(rows).toHaveLength(1);
  });

  it('never lets an unpriced placeholder lead the list', () => {
    // bestSeconds 0 means "no result yet". Sorting naively would make it rank first and every
    // gap would then be measured against a chain that was never simulated.
    const rows = pickShortlist([e('195 490', 0), e('195 219 248 286 327 490', 741.965)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].seconds).toBeGreaterThan(0);
  });

  it('sums night shifts and prestige waits when legs are present', () => {
    const rows = pickShortlist([
      e('195 219 490', 741.965, [
        leg({ nightShifts: 2, sleepDelaySeconds: 3600 }),
        leg({ nightShifts: 1, sleepDelaySeconds: 0 }),
      ]),
    ]);
    expect(rows[0].nightShifts).toBe(3);
    expect(rows[0].prestigeWaitSeconds).toBe(3600);
  });

  it('reports null, not zero, when a chain has no legs to count', () => {
    // A chain replayed from a checkpoint has no legs. Zero would read as "no night shifts",
    // which is a claim; null is the truth, and the UI renders it as unknown.
    const rows = pickShortlist([e('195 219 490', 741.965)]);
    expect(rows[0].nightShifts).toBeNull();
    expect(rows[0].prestigeWaitSeconds).toBeNull();
  });

  it('honours maxRows and returns fastest-first', () => {
    const rows = pickShortlist(
      [
        e('195 219 248 286 327 490', 743),
        e('195 219 300 286 327 490', 742),
        e('195 219 270 340 327 490', 741),
      ],
      { maxRows: 2 }
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].seconds).toBeLessThan(rows[1].seconds);
  });

  it('survives an empty cache', () => {
    expect(pickShortlist([])).toEqual([]);
  });
});
