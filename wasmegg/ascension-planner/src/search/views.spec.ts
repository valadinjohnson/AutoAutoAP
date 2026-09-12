/**
 * The preset views over a run's priced chains.
 *
 * The property each view has to hold is "shows what it says on the pill", and the failures worth
 * catching are the silent ones: a view that quietly drops options the player asked to see, or one
 * that collapses to a single row because a required input was missing.
 */
import { describe, expect, it } from 'vitest';
import type { CacheEntry } from './driver';
import { buildView, scheduleCost, VIEWS } from './views';
import type { LegSummary } from './types';

const DAY = 86400;

/** A leg carrying only the fields the views read. */
function leg(sleep: number, shift: number): LegSummary {
  return {
    key: '1-sale',
    endTE: 0,
    endTime: 0,
    durationSeconds: 0,
    maxELR: 0,
    sleepDelaySeconds: sleep,
    shiftDelaySeconds: shift,
  } as unknown as LegSummary;
}

function entry(chain: number[], days: number, wait = 0, hold = 0): CacheEntry {
  return { key: chain.join(','), seconds: days * DAY, legs: [leg(wait, hold)] };
}

describe('buildView', () => {
  it('gives every pill a label and a hint', () => {
    for (const v of VIEWS) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.hint.length).toBeGreaterThan(20);
    }
    expect(new Set(VIEWS.map(v => v.id)).size).toBe(VIEWS.length);
  });

  it('fastest returns the raw ranking with nothing filtered out', () => {
    // Deliberately includes near-duplicates and a chain 40 days behind: `balanced` drops both,
    // and this view must not, because "fastest" that hides candidates is a lie.
    const entries = [
      entry([195, 219, 490], 700),
      entry([195, 220, 490], 700.1),
      entry([195, 221, 490], 700.2),
      entry([300, 400, 490], 740),
    ];
    const rows = buildView(entries, 'fastest');
    expect(rows.map(r => r.seconds / DAY)).toEqual([700, 700.1, 700.2, 740]);
    expect(rows[0].reason).toBe('best');
  });

  it('cheapest-hours sorts by waiting, not by length', () => {
    const entries = [
      entry([195, 219, 490], 700, 5 * 3600, 5 * 3600), // fastest, 10 h of waiting
      entry([195, 230, 490], 701, 1 * 3600, 0), // a day slower, 1 h of waiting
    ];
    const rows = buildView(entries, 'cheapest-hours');
    expect(rows[0].chain).toEqual([195, 230, 490]);
    expect(scheduleCost(rows[0])).toBe(3600);
  });

  it('ranks a chain with no recorded legs last rather than as free', () => {
    // A replayed checkpoint keeps no legs, so its cost is unknown. Sorting unknown as zero would
    // put it top of the "kindest to my schedule" list on no evidence at all.
    const noLegs: CacheEntry = { key: '195,219,490', seconds: 700 * DAY, legs: [] };
    const known = entry([195, 230, 490], 701, 3600, 0);
    const rows = buildView([noLegs, known], 'cheapest-hours');
    expect(rows[0].chain).toEqual([195, 230, 490]);
    expect(scheduleCost(rows[1])).toBeNull();
  });

  it('per-count gives one row per ascension count, shortest first', () => {
    const entries = [
      entry([195, 219, 248, 490], 700),
      entry([195, 219, 249, 490], 700.5),
      entry([195, 219, 490], 701),
      entry([195, 219, 248, 286, 490], 702),
    ];
    const rows = buildView(entries, 'per-count');
    expect(rows.map(r => r.prestiges)).toEqual([3, 4, 5]);
    // Best WITHIN each count, not merely the first seen.
    expect(rows[1].seconds / DAY).toBe(700);
  });

  it('finish-days gives one row per calendar day, earliest first', () => {
    const planStart = Date.UTC(2026, 8, 9) / 1000;
    const entries = [
      entry([195, 219, 490], 700), // day A
      entry([195, 220, 490], 700.2), // same day A, slower
      entry([195, 230, 490], 702), // two days later
    ];
    const rows = buildView(entries, 'finish-days', { planStart, timezone: 'UTC' });
    expect(rows).toHaveLength(2);
    expect(rows[0].seconds / DAY).toBe(700);
    expect(rows[1].seconds / DAY).toBe(702);
  });

  it('falls back to the ranking when finish-days has no plan start', () => {
    // Every chain would bucket to the same epoch day and the view would collapse to one row.
    // Showing the ranking is useless-but-honest; showing one row would look like a real answer.
    const entries = [entry([195, 219, 490], 700), entry([195, 230, 490], 702)];
    expect(buildView(entries, 'finish-days', { timezone: 'UTC' })).toHaveLength(2);
  });

  it('never returns a chain that was not priced', () => {
    const entries = [entry([195, 219, 490], 700), { key: '195,300,490', seconds: 0, legs: [] }];
    for (const v of VIEWS) {
      const rows = buildView(entries, v.id, { planStart: 1, timezone: 'UTC' });
      expect(rows.every(r => r.seconds > 0), v.id).toBe(true);
    }
  });

  it('returns nothing at all rather than throwing on an empty cache', () => {
    for (const v of VIEWS) expect(buildView([], v.id)).toEqual([]);
  });
});
