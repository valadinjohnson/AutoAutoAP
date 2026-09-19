import { describe, expect, it } from 'vitest';
import { reviewLegs, reviewSetup, qph, SLOW_LEG_DAYS, COLLAPSE_RATIO } from './health';
import type { LegSummary } from './types';

/** `maxELR` is per second; the panel and CSV both read it as q/hr. */
const leg = (endTE: number, ratePerHour: number, days = 30): LegSummary => ({
  key: '3-sale',
  endTE,
  durationSeconds: days * 86400,
  maxELR: (ratePerHour * 1e15) / 3600,
  endTime: 0,
  tier13Unlocked: false,
});

describe('reviewLegs', () => {
  it('is quiet on a plan whose delivery climbs, which is what a real one does', () => {
    expect(reviewLegs([leg(195, 3.574), leg(212, 5.593), leg(251, 7.009)])).toEqual([]);
  });

  // The case this module was written for: a real run where leg 1 matched the official planner to
  // three decimals and leg 2 came back at a tenth of it, for 817 days, with no warning anywhere.
  it('catches the collapse that made a 736-day plan read as 2,277', () => {
    const issues = reviewLegs([leg(195, 3.574, 34.8), leg(212, 0.32, 817.6)]);
    expect(issues.map(i => i.kind).sort()).toEqual(['rate-collapse', 'slow-leg']);
    expect(issues.find(i => i.kind === 'rate-collapse')!.level).toBe('error');
    expect(issues.find(i => i.kind === 'rate-collapse')!.message).toContain('0.320 q/hr');
  });

  // Strategy choice moves the peak around legitimately. A check that fires on ordinary variation
  // is a check people learn to ignore.
  it('tolerates an ordinary dip between strategies', () => {
    expect(reviewLegs([leg(195, 4), leg(212, 4 * COLLAPSE_RATIO + 0.01)])).toEqual([]);
  });

  it('flags a leg long enough to be worth checking', () => {
    const issues = reviewLegs([leg(195, 3), leg(212, 3, SLOW_LEG_DAYS + 1)]);
    expect(issues.map(i => i.kind)).toEqual(['slow-leg']);
  });

  it('never judges the first leg against nothing', () => {
    expect(reviewLegs([leg(195, 0.001)])).toEqual([]);
  });

  it('survives a leg with no measured rate rather than dividing by it', () => {
    expect(() => reviewLegs([leg(195, 0), leg(212, 5)])).not.toThrow();
    expect(reviewLegs([leg(195, 0), leg(212, 5)])).toEqual([]);
  });

  it('reads maxELR in the same unit the CSV prints', () => {
    expect(qph(leg(195, 3.574))).toBeCloseTo(3.574, 6);
  });
});

describe('reviewSetup', () => {
  const ok = {
    hasBackup: true,
    artifacts: [{ label: 'T4L Gusset', count: 1 }],
    stones: [{ label: 'T4 Tachyon stone', count: 6 }],
    delivery: [{ artifact: 'T4L Gusset', stones: [] }],
    earnings: [{ artifact: 'T4L Lunar totem', stones: [] }],
  };

  it('is quiet when everything loaded', () => {
    expect(reviewSetup(ok)).toEqual([]);
  });

  // One cause, one message. Listing the four downstream symptoms of a missing backup teaches
  // nothing and buries the one thing to do about it.
  it('says only that the backup is missing, not its four consequences', () => {
    const issues = reviewSetup({ ...ok, hasBackup: false, artifacts: [], delivery: [], earnings: [] });
    expect(issues.map(i => i.kind)).toEqual(['no-backup']);
  });

  it('catches an inventory that came back empty behind a loaded backup', () => {
    expect(reviewSetup({ ...ok, artifacts: [] }).map(i => i.kind)).toEqual(['no-artifacts']);
  });

  it('treats a missing delivery set as an error and a missing earnings set as a warning', () => {
    expect(reviewSetup({ ...ok, delivery: [] })[0].level).toBe('error');
    expect(reviewSetup({ ...ok, earnings: [] })[0].level).toBe('warning');
  });
});
