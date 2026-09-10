/**
 * The availability schedule. Pure arithmetic over real IANA zones, so no simulation and no mocking
 * of time.
 *
 * The cases that matter are the ones that are easy to get wrong: a window that wraps midnight (the
 * NORMAL case for "evenings", not an edge case), a schedule that excludes nothing, the session-day
 * rule for wrapping windows, and DST — a plan runs for two years and crosses four transitions per
 * zone, so a naive `+3600` drifts an hour twice a year in opposite directions.
 */
import { describe, expect, it } from 'vitest';
import { getLocalTimestampInTimezone } from '@/lib/events';
import {
  availabilityKey,
  countUnavailable,
  describeAvailability,
  fromSleepHours,
  isAvailable,
  isConstrained,
  localDayOfWeek,
  localHour,
  nextAvailable,
} from './availability';

const DENVER = 'America/Denver';
/** Awake 07:00-23:00 every day — the sleep preset, and the default the panel ships. */
const AWAKE = fromSleepHours(23, 7, DENVER);

function at(dateStr: string, timeStr: string, tz = DENVER): number {
  return getLocalTimestampInTimezone(dateStr, timeStr, tz);
}

describe('isConstrained', () => {
  it('rejects every day plus all hours — that is the default, not a constraint', () => {
    expect(isConstrained({ days: [], fromHour: 9, toHour: 9, timezone: DENVER })).toBe(false);
    expect(isConstrained({ days: [0, 1, 2, 3, 4, 5, 6], fromHour: 0, toHour: 0, timezone: DENVER })).toBe(false);
  });

  it('accepts an hour restriction on its own, and a day restriction on its own', () => {
    expect(isConstrained(AWAKE)).toBe(true);
    expect(isConstrained({ days: [0, 6], fromHour: 0, toHour: 0, timezone: DENVER })).toBe(true);
  });

  it('rejects out-of-range and non-integer hours rather than trusting them', () => {
    expect(isConstrained({ days: [], fromHour: -1, toHour: 7, timezone: DENVER })).toBe(false);
    expect(isConstrained({ days: [], fromHour: 7, toHour: 24, timezone: DENVER })).toBe(false);
    expect(isConstrained({ days: [], fromHour: 7.5, toHour: 23, timezone: DENVER })).toBe(false);
  });

  it('accepts null/undefined as "no schedule"', () => {
    expect(isConstrained(null)).toBe(false);
    expect(isConstrained(undefined)).toBe(false);
  });
});

describe('localHour / localDayOfWeek', () => {
  it('reads the zone given, not the runner’s', () => {
    expect(localHour(at('2026-09-08', '03:14'), DENVER)).toBe(3);
    expect(localHour(at('2026-09-08', '00:00'), DENVER)).toBe(0);
  });

  it('numbers days from Sunday', () => {
    // 2026-09-08 is a Tuesday.
    expect(localDayOfWeek(at('2026-09-08', '12:00'), DENVER)).toBe(2);
    expect(localDayOfWeek(at('2026-09-13', '12:00'), DENVER)).toBe(0);
    expect(localDayOfWeek(at('2026-09-12', '12:00'), DENVER)).toBe(6);
  });
});

describe('isAvailable', () => {
  it('handles the awake window', () => {
    for (const t of ['07:00', '09:00', '22:59']) expect(isAvailable(at('2026-09-08', t), AWAKE)).toBe(true);
    for (const t of ['23:00', '00:00', '03:14', '06:59']) expect(isAvailable(at('2026-09-08', t), AWAKE)).toBe(false);
  });

  it('wraps across midnight for an evening window', () => {
    const evening = { days: [], fromHour: 18, toHour: 2, timezone: DENVER };
    expect(isAvailable(at('2026-09-08', '18:00'), evening)).toBe(true);
    expect(isAvailable(at('2026-09-09', '01:59'), evening)).toBe(true);
    expect(isAvailable(at('2026-09-09', '02:00'), evening)).toBe(false);
    expect(isAvailable(at('2026-09-08', '17:59'), evening)).toBe(false);
  });

  it('credits the back half of a wrapping window to the day the session STARTED', () => {
    // Friday 18:00-02:00. Saturday 01:00 is still Friday night; testing the calendar day would
    // reject the second half of every session the user asked for.
    const fridayNight = { days: [5], fromHour: 18, toHour: 2, timezone: DENVER };
    expect(isAvailable(at('2026-09-11', '20:00'), fridayNight)).toBe(true); // Fri evening
    expect(isAvailable(at('2026-09-12', '01:00'), fridayNight)).toBe(true); // Sat 01:00 = Fri night
    expect(isAvailable(at('2026-09-12', '20:00'), fridayNight)).toBe(false); // Sat evening
  });

  it('filters by day with no hour restriction at all', () => {
    const weekends = { days: [0, 6], fromHour: 0, toHour: 0, timezone: DENVER };
    expect(isAvailable(at('2026-09-12', '03:00'), weekends)).toBe(true); // Saturday
    expect(isAvailable(at('2026-09-13', '23:00'), weekends)).toBe(true); // Sunday
    expect(isAvailable(at('2026-09-14', '12:00'), weekends)).toBe(false); // Monday
  });
});

