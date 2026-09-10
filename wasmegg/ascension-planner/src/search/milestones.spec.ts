/**
 * Dated TE milestones.
 *
 * The interesting cases are the ones where "satisfied" is ambiguous: a plan that never reaches the
 * TE at all, a milestone above the final target, and the ordering guarantee the `reachedAt` scan
 * relies on.
 */
import { describe, expect, it } from 'vitest';
import { meetsAll, milestonesKey, missedMilestones, reachedAt, usableMilestones } from './milestones';
import type { LegSummary } from './types';

const DAY = 86400;

function leg(endTE: number, endTime: number): LegSummary {
  return { key: '2-sale-tier13', endTE, durationSeconds: DAY, maxELR: 1e12, endTime, tier13Unlocked: true };
}

/** 195 on day 10, 248 on day 100, 490 on day 500. */
const LEGS = [leg(195, 10 * DAY), leg(248, 100 * DAY), leg(490, 500 * DAY)];

describe('reachedAt', () => {
  it('returns the first leg that reaches AT OR ABOVE the target', () => {
    // A chain rarely has a checkpoint exactly on the milestone, so "at or above" is the only
    // useful reading — 200 is reached the moment the plan passes 248.
    expect(reachedAt(LEGS, 195)).toBe(10 * DAY);
    expect(reachedAt(LEGS, 200)).toBe(100 * DAY);
    expect(reachedAt(LEGS, 248)).toBe(100 * DAY);
  });

  it('is undefined when the plan never gets there', () => {
    expect(reachedAt(LEGS, 600)).toBeUndefined();
  });
});

describe('missedMilestones', () => {
  it('accepts a plan that arrives exactly on the deadline', () => {
    expect(missedMilestones(LEGS, [{ te: 248, by: 100 * DAY }])).toEqual([]);
  });

  it('rejects a plan that arrives a second late', () => {
    expect(missedMilestones(LEGS, [{ te: 248, by: 100 * DAY - 1 }])).toHaveLength(1);
  });

  it('counts "never reaches it" as missed, not as vacuously satisfied', () => {
    // The dangerous default: an unreachable TE with no matching leg would otherwise pass every
    // check and the constraint would silently do nothing.
    expect(missedMilestones(LEGS, [{ te: 600, by: 9999 * DAY }])).toHaveLength(1);
  });

  it('reports every milestone that is missed, not just the first', () => {
    const missed = missedMilestones(LEGS, [
      { te: 195, by: 1 * DAY },
      { te: 248, by: 500 * DAY },
      { te: 490, by: 400 * DAY },
    ]);
    expect(missed.map(m => m.te)).toEqual([195, 490]);
  });

  it('meetsAll agrees with an empty miss list', () => {
    expect(meetsAll(LEGS, [{ te: 248, by: 200 * DAY }])).toBe(true);
    expect(meetsAll(LEGS, [{ te: 248, by: 50 * DAY }])).toBe(false);
    expect(meetsAll(LEGS, [])).toBe(true);
  });
});

describe('usableMilestones', () => {
  it('drops anything unsatisfiable rather than rejecting every chain over a typo', () => {
    const kept = usableMilestones(
      [
        { te: 248, by: 100 * DAY },
        { te: 600, by: 100 * DAY }, // above the final target
        { te: 0, by: 100 * DAY }, // no TE
        { te: 248, by: 0 }, // no date
        { te: NaN, by: 100 * DAY },
      ],
      490
    );
    expect(kept).toEqual([{ te: 248, by: 100 * DAY }]);
  });

  it('treats a milestone exactly on the final target as usable', () => {
    expect(usableMilestones([{ te: 490, by: 100 * DAY }], 490)).toHaveLength(1);
  });

  it('handles null and undefined', () => {
    expect(usableMilestones(null, 490)).toEqual([]);
    expect(usableMilestones(undefined, 490)).toEqual([]);
  });
});

describe('milestonesKey', () => {
  it('is empty with no milestones, so the fingerprint is byte-identical to an unconstrained run', () => {
    expect(milestonesKey([])).toBe('');
    expect(milestonesKey(null)).toBe('');
  });

  it('does not depend on the order the rows were added', () => {
    // Otherwise reordering the list silently discards a three-hour run's checkpoint.
    const a = milestonesKey([
      { te: 248, by: 100 * DAY },
      { te: 195, by: 10 * DAY },
    ]);
    const b = milestonesKey([
      { te: 195, by: 10 * DAY },
      { te: 248, by: 100 * DAY },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a date changes', () => {
    expect(milestonesKey([{ te: 248, by: 100 * DAY }])).not.toBe(milestonesKey([{ te: 248, by: 101 * DAY }]));
  });
});
