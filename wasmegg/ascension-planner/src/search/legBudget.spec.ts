import { describe, expect, it } from 'vitest';
import { applyLegBudget, estimateLegBytes } from './legBudget';
import type { CacheEntry } from './driver';
import type { LegSummary } from './types';

const leg = (): LegSummary => ({
  key: '2-sale-tier13',
  endTE: 219,
  durationSeconds: 100,
  maxELR: 1,
  endTime: 2,
  tier13Unlocked: true,
  shifts: Array.from({ length: 12 }, (_, k) => ({ at: k, egg: 'Truth', fromEgg: 'Enlightenment' })),
});

const entry = (key: string, seconds: number, legs = 2): CacheEntry => ({
  key,
  seconds,
  legs: Array.from({ length: legs }, leg),
});

describe('applyLegBudget', () => {
  it('keeps the fastest chains and strips the rest', () => {
    const entries = [entry('c', 300), entry('a', 100), entry('b', 200), entry('d', 400)];
    expect(applyLegBudget(entries, 2)).toEqual({ held: 2, dropped: 2 });
    expect(entries.filter(e => e.legs.length).map(e => e.key)).toEqual(['a', 'b']);
  });

  it('does nothing when the cache is inside the budget', () => {
    const entries = [entry('a', 100), entry('b', 200)];
    expect(applyLegBudget(entries, 10)).toEqual({ held: 2, dropped: 0 });
    expect(entries.every(e => e.legs.length)).toBe(true);
  });

  it('treats a budget of zero as keep everything', () => {
    const entries = [entry('a', 100), entry('b', 200)];
    expect(applyLegBudget(entries, 0).dropped).toBe(0);
    expect(entries.every(e => e.legs.length)).toBe(true);
  });

  // The winner is what `bestLegs` points at and what the submission's per-leg detail comes from.
  // Evicting it would silently turn a full result into a checkpoint-shaped one.
  it('never strips the winner, however small the budget', () => {
    const entries = [entry('slow', 900), entry('winner', 10), entry('mid', 500)];
    applyLegBudget(entries, 1);
    expect(entries.find(e => e.key === 'winner')!.legs.length).toBeGreaterThan(0);
  });

  // Zero is "not priced yet", not "instant". Sorting it to the front would fill the kept set with
  // placeholders and evict the real answers they are standing in for.
  it('sorts unpriced entries last rather than to the top', () => {
    const entries = [entry('unpriced', 0), entry('fast', 100), entry('slow', 900)];
    applyLegBudget(entries, 1);
    expect(entries.filter(e => e.legs.length).map(e => e.key)).toEqual(['fast']);
  });

  it('leaves already-stripped entries alone rather than counting them as held', () => {
    const entries = [entry('a', 100), { key: 'b', seconds: 200, legs: [] }, entry('c', 300)];
    expect(applyLegBudget(entries, 10)).toEqual({ held: 2, dropped: 0 });
  });

  it('is idempotent — a second pass at the same budget drops nothing more', () => {
    const entries = [entry('a', 100), entry('b', 200), entry('c', 300)];
    applyLegBudget(entries, 2);
    expect(applyLegBudget(entries, 2)).toEqual({ held: 2, dropped: 0 });
  });
});

describe('estimateLegBytes', () => {
  it('scales one sampled entry by the count held', () => {
    const entries = [entry('a', 100), entry('b', 200)];
    const one = JSON.stringify(entries[0].legs).length;
    expect(estimateLegBytes(entries, 2)).toBe(one * 2);
  });

  it('is zero when nothing is held', () => {
    expect(estimateLegBytes([{ key: 'a', seconds: 1, legs: [] }], 0)).toBe(0);
    expect(estimateLegBytes([], 5)).toBe(0);
  });
});
