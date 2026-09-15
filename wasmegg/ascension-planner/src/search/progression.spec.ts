import { describe, it, expect } from 'vitest';
import {
  summariseEpicResearch,
  summariseColleggtibles,
  describeEpicResearch,
  describeColleggtibles,
} from './progression';

const research = (id: string, level: number, maxLevel: number) => ({ id, name: id, level, maxLevel });

describe('summariseEpicResearch', () => {
  it('reports max when everything is at cap, without listing anything', () => {
    // The common case for anyone running a three-hour chain search, and the reason this is a
    // summary rather than a level dump.
    const s = summariseEpicResearch([research('a', 20, 20), research('b', 100, 100)]);
    expect(s).toEqual({ maxed: true, atMax: 2, total: 2, short: [] });
    expect(describeEpicResearch(s)).toBe('max');
  });

  it('lists only what is short, worst first', () => {
    const s = summariseEpicResearch([research('done', 20, 20), research('half', 10, 20), research('barely', 1, 100)]);
    expect(s?.maxed).toBe(false);
    expect(s?.atMax).toBe(1);
    expect(s?.short).toEqual(['barely 1/100', 'half 10/20']);
    expect(describeEpicResearch(s)).toBe('1/3 at max');
  });

  it('caps the list so a new account does not post its whole tree', () => {
    const many = Array.from({ length: 30 }, (_, i) => research(`r${i}`, 0, 10));
    expect(summariseEpicResearch(many)?.short).toHaveLength(12);
  });

  it('is null when there is nothing usable to summarise', () => {
    expect(summariseEpicResearch([])).toBeNull();
    expect(summariseEpicResearch([research('bad', NaN, 10)])).toBeNull();
  });
});

describe('summariseColleggtibles', () => {
  it('reports maxed when every egg is at the top tier', () => {
    const s = summariseColleggtibles({ carbon: 3, chocolate: 3 });
    expect(s?.maxed).toBe(true);
    expect(s?.short).toEqual([]);
    expect(describeColleggtibles(s)).toBe('all T4');
  });

  it('buckets by tier and names what is short', () => {
    // -1 is the backup's "none earned"; 0-3 are tiers 1-4.
    const s = summariseColleggtibles({ carbon: 3, chocolate: 1, easter: -1 });
    expect(s?.maxed).toBe(false);
    expect(s?.total).toBe(3);
    // index 0 is "none", then T1..T4
    expect(s?.byTier).toEqual([1, 0, 1, 0, 1]);
    expect(s?.short).toEqual(['chocolate T2', 'easter none']);
  });

  it('describes a partial set highest tier first', () => {
    const s = summariseColleggtibles({ a: 3, b: 3, c: 2, d: -1 });
    expect(describeColleggtibles(s)).toBe('2 at T4, 1 at T3, 1 none');
  });

  it('clamps a tier index outside the known range rather than growing a bucket', () => {
    const s = summariseColleggtibles({ weird: 99, alsoWeird: -50 });
    expect(s?.byTier).toHaveLength(5);
    expect(s?.total).toBe(2);
  });

  it('is null with nothing to summarise', () => {
    expect(summariseColleggtibles({})).toBeNull();
  });
});
