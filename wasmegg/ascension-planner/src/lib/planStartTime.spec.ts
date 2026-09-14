import { describe, it, expect } from 'vitest';
import { resolvePlanStart, planStartDrift, formatDriftHours, DRIFT_TOLERANCE_HOURS } from './planStartTime';

const BACKUP = 1_757_000_000; // arbitrary fixed instant; only the differences matter
const HOUR = 3600;
const NOW = BACKUP + 5 * HOUR;

describe('resolvePlanStart', () => {
  it('defaults an empty form to the backup timestamp, not to now', () => {
    expect(resolvePlanStart({ backupSeconds: BACKUP, currentSeconds: null, nowSeconds: NOW })).toBe(BACKUP);
  });

  it('falls back to now when no backup is loaded', () => {
    expect(resolvePlanStart({ backupSeconds: null, currentSeconds: null, nowSeconds: NOW })).toBe(NOW);
  });

  it('replaces a start that predates the backup', () => {
    // The shape a stale cached form takes: yesterday's start against today's backup. Starting
    // there would simulate the farm before the state it is starting from existed.
    const stale = BACKUP - 26 * HOUR;
    expect(resolvePlanStart({ backupSeconds: BACKUP, currentSeconds: stale, nowSeconds: NOW })).toBe(BACKUP);
  });

  it('leaves a start after the backup alone', () => {
    // "Begin this plan tomorrow morning" is a real request, so it is warned about, not overridden.
    const later = BACKUP + 18 * HOUR;
    expect(resolvePlanStart({ backupSeconds: BACKUP, currentSeconds: later, nowSeconds: NOW })).toBeNull();
  });

  it('leaves an exact match alone rather than rewriting it to itself', () => {
    expect(resolvePlanStart({ backupSeconds: BACKUP, currentSeconds: BACKUP, nowSeconds: NOW })).toBeNull();
  });

  it('leaves the form alone when there is no backup to sync to', () => {
    const anything = BACKUP - 100 * HOUR;
    expect(resolvePlanStart({ backupSeconds: null, currentSeconds: anything, nowSeconds: NOW })).toBeNull();
  });

  it('treats a missing approx_time as no backup', () => {
    // A backup without the field decodes to 0, which as a unix timestamp is 1970 and would drag
    // every start time back with it.
    expect(resolvePlanStart({ backupSeconds: 0, currentSeconds: null, nowSeconds: NOW })).toBe(NOW);
    expect(resolvePlanStart({ backupSeconds: 0, currentSeconds: BACKUP, nowSeconds: NOW })).toBeNull();
    expect(resolvePlanStart({ backupSeconds: NaN, currentSeconds: BACKUP, nowSeconds: NOW })).toBeNull();
  });
});

describe('planStartDrift', () => {
  it('is positive when the start is after the backup and negative before', () => {
    expect(planStartDrift(BACKUP, BACKUP + 3 * HOUR)).toBeCloseTo(3);
    expect(planStartDrift(BACKUP, BACKUP - 3 * HOUR)).toBeCloseTo(-3);
  });

  it('is null without both a usable backup and a resolved start', () => {
    expect(planStartDrift(null, BACKUP)).toBeNull();
    expect(planStartDrift(0, BACKUP)).toBeNull();
    expect(planStartDrift(BACKUP, null)).toBeNull();
    expect(planStartDrift(BACKUP, NaN)).toBeNull();
  });

  it('reports a drift inside the tolerance the UI treats as a match', () => {
    const drift = planStartDrift(BACKUP, BACKUP + 60);
    expect(drift).not.toBeNull();
    expect(Math.abs(drift as number)).toBeLessThan(DRIFT_TOLERANCE_HOURS);
  });
});

describe('formatDriftHours', () => {
  it('uses minutes under an hour, hours under two days, then days', () => {
    expect(formatDriftHours(0.75)).toBe('45m');
    expect(formatDriftHours(6)).toBe('6h');
    expect(formatDriftHours(47)).toBe('47h');
    expect(formatDriftHours(72)).toBe('3d');
  });

  it('ignores the sign, since the caller supplies the direction in words', () => {
    expect(formatDriftHours(-6)).toBe('6h');
  });
});