describe('nextAvailable', () => {
  it('leaves an available instant exactly alone', () => {
    // Applied unconditionally by chain.ts, so this is the common path.
    const t = at('2026-09-08', '14:22');
    expect(nextAvailable(t, AWAKE)).toBe(t);
  });

  it('moves a 03:14 prestige to 07:00 the same morning', () => {
    expect(nextAvailable(at('2026-09-08', '03:14'), AWAKE)).toBe(at('2026-09-08', '07:00'));
  });

  it('moves a 23:30 prestige to 07:00 the NEXT morning', () => {
    // The bug this guards: reading the window start as "today at 07:00" pushes time BACKWARDS by
    // sixteen hours, which would make a chain look faster the more sleep it needed.
    expect(nextAvailable(at('2026-09-08', '23:30'), AWAKE)).toBe(at('2026-09-09', '07:00'));
  });

  it('skips whole unavailable days', () => {
    // Tuesday 12:00 with a weekends-only schedule must land on Saturday, not on Wednesday.
    const weekends = { days: [0, 6], fromHour: 8, toHour: 22, timezone: DENVER };
    expect(nextAvailable(at('2026-09-08', '12:00'), weekends)).toBe(at('2026-09-12', '08:00'));
  });

  it('never returns an instant earlier than its input', () => {
    for (const t of ['00:00', '03:00', '06:59', '07:00', '12:00', '22:59', '23:00', '23:59']) {
      const start = at('2026-09-08', t);
      expect(nextAvailable(start, AWAKE)).toBeGreaterThanOrEqual(start);
    }
  });

  it('is a no-op for a schedule that excludes nothing', () => {
    const t = at('2026-09-08', '03:14');
    expect(nextAvailable(t, { days: [], fromHour: 5, toHour: 5, timezone: DENVER })).toBe(t);
  });

  it('gives up instead of spinning when no day is available', () => {
    // An empty day list means "every day"; a list the validator strips to nothing must not hang
    // the search. Returning the input is strictly better than a frozen tab.
    const impossible = { days: [99], fromHour: 8, toHour: 9, timezone: DENVER };
    const t = at('2026-09-08', '03:00');
    expect(nextAvailable(t, impossible)).toBeGreaterThanOrEqual(t);
  });

  it('lands on 07:00 local across both DST transitions', () => {
    // Spring forward 2027-03-14 and fall back 2027-11-07 in America/Denver. A plan spans two
    // years and crosses four of these; adding a fixed 8*3600 drifts an hour twice a year.
    for (const day of ['2027-03-13', '2027-03-14', '2027-11-06', '2027-11-07']) {
      const pushed = nextAvailable(at(day, '03:30'), AWAKE);
      expect(localHour(pushed, DENVER)).toBe(7);
      expect(isAvailable(pushed, AWAKE)).toBe(true);
    }
  });

  it('handles a window starting inside the spring-forward gap', () => {
    // 02:00 does not exist on 2027-03-14 in Denver. The result must still be available and
    // strictly later, not the input and not something inside the excluded stretch.
    const gap = { days: [], fromHour: 2, toHour: 22, timezone: DENVER };
    const start = at('2027-03-13', '23:30');
    const pushed = nextAvailable(start, gap);
    expect(pushed).toBeGreaterThan(start);
    expect(isAvailable(pushed, gap)).toBe(true);
  });
});

describe('countUnavailable', () => {
  it('counts only the instants outside the schedule', () => {
    const times = ['22:00', '23:10', '01:00', '06:30', '07:30'].map(t => at('2026-09-08', t));
    expect(countUnavailable(times, AWAKE)).toBe(3);
  });

  it('is zero with no schedule, whatever the instants', () => {
    expect(countUnavailable([at('2026-09-08', '03:00')], null)).toBe(0);
  });
});

describe('describeAvailability / availabilityKey', () => {
  it('reads as days and hours, and says "any time" when unset', () => {
    expect(describeAvailability(AWAKE)).toBe(`every day 07:00-23:00 ${DENVER}`);
    expect(describeAvailability({ days: [0, 6], fromHour: 8, toHour: 22, timezone: DENVER })).toBe(
      `Sun,Sat 08:00-22:00 ${DENVER}`
    );
    expect(describeAvailability(null)).toBe('any time');
  });

  it('keys the same schedule identically whatever order the days were ticked', () => {
    // Otherwise reordering checkboxes changes the fingerprint and silently discards a
    // three-hour run's checkpoint.
    const a = { days: [6, 0], fromHour: 8, toHour: 22, timezone: DENVER };
    const b = { days: [0, 6], fromHour: 8, toHour: 22, timezone: DENVER };
    expect(availabilityKey(a)).toBe(availabilityKey(b));
  });

  it('produces an empty key when nothing is excluded, so the fingerprint is unchanged', () => {
    expect(availabilityKey(null)).toBe('');
    expect(availabilityKey({ days: [], fromHour: 3, toHour: 3, timezone: DENVER })).toBe('');
  });
});

describe('fromSleepHours', () => {
  it('inverts sleep hours into availability', () => {
    expect(AWAKE).toEqual({ days: [], fromHour: 7, toHour: 23, timezone: DENVER });
  });
});
